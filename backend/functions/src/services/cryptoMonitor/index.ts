/**
 * Crypto buy-signal monitor.
 *
 * For each watchlist coin: collect data, score a diagnostic scorecard, evaluate
 * the separate strategies, persist a `coin_metrics` row + the run snapshot, and
 * notify the highest-priority strategy alert (per-strategy cooldown). On a fresh
 * STRONG_BUY alert it also auto-buys via executeOrder when `MONITOR_AUTO_BUY` is
 * on (DCA stack-cap + risk gated, ~$10; the global ORDER_PYRAMID flag does NOT
 * apply to the monitor). Other strategies are notify-only.
 */

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import crypto from "crypto";
import { sendTelegramMessage } from "../telegram";
import { sendCryptoBuyAlertNotification, sendCryptoBuyFailedNotification, sendTakeProfitSoldNotification } from "../notification";
import { getBroker } from "../../brokers";
import { CoinbaseBroker } from "../../brokers/coinbase";
import { getTradingConfig, TradingConfig } from "../../api/config";
import { executeOrder } from "../../api/trade";
import { logDecision } from "../decisionLog";
import { Signal } from "../../types";
import { loadWatchlistOverride, WatchCoin, DEFAULT_WATCHLIST } from "./watchlist";
import {
  fetchMarketRows, fetch7dAvgVolume, fetchHourlyCandles,
  fetchDefiMetrics, fetchNewsDataHeadlines, fetchGoogleHeadlines, mergeHeadlines, fetchMoversWatchlist, searchCoinGeckoId, CgMarketRow,
} from "./data";
import { scoreCoin, MarketRow, ScoreResult } from "./scoring";
import { formatBreakdown, formatBeginnerBreakdown, toPlainText } from "./format";
import {
  evaluateAll, selectAlert, StrategyResult, StrategyConfig, STRATEGY_DEFAULTS, STRATEGY_PRIORITY, AlertType,
  shouldStack, gainPct,
} from "./strategies";

const db = getFirestore();
const METRICS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Telegram is muted for the monitor (user request). Every proactive
// sendTelegramMessage call in this file was aliased to this no-op. The ONLY
// Telegram message we still send is the "DCA maxed out & still underwater"
// review alert — see alertStuckUnderwater(), which calls sendTelegramMessage
// directly. Mobile push (sendCryptoBuy*/sendTakeProfit*) is unaffected.
const tgMuted = async (_msg?: string): Promise<void> => {};

/** Throttle (per coin) for the "stuck at cap & underwater" Telegram review alert. */
const STUCK_ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000;

/**
 * Send the coin's analysis to Telegram when its DCA is "continuously failing" —
 * i.e. we've hit MONITOR_STACK_MAX_USD (can't stack more) but it's still below
 * average entry (underwater). Throttled per coin so it's a periodic review nudge,
 * not spam. This is the sole proactive Telegram message the monitor still sends.
 */
