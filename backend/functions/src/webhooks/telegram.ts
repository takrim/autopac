import { Request, Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { getTelegramConfig } from "../config";
import { runBtcBacktestJob } from "../services/backtest";
import { listStrategies, getStrategy, DEFAULT_STRATEGY_ID } from "../services/strategies";
import { sendTelegramMessage } from "../services/telegram";
import { BacktestRunDoc } from "../types";
import { fetchOrderBook, scoreBook, BookLevel } from "../services/orderbook";
import { placeManualOrder } from "../api/trade"
import { runNewsMonitor } from "../services/newsMonitor";
import { runCryptoMonitor, explainCoin, resolveWatchlist } from "../services/cryptoMonitor";
import { queryDecisions, DecisionOutcome } from "../services/decisionLog";
import { runCgBacktest, CgBacktestInput, CgBacktestResult } from "../services/cgBacktest";
import { runDecisionAnalyzer } from "../services/decisionAnalyzer";
import { analyzeStoredDecisionWithAI, normaliseProductId } from "../services/aiBurstAnalyze";
import { formatSeattleDateTime, formatSeattleShort } from "../services/timeFormat";
import { sendEmail } from "../services/email";

const AIBURST_EMAIL_TO = process.env.ANALYSIS_EMAIL_TO || "cliqueadmin@helpables.org";
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
import { getBroker } from "../brokers";

const db = getFirestore();

function fmtUsd(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}$${v.toFixed(2)}`;
}

async function replyTo(chatId: string | number, text: string): Promise<void> {
  const { botToken } = getTelegramConfig();
  if (!botToken) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }).catch((err) => logger.error("[TG_WEBHOOK] Reply failed", { error: String(err) }));
}

async function handleRunCommand(chatId: string | number, strategyId?: string, symbol?: string): Promise<void> {
  const strat = getStrategy(strategyId ?? DEFAULT_STRATEGY_ID);
  const stratName = strat.name;
  const symLabel = symbol ?? "BTC-USD";
  await replyTo(chatId, `⏳ Backtest started (${stratName} on ${symLabel}). Results will follow when done...`);
  try {
    const result = await runBtcBacktestJob({ trigger: "manual", failIfLocked: true, strategyId, symbol });
    const s = result.summary;
    const verdict = s.netPnl >= 0 ? "✅ Backtest Completed" : "❌ Backtest Completed (loss)";
    const rrLabel = s.avgLoss !== 0 ? Math.abs(s.avgWin / s.avgLoss).toFixed(2) : "N/A";

    // Fee-aware net TP/SL per $1k order
    const feePct = 0.6; // per side %
    const netTpPct = strat.takeProfitPct - feePct * 2;
    const netSlPct = strat.stopLossPct  + feePct * 2;
    const beWinRate = netSlPct / (netSlPct + netTpPct);

    const text = [
      verdict,
      `Strategy: ${stratName}`,
      `Symbol: ${result.symbol} • ${result.candleCount.toLocaleString()} candles`,
      ``,
      `⚙️ Strategy Settings`,
      `Order Size: $${s.orderSizeUsd.toFixed(0)} per trade`,
      `Take Profit: +${strat.takeProfitPct.toFixed(1)}% gross  →  net +${netTpPct.toFixed(1)}%`,
      `Stop Loss:   -${strat.stopLossPct.toFixed(1)}% gross  →  net -${netSlPct.toFixed(1)}%`,
      `Fee: 0.6%/side (1.2% round-trip)`,
      `Break-even Win Rate: ${(beWinRate * 100).toFixed(1)}%`,
      ``,
      `📈 Performance`,
      `Trades: ${s.totalTrades} (${s.wins}W / ${s.losses}L)`,
      `Win Rate: ${(s.winRate * 100).toFixed(1)}%  (need ≥${(beWinRate * 100).toFixed(1)}%)`,
      `Net P&L: ${fmtUsd(s.netPnl)}`,
      `Gross P&L: ${fmtUsd(s.grossPnl)}`,
      `Max Drawdown: ${fmtUsd(-s.maxDrawdown)}`,
      `Avg Win: ${fmtUsd(s.avgWin)} | Avg Loss: ${fmtUsd(s.avgLoss)}`,
      `Reward/Risk: ${rrLabel}`,
      ``,
      `💰 Cost`,
      `Total Fees: ${fmtUsd(-s.totalFees)}`,
      `Total Slippage: ${fmtUsd(-s.totalSlippage)}`,
      `Volume Traded: ${s.totalVolumeBtc.toFixed(4)} ${result.symbol.split("-")[0]} ($${(s.totalVolumeUsd / 1000).toFixed(1)}k)`,
      ``,
      `⏱ Exits`,
      `Stop Loss: ${s.stopCount} | Take Profit: ${s.targetCount} | Time: ${s.timeCount}`,
      `Avg Hold: ${s.avgHoldHours.toFixed(1)}h`,
      `Best Hour (UTC): ${s.bestHourUtc !== -1 ? s.bestHourUtc + ":00" : "N/A"}`,
      ``,
      `Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    ].join("\n");
    await replyTo(chatId, text);
  } catch (err) {
    const msg = String(err);
    logger.error("[TG_WEBHOOK] /run failed", { error: msg });
    if (msg.includes("already running")) {
      await replyTo(chatId, "⚠️ Backtest is already running. Try /status for the latest info.");
    } else {
      await replyTo(chatId, `❌ Backtest FAILED:\n${msg}`);
    }
  }
}

/** Format a price with enough decimal places so micro-cap tokens never show $0.00 */
function fmtPrice(p: number): string {
  if (p === 0) return "0.00";
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1)    return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  if (p >= 0.0001) return p.toFixed(7);
  return p.toFixed(10);
}

