/**
 * Stock buy-signal monitor — the equity counterpart of the crypto monitor.
 *
 * Reuses the asset-agnostic scoring/strategies/format core and swaps the data
 * layer to Alpaca (basic / IEX), the broker to `alpaca`, the Firestore
 * collections to `stock_*`, and the config to `STOCK_MONITOR_*`. Runs every 5
 * min while the US market (incl. the 24/5 overnight session) is open; scores a
 * curated watchlist, emits the highest-priority strategy alert, and on a fresh
 * STRONG_BUY auto-buys via Alpaca with DCA stacking, take-profit, and dip-buys.
 *
 * No fundamentals on Alpaca basic — the "fundamental" score is a relative-volume
 * proxy only; technical + news carry the signal.
 */

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import crypto from "crypto";
import { sendTelegramMessage } from "../telegram";
import { sendCryptoBuyAlertNotification, sendCryptoBuyFailedNotification, sendTakeProfitSoldNotification } from "../notification";
import { getBroker } from "../../brokers";
import { AlpacaBroker } from "../../brokers/alpaca";
import { getTradingConfig, TradingConfig } from "../../api/config";
import { executeOrder } from "../../api/trade";
import { logDecision } from "../decisionLog";
import { Signal } from "../../types";
import { isUsStockMarketOpen } from "../marketHours";
import { resolveStockWatchlist } from "./watchlist";
import { fetchStockSnapshots, fetchDailyBars, fetchAlpacaNews, buildMarketRow, StockSnapshot } from "./data";
import { scoreCoin, ScoreResult, NewsHeadline } from "../cryptoMonitor/scoring";
import { WatchCoin } from "../cryptoMonitor/watchlist";
import { formatBreakdown, formatBeginnerBreakdown, toPlainText } from "../cryptoMonitor/format";
import {
  evaluateAll, selectAlert, StrategyResult, StrategyConfig, STRATEGY_DEFAULTS, STRATEGY_PRIORITY, AlertType,
  shouldStack, gainPct, shouldDcaDip,
} from "../cryptoMonitor/strategies";

const db = getFirestore();
const METRICS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Telegram is muted for the monitor (user request). Every proactive
// sendTelegramMessage call in this file was aliased to this no-op. The ONLY
// Telegram message we still send is the "DCA maxed out & still underwater"
// review alert — see alertStuckUnderwater(). Mobile push is unaffected.
const tgMuted = async (_msg?: string): Promise<void> => {};

/** Throttle (per stock) for the "stuck at cap & underwater" Telegram review alert. */
const STUCK_ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000;

/**
 * Send the stock's analysis to Telegram when its DCA is "continuously failing" —
 * we've hit STOCK_MONITOR_STACK_MAX_USD (can't stack more) but it's still below
 * average entry. Throttled per stock. Sole proactive Telegram message we send.
 */
async function alertStuckUnderwater(coin: WatchCoin, result: ScoreResult, price: number, avg: number, cur: number, pct: number, capUsd: number, costBasis: number): Promise<void> {
  const stateRef = db.collection("stock_monitor_state").doc(`${coin.symbol.toUpperCase()}__CAP_UNDERWATER`);
  const now = Date.now();
  const prev = (await stateRef.get()).data() as { lastAlertAtMs?: number } | undefined;
  if (prev?.lastAlertAtMs && now - prev.lastAlertAtMs < STUCK_ALERT_THROTTLE_MS) return;
  await stateRef.set({ lastAlertAtMs: now }, { merge: true });

  const header =
    `🔴 *DCA maxed out & still underwater* — ${coin.symbol}\n` +
    `Invested ~$${costBasis.toFixed(0)} (cap $${capUsd}) · avg entry ${avg} · now ${cur} · *${pct.toFixed(1)}%*\n` +
    `Can't average down further. Review whether to hold or cut:\n\n`;
  await sendTelegramMessage(header + formatBeginnerBreakdown(coin, result, price)).catch(() => {});
}

/** A ticker rendered as the WatchCoin shape so the shared format/scoring code works. */
function tickerToCoin(symbol: string): WatchCoin {
  const s = symbol.toUpperCase();
  return { symbol: s, coinbaseProductId: s, coingeckoId: s };
}

