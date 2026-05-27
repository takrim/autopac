/**
 * AI-powered analysis of a symbol against the burst scanner's buy gates.
 * Runs the same checkEntrySignal() the live scanner uses, then asks Gemini to
 * explain each gate verdict in detail and produce an overall recommendation.
 */
import { logger } from "firebase-functions/v2";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getBroker } from "../brokers";
import { CoinbaseBroker } from "../brokers/coinbase";
import { formatSeattleDateTime } from "./timeFormat";
import {
  checkEntrySignal,
  EntryResult,
  RSI_PERIOD,
  RSI_BUY_MAX,
  RSI_OVERSOLD,
  RSI_TURNUP_LOOKBACK,
  REQUIRE_RSI_TURN_UP,
  REQUIRE_TREND_FILTER,
  TREND_EMA_PERIOD,
} from "./burstScanner";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/** Normalise a free-form symbol (BTCUSD, btc-usd, BTC) to a Coinbase productId like BTC-USD. */
export function normaliseProductId(raw: string): string {
  const sym = raw.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (sym.includes("-")) return sym;
  for (const quote of ["USDT", "USDC", "USD", "BTC", "ETH"]) {
    if (sym.endsWith(quote) && sym.length > quote.length) {
      return `${sym.slice(0, sym.length - quote.length)}-${quote}`;
    }
  }
  return `${sym}-USD`;
}

interface AnalysisContext {
  productId: string;
  entry: EntryResult;
  currentPrice: number;
  position: { entryPrice: number; pnlPct: number; stopLoss: number } | null;
}

async function gatherContext(productId: string): Promise<AnalysisContext> {
  // Burst scanner is a Coinbase-native strategy (uses Coinbase 1m/5m/1h candle API),
  // so instantiate CoinbaseBroker directly regardless of ACTIVE_BROKER. Position lookup
  // still uses the active broker (which may be Alpaca for equities).
  const broker = new CoinbaseBroker();
  const activeBroker = getBroker();
  const [entry, positions] = await Promise.all([
    checkEntrySignal(broker, productId),
    activeBroker.getDetailedPositions ? activeBroker.getDetailedPositions() : Promise.resolve([]),
  ]);

  // Find the most recent close price for context (use a 1m candle peek)
  let currentPrice = 0;
  try {
    const cs = await broker.getCandles(productId, "ONE_MINUTE", 1);
    if (cs.length > 0) currentPrice = cs[cs.length - 1].close;
  } catch { /* non-fatal */ }

  // Match against open positions
  let position: AnalysisContext["position"] = null;
  for (const p of positions) {
    const sym = p.symbol.includes("-") ? p.symbol.toUpperCase() : `${p.symbol.toUpperCase()}-USD`;
    if (sym === productId) {
      const entryPrice = parseFloat(p.avg_entry_price) || 0;
      const cur = parseFloat(p.current_price) || currentPrice;
      const pnlPct = entryPrice > 0 ? ((cur - entryPrice) / entryPrice) * 100 : 0;
      position = {
        entryPrice,
        pnlPct,
        stopLoss: p.stop_loss ? parseFloat(p.stop_loss) || 0 : 0,
      };
      if (currentPrice === 0) currentPrice = cur;
      break;
    }
  }

  return { productId, entry, currentPrice, position };
}