// ─── Order Book Snapshot ─────────────────────────────────────────────────────

async function handleBookCommand(chatId: string | number, symbol: string): Promise<void> {
  await replyTo(chatId, `📖 Fetching order book for ${symbol}...`);

  const book = await fetchOrderBook(symbol, 50);
  if (!book || book.bids.length === 0 || book.asks.length === 0) {
    await replyTo(chatId, `❌ Could not fetch order book for ${symbol}. Check the symbol (e.g. BTC-USD).`);
    return;
  }

  const { bids, asks } = book;

  // ── Best bid/ask & spread ───────────────────────────────────────────────────
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const mid     = (bestBid + bestAsk) / 2;
  const spread  = bestAsk - bestBid;
  const spreadPct = (spread / mid) * 100;

  // ── Totals ──────────────────────────────────────────────────────────────────
  const totalBidSize = bids.reduce((s, l) => s + l.size, 0);
  const totalAskSize = asks.reduce((s, l) => s + l.size, 0);
  const totalBidUsd  = bids.reduce((s, l) => s + l.size * l.price, 0);
  const totalAskUsd  = asks.reduce((s, l) => s + l.size * l.price, 0);

  const totalSize  = totalBidSize + totalAskSize;
  const bidPct     = (totalBidSize / totalSize) * 100;
  const askPct     = 100 - bidPct;

  const within1pctBidUsd = bids.filter(l => l.price >= mid * 0.99).reduce((s, l) => s + l.size * l.price, 0);
  const within1pctAskUsd = asks.filter(l => l.price <= mid * 1.01).reduce((s, l) => s + l.size * l.price, 0);

  const cvdDelta = totalBidUsd - totalAskUsd;
  const cvdLabel = cvdDelta > 0
    ? `+$${(cvdDelta / 1000).toFixed(1)}k (buy-side heavier)`
    : `-$${(Math.abs(cvdDelta) / 1000).toFixed(1)}k (sell-side heavier)`;

  // ── Scoring via shared service ──────────────────────────────────────────────
  const scored = scoreBook(bids, asks);
  const { score, signal: bookSignal, imbalanceRatio } = scored;

  let imbalanceLabel: string;
  if (imbalanceRatio > 1.5)       imbalanceLabel = "🟢 Strong buy pressure (bids dominate)";
  else if (imbalanceRatio > 1.15) imbalanceLabel = "🟡 Mild buy pressure";
  else if (imbalanceRatio < 0.67) imbalanceLabel = "🔴 Strong sell pressure (asks dominate)";
  else if (imbalanceRatio < 0.87) imbalanceLabel = "🟡 Mild sell pressure";
  else                             imbalanceLabel = "⚪ Balanced (no clear pressure)";

  let spreadQuality: string;
  if (spreadPct < 0.01)      spreadQuality = "🟢 Very tight (liquid)";
  else if (spreadPct < 0.05) spreadQuality = "🟡 Normal";
  else if (spreadPct < 0.15) spreadQuality = "🟠 Wide (low liquidity)";
  else                        spreadQuality = "🔴 Very wide (illiquid / volatile)";

  let recommendation: string;
  if      (score >= 3)  recommendation = "🟢 STRONG BUY";
  else if (score >= 1)  recommendation = "🟩 BUY";
  else if (score <= -3) recommendation = "🔴 STRONG SELL";
  else if (score <= -1) recommendation = "🟥 SELL";
  else                  recommendation = "⚪ NEUTRAL — hold off";

  // ── Walls ───────────────────────────────────────────────────────────────────
  const topBidWalls = [...bids].sort((a, b) => b.size - a.size).slice(0, 3);
  const topAskWalls = [...asks].sort((a, b) => b.size - a.size).slice(0, 3);
  const fmtWall = (l: BookLevel) =>
    `  $${fmtPrice(l.price)} × ${l.size.toFixed(4)} (${(l.size * l.price / 1000).toFixed(1)}k)`;

  // ── Order suggestion (longs only) ──────────────────────────────────────────
  const base = symbol.split("-")[0];
  const nearestBidWall = [...topBidWalls].sort((a, b) => b.price - a.price)[0];
  const nearestAskWall = [...topAskWalls].sort((a, b) => a.price - b.price)[0];
  const buyEntry = parseFloat((bestBid + spread * 0.5).toPrecision(6));
  const buySL    = parseFloat((nearestBidWall.price * 0.997).toPrecision(6));
  const buyTP    = parseFloat((nearestAskWall.price * 1.002).toPrecision(6));

  const orderLines: string[] = [];
  if (score >= 1) {
    orderLines.push(
      `Entry (limit): $${fmtPrice(buyEntry)}`,
      `Stop loss:     $${fmtPrice(buySL)}  (${(((buyEntry - buySL) / buyEntry) * 100).toFixed(2)}% risk)`,
      `Take profit:   $${fmtPrice(buyTP)}  (${(((buyTP - buyEntry) / buyEntry) * 100).toFixed(2)}% target)`,
    );
  } else {
    orderLines.push(`No long setup — wait for buy-side pressure before entering.`);
  }

  const text = [
    `📖 Order Book — ${symbol}`,
    `Mid Price: $${fmtPrice(mid)}`,
    ``,
    `📊 Spread`,
    `Bid: $${fmtPrice(bestBid)} | Ask: $${fmtPrice(bestAsk)}`,
    `Spread: $${fmtPrice(spread)} (${spreadPct.toFixed(3)}%)`,
    `Quality: ${spreadQuality}`,
    ``,
    `⚖️ Imbalance (top ${bids.length} levels)`,
    `Bids: ${bidPct.toFixed(1)}% | Asks: ${askPct.toFixed(1)}%`,
    `Ratio: ${imbalanceRatio.toFixed(2)}x`,
    imbalanceLabel,
    ``,
    `💧 Depth within ±1% of mid`,
    `Bid depth: $${(within1pctBidUsd / 1000).toFixed(1)}k`,
    `Ask depth: $${(within1pctAskUsd / 1000).toFixed(1)}k`,
    ``,
    `📈 CVD Delta (book snapshot)`,
    cvdLabel,
    ``,
    `🧱 Largest Bid Walls`,
    ...topBidWalls.map(fmtWall),
    ``,
    `🧱 Largest Ask Walls`,
    ...topAskWalls.map(fmtWall),
    ``,
    `📦 Total Depth (${bids.length} levels each side)`,
    `Bids: ${totalBidSize.toFixed(4)} ${base} ($${(totalBidUsd / 1000).toFixed(1)}k)`,
    `Asks: ${totalAskSize.toFixed(4)} ${base} ($${(totalAskUsd / 1000).toFixed(1)}k)`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🎯 Signal Score: ${score > 0 ? "+" : ""}${score}/4`,
    `Recommendation: ${recommendation}`,
    ``,
    `📋 Suggested Order`,
    ...orderLines,
    ``,
    `⚠️ Snapshot only — not financial advice.`,
  ].join("\n");

  await replyTo(chatId, text);
}

async function handleStatusCommand(chatId: string | number): Promise<void> {
  // Check if job is currently locked (running)
  const lockDoc = await db.collection("_jobs").doc("btc_backtest_5m").get();
  if (lockDoc.exists && lockDoc.data()?.running === true) {
    const data = lockDoc.data()!;
    const startedAt = data.startedAtMs
      ? formatSeattleDateTime(new Date(data.startedAtMs))
      : "unknown";
    const elapsed = data.startedAtMs
      ? Math.round((Date.now() - data.startedAtMs) / 1000)
      : 0;
    const step = data.step || "Running";
    const detail = data.stepDetail || "";
    const lines = [
      "⏳ Backtest RUNNING",
      `Started: ${startedAt}`,
      `Elapsed: ${elapsed}s`,
      `Step: ${step}`,
    ];
    if (detail) lines.push(`  ${detail}`);
    await replyTo(chatId, lines.join("\n"));
    return;
  }

  // Get the latest completed run
  const snap = await db
    .collection("backtest_runs")
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (snap.empty) {
    await replyTo(chatId, "ℹ️ No backtest runs found yet. Send /run to start one.");
    return;
  }

  const run = snap.docs[0].data() as BacktestRunDoc;
  const tsDate = run.createdAt instanceof Date
    ? run.createdAt
    : new Date((run.createdAt as any)._seconds * 1000);
  const ts = formatSeattleDateTime(tsDate);

  const s = run.summary;
  const avgWin = s.wins > 0 ? (s.grossPnl > 0 ? s.grossPnl / s.wins : 0) : 0;
  const losses = s.losses ?? (s.totalTrades - s.wins);
  const avgLoss = losses > 0 ? ((s.netPnl - s.grossPnl + s.totalFees) / losses) : 0;
  const rrLabel = avgLoss !== 0 ? (Math.abs(avgWin / avgLoss)).toFixed(2) : "N/A";
  const verdict = s.netPnl >= 0 ? "✅ Profitable" : "❌ Not profitable";

  const text = [
    `📊 Last Backtest (${run.trigger ?? "scheduled"})`,
    `Run at: ${ts}`,
    `Symbol: ${run.symbol} • 5m candles • ${run.lookbackDays ?? 90}d`,
    `Candles: ${run.candleCount}`,
    ``,
    `${verdict}`,
    `Trades: ${s.totalTrades} (${s.wins}W / ${losses}L)`,
    `Win Rate: ${(s.winRate * 100).toFixed(1)}%`,
    `Net P&L: ${fmtUsd(s.netPnl)}`,
    `Gross P&L: ${fmtUsd(s.grossPnl)}`,
    `Total Fees: ${fmtUsd(-s.totalFees)}`,
    `Max Drawdown: ${fmtUsd(-s.maxDrawdown)}`,
    `Avg Win: ${fmtUsd(avgWin)} | Avg Loss: ${fmtUsd(avgLoss)}`,
    `Reward/Risk: ${rrLabel}`,
    ``,
    `Best Hour (UTC): ${s.bestHourUtc !== -1 ? s.bestHourUtc + ":00" : "N/A"}`,
    `Best Signal Grade: ${s.bestGrade ?? "N/A"}`,
    `Duration: ${(run.durationMs / 1000).toFixed(1)}s`,
    ``,
    `Send /strategy for signal logic`,
  ].join("\n");

  await replyTo(chatId, text);
}

/**
 * /decisions — query the structured decision log.
 * Usage:
 *   /decisions                       → last 24h, any outcome, all symbols (max 20)
 *   /decisions BTC-USD               → that symbol, last 24h
 *   /decisions accepted              → only accepted, last 24h
 *   /decisions rejected ETH-USD 7d   → rejected, that symbol, last 7 days
 *   /decisions 7d                    → last 7 days, any outcome
 * Tokens can be combined in any order.
 */
async function handleDecisionsCommand(chatId: string | number, args: string[]): Promise<void> {
  let outcome: DecisionOutcome | undefined;
  let symbol: string | undefined;
  let days = 1;

  for (const raw of args) {
    if (!raw) continue;
    const tok = raw.trim();
    const lower = tok.toLowerCase();
    if (lower === "accepted" || lower === "approved" || lower === "passed") { outcome = "ACCEPTED"; continue; }
    if (lower === "rejected" || lower === "skipped" || lower === "failed")  { outcome = "REJECTED"; continue; }
    const dayMatch = lower.match(/^(\d+)d$/);
    if (dayMatch) { days = Math.min(Math.max(parseInt(dayMatch[1], 10), 1), 7); continue; }
    // Otherwise treat as a symbol — normalise to UPPER and handle BTCUSD → BTC-USD
    const sym = tok.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (sym.includes("-")) { symbol = sym; continue; }
    let resolved = sym;
    for (const quote of ["USDT", "USDC", "USD", "BTC", "ETH"]) {
      if (sym.endsWith(quote) && sym.length > quote.length) {
        resolved = `${sym.slice(0, sym.length - quote.length)}-${quote}`;
        break;
      }
    }
    symbol = resolved;
  }

  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let rows;
  try {
    rows = await queryDecisions({ symbol, outcome, sinceMs, limit: 40 });
  } catch (err) {
    logger.error("[TG_WEBHOOK] /decisions query failed", { error: String(err) });
    await replyTo(chatId, `❌ Query failed: ${String(err).slice(0, 200)}`);
    return;
  }

  if (rows.length === 0) {
    await replyTo(chatId, `📭 No decisions found (window=${days}d${symbol ? `, symbol=${symbol}` : ""}${outcome ? `, outcome=${outcome}` : ""})`);
    return;
  }

  const header = `📜 Decisions — last ${days}d${symbol ? ` • ${symbol}` : ""}${outcome ? ` • ${outcome}` : ""} (${rows.length})`;
  const lines: string[] = [header, ""];

  for (const r of rows) {
    const ts = formatSeattleShort(r.timestamp);
    const icon = r.outcome === "ACCEPTED" ? "✅" : "❌";
    const priceStr = r.price !== undefined ? ` @ $${Number(r.price).toFixed(r.price < 1 ? 6 : 2)}` : "";
    lines.push(`${icon} ${ts} ${r.symbol} [${r.action}/${r.source}]${priceStr}`);
    lines.push(`   ${r.reason}`);
    if (r.expression) lines.push(`   ${r.expression}`);
    lines.push("");
  }

  // Telegram caps at 4096 chars — chunk if needed
  let text = lines.join("\n");
  const MAX = 3900;
  while (text.length > 0) {
    const chunk = text.slice(0, MAX);
    const breakAt = chunk.lastIndexOf("\n");
    const sendLen = text.length > MAX && breakAt > 0 ? breakAt : chunk.length;
    await replyTo(chatId, text.slice(0, sendLen));
    text = text.slice(sendLen).replace(/^\n+/, "");
  }
}

async function sendChunked(chatId: string | number, text: string): Promise<void> {
  const MAX = 3900;
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) { await replyTo(chatId, remaining); return; }
    const breakAt = remaining.slice(0, MAX).lastIndexOf("\n");
    const cut = breakAt > 0 ? breakAt : MAX;
    await replyTo(chatId, remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
}

/**
 * /cgbacktest — CoinGecko-driven crypto filter backtest.
 *
 * Usage:
 *   /cgbacktest <symbol> [Nd | from=YYYY-MM-DD to=YYYY-MM-DD] "<expr>" [tp=… sl=… maxhold=…]
 *
 * Examples:
 *   /cgbacktest BTC 14d "rsi<35 && aboveTrend"
 *   /cgbacktest BTC from=2025-12-01 to=2025-12-15 "rsi<35 && vol24h>1m" tp=3 sl=1
 *   /cgbacktest ETH from=2026-05-10 "rsi<30 || (gainBar>2 && rank<100)"
 */
function parseCgBacktestArgs(raw: string): {
  symbol: string;
  input: CgBacktestInput;
} {
  // Pull out the quoted expression first (single or double quotes, balanced)
  const exprMatch = raw.match(/(["'])([^"']+)\1/);
  if (!exprMatch) {
    throw new Error('Missing filter expression. Wrap it in quotes, e.g. "rsi<35 && aboveTrend"');
  }
  const expression = exprMatch[2].trim();
  if (!expression) throw new Error("Filter expression is empty.");
  const withoutExpr = (raw.slice(0, exprMatch.index) + " " + raw.slice((exprMatch.index ?? 0) + exprMatch[0].length)).trim();

  const tokens = withoutExpr.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("Missing symbol.");

  // First positional token is the symbol
  const symbol = tokens.shift()!.toUpperCase();

  const input: CgBacktestInput = { symbol, expression };
  for (const tok of tokens) {
    const m = tok.match(/^([a-zA-Z]+)=(.+)$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2];
      if (key === "from") {
        const d = new Date(val);
        if (isNaN(d.getTime())) throw new Error(`Bad from= date: '${val}' (expected YYYY-MM-DD)`);
        input.fromMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      } else if (key === "to") {
        const d = new Date(val);
        if (isNaN(d.getTime())) throw new Error(`Bad to= date: '${val}' (expected YYYY-MM-DD)`);
        input.toMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 24 * 60 * 60 * 1000 - 1;
      } else if (key === "tp") {
        const n = parseFloat(val); if (isNaN(n)) throw new Error(`Bad tp=${val}`); input.tpPct = n;
      } else if (key === "sl") {
        const n = parseFloat(val); if (isNaN(n)) throw new Error(`Bad sl=${val}`); input.slPct = n;
      } else if (key === "trail") {
        const n = parseFloat(val); if (isNaN(n)) throw new Error(`Bad trail=${val}`); input.trailPct = n;
      } else if (key === "maxhold") {
        const hm = val.match(/^(\d+)([hb]?)$/i);
        if (!hm) throw new Error(`Bad maxhold=${val} (use bars like 48 or hours like 24h)`);
        const n = parseInt(hm[1], 10);
        input.maxHoldBars = hm[2].toLowerCase() === "h" ? n : n;
      } else {
        throw new Error(`Unknown option: ${key}=`);
      }
    } else if (/^\d+d$/i.test(tok)) {
      if (input.fromMs === undefined) input.days = parseInt(tok, 10);
    } else {
      throw new Error(`Unrecognised token '${tok}'. Use Nd or from=YYYY-MM-DD to=YYYY-MM-DD.`);
    }
  }
  return { symbol, input };
}

function formatCgBacktestReport(r: CgBacktestResult): string {
  const s = r.stats;
  const header = [
    `📊 /cgbacktest — ${r.symbol} (${r.cgId})`,
    `Window: ${r.windowLabel} • ${r.barCount} bars (${r.barIntervalLabel})`,
    `Market-cap rank: ${r.marketCapRank ?? "N/A"}${r.marketCapUsd ? ` • $${(r.marketCapUsd / 1e9).toFixed(2)}B mcap` : ""}`,
    `Filter matches: ${r.filterMatches} bars`,
  ];
  if (r.warnings.length) header.push(...r.warnings.map(w => `⚠️ ${w}`));

  const verdict = s.totalTrades === 0
    ? "📭 No trades simulated."
    : s.netPnl >= 0 ? "✅ Profitable" : "❌ Not profitable";
  const summary = s.totalTrades === 0 ? ["", verdict] : [
    "",
    verdict,
    `Trades: ${s.totalTrades} (${s.wins}W / ${s.losses}L)`,
    `Win Rate: ${(s.winRate * 100).toFixed(1)}%`,
    `Net P&L: ${fmtUsd(s.netPnl)} (per $${ORDER_SIZE_USD}/trade, 0.6%/side fees)`,
    `Gross P&L: ${fmtUsd(s.grossPnl)}`,
    `Avg Win: ${fmtUsd(s.avgWin)} | Avg Loss: ${fmtUsd(s.avgLoss)}`,
    `Reward/Risk: ${s.rr !== null ? s.rr.toFixed(2) : "N/A"}`,
    `Max Drawdown: ${fmtUsd(-s.maxDrawdown)}`,
    `Best Hour (UTC): ${s.bestHourUtc !== null ? `${s.bestHourUtc}:00` : "N/A"}`,
    `Exits: ${Object.entries(s.exitReasons).map(([k, v]) => `${k}=${v}`).join(" • ") || "—"}`,
  ];

  const tradesSection: string[] = [];
  if (s.totalTrades > 0) {
    tradesSection.push("", `📋 Last ${Math.min(10, r.trades.length)} trades:`);
    const recent = r.trades.slice(-10);
    for (const t of recent) {
      const ent = new Date(t.entryTs * 1000).toISOString().replace("T", " ").slice(0, 16);
      const ext = new Date(t.exitTs * 1000).toISOString().replace("T", " ").slice(0, 16);
      const pnlIcon = t.pnlUsd > 0 ? "🟢" : "🔴";
      tradesSection.push(
        `${pnlIcon} ${ent} → ${ext} · $${fmtPrice(t.entryPrice)} → $${fmtPrice(t.exitPrice)} · ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}% (${fmtUsd(t.pnlUsd)}) · ${t.exitReason}`
      );
    }
  }
  return [...header, ...summary, ...tradesSection].join("\n");
}

const ORDER_SIZE_USD = 1000; // mirrors cgBacktest constant; for display only

async function handleCgBacktestCommand(chatId: string | number, raw: string): Promise<void> {
  let parsed: ReturnType<typeof parseCgBacktestArgs>;
  try {
    parsed = parseCgBacktestArgs(raw);
  } catch (err) {
    await replyTo(chatId, `❌ ${String((err as Error).message)}\n\nUsage: /cgbacktest <sym> [Nd | from=YYYY-MM-DD to=YYYY-MM-DD] "<expr>" [tp=… sl=… maxhold=…]`);
    return;
  }
  await replyTo(chatId, `⏳ Fetching ${parsed.symbol}…`);
  try {
    const result = await runCgBacktest(parsed.input);
    await sendChunked(chatId, formatCgBacktestReport(result));
  } catch (err) {
    logger.error("[TG_WEBHOOK] /cgbacktest failed", { error: String(err) });
    await replyTo(chatId, `❌ ${String((err as Error).message).slice(0, 500)}`);
  }
}

export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  try {
    const cfg = getTelegramConfig();

    const update = req.body as {
      message?: {
        chat: { id: number };
        text?: string;
        from?: { id: number };
      };
    };

    const message = update.message;
    if (!message?.text) {
      res.json({ ok: true });
      return;
    }

    const chatId = message.chat.id;

    // Only allow commands from our configured chat
    if (String(chatId) !== cfg.chatId) {
      logger.warn("[TG_WEBHOOK] Message from unknown chat", { chatId });
      res.json({ ok: true });
      return;
    }

    const text = message.text.trim();
    const lower = text.toLowerCase();

    if (lower === "/run" || lower.startsWith("/run ")) {
      const parts = text.trim().split(/\s+/);
      const strategyId = parts[1]?.toLowerCase() || undefined;
      // 3rd word is optional symbol, e.g. /run scalpx ETH-USD or ETHUSD
      const symbol = parts[2]?.toUpperCase() || undefined;
      await handleRunCommand(chatId, strategyId, symbol).catch((err) =>
        logger.error("[TG_WEBHOOK] handleRunCommand error", { error: String(err) })
      );
      res.json({ ok: true });
    } else if (lower === "/status" || lower.startsWith("/status ")) {
      await handleStatusCommand(chatId);
      res.json({ ok: true });
    } else if (lower === "/strategy" || lower.startsWith("/strategy ")) {
      const parts = text.trim().split(/\s+/);
      const stratId = parts[1]?.toLowerCase();
      if (stratId) {
        let strat;
        try { strat = getStrategy(stratId); } catch {
          await replyTo(chatId, `❌ Unknown strategy: "${stratId}"\nAvailable: ${listStrategies().map(s => s.id).join(", ")}`);
          res.json({ ok: true });
          return;
        }
        const msg = [
          `🔬 ${strat.name}`,
          "",
          ...strat.description,
        ].join("\n");
        await replyTo(chatId, msg);
      } else {
        const all = listStrategies();
        const lines = [
          "📋 Available Strategies:",
          "",
          ...all.map(s => `• ${s.id} — ${s.name}`),
          "",
          "Use /strategy <id> for details",
          "Use /run <id> to run a specific strategy",
        ];
        await replyTo(chatId, lines.join("\n"));
      }
      res.json({ ok: true });
    } else if (lower === "/buy" || lower.startsWith("/buy ")) {
      const parts = text.trim().split(/\s+/);
      const rawSym = parts[1]?.trim();
      if (!rawSym) {
        await replyTo(chatId, "Usage: /buy <symbol>\nExample: /buy BTCUSD or /buy BTC-USD");
      } else {
        // Normalise e.g. BTCUSD → BTC-USD for Coinbase
        const sym = rawSym.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const normSym = (() => {
          for (const quote of ["USDT", "USD", "BTC", "ETH"]) {
            if (sym.endsWith(quote) && sym.length > quote.length)
              return `${sym.slice(0, sym.length - quote.length)}-${quote}`;
          }
          return sym;
        })();
        await replyTo(chatId, `⏳ Placing BUY order for ${normSym}...`);
        try {
          const result = await placeManualOrder(normSym, "BUY", "telegram");
          if (result.error) {
            await replyTo(chatId, `❌ Order failed: ${result.error}`);
          } else if (result.status === "skipped_pyramid_off") {
            await replyTo(chatId, `⚠️ Skipped: ${result.error ?? "Pyramid disabled — position already open"}`);
          } else if (result.status === "executed") {
            await replyTo(chatId, [
              `✅ BUY order placed!`,
              `Symbol: ${result.symbol}`,
              `Price: $${fmtPrice(result.price)}`,
              `Stop Loss: $${fmtPrice(result.stopLoss)}`,
              `Take Profit: $${fmtPrice(result.takeProfit)}`,
              `Order ID: ${result.orderId}`,
            ].join("\n"));
          } else {
            await replyTo(chatId, `❌ Order failed\nStatus: ${result.status}\nSignal: ${result.signalId}`);
          }
        } catch (buyErr) {
          logger.error("[TG_WEBHOOK] /buy failed", { error: String(buyErr), symbol: normSym });
          await replyTo(chatId, `❌ Error placing buy order: ${String(buyErr).slice(0, 200)}`);
        }
      }
      res.json({ ok: true });
    } else if (lower === "/book" || lower.startsWith("/book ")) {
      const parts = text.trim().split(/\s+/);
      const sym = parts[1] ? parts[1].toUpperCase().replace(/[^A-Z0-9]/g, "") : "BTCUSD";
      // Normalise e.g. ETHUSD → ETH-USD
      const normSym = (() => {
        for (const quote of ["USDT", "USD", "BTC", "ETH"]) {
          if (sym.endsWith(quote) && sym.length > quote.length)
            return `${sym.slice(0, sym.length - quote.length)}-${quote}`;
        }
        return sym;
      })();
      await handleBookCommand(chatId, normSym);
      res.json({ ok: true });
    } else if (lower === "/trend") {
      await replyTo(chatId, "⏳ Fetching trend analysis...");
      try {
        await runNewsMonitor((msg) => replyTo(chatId, msg));
      } catch (trendErr) {
        logger.error("[TG_WEBHOOK] /trend failed", { error: String(trendErr) });
        await replyTo(chatId, `❌ Trend analysis failed: ${String(trendErr).slice(0, 200)}`);
      }
      res.json({ ok: true });
    } else if (lower === "/scan" || lower.startsWith("/scan ")) {
      const arg = text.trim().split(/\s+/)[1];
      await replyTo(chatId, `⏳ Scanning${arg ? ` ${arg.toUpperCase()}` : " watchlist"}...`);
      try {
        // dry-run: preview only — no writes, no alerts, no auto-buy
        const result = await runCryptoMonitor({ onlySymbol: arg, dryRun: true });
        const header = `🔎 Crypto scan (preview) — ${result.scanned} coin${result.scanned !== 1 ? "s" : ""}, ${result.alerts} would-alert`;
        await replyTo(chatId, `${header}\n\n${result.lines.join("\n") || "(no coins)"}`);
      } catch (scanErr) {
        logger.error("[TG_WEBHOOK] /scan failed", { error: String(scanErr) });
        await replyTo(chatId, `❌ Scan failed: ${String(scanErr).slice(0, 200)}`);
      }
      res.json({ ok: true });
    } else if (lower === "/coin" || lower.startsWith("/coin ")) {
      const arg = text.trim().split(/\s+/)[1];
      if (!arg) {
        await replyTo(chatId, "Usage: /coin <symbol>\nExample: /coin SOL");
      } else {
        await replyTo(chatId, `⏳ Scoring ${arg.toUpperCase()}...`);
        try {
          const breakdown = await explainCoin(arg);
          await replyTo(chatId, breakdown ?? `❓ ${arg.toUpperCase()} is not in the watchlist. Try /watchlist.`);
        } catch (coinErr) {
          logger.error("[TG_WEBHOOK] /coin failed", { error: String(coinErr) });
          await replyTo(chatId, `❌ Breakdown failed: ${String(coinErr).slice(0, 200)}`);
        }
      }
      res.json({ ok: true });
    } else if (lower === "/watchlist") {
      try {
        const coins = await resolveWatchlist();
        await replyTo(chatId, `📋 Universe (${coins.length} — Coinbase top movers, non-defi/meme):\n${coins.map(c => `• ${c.symbol} (${c.coinbaseProductId})`).join("\n")}`);
      } catch (wlErr) {
        await replyTo(chatId, `❌ Watchlist read failed: ${String(wlErr).slice(0, 200)}`);
      }
      res.json({ ok: true });
    } else if (lower === "/cgbacktest" || lower.startsWith("/cgbacktest ")) {
      const raw = text.slice("/cgbacktest".length).trim();
      await handleCgBacktestCommand(chatId, raw).catch((err) =>
        logger.error("[TG_WEBHOOK] handleCgBacktestCommand error", { error: String(err) })
      );
      res.json({ ok: true });
    } else if (lower === "/decisions" || lower.startsWith("/decisions ")) {
      const args = text.trim().split(/\s+/).slice(1);
      await handleDecisionsCommand(chatId, args).catch((err) =>
        logger.error("[TG_WEBHOOK] /decisions failed", { error: String(err) })
      );
      res.json({ ok: true });
    } else if (lower === "/analyze" || lower.startsWith("/analyze ")) {
      const args = text.trim().split(/\s+/).slice(1);
      let hours = 24;
      for (const a of args) {
        const m = a.toLowerCase().match(/^(\d+)([hd])$/);
        if (m) {
          const n = parseInt(m[1], 10);
          hours = m[2] === "d" ? Math.min(Math.max(n, 1), 7) * 24 : Math.min(Math.max(n, 1), 168);
        }
      }
      await replyTo(chatId, `🔍 Running Gemini analysis on last ${hours}h of decisions… (will email report when done)`);
      try {
        const result = await runDecisionAnalyzer(hours);
        if (result.decisions === 0) {
          await replyTo(chatId, `💭 No decisions found in last ${hours}h.`);
        } else if (result.emailError) {
          await replyTo(chatId, `⚠️ Analyzed ${result.decisions} decisions (${result.accepted}A/${result.rejected}R) but email failed: ${result.emailError.slice(0, 200)}`);
        } else {
          await replyTo(chatId, `✅ Analyzed ${result.decisions} decisions (${result.accepted}A/${result.rejected}R) — report emailed.`);
        }
      } catch (err) {
        logger.error("[TG_WEBHOOK] /analyze failed", { error: String(err) });
        await replyTo(chatId, `❌ Analysis failed: ${String(err).slice(0, 300)}`);
      }
      res.json({ ok: true });
    } else if (lower === "/aiburstanalyze" || lower.startsWith("/aiburstanalyze ")) {
      const parts = text.trim().split(/\s+/).slice(1);
      const arg = parts[0]?.toLowerCase();
      try {
        // No arg — analyze the LAST SUCCESSFUL BUY using the preserved decision_logs snapshot
        // (no live re-evaluation; we explain the entry as it was taken).
        if (!arg) {
          const snap = await db.collection("signals")
            .where("strategy", "==", "burst_scanner")
            .orderBy("createdAt", "desc")
            .limit(1)
            .get();
          if (snap.empty) {
            await replyTo(chatId, "No burst-scanner buy found yet. Usage: /aiburstanalyze [symbol|all]");
            res.json({ ok: true });
            return;
          }
          const sym = String(snap.docs[0].data().symbol).toUpperCase();
          await replyTo(chatId, `🤖 Running Gemini analysis on last buy: ${sym}...`);
          try {
            const report = await analyzeStoredDecisionWithAI(sym, { outcome: "ACCEPTED" });
            if (!report) {
              await replyTo(chatId, `⚠️ No preserved decision_logs snapshot found for ${sym}.`);
              res.json({ ok: true });
              return;
            }
            const MAX = 4000;
            if (report.text.length <= MAX) {
              await replyTo(chatId, report.text);
            } else {
              for (let i = 0; i < report.text.length; i += MAX) {
                await replyTo(chatId, report.text.slice(i, i + MAX));
              }
            }
            try {
              const subject = `AutoPac Burst AI Analysis — ${sym} (${report.isBuy ? "executed buy" : "rejected"})`;
              const emailRes = await sendEmail({ to: AIBURST_EMAIL_TO, subject, html: report.html, text: report.text });
              if (!emailRes.ok) {
                logger.warn("[TG_WEBHOOK] /aiburstanalyze email send failed", { symbol: sym, error: emailRes.error });
                await replyTo(chatId, `⚠️ ${sym}: email failed — ${String(emailRes.error).slice(0, 200)}`);
              }
            } catch (mailErr) {
              logger.warn("[TG_WEBHOOK] /aiburstanalyze email exception", { symbol: sym, error: String(mailErr) });
            }
          } catch (symErr) {
            logger.error("[TG_WEBHOOK] /aiburstanalyze historical failed", { symbol: sym, error: String(symErr) });
            await replyTo(chatId, `❌ ${sym}: ${String(symErr).slice(0, 300)}`);
          }
          res.json({ ok: true });
          return;
        }

        let targets: string[] = [];
        if (arg === "all") {
          // All open positions
          const broker = getBroker();
          if (!broker.getDetailedPositions) {
            await replyTo(chatId, "❌ Broker doesn't support listing positions.");
            res.json({ ok: true });
            return;
          }
          const positions = await broker.getDetailedPositions();
          if (positions.length === 0) {
            await replyTo(chatId, "No open positions.");
            res.json({ ok: true });
            return;
          }
          targets = positions.map(p => p.symbol.includes("-") ? p.symbol.toUpperCase() : `${p.symbol.toUpperCase()}-USD`);
        } else {
          targets = [normaliseProductId(parts[0])];
        }

        await replyTo(chatId, `🤖 Running Gemini analysis on ${targets.length} symbol${targets.length === 1 ? "" : "s"}: ${targets.join(", ")}...`);
        for (const sym of targets) {
          try {
            const report = await analyzeStoredDecisionWithAI(sym);
            if (!report) {
              await replyTo(chatId, `⚠️ ${sym}: no burst-scanner decision_logs snapshot found.`);
              continue;
            }
            // Telegram caps at 4096 chars — chunk if needed
            const MAX = 4000;
            if (report.text.length <= MAX) {
              await replyTo(chatId, report.text);
            } else {
              for (let i = 0; i < report.text.length; i += MAX) {
                await replyTo(chatId, report.text.slice(i, i + MAX));
              }
            }
            // Email a copy of the report
            try {
              const subject = `AutoPac Burst AI Analysis — ${sym} (${report.isBuy ? "executed buy" : "rejected"})`;
              const emailRes = await sendEmail({ to: AIBURST_EMAIL_TO, subject, html: report.html, text: report.text });
              if (!emailRes.ok) {
                logger.warn("[TG_WEBHOOK] /aiburstanalyze email send failed", { symbol: sym, error: emailRes.error });
                await replyTo(chatId, `⚠️ ${sym}: email failed — ${String(emailRes.error).slice(0, 200)}`);
              }
            } catch (mailErr) {
              logger.warn("[TG_WEBHOOK] /aiburstanalyze email exception", { symbol: sym, error: String(mailErr) });
            }
          } catch (symErr) {
            logger.error("[TG_WEBHOOK] /aiburstanalyze symbol failed", { symbol: sym, error: String(symErr) });
            await replyTo(chatId, `❌ ${sym}: ${String(symErr).slice(0, 300)}`);
          }
        }
      } catch (err) {
        logger.error("[TG_WEBHOOK] /aiburstanalyze failed", { error: String(err) });
        await replyTo(chatId, `❌ Analysis failed: ${String(err).slice(0, 300)}`);
      }
      res.json({ ok: true });
    } else if (lower === "/help" || lower === "/start") {
      const helpText = [
        "🤖 *AutoPac Bot — Command Reference*",
        "",
        "━━━ 📊 Trading ━━━",
        "",
        "*/buy* <symbol>",
        "  Place a market BUY order for a symbol.",
        "  Example: /buy ATOM-USD  or  /buy ATOMUSD",
        "",
        "*/book* [symbol]",
        "  Order book snapshot with imbalance score, spread quality, wall analysis, and a suggested entry/SL/TP.",
        "  Default: BTC-USD   Example: /book ETH-USD",
        "",
        "*/trend*",
        "  Run trend analysis now (RSI, momentum, news sentiment).",
        "",
        "━━━  Decision Log ━━━",
        "",
        "*/decisions* [symbol] [accepted|rejected] [Nd]",
        "  Query the structured trade-decision log. Tokens can be in any order.",
        "  Defaults: last 24h, all outcomes, all symbols (max 40 rows).",
        "  Examples:",
        "    /decisions",
        "    /decisions ATOM-USD",
        "    /decisions rejected 7d",
        "    /decisions accepted BTC-USD 3d",
        "",
        "*/analyze* [Nh | Nd]",
        "  Run a Gemini AI analysis over recent decisions and email the report.",
        "  Default: last 24h.   Examples: /analyze 48h   /analyze 3d",
        "",
        "*/aiburstanalyze* [symbol | all]",
        "  Gemini gate-by-gate review for the burst scanner using the preserved decision_logs snapshot.",
        "  No arg → last burst-scanner buy.   all → all open positions.",
        "  Example: /aiburstanalyze BTC-USD",
        "",
        "━━━ 🧪 Backtesting ━━━",
        "",
        "*/run* [strategy] [symbol]",
        "  Run a backtest. Default: momentum strategy on BTC-USD.",
        "  Examples:",
        "    /run",
        "    /run scalpx",
        "    /run scalpx ETH-USD",
        "",
        "*/cgbacktest* <symbol> [Nd | from=YYYY-MM-DD [to=YYYY-MM-DD]] \"<expr>\" [tp=N] [sl=N] [maxhold=N]",
        "  CoinGecko-driven crypto filter backtest.",
        "  Filter vars: price  gainBar  gain24h  vol24h  rsi  ema200  aboveTrend  rank  marketCap",
        "  Examples:",
        "    /cgbacktest BTC 14d \"rsi<35 && aboveTrend\"",
        "    /cgbacktest ETH from=2025-12-01 to=2025-12-15 \"rsi<35 && vol24h>1m\" tp=3 sl=1",
        "",
        "*/status*",
        "  Show results of the latest completed backtest run.",
        "",
        "*/strategy*",
        "  List all available strategies.",
        "",
        "*/strategy* <id>",
        "  Show detailed description and parameters for a strategy.",
        "  Example: /strategy scalpx",
        "",
        "*/scan* [symbol]",
        "  Run the crypto buy-signal monitor now (whole watchlist, or one coin).",
        "  Example: /scan SOL",
        "",
        "*/coin* <symbol>",
        "  Detailed score breakdown for one coin (how the calc happened).",
        "  Example: /coin SOL",
        "",
        "*/watchlist*",
        "  Show the coins the monitor tracks.",
        "",
        "━━━ ℹ️ General ━━━",
        "",
        "*/help*  or  */start*",
        "  Show this command reference.",
      ].join("\n");
      await sendChunked(chatId, helpText);
      res.json({ ok: true });
    } else {
      res.json({ ok: true });
    }
  } catch (err) {
    logger.error("[TG_WEBHOOK] Unhandled error", { error: String(err) });
    if (!res.headersSent) res.json({ ok: true });
  }
}