/** Merge an optional Firestore override (monitor_config/stock_strategies) over the defaults. */
async function loadStrategyConfig(): Promise<StrategyConfig> {
  try {
    const snap = await db.collection("monitor_config").doc("stock_strategies").get();
    const override = snap.data();
    if (override) {
      const defaults = STRATEGY_DEFAULTS as unknown as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...defaults };
      for (const [k, v] of Object.entries(override)) {
        if (v && typeof v === "object" && !Array.isArray(v)) merged[k] = { ...(defaults[k] as object), ...(v as object) };
        else merged[k] = v;
      }
      return merged as unknown as StrategyConfig;
    }
  } catch (err) {
    logger.warn("[STOCK_MONITOR] strategy config read failed — using defaults", { error: String(err) });
  }
  return STRATEGY_DEFAULTS;
}

export interface StockMonitorRunResult {
  scanned: number;
  alerts: number;
  lines: string[];
  skipped?: "market_closed";
}

/** Collect + score one stock (no persistence). Shared by the run loop and drill-down. */
async function collectAndScore(
  symbol: string,
  snapshot: StockSnapshot | undefined,
  newsBySymbol: Map<string, NewsHeadline[]> | null,
): Promise<{ result: ScoreResult; price: number }> {
  const bars = await fetchDailyBars(symbol);
  const headlines = newsBySymbol?.get(symbol.toUpperCase()) ?? [];
  const row = buildMarketRow(snapshot, bars);
  const result = scoreCoin(bars, row, headlines);
  const price = bars.length ? bars[bars.length - 1].close : (snapshot?.price ?? 0);
  return { result, price };
}

/**
 * Run one stock monitoring pass.
 * @param opts.dryRun preview only — no writes/alerts/auto-buy.
 * @param opts.onlySymbol score a single ticker (ignores the market-hours gate).
 */
export async function runStockMonitor(opts?: { onlySymbol?: string; notify?: boolean; dryRun?: boolean; updatesCooldown?: boolean }): Promise<StockMonitorRunResult> {
  const notify = opts?.notify ?? true;
  const dryRun = opts?.dryRun ?? false;
  const updatesCooldown = opts?.updatesCooldown ?? true;

  // Market-hours gate — skip full scheduled runs when equities aren't tradeable.
  if (!opts?.onlySymbol && !isUsStockMarketOpen()) {
    logger.info("[STOCK_MONITOR] market closed — skipping run");
    return { scanned: 0, alerts: 0, lines: [], skipped: "market_closed" };
  }

  const strategyCfg = await loadStrategyConfig();
  const symbols = opts?.onlySymbol ? [opts.onlySymbol.toUpperCase()] : await resolveStockWatchlist();
  const tradingConfig = await getTradingConfig();

  // Position sweep (take-profit + DCA-on-dip) over held Alpaca equities.
  if (!dryRun && !opts?.onlySymbol && tradingConfig.STOCK_MONITOR_AUTO_BUY) {
    await runPositionSweep(tradingConfig, strategyCfg, notify).catch(async err => {
      logger.error("[STOCK_MONITOR] position sweep failed", { error: String(err) });
      if (notify) await tgMuted(`🚨 *Stock position sweep FAILED*\n${String(err).slice(0, 200)}`).catch(() => {});
    });
  }

  const [snapshots, newsBySymbol] = await Promise.all([
    fetchStockSnapshots(symbols),
    fetchAlpacaNews(symbols),
  ]);

  const lines: string[] = [];
  const runCoins: Record<string, unknown>[] = [];
  let alerts = 0;

  for (const symbol of symbols) {
    try {
      const coin = tickerToCoin(symbol);
      const { result, price } = await collectAndScore(symbol, snapshots.get(symbol), newsBySymbol);

      lines.push(`${symbol}: ${result.category} (total ${result.total} — F${result.fundamental}/N${result.news}/T${result.technical})`);
      if (dryRun) { if (result.category !== "AVOID") alerts++; continue; }

      await db.collection("stock_metrics").add({
        symbol,
        productId: symbol,
        timestamp: FieldValue.serverTimestamp(),
        price,
        volume24h: snapshots.get(symbol)?.volume24h ?? 0,
        rsi: result.rsi,
        ema20: result.ema20,
        ema50: result.ema50,
        ema200: result.ema200,
        fundamentalScore: result.fundamental,
        technicalScore: result.technical,
        newsScore: result.news,
        totalScore: result.total,
        category: result.category,
        expiresAt: Timestamp.fromMillis(Date.now() + METRICS_TTL_MS),
      });

      const { selected, triggered } = selectAlert(evaluateAll(result, strategyCfg));

      runCoins.push({
        symbol,
        productId: symbol,
        price,
        category: result.category,
        alertType: selected?.name ?? "NONE",
        strategies: triggered.map(s => s.name),
        majorBearish: result.majorBearish,
        total: result.total,
        fundamental: result.fundamental,
        news: result.news,
        technical: result.technical,
        friendly: toPlainText(formatBeginnerBreakdown(coin, result, price)),
        full: toPlainText(formatBreakdown(coin, result, price)),
      });

      const emitted = await notifyAlert(coin, result, selected, triggered, price, notify, updatesCooldown, strategyCfg.cooldown_hours);
      if (emitted) alerts++;

      // Auto-buy on a fresh STRONG_BUY (loud on failure — never silent).
      if (emitted && selected?.name === "STRONG_BUY" && updatesCooldown && tradingConfig.STOCK_MONITOR_AUTO_BUY) {
        await autoBuy(coin, result, price, notify, tradingConfig, true, "Auto-buy STRONG_BUY").catch(async err => {
          logger.error("[STOCK_MONITOR] auto-buy failed", { symbol, error: String(err) });
          if (notify) {
            await tgMuted(`🚨 *Stock auto-buy FAILED* ${symbol} (STRONG_BUY)\n${String(err).slice(0, 200)}`).catch(() => {});
            await sendCryptoBuyFailedNotification(symbol, String(err)).catch(() => {});
          }
        });
      }
    } catch (err) {
      logger.warn("[STOCK_MONITOR] stock scoring failed", { symbol, error: String(err) });
    }
  }

  if (!dryRun && !opts?.onlySymbol && runCoins.length > 0) {
    const rank = (a: string) => { const i = STRATEGY_PRIORITY.indexOf(a as AlertType); return i < 0 ? 99 : i; };
    runCoins.sort((a, b) => (rank(a.alertType as string) - rank(b.alertType as string)) || ((b.total as number) - (a.total as number)));
    await db.collection("stock_monitor_runs").add({
      runAt: FieldValue.serverTimestamp(),
      count: runCoins.length,
      coins: runCoins,
      expiresAt: Timestamp.fromMillis(Date.now() + METRICS_TTL_MS),
    }).catch(err => logger.warn("[STOCK_MONITOR] stock_monitor_runs write failed", { error: String(err) }));
  }

  logger.info("[STOCK_MONITOR] run complete", { scanned: symbols.length, alerts });
  return { scanned: symbols.length, alerts, lines };
}

