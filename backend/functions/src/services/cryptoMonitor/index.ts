/**
 * Crypto buy-signal monitor (Phase 2).
 *
 * For each watchlist coin: collect Coinbase candles + CoinGecko market row +
 * DefiLlama fundamentals + CoinGecko/Google news, score (fundamental + news +
 * technical), persist a `coin_metrics` row, and — when a coin scores into
 * STRONG_BUY/WATCHLIST and is not in cooldown — write a `crypto_alerts` row and
 * notify (Telegram + push). On STRONG_BUY it also places a buy via the existing
 * executeOrder flow (gated by AUTO_APPROVE + pyramid).
 */

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import crypto from "crypto";
import { sendTelegramMessage } from "../telegram";
import { sendCryptoBuyAlertNotification } from "../notification";
import { getBroker } from "../../brokers";
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
} from "./strategies";

const db = getFirestore();
const METRICS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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
        await autoBuy(coin, result, price, notify, tradingConfig, true).catch(err =>
          logger.error("[CRYPTO_MONITOR] forced buy failed", { symbol: coin.symbol, error: String(err) })
        );
        alerts++;
        continue;
      }

      const emitted = await notifyAlert(coin, result, selected, triggered, price, notify, updatesCooldown, strategyCfg.cooldown_hours);
      if (emitted) alerts++;
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
    await sendTelegramMessage(formatBeginnerBreakdown(coin, result, price)).catch(() => {});
    if (selected.name !== "RISK_BLOCK") {
      await sendCryptoBuyAlertNotification(coin.symbol, selected.name, result.total, selected.reasons).catch(() => {});
    }
  }
  return true;
}

/**
 * Place a buy mirroring the bulltrend path (pyramid + AUTO_APPROVE gated).
 * `force` is for the `/scan <sym> live force` manual test — it executes the order
 * regardless of AUTO_APPROVE (still pyramid + risk gated), like a manual /buy.
 */
async function autoBuy(coin: WatchCoin, result: ScoreResult, price: number, notify: boolean, cfg: TradingConfig, force = false): Promise<void> {
  // Pyramid guard — skip if already holding.
  if (!cfg.ORDER_PYRAMID) {
    try {
      const existing = await getBroker("coinbase").getPosition(coin.coinbaseProductId);
      if (existing && existing.qty > 0) {
        logger.info("[CRYPTO_MONITOR] auto-buy skipped — already holding", { symbol: coin.symbol, qty: existing.qty });
        return;
      }
    } catch (err) {
      logger.warn("[CRYPTO_MONITOR] pyramid check failed, allowing buy", { symbol: coin.symbol, error: String(err) });
    }
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
    stopLoss: entryPrice > 0 ? parseFloat((entryPrice * (1 - cfg.STOP_LOSS_PCT / 100)).toFixed(8)) : undefined,
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
    reason: force ? `Crypto monitor FORCED test buy (score ${result.total})` : `Crypto monitor STRONG_BUY (score ${result.total})`,
    expression: `F${result.fundamental}/N${result.news}/T${result.technical} → ${result.total}${force ? " (forced)" : ` ≥ ${25}`}`,
    signalId: ref.id,
  });

  if (force || cfg.AUTO_APPROVE) {
    const res = await executeOrder(buySignal, "crypto-monitor");
    if (notify) {
      const tag = force ? "Crypto monitor FORCED BUY" : "Crypto monitor BUY";
      await sendTelegramMessage(
        res.status === "executed"
          ? `✅ *${tag}* ${coin.symbol} @ ${entryPrice} (score ${result.total})`
          : `❌ *${tag} not executed* ${coin.symbol}\nexecuteOrder: ${res.status}`
      ).catch(() => {});
    }
  } else if (notify) {
    await sendTelegramMessage(`⏸ *Crypto monitor STRONG_BUY stored* ${coin.symbol} @ ${entryPrice}\nAUTO_APPROVE=false — manual approval required`).catch(() => {});
  }
}