async function alertStuckUnderwater(coin: WatchCoin, result: ScoreResult, price: number, avg: number, cur: number, pct: number, capUsd: number, costBasis: number): Promise<void> {
  const stateRef = db.collection("monitor_state").doc(`${coin.symbol.toUpperCase()}__CAP_UNDERWATER`);
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

/** Merge an optional Firestore override (monitor_config/strategies) over the defaults. */
async function loadStrategyConfig(): Promise<StrategyConfig> {
  try {
    const snap = await db.collection("monitor_config").doc("strategies").get();
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
    logger.warn("[CRYPTO_MONITOR] strategy config read failed — using defaults", { error: String(err) });
  }
  return STRATEGY_DEFAULTS;
}

export interface MonitorRunResult {
  scanned: number;
  alerts: number;
  lines: string[];
}

/** The active universe: manual Firestore override, else Coinbase top movers (gainers + losers). */
export async function resolveWatchlist(): Promise<WatchCoin[]> {
  const override = await loadWatchlistOverride();
  if (override) return override;
  return fetchMoversWatchlist();
}

/** Resolve a single ticker to a WatchCoin (any coin, not just the universe). */
async function resolveCoinForSymbol(symbol: string): Promise<WatchCoin | null> {
  const want = symbol.toUpperCase().replace(/-USD.*$/, "");
  const known = DEFAULT_WATCHLIST.find(c => c.symbol.toUpperCase() === want || c.coinbaseProductId.toUpperCase() === symbol.toUpperCase());
  if (known) return known;
  const cgId = await searchCoinGeckoId(want);
  if (!cgId) return null;
  return { symbol: want, coinbaseProductId: `${want}-USD`, coingeckoId: cgId, defillama: DEFAULT_WATCHLIST.find(c => c.symbol.toUpperCase() === want)?.defillama };
}

/** Collect + score one coin (no persistence). Shared by the run loop and /coin. */
async function collectAndScore(
  coin: WatchCoin,
  marketRow: CgMarketRow | undefined,
  newsBySymbol: Map<string, { title: string }[]> | null
): Promise<{ result: ScoreResult; price: number }> {
  const [candles, vol7d, defi] = await Promise.all([
    fetchHourlyCandles(coin.coinbaseProductId),
    fetch7dAvgVolume(coin.coingeckoId),
    fetchDefiMetrics(coin.defillama),
  ]);

  // Aggregate multiple sources (newsdata.io + Google News), de-duped, for coverage.
  const fromNewsData = newsBySymbol?.get(coin.symbol.toUpperCase()) ?? [];
  const fromGoogle = await fetchGoogleHeadlines(coin.symbol);
  const headlines = mergeHeadlines(fromNewsData, fromGoogle);

  const row: MarketRow = {
    marketCapRank: marketRow?.market_cap_rank ?? null,
    volume24h: marketRow?.total_volume ?? 0,
    volume7dAvg: vol7d,
    change24hPct: marketRow?.price_change_percentage_24h_in_currency ?? 0,
    change7dPct: marketRow?.price_change_percentage_7d_in_currency ?? 0,
    tvlChange30dPct: defi.tvlChange30dPct,
    stablecoinInflow30dPct: defi.stablecoinInflow30dPct,
    revenueRising: defi.revenueRising,
  };

  const result = scoreCoin(candles, row, headlines);
  const price = candles.length ? candles[candles.length - 1].close : (marketRow?.current_price ?? 0);
  return { result, price };
}

/**
 * Run one monitoring pass.
 * @param opts.dryRun preview only — no Firestore writes, no alerts, no auto-buy
 *   (used by the Telegram /scan command). The scheduled run uses the default.
 */
export async function runCryptoMonitor(opts?: { onlySymbol?: string; notify?: boolean; dryRun?: boolean; forceBuy?: boolean; updatesCooldown?: boolean }): Promise<MonitorRunResult> {
  const notify = opts?.notify ?? true;
  const dryRun = opts?.dryRun ?? false;
  const forceBuy = opts?.forceBuy ?? false;
  const updatesCooldown = opts?.updatesCooldown ?? true; // scheduled runs consume cooldown; manual /scan does not
  const strategyCfg = await loadStrategyConfig();

  let watchlist: WatchCoin[];
  if (opts?.onlySymbol) {
    const coin = await resolveCoinForSymbol(opts.onlySymbol);
    watchlist = coin ? [coin] : [];
  } else {
    watchlist = await resolveWatchlist();
  }

  const tradingConfig = await getTradingConfig();

  // Position sweep (take-profit + DCA-on-dip) over ALL held Coinbase positions
  // (full scheduled runs only).
  if (!dryRun && !opts?.onlySymbol && tradingConfig.MONITOR_AUTO_BUY) {
    await runPositionSweep(tradingConfig, strategyCfg.cooldown_hours, notify).catch(async err => {
      logger.error("[CRYPTO_MONITOR] position sweep failed", { error: String(err) });
      if (notify) await tgMuted(`🚨 *Position sweep FAILED*\n${String(err).slice(0, 200)}`).catch(() => {});
    });
  }

  const [marketRows, newsBySymbol] = await Promise.all([
    fetchMarketRows(watchlist.map(c => c.coingeckoId)),
    fetchNewsDataHeadlines(watchlist.map(c => c.symbol)),
  ]);

  const lines: string[] = [];
  const runCoins: Record<string, unknown>[] = [];
  let alerts = 0;

  for (const coin of watchlist) {
    try {
      const cgRow = marketRows.get(coin.coingeckoId);
      const { result, price } = await collectAndScore(coin, cgRow, newsBySymbol);

      lines.push(`${coin.symbol}: ${result.category} (total ${result.total} — F${result.fundamental}/N${result.news}/T${result.technical})`);

      if (dryRun) {
        if (result.category !== "AVOID") alerts++; // count would-be alerts
        continue;
      }

      await db.collection("coin_metrics").add({
        symbol: coin.symbol,
        productId: coin.coinbaseProductId,
        timestamp: FieldValue.serverTimestamp(),
        price,
        volume24h: cgRow?.total_volume ?? 0,
        marketCapRank: cgRow?.market_cap_rank ?? null,
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

      // Capture per-coin result for the mobile "last run" view.
      runCoins.push({
        symbol: coin.symbol,
        productId: coin.coinbaseProductId,
        price,
        category: result.category, // diagnostic combined band
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

      if (forceBuy) {
        await autoBuy(coin, result, price, notify, tradingConfig, true, "FORCED test BUY").catch(err =>
          logger.error("[CRYPTO_MONITOR] forced buy failed", { symbol: coin.symbol, error: String(err) })
        );
        alerts++;
        continue;
      }

      const emitted = await notifyAlert(coin, result, selected, triggered, price, notify, updatesCooldown, strategyCfg.cooldown_hours);
      if (emitted) alerts++;

      // Auto-buy on a fresh STRONG_BUY alert (scheduled runs only, gated by MONITOR_AUTO_BUY).
      // A failure here must NOT be silent — alert loudly so a broken buy path is
      // visible immediately (this is what hid the stopLoss=undefined regression).
      if (emitted && selected?.name === "STRONG_BUY" && updatesCooldown && tradingConfig.MONITOR_AUTO_BUY) {
        await autoBuy(coin, result, price, notify, tradingConfig, true, "Auto-buy STRONG_BUY").catch(async err => {
          logger.error("[CRYPTO_MONITOR] auto-buy failed", { symbol: coin.symbol, error: String(err) });
          if (notify) {
            await tgMuted(`🚨 *Auto-buy FAILED* ${coin.symbol} (STRONG_BUY)\n${String(err).slice(0, 200)}`).catch(() => {});
            await sendCryptoBuyFailedNotification(coin.symbol, String(err)).catch(() => {});
          }
        });
      }
    } catch (err) {
      logger.warn("[CRYPTO_MONITOR] coin scoring failed", { symbol: coin.symbol, error: String(err) });
    }
  }

  // Persist the run snapshot for the mobile "last run" view — full universe runs only.
  if (!dryRun && !opts?.onlySymbol && runCoins.length > 0) {
    const rank = (a: string) => { const i = STRATEGY_PRIORITY.indexOf(a as AlertType); return i < 0 ? 99 : i; };
    runCoins.sort((a, b) =>
      (rank(a.alertType as string) - rank(b.alertType as string)) || ((b.total as number) - (a.total as number))
    );
    await db.collection("monitor_runs").add({
      runAt: FieldValue.serverTimestamp(),
      count: runCoins.length,
      coins: runCoins,
      expiresAt: Timestamp.fromMillis(Date.now() + METRICS_TTL_MS),
    }).catch(err => logger.warn("[CRYPTO_MONITOR] monitor_runs write failed", { error: String(err) }));
  }

  logger.info("[CRYPTO_MONITOR] run complete", { scanned: watchlist.length, alerts });
  return { scanned: watchlist.length, alerts, lines };
}

/** Read-only single-coin scoring for the Telegram drill-down. Works for any
 * ticker (not just the current universe): reuses a known mapping when available,
 * otherwise resolves the CoinGecko id by symbol. `detailed` returns the technical
 * check-by-check view; the default is the beginner-friendly summary. */
export async function explainCoin(symbol: string, detailed = false): Promise<string | null> {
  const coin = await resolveCoinForSymbol(symbol);
  if (!coin) return null;

  const [marketRows, newsBySymbol] = await Promise.all([fetchMarketRows([coin.coingeckoId]), fetchNewsDataHeadlines([coin.symbol])]);
  const { result, price } = await collectAndScore(coin, marketRows.get(coin.coingeckoId), newsBySymbol);
  return detailed ? formatBreakdown(coin, result, price) : formatBeginnerBreakdown(coin, result, price);
}

/**
 * Notify the selected strategy alert (notify-only; no auto-buy). Per-strategy
 * cooldown keyed by `symbol__strategy`. FUNDAMENTAL_WATCH is informational and
 * never push-notifies (stored only). Manual scans pass updatesCooldown=false so
 * they don't consume the scheduled notification cooldown.
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
  // Only actionable alerts + RISK_BLOCK are notifiable; FUNDAMENTAL_WATCH-only is informational.
  if (!selected || selected.name === "FUNDAMENTAL_WATCH") return false;

  const now = Date.now();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const stateRef = db.collection("monitor_state").doc(`${coin.symbol.toUpperCase()}__${selected.name}`);
  const prev = (await stateRef.get()).data() as { lastAlertAtMs?: number } | undefined;
  const cooled = !prev?.lastAlertAtMs || now - prev.lastAlertAtMs >= cooldownMs;
  if (!cooled) return false;

  await db.collection("crypto_alerts").add({
    symbol: coin.symbol,
    productId: coin.coinbaseProductId,
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
    // Mobile push is reserved for STRONG_BUY only (other alert types stay
    // Telegram-only). Buy-failure and take-profit-sell pushes fire elsewhere.
    if (selected.name === "STRONG_BUY") {
      await sendCryptoBuyAlertNotification(coin.symbol, selected.name, result.total, selected.reasons).catch(() => {});
    }
  }
  return true;
}

/** Resolve + score a single held coin (no persistence) so the sweep can check
 * for major-bearish news before DCAing into a dip. Returns null if the ticker
 * can't be resolved/scored. Mirrors explainCoin's data path. */
async function scoreHeldCoin(symbol: string): Promise<{ coin: WatchCoin; result: ScoreResult; price: number } | null> {
  const coin = await resolveCoinForSymbol(symbol);
  if (!coin) return null;
  const [marketRows, newsBySymbol] = await Promise.all([
    fetchMarketRows([coin.coingeckoId]),
    fetchNewsDataHeadlines([coin.symbol]),
  ]);
  const { result, price } = await collectAndScore(coin, marketRows.get(coin.coingeckoId), newsBySymbol);
  return { coin, result, price };
}

/**
 * Sweep over every held Coinbase position once per scheduled run:
 *   • take-profit  — sell when ≥ MONITOR_TAKE_PROFIT_PCT above average entry;
 *   • DCA-on-dip   — buy another tranche when ≤ MONITOR_DCA_DIP_PCT below average
 *                    entry, guarded by the $100 stack cap (in autoBuy), a
 *                    re-scored major-bearish-news check, and a per-coin cooldown.
 * Measured vs average entry, so each dip-buy lowers the average and the next
 * trigger requires a further drop — the rule is naturally self-spacing.
 */
async function runPositionSweep(cfg: TradingConfig, cooldownHours: number, notify: boolean): Promise<void> {
  const broker = getBroker("coinbase") as CoinbaseBroker;
  const positions = await broker.getDetailedPositions();
  for (const p of positions) {
    const avg = parseFloat(String(p.avg_entry_price) || "0");
    const cur = parseFloat(String(p.current_price) || "0");
    const pct = gainPct(avg, cur);
    if (pct == null) continue;
    const symbol = String(p.symbol);

    // Take-profit: sell when far enough above entry.
    if (pct >= cfg.MONITOR_TAKE_PROFIT_PCT) {
      try {
        const result = await broker.liquidatePosition(symbol);
        logger.info("[CRYPTO_MONITOR] take-profit sold", { symbol, pct: pct.toFixed(2) });
        await logDecision({
          source: "auto_approve",
          outcome: "ACCEPTED",
          action: "SELL",
          symbol,
          price: cur,
          reason: `Take-profit +${pct.toFixed(2)}% ≥ ${cfg.MONITOR_TAKE_PROFIT_PCT}%`,
          expression: `(${cur} - ${avg}) / ${avg} = +${pct.toFixed(2)}%`,
          params: { result },
        });
        if (notify) {
          await tgMuted(`💰 *Take-profit SOLD* ${symbol} +${pct.toFixed(2)}% (entry ${avg}, now ${cur})`).catch(() => {});
          await sendTakeProfitSoldNotification(symbol, pct, avg, cur).catch(() => {});
        }
      } catch (err) {
        logger.error("[CRYPTO_MONITOR] take-profit sell failed", { symbol, error: String(err) });
        if (notify) await tgMuted(`❌ *Take-profit sell failed* ${symbol}: ${String(err).slice(0, 150)}`).catch(() => {});
      }
      continue;
    }

    // DCA-on-dip: buy more when far enough BELOW average entry.
    if (cfg.MONITOR_DCA_DIP_PCT > 0 && pct <= -cfg.MONITOR_DCA_DIP_PCT) {
      await dcaDip(symbol, cur, avg, pct, cfg, cooldownHours, notify).catch(async err => {
        logger.error("[CRYPTO_MONITOR] DCA dip-buy failed", { symbol, error: String(err) });
        if (notify) await tgMuted(`🚨 *DCA dip-buy FAILED* ${symbol}\n${String(err).slice(0, 200)}`).catch(() => {});
      });
    }
  }
}

/** DCA another tranche into a held coin that has dropped ≥ MONITOR_DCA_DIP_PCT
 * below average entry. Skips a major-bearish catalyst (don't average into a
 * hack/lawsuit/etc.); the $100 stack cap is enforced inside autoBuy. A per-coin
 * cooldown keeps a sustained drop from buying on every 5-min run. */
async function dcaDip(symbol: string, cur: number, avg: number, pct: number, cfg: TradingConfig, cooldownHours: number, notify: boolean): Promise<void> {
  const stateRef = db.collection("monitor_state").doc(`${symbol.toUpperCase()}__DCA_DIP`);
  const now = Date.now();
  const prev = (await stateRef.get()).data() as { lastAlertAtMs?: number } | undefined;
  if (prev?.lastAlertAtMs && now - prev.lastAlertAtMs < cooldownHours * 60 * 60 * 1000) return;

  const scored = await scoreHeldCoin(symbol);
  if (!scored) {
    logger.warn("[CRYPTO_MONITOR] DCA dip skipped — could not score", { symbol });
    return;
  }
  if (scored.result.majorBearish) {
    logger.info("[CRYPTO_MONITOR] DCA dip skipped — major bearish news", { symbol, pct: pct.toFixed(2) });
    if (notify) await tgMuted(`⏸ *DCA dip skipped* ${symbol} ${pct.toFixed(1)}% — major bearish news, not averaging down`).catch(() => {});
    return;
  }

  // Claim the cooldown before buying so a retry/double-tick can't double-buy.
  await stateRef.set({ lastAlertAtMs: now, lastAlertType: "DCA_DIP" }, { merge: true });
  await autoBuy(scored.coin, scored.result, cur, notify, cfg, true, `DCA dip buy ${pct.toFixed(1)}% below entry`);
}

/**
 * Place a buy for the monitor. Gating is the DCA stack cap (MONITOR_STACK_MAX_USD)
 * + executeOrder's risk checks only — the global ORDER_PYRAMID flag is NOT
 * consulted here, so stacking works regardless of its value. `execute`
 * decides whether to actually place the order (else store a PENDING signal).
 * Used by the scheduled STRONG_BUY auto-buy (gated by MONITOR_AUTO_BUY) and the
 * `/scan <sym> live force` manual test.
 */
async function autoBuy(coin: WatchCoin, result: ScoreResult, price: number, notify: boolean, cfg: TradingConfig, execute = false, tag = "Crypto monitor BUY"): Promise<void> {
  const tradeValueUsd = cfg.brokerSettings?.coinbase?.tradeValueUsd || cfg.TRADE_VALUE_USD;

  // DCA stacking: buy $X each time, up to MONITOR_STACK_MAX_USD invested per coin.
  try {
    const positions = await (getBroker("coinbase") as CoinbaseBroker).getDetailedPositions();
    const pos = positions.find(p => String(p.symbol).toUpperCase() === coin.coinbaseProductId.toUpperCase());
    const costBasis = pos ? parseFloat(String(pos.cost_basis) || "0") : 0;
    if (!shouldStack(costBasis, tradeValueUsd, cfg.MONITOR_STACK_MAX_USD)) {
      logger.info("[CRYPTO_MONITOR] stack cap reached — skipping", { symbol: coin.symbol, costBasis, max: cfg.MONITOR_STACK_MAX_USD });
      // DCA is "continuously failing": at the cap but still underwater → Telegram review.
      if (notify && pos) {
        const avg = parseFloat(String(pos.avg_entry_price) || "0");
        const cur = parseFloat(String(pos.current_price) || "0");
        const pct = gainPct(avg, cur);
        if (pct != null && pct < 0) await alertStuckUnderwater(coin, result, price, avg, cur, pct, cfg.MONITOR_STACK_MAX_USD, costBasis).catch(() => {});
      }
      return;
    }
  } catch (err) {
    logger.warn("[CRYPTO_MONITOR] stack check failed, allowing buy", { symbol: coin.symbol, error: String(err) });
  }

  const entryPrice = price > 0 ? price : 0;
  const buySignal: Signal = {
    strategy: "crypto-monitor",
    symbol: coin.coinbaseProductId,
    action: "BUY",
    timeframe: "1h",
    price: entryPrice,
    status: "PENDING",
    broker: "coinbase",
    signalTime: new Date().toISOString(),
    // No stop-loss: the monitor's strategy is DCA-down + take-profit at
    // MONITOR_TAKE_PROFIT_PCT. A tight global STOP_LOSS_PCT (0.5%) stop would
    // instantly stop out volatile coins (this is what "liquidated" 2Z) and
    // contradicts stacking into dips. The `stopLoss` field is OMITTED entirely
    // (not set to `undefined`) — Firestore rejects documents with explicit
    // `undefined` values, which silently failed every auto-buy's signals.add().
    strongBuy: true,
    idempotencyKey: crypto.createHash("sha256").update(`crypto-monitor:${coin.symbol}:${Date.now()}`).digest("hex").slice(0, 32),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const ref = await db.collection("signals").add(buySignal);
  buySignal.id = ref.id;

  await logDecision({
    source: "auto_approve",
    outcome: "ACCEPTED",
    action: "BUY",
    symbol: coin.coinbaseProductId,
    price: entryPrice,
    reason: `${tag} (score ${result.total})`,
    expression: `F${result.fundamental}/N${result.news}/T${result.technical} → ${result.total}`,
    signalId: ref.id,
  });

  if (execute) {
    const res = await executeOrder(buySignal, "crypto-monitor");
    if (notify) {
      await tgMuted(
        res.status === "executed"
          ? `✅ *${tag}* ${coin.symbol} @ ${entryPrice} (score ${result.total})`
          : `❌ *${tag} not executed* ${coin.symbol}\nexecuteOrder: ${res.status}`
      ).catch(() => {});
    }
  } else if (notify) {
    await tgMuted(`⏸ *${tag} stored* ${coin.symbol} @ ${entryPrice}\nmanual approval required`).catch(() => {});
  }
}