/** Read-only single-ticker scoring (for a Telegram drill-down / testing). */
export async function explainStock(symbol: string, detailed = false): Promise<string | null> {
  const sym = symbol.toUpperCase();
  const coin = tickerToCoin(sym);
  const [snapshots, newsBySymbol] = await Promise.all([fetchStockSnapshots([sym]), fetchAlpacaNews([sym])]);
  const { result, price } = await collectAndScore(sym, snapshots.get(sym), newsBySymbol);
  return detailed ? formatBreakdown(coin, result, price) : formatBeginnerBreakdown(coin, result, price);
}

/**
 * Notify the selected strategy alert. Per-strategy cooldown keyed in
 * `stock_monitor_state`. FUNDAMENTAL_WATCH is informational (stored only).
 */
async function notifyAlert(
  coin: WatchCoin,
  result: ScoreResult,
  selected: StrategyResult | null,
  triggered: StrategyResult[],
  price: number,
  notify: boolean,
  updatesCooldown: boolean,
  cooldownHours: number,
): Promise<boolean> {
  if (!selected || selected.name === "FUNDAMENTAL_WATCH") return false;

  const now = Date.now();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const stateRef = db.collection("stock_monitor_state").doc(`${coin.symbol.toUpperCase()}__${selected.name}`);
  const prev = (await stateRef.get()).data() as { lastAlertAtMs?: number } | undefined;
  const cooled = !prev?.lastAlertAtMs || now - prev.lastAlertAtMs >= cooldownMs;
  if (!cooled) return false;

  await db.collection("stock_alerts").add({
    symbol: coin.symbol,
    productId: coin.symbol,
    alertType: selected.name,
    category: result.category,
    strategies: triggered.map(s => s.name),
    score: result.total,
    fundamental: result.fundamental,
    news: result.news,
    technical: result.technical,
    majorBearish: result.majorBearish,
    reasons: selected.reasons,
    risks: selected.risks,
    action: selected.action,
    checks: result.checks,
    price,
    createdAt: FieldValue.serverTimestamp(),
  });

  if (updatesCooldown) {
    await stateRef.set({ lastAlertAtMs: now, lastAlertType: selected.name }, { merge: true });
  }

  if (notify) {
    await tgMuted(formatBeginnerBreakdown(coin, result, price)).catch(() => {});
    if (selected.name === "STRONG_BUY") {
      await sendCryptoBuyAlertNotification(coin.symbol, selected.name, result.total, selected.reasons).catch(() => {});
    }
  }
  return true;
}