function buildPrompt(ctx: AnalysisContext): string {
  const { productId, entry, currentPrice, position } = ctx;
  const fmt = (n: number, p = 4) => Number.isFinite(n) && n >= 0 ? n.toPrecision(p) : "n/a";

  const lines: string[] = [];
  lines.push(`You are an expert quantitative crypto trader reviewing a single Coinbase symbol against the AutoPac "burst scanner" buy-entry strategy.`);
  lines.push("");
  lines.push(`STRATEGY OVERVIEW (read carefully):`);
  lines.push(`- Goal: buy oversold gainers — symbols that pumped on 24h volume/gain but are now temporarily oversold on the short timeframe, then turning back up.`);
  lines.push(`- Timeframe: RSI(${RSI_PERIOD}) on 3-minute candles (with 5-minute fallback when 3m data is too sparse).`);
  lines.push(`- Hard-fail gates (any failure ⇒ SKIP, no buy):`);
  lines.push(`    1. Order-book pressure: if top-10 bid/ask ratio classifies as SELL or STRONG_SELL ⇒ SKIP.`);
  lines.push(`    2. Trend filter (REQUIRE_TREND_FILTER=${REQUIRE_TREND_FILTER}): last 1h close must be ABOVE EMA-${TREND_EMA_PERIOD} on 1h ⇒ only buy dips in established uptrends.`);
  lines.push(`    3. Oversold: RSI must be STRICTLY LESS THAN ${RSI_BUY_MAX} ⇒ otherwise not oversold enough.`);
  lines.push(`    4. Turn-up confirmation (REQUIRE_RSI_TURN_UP=${REQUIRE_RSI_TURN_UP}): in the last ${RSI_TURNUP_LOOKBACK} bars RSI must have dipped to ≤${RSI_OVERSOLD}, the last bar must be rising vs the previous bar, AND current RSI must be ABOVE ${RSI_OVERSOLD} (i.e. exited oversold).`);
  lines.push(`- Boost (not a gate): bullish RSI divergence (price lower-low while RSI higher-low) plus at-least-neutral order book ⇒ upgrades BUY to STRONG_BUY.`);
  lines.push(`- Final signal value semantics: "BUY" or "STRONG_BUY" ⇒ scanner places an order; "SKIP" ⇒ no order this run.`);
  lines.push("");
  lines.push(`SYMBOL UNDER REVIEW: ${productId}`);
  lines.push(`Current price snapshot: $${fmt(currentPrice)}`);
  lines.push("");
  lines.push(`LIVE GATE TELEMETRY (just computed by running the real scanner on this symbol):`);
  lines.push(`- Signal verdict: ${entry.signal}${entry.skipReason ? `  (skipReason: "${entry.skipReason}")` : ""}`);
  lines.push(`- Order book: ratio=${entry.bidAskRatio.toFixed(2)}  classification=${entry.obSignal}`);
  lines.push(`- Trend filter: aboveTrend=${entry.aboveTrend}  EMA200(1h)=$${fmt(entry.ema200)}  ⇒ ${entry.aboveTrend ? "uptrend (PASS)" : "downtrend (FAIL)"}`);
  lines.push(`- RSI: rsi=${entry.rsi >= 0 ? entry.rsi.toFixed(2) : "n/a"}  rsiMA(${"9"})=${entry.rsiMa >= 0 ? entry.rsiMa.toFixed(2) : "n/a"}  threshold=${RSI_BUY_MAX}`);
  lines.push(`- Turn-up: rsiTurnedUp=${entry.rsiTurnedUp}  (lookback ${RSI_TURNUP_LOOKBACK} bars, oversold floor ${RSI_OVERSOLD})`);
  lines.push(`- Divergence boost: bullishDivergence=${entry.bullishDivergence}`);
  if (position) {
    lines.push("");
    lines.push(`POSITION CONTEXT: you are ALREADY LONG ${productId} — entry=$${fmt(position.entryPrice)}, P/L=${position.pnlPct >= 0 ? "+" : ""}${position.pnlPct.toFixed(2)}%, stopLoss=${position.stopLoss > 0 ? "$" + fmt(position.stopLoss) : "none"}.`);
    lines.push(`Consider this in the recommendation (the live scanner won't pyramid into open positions).`);
  } else {
    lines.push("");
    lines.push(`POSITION CONTEXT: no open position on this symbol.`);
  }
  lines.push("");
  lines.push(`TASK:`);
  lines.push(`Produce a detailed plain-text report (no markdown headers, no HTML — Telegram plain text). Use short labelled sections. Be quantitative — cite the actual numbers above.`);
  lines.push(`Cover, in this order:`);
  lines.push(`1. One-line OVERALL VERDICT (BUY / STRONG_BUY / SKIP) and one-line WHY.`);
  lines.push(`2. Per-gate breakdown (Gate 1 Order Book, Gate 2 Trend, Gate 3 Oversold, Gate 4 Turn-up, Boost Divergence) — for each: state PASS / FAIL / BORDERLINE, cite the number vs threshold, and explain in 1-2 sentences what the live market is signalling.`);
  lines.push(`3. WHAT WOULD FLIP THE VERDICT — concrete trigger conditions (e.g. "RSI needs to fall from 47 to below 35 and then bounce, or order book ratio needs to rise above 1.2").`);
  lines.push(`4. RISK FLAGS — anything in the data that looks shaky (low ratio, weak trend, divergence absent, etc.). Be honest, don't sugar-coat.`);
  if (position) {
    lines.push(`5. POSITION ADVICE — since we're already long, comment on whether to hold, where the next exit trigger likely is (RSI<30 cut, RSI≥70 trailing-stop arm), and risk to the open P/L.`);
  }
  lines.push("");
  lines.push(`Length: 250-450 words. Tone: direct, professional, no fluff.`);
  return lines.join("\n");
}

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 2048 },
    }),
  });
  const data = await resp.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (!resp.ok) {
    throw new Error(`Gemini ${resp.status}: ${data.error?.message || JSON.stringify(data)}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("\n") || "";
  if (!text) throw new Error("Gemini returned empty response");
  return text.trim();
}

/**
 * Run the live burst-scanner gates against one symbol, then ask Gemini to
 * explain the verdict in detail. Returns a plain-text Telegram-ready report.
 */
export async function analyzeSymbolWithAI(productId: string): Promise<string> {
  const normalised = normaliseProductId(productId);
  logger.info("[AI_BURST] Analyzing symbol", { symbol: normalised });
  const ctx = await gatherContext(normalised);
  const prompt = buildPrompt(ctx);
  const aiReport = await callGemini(prompt);

  const header = [
    `🤖 AI Burst Analysis — ${normalised}`,
    `Signal: ${ctx.entry.signal}${ctx.entry.skipReason ? ` (${ctx.entry.skipReason})` : ""}`,
    `RSI=${ctx.entry.rsi >= 0 ? ctx.entry.rsi.toFixed(1) : "n/a"}  ratio=${ctx.entry.bidAskRatio.toFixed(2)}  trend=${ctx.entry.aboveTrend ? "up" : "down"}`,
    "─────────────────────",
  ].join("\n");
  return `${header}\n${aiReport}`;
}

/**
 * Analyze the most recent burst-scanner decision_log entry for a symbol
 * (either ACCEPTED or REJECTED) using the preserved snapshot — no live
 * re-evaluation. Returns a plain-text Telegram report PLUS a styled HTML
 * email body, or null if no decision_log record found for the symbol.
 */
export interface BurstAnalysisReport { text: string; html: string; isBuy: boolean }
export async function analyzeStoredDecisionWithAI(
  productId: string,
  opts: { outcome?: "ACCEPTED" | "REJECTED" } = {},
): Promise<BurstAnalysisReport | null> {
  const normalised = normaliseProductId(productId);
  const db = getFirestore();
  // Index: decision_logs(symbol ASC, timestamp DESC) or (symbol+outcome+timestamp DESC).
  // Filter source=burst_scanner client-side. Also skip portfolio-management rejections
  // like "already holding" which aren't gate evaluations.
  let q: FirebaseFirestore.Query = db.collection("decision_logs")
    .where("symbol", "==", normalised);
  if (opts.outcome) q = q.where("outcome", "==", opts.outcome);
  const snap = await q.orderBy("timestamp", "desc").limit(50).get();
  const doc = snap.docs.find(d => {
    const x = d.data();
    if (x.source !== "burst_scanner") return false;
    // Skip portfolio-management rejections (already holding, cooldown, max positions)
    // — these aren't real gate evaluations. Keep all other rejections even if they
    // have no checks[] (e.g. early-exit "RSI not oversold" pre-screen rejections).
    if (x.outcome === "REJECTED") {
      const reason = String(x.reason || "").toLowerCase();
      if (reason.includes("already holding")) return false;
      if (reason.includes("cooldown")) return false;
      if (reason.includes("max open positions")) return false;
    }
    return true;
  });
  if (!doc) return null;

  const rec = doc.data() as {
    symbol: string;
    outcome: "ACCEPTED" | "REJECTED";
    action?: string;
    reason?: string;
    expression?: string;
    params?: Record<string, unknown>;
    checks?: Array<{ name: string; passed: boolean; expression: string; actual?: number | string; threshold?: number | string }>;
    timestamp?: Timestamp;
    price?: number;
  };

  const isBuy = rec.outcome === "ACCEPTED";
  logger.info("[AI_BURST] Analyzing stored decision snapshot", {
    symbol: normalised, decisionId: doc.id, outcome: rec.outcome,
  });

  const ts = rec.timestamp?.toDate?.() ?? null;
  const tsStr = formatSeattleDateTime(ts);

  const lines: string[] = [];
  lines.push(`You are an expert quantitative crypto trader reviewing a HISTORICAL burst-scanner decision.`);
  if (isBuy) {
    lines.push(`The AutoPac burst scanner DECIDED TO BUY ${normalised} at the moment shown below — all gates PASSED.`);
    lines.push(`Your job is to explain WHY each gate passed in plain language and assess the quality of the entry, using ONLY the preserved snapshot data (do NOT infer the current market state — that is irrelevant here).`);
  } else {
    lines.push(`The AutoPac burst scanner SKIPPED (rejected) ${normalised} at the moment shown below — at least one gate FAILED.`);
    lines.push(`Your job is to explain WHY the symbol was rejected in plain language and assess whether this was the right call, using ONLY the preserved snapshot data (do NOT infer the current market state — that is irrelevant here).`);
  }
  lines.push("");
  lines.push(`STRATEGY OVERVIEW:`);
  lines.push(`- Goal: buy oversold 24h gainers — pumped on volume/gain but temporarily oversold on the 3-minute timeframe, then turning back up.`);
  lines.push(`- Hard-fail gates: order-book pressure, 1h-EMA trend, RSI oversold (<${RSI_BUY_MAX}), RSI turn-up confirmation, plus filters on 24h gain, volume, market cap rank, 7d trend, ATH distance, FDV/MCap ratio, cooldown, allowlist.`);
  lines.push("");
  lines.push(`PRESERVED SNAPSHOT (at the time of the decision):`);
  lines.push(`- Symbol: ${normalised}`);
  lines.push(`- Outcome: ${rec.outcome}`);
  lines.push(`- Decided at: ${tsStr}`);
  if (rec.price !== undefined) lines.push(`- Price at decision: $${rec.price}`);
  lines.push(`- One-line reason: ${rec.reason || "n/a"}`);
  lines.push("");
  if (rec.params && Object.keys(rec.params).length > 0) {
    lines.push(`PARAMS (the raw telemetry the scanner saw):`);
    for (const [k, v] of Object.entries(rec.params)) {
      lines.push(`  - ${k}: ${JSON.stringify(v)}`);
    }
    lines.push("");
  }
  if (rec.checks && rec.checks.length > 0) {
    lines.push(`CHECKS (each gate evaluated):`);
    for (const c of rec.checks) {
      const verdict = c.passed ? "PASS" : "FAIL";
      lines.push(`  - ${c.name}: ${verdict} — ${c.expression}`);
    }
    lines.push("");
  }
  lines.push(`TASK:`);
  lines.push(`Produce a detailed plain-text report (no markdown headers, no HTML — Telegram plain text). Use short labelled sections. Be quantitative — cite the actual numbers above.`);
  lines.push(`Cover, in this order:`);
  if (isBuy) {
    lines.push(`1. One-line VERDICT — "BUY (executed)" — plus a one-line summary of the setup.`);
    lines.push(`2. Per-gate breakdown — for each gate in the CHECKS list, restate the gate, cite the actual vs threshold, and explain in 1-2 sentences what it tells you about the entry quality.`);
    lines.push(`3. ENTRY QUALITY SCORE (1-10) with a one-line justification — was this a textbook setup, a marginal one, or borderline?`);
    lines.push(`4. RISK FLAGS — anything in the snapshot that looks shaky (low ratio, weak trend, marginal RSI, etc.).`);
    lines.push(`5. WHAT TO WATCH NEXT — exit triggers the position monitor will use (RSI<30 stop, RSI≥70 trailing-stop).`);
  } else {
    lines.push(`1. One-line VERDICT — "SKIP (rejected)" — plus a one-line summary of which gate(s) blocked the trade.`);
    lines.push(`2. ROOT CAUSE — identify the failing gate(s) from the CHECKS list (passed=false), cite the actual vs threshold, and explain in 1-2 sentences why the threshold exists.`);
    lines.push(`3. Per-gate breakdown of every CHECKS entry — PASS/FAIL with a 1-sentence interpretation.`);
    lines.push(`4. REJECTION QUALITY (1-10) — was this a clear, correct skip, or a marginal one that might have been worth taking?`);
    lines.push(`5. WHAT WOULD HAVE FLIPPED IT — concrete trigger values (e.g. "if RSI had been 32 instead of 56, gate 3 would have passed").`);
  }
  lines.push("");
  lines.push(`Length: 250-450 words. Tone: direct, professional, no fluff.`);

  const prompt = lines.join("\n");
  const aiReport = await callGemini(prompt);

  const headerLines = [
    `🤖 AI Burst Analysis — ${normalised} (${isBuy ? "executed buy" : "rejected"})`,
    `Decided: ${tsStr}`,
  ];
  if (rec.price !== undefined) headerLines.push(`Price: $${rec.price}`);
  headerLines.push(`Reason: ${rec.reason || "n/a"}`);
  headerLines.push("─────────────────────");
  const text = `${headerLines.join("\n")}\n${aiReport}`;
  const html = renderBurstReportHtml({
    symbol: normalised,
    isBuy,
    tsStr,
    price: rec.price,
    reason: rec.reason,
    outcome: rec.outcome,
    params: rec.params,
    checks: rec.checks,
    aiReport,
  });
  return { text, html, isBuy };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Human-readable description of each burst-scanner gate. */
const GATE_MEANINGS: Record<string, string> = {
  min_gain_pct: "Asset must have pumped enough in the last 24h to qualify as a ‘burst’ candidate.",
  min_volume_usd: "Liquidity floor — ensures enough 24h volume to enter/exit without heavy slippage.",
  max_market_cap_rank: "Caps to top-N market-cap coins so we avoid illiquid micro-caps.",
  coinbase_allowlist: "Symbol must be tradable on Coinbase (the broker actually executing the order).",
  not_already_held: "No duplicate exposure — we never stack into a position we already own.",
  cooldown: "Per-symbol cooldown after a buy/exit to avoid churn and revenge entries.",
  rsi_oversold_entry: "Strategy buys oversold 3m RSI — the dip-buy gate. RSI must be below the buy ceiling.",
  rsi_turn_up: "Confirms RSI dipped into oversold and has started rising — entry timing filter.",
  trend_filter: "Price must be above the 1h EMA-200 — we only buy oversold dips inside an uptrend.",
  bid_ask_ratio: "Order-book pressure check — ensures bids outweigh asks at decision time.",
  order_book_pressure: "Order-book pressure must not be bearish (SELL / STRONG_SELL blocks entry).",
  "7d_trend": "7-day price change floor — rejects assets in a sustained multi-day downtrend.",
  ath_distance: "Must be at least this far below ATH — avoid buying tops where upside is capped.",
  fdv_mcap_ratio: "FDV/MarketCap ratio cap — rejects coins with heavy future-unlock dilution.",
  defi_category: "Hard exclusion — CoinGecko categories include ‘DeFi’; strategy avoids DeFi tokens.",
};

function gateMeaning(name: string): string {
  if (GATE_MEANINGS[name]) return GATE_MEANINGS[name];
  // Heuristic fallbacks for unknown gates
  if (name.startsWith("rsi")) return "RSI-based timing filter.";
  if (name.includes("volume")) return "Liquidity / volume threshold.";
  if (name.includes("cap")) return "Market-cap eligibility filter.";
  return "Strategy gate.";
}

/** Convert the plain-text AI report into nicely formatted HTML paragraphs.
 * Treats blank lines as paragraph breaks and lines that look like section
 * headers ("1. FOO — ", "FOO:", or all-caps phrases) as <h3>. */
function aiTextToHtml(text: string): string {
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split(/\n/);
    const first = lines[0].trim();
    const isHeader =
      /^\d+\.\s+[A-Z][^a-z]*?(?:\s+[—-]|:)/.test(first) ||
      /^[A-Z][A-Z0-9 &/()\-]{3,}:\s*$/.test(first);
    if (isHeader) {
      out.push(`<h3 style="margin:18px 0 6px;color:#1e3a8a;font-size:15px;">${escapeHtml(first.replace(/[:\-—\s]+$/, ""))}</h3>`);
      const rest = lines.slice(1).join(" ").trim();
      if (rest) out.push(`<p style="margin:0 0 8px;">${escapeHtml(rest).replace(/\n/g, "<br>")}</p>`);
    } else {
      out.push(`<p style="margin:0 0 10px;">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`);
    }
  }
  return out.join("\n");
}

function renderBurstReportHtml(args: {
  symbol: string;
  isBuy: boolean;
  tsStr: string;
  price?: number;
  reason?: string;
  outcome: string;
  params?: Record<string, unknown>;
  checks?: Array<{ name: string; passed: boolean; expression: string }>;
  aiReport: string;
}): string {
  const { symbol, isBuy, tsStr, price, reason, outcome, params, checks, aiReport } = args;
  const accent = isBuy ? "#15803d" : "#b91c1c";
  const badge = isBuy ? "BUY · executed" : "SKIP · rejected";
  const checksRows = (checks || []).map(c => {
    const color = c.passed ? "#15803d" : "#b91c1c";
    const label = c.passed ? "PASS" : "FAIL";
    return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-weight:600;vertical-align:top;">${escapeHtml(c.name)}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;color:${color};font-weight:700;vertical-align:top;">${label}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#444;vertical-align:top;">${escapeHtml(c.expression)}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#555;vertical-align:top;">${escapeHtml(gateMeaning(c.name))}</td></tr>`;
  }).join("");
  const paramRows = params && Object.keys(params).length > 0
    ? Object.entries(params).map(([k, v]) =>
      `<tr><td style="padding:3px 8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#444;">${escapeHtml(k)}</td><td style="padding:3px 8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#111;">${escapeHtml(JSON.stringify(v))}</td></tr>`
    ).join("")
    : "";
  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:760px;margin:0 auto;padding:24px;color:#222;line-height:1.55;background:#fff;">
  <div style="border-left:4px solid ${accent};padding:12px 16px;background:#f8fafc;margin-bottom:20px;">
    <div style="font-size:12px;color:#666;letter-spacing:0.5px;text-transform:uppercase;">AutoPac · Burst AI Analysis</div>
    <h1 style="margin:4px 0 6px;color:#1e3a8a;font-size:22px;">${escapeHtml(symbol)}</h1>
    <div style="display:inline-block;padding:3px 10px;background:${accent};color:#fff;font-weight:700;font-size:12px;border-radius:4px;letter-spacing:0.5px;">${badge}</div>
  </div>
  <table style="border-collapse:collapse;font-size:13px;margin-bottom:18px;">
    <tr><td style="padding:3px 12px 3px 0;color:#666;">Decided</td><td style="padding:3px 0;"><strong>${escapeHtml(tsStr)}</strong></td></tr>
    ${price !== undefined ? `<tr><td style="padding:3px 12px 3px 0;color:#666;">Price</td><td style="padding:3px 0;"><strong>$${escapeHtml(String(price))}</strong></td></tr>` : ""}
    <tr><td style="padding:3px 12px 3px 0;color:#666;">Outcome</td><td style="padding:3px 0;"><strong>${escapeHtml(outcome)}</strong></td></tr>
    <tr><td style="padding:3px 12px 3px 0;color:#666;vertical-align:top;">Reason</td><td style="padding:3px 0;">${escapeHtml(reason || "n/a")}</td></tr>
  </table>
  ${checksRows ? `<h2 style="font-size:15px;color:#1e3a8a;margin:18px 0 8px;">Gate Checks</h2><table style="border-collapse:collapse;width:100%;font-size:13px;"><thead><tr style="background:#f1f5f9;"><th style="text-align:left;padding:6px 8px;">Gate</th><th style="text-align:left;padding:6px 8px;width:60px;">Verdict</th><th style="text-align:left;padding:6px 8px;">Expression</th><th style="text-align:left;padding:6px 8px;">Meaning</th></tr></thead><tbody>${checksRows}</tbody></table>` : ""}
  ${paramRows ? `<h2 style="font-size:15px;color:#1e3a8a;margin:18px 0 8px;">Snapshot Params</h2><table style="border-collapse:collapse;width:100%;background:#fafafa;border:1px solid #eee;">${paramRows}</table>` : ""}
  <h2 style="font-size:15px;color:#1e3a8a;margin:22px 0 8px;border-top:1px solid #e5e7eb;padding-top:14px;">Gemini Analysis</h2>
  <div style="font-size:14px;">${aiTextToHtml(aiReport)}</div>
  <hr style="margin-top:28px;border:none;border-top:1px solid #ddd;">
  <div style="color:#888;font-size:11px;">Generated by AutoPac · Gemini ${escapeHtml(GEMINI_MODEL)} · timestamps in Seattle (America/Los_Angeles)</div>
</body></html>`;
}

/** @deprecated Use `analyzeStoredDecisionWithAI`. Kept for backwards compatibility. */
export const analyzeHistoricalBuyWithAI = analyzeStoredDecisionWithAI;