/** Resolve + score a held stock so the sweep can avoid DCAing into bad news. */
async function scoreHeldStock(symbol: string): Promise<{ coin: WatchCoin; result: ScoreResult; price: number } | null> {
  const sym = symbol.toUpperCase();
  const [snapshots, newsBySymbol] = await Promise.all([fetchStockSnapshots([sym]), fetchAlpacaNews([sym])]);
  const { result, price } = await collectAndScore(sym, snapshots.get(sym), newsBySymbol);
  return { coin: tickerToCoin(sym), result, price };
}

/**
 * Sweep held Alpaca equities once per run: take-profit ≥ STOCK_MONITOR_TAKE_PROFIT_PCT
 * above avg entry; DCA-on-dip ≤ STOCK_MONITOR_DCA_DIP_PCT below avg entry, gated by
 * the shouldDcaDip rules (trend intact, technical floor, no major bearish news,
 * price ladder vs the last tranche, dedicated cooldown) + the stack cap in autoBuy.
 * Crypto positions are ignored.
 */
async function runPositionSweep(cfg: TradingConfig, strategyCfg: StrategyConfig, notify: boolean): Promise<void> {
  const broker = getBroker("alpaca") as AlpacaBroker;
  const positions = await broker.getDetailedPositions();
  for (const p of positions) {
    if (p.asset_class && p.asset_class !== "us_equity") continue; // equities only
    const avg = parseFloat(String(p.avg_entry_price) || "0");
    const cur = parseFloat(String(p.current_price) || "0");
    const pct = gainPct(avg, cur);
    if (pct == null) continue;
    const symbol = String(p.symbol);

    if (pct >= cfg.STOCK_MONITOR_TAKE_PROFIT_PCT) {
      try {
        const result = await broker.liquidatePosition(symbol);
        logger.info("[STOCK_MONITOR] take-profit sold", { symbol, pct: pct.toFixed(2) });
        await logDecision({
          source: "auto_approve", outcome: "ACCEPTED", action: "SELL", symbol, price: cur,
          reason: `Take-profit +${pct.toFixed(2)}% ≥ ${cfg.STOCK_MONITOR_TAKE_PROFIT_PCT}%`,
          expression: `(${cur} - ${avg}) / ${avg} = +${pct.toFixed(2)}%`,
          params: { result },
        });
        if (notify) {
          await tgMuted(`💰 *Stock take-profit SOLD* ${symbol} +${pct.toFixed(2)}% (entry ${avg}, now ${cur})`).catch(() => {});
          await sendTakeProfitSoldNotification(symbol, pct, avg, cur).catch(() => {});
        }
      } catch (err) {
        logger.error("[STOCK_MONITOR] take-profit sell failed", { symbol, error: String(err) });
        if (notify) await tgMuted(`❌ *Stock take-profit sell failed* ${symbol}: ${String(err).slice(0, 150)}`).catch(() => {});
      }
      continue;
    }

    if (cfg.STOCK_MONITOR_DCA_DIP_PCT > 0 && pct <= -cfg.STOCK_MONITOR_DCA_DIP_PCT) {
      await dcaDip(symbol, cur, pct, cfg, strategyCfg.dca_dip, notify).catch(err => {
        logger.error("[STOCK_MONITOR] DCA dip-buy failed", { symbol, error: String(err) });
      });
    }
  }
}

/** DCA another tranche into a held stock that has dropped enough below avg entry.
 * Gated by shouldDcaDip (trend intact, technical floor, no major-bearish news,
 * ≥min_drop_step_pct below the LAST tranche) plus a dedicated dip cooldown. */
async function dcaDip(symbol: string, cur: number, pct: number, cfg: TradingConfig, dipCfg: StrategyConfig["dca_dip"], notify: boolean): Promise<void> {
  const stateRef = db.collection("stock_monitor_state").doc(`${symbol.toUpperCase()}__DCA_DIP`);
  const now = Date.now();
  const prev = (await stateRef.get()).data() as { lastAlertAtMs?: number; lastBuyPrice?: number } | undefined;
  if (prev?.lastAlertAtMs && now - prev.lastAlertAtMs < dipCfg.cooldown_hours * 60 * 60 * 1000) return;

  const scored = await scoreHeldStock(symbol);
  if (!scored) { logger.warn("[STOCK_MONITOR] DCA dip skipped — could not score", { symbol }); return; }

  const verdict = shouldDcaDip(
    {
      pct,
      currentPrice: cur,
      lastDipBuyPrice: prev?.lastBuyPrice ?? null,
      priceAboveEma200: scored.result.priceAboveEma200,
      technical: scored.result.technical,
      majorBearish: scored.result.majorBearish,
    },
    dipCfg,
    cfg.STOCK_MONITOR_DCA_DIP_PCT,
  );
  if (!verdict.buy) {
    logger.info("[STOCK_MONITOR] DCA dip skipped", { symbol, pct: pct.toFixed(2), reason: verdict.reason });
    return;
  }

  // Claim the cooldown + ladder reference BEFORE buying (double-tick protection).
  await stateRef.set({ lastAlertAtMs: now, lastAlertType: "DCA_DIP", lastBuyPrice: cur }, { merge: true });
  await autoBuy(scored.coin, scored.result, cur, notify, cfg, true, `DCA dip buy ${pct.toFixed(1)}% below entry`);
}

/**
 * Place a stock buy for the monitor. Gating is the DCA stack cap
 * (STOCK_MONITOR_STACK_MAX_USD) + executeOrder's risk checks. Each tranche is
 * sized from brokerSettings.alpaca.tradeValueUsd. No stop-loss (DCA + take-profit).
 */
async function autoBuy(coin: WatchCoin, result: ScoreResult, price: number, notify: boolean, cfg: TradingConfig, execute = false, tag = "Stock monitor BUY"): Promise<void> {
  const tradeValueUsd = cfg.brokerSettings?.alpaca?.tradeValueUsd || cfg.TRADE_VALUE_USD;

  try {
    const positions = await (getBroker("alpaca") as AlpacaBroker).getDetailedPositions();
    const pos = positions.find(p => String(p.symbol).toUpperCase() === coin.symbol.toUpperCase());
    const costBasis = pos ? parseFloat(String(pos.cost_basis) || "0") : 0;
    if (!shouldStack(costBasis, tradeValueUsd, cfg.STOCK_MONITOR_STACK_MAX_USD)) {
      logger.info("[STOCK_MONITOR] stack cap reached — skipping", { symbol: coin.symbol, costBasis, max: cfg.STOCK_MONITOR_STACK_MAX_USD });
      // DCA is "continuously failing": at the cap but still underwater → Telegram review.
      if (notify && pos) {
        const avg = parseFloat(String(pos.avg_entry_price) || "0");
        const cur = parseFloat(String(pos.current_price) || "0");
        const pct = gainPct(avg, cur);
        if (pct != null && pct < 0) await alertStuckUnderwater(coin, result, price, avg, cur, pct, cfg.STOCK_MONITOR_STACK_MAX_USD, costBasis).catch(() => {});
      }
      return;
    }
  } catch (err) {
    logger.warn("[STOCK_MONITOR] stack check failed, allowing buy", { symbol: coin.symbol, error: String(err) });
  }

  const entryPrice = price > 0 ? price : 0;
  const buySignal: Signal = {
    strategy: "stock-monitor",
    symbol: coin.symbol,
    action: "BUY",
    timeframe: "1d",
    price: entryPrice,
    status: "PENDING",
    broker: "alpaca",
    signalTime: new Date().toISOString(),
    // No stop-loss — exits are the take-profit + DCA-into-dips (cap-bounded).
    strongBuy: true,
    idempotencyKey: crypto.createHash("sha256").update(`stock-monitor:${coin.symbol}:${Date.now()}`).digest("hex").slice(0, 32),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await db.collection("signals").add(buySignal);
  buySignal.id = ref.id;

  await logDecision({
    source: "auto_approve", outcome: "ACCEPTED", action: "BUY", symbol: coin.symbol, price: entryPrice,
    reason: `${tag} (score ${result.total})`,
    expression: `F${result.fundamental}/N${result.news}/T${result.technical} → ${result.total}`,
    signalId: ref.id,
  });

  if (execute) {
    const res = await executeOrder(buySignal, "stock-monitor");
    if (notify) {
      await tgMuted(
        res.status === "executed"
          ? `✅ *${tag}* ${coin.symbol} @ ${entryPrice} (score ${result.total})`
          : `❌ *${tag} not executed* ${coin.symbol}\nexecuteOrder: ${res.status}`
      ).catch(() => {});
    }
  }
}
