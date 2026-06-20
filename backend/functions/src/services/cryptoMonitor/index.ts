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
import { loadWatchlist, WatchCoin } from "./watchlist";
import {
  fetchMarketRows, fetch7dAvgVolume, fetchHourlyCandles,
  fetchDefiMetrics, fetchNewsDataHeadlines, fetchGoogleHeadlines, CgMarketRow,
} from "./data";
import { scoreCoin, MarketRow, ScoreResult, Category } from "./scoring";
import { formatBreakdown } from "./format";

const db = getFirestore();
const METRICS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const CATEGORY_RANK: Record<Category, number> = { AVOID: 0, WATCHLIST: 1, STRONG_BUY: 2 };

export interface MonitorRunResult {
  scanned: number;
  alerts: number;
  lines: string[];
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

  // newsdata.io primary; per-coin Google-News fallback when it has nothing tagged.
  const fromNewsData = newsBySymbol?.get(coin.symbol.toUpperCase());
  const headlines = fromNewsData && fromNewsData.length ? fromNewsData : await fetchGoogleHeadlines(coin.symbol);

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
export async function runCryptoMonitor(opts?: { onlySymbol?: string; notify?: boolean; dryRun?: boolean }): Promise<MonitorRunResult> {
  const notify = opts?.notify ?? true;
  const dryRun = opts?.dryRun ?? false;

  let watchlist = await loadWatchlist();
  if (opts?.onlySymbol) {
    const want = opts.onlySymbol.toUpperCase().replace(/-USD.*$/, "");
    watchlist = watchlist.filter(
      c => c.symbol.toUpperCase() === want || c.coinbaseProductId.toUpperCase() === opts.onlySymbol!.toUpperCase()
    );
  }

  const tradingConfig = await getTradingConfig();
  const [marketRows, newsBySymbol] = await Promise.all([
    fetchMarketRows(watchlist.map(c => c.coingeckoId)),
    fetchNewsDataHeadlines(watchlist.map(c => c.symbol)),
  ]);

  const lines: string[] = [];
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

      const emitted = await reconcileAlert(coin, result, price, notify, tradingConfig);
      if (emitted) alerts++;
    } catch (err) {
      logger.warn("[CRYPTO_MONITOR] coin scoring failed", { symbol: coin.symbol, error: String(err) });
    }
  }

  logger.info("[CRYPTO_MONITOR] run complete", { scanned: watchlist.length, alerts });
  return { scanned: watchlist.length, alerts, lines };
}

/** Read-only single-coin scoring for the Telegram drill-down. */
export async function explainCoin(symbol: string): Promise<string | null> {
  const watchlist = await loadWatchlist();
  const want = symbol.toUpperCase().replace(/-USD.*$/, "");
  const coin = watchlist.find(c => c.symbol.toUpperCase() === want || c.coinbaseProductId.toUpperCase() === symbol.toUpperCase());
  if (!coin) return null;

  const [marketRows, newsBySymbol] = await Promise.all([fetchMarketRows([coin.coingeckoId]), fetchNewsDataHeadlines([coin.symbol])]);
  const { result, price } = await collectAndScore(coin, marketRows.get(coin.coingeckoId), newsBySymbol);
  return formatBreakdown(coin, result, price);
}

async function reconcileAlert(coin: WatchCoin, result: ScoreResult, price: number, notify: boolean, cfg: TradingConfig): Promise<boolean> {
  const stateRef = db.collection("monitor_state").doc(coin.symbol.toUpperCase());
  const snap = await stateRef.get();
  const prev = snap.data() as { lastCategory?: Category; lastAlertAtMs?: number } | undefined;
  const now = Date.now();

  const isBuy = result.category === "STRONG_BUY" || result.category === "WATCHLIST";
  if (!isBuy) {
    await stateRef.set({ lastCategory: result.category }, { merge: true });
    return false;
  }

  const prevRank = CATEGORY_RANK[prev?.lastCategory ?? "AVOID"] ?? 0;
  const upgraded = CATEGORY_RANK[result.category] > prevRank;
  const cooled = !prev?.lastAlertAtMs || now - prev.lastAlertAtMs >= ALERT_COOLDOWN_MS;
  if (!upgraded && !cooled) {
    await stateRef.set({ lastCategory: result.category }, { merge: true });
    return false;
  }

  await db.collection("crypto_alerts").add({
    symbol: coin.symbol,
    productId: coin.coinbaseProductId,
    category: result.category,
    score: result.total,
    fundamental: result.fundamental,
    technical: result.technical,
    news: result.news,
    reasons: result.reasons,
    risks: result.risks,
    checks: result.checks,
    price,
    createdAt: FieldValue.serverTimestamp(),
  });
  await stateRef.set({ lastCategory: result.category, lastAlertAtMs: now }, { merge: true });

  if (notify) {
    await sendTelegramMessage(formatAlert(coin, result, price)).catch(() => {});
    if (result.category === "STRONG_BUY") {
      await sendCryptoBuyAlertNotification(coin.symbol, result.category, result.total, result.reasons).catch(() => {});
    }
  }

  if (result.category === "STRONG_BUY") {
    await autoBuy(coin, result, price, notify, cfg).catch(err =>
      logger.error("[CRYPTO_MONITOR] auto-buy failed", { symbol: coin.symbol, error: String(err) })
    );
  }
  return true;
}

/** Place a buy on STRONG_BUY, mirroring the bulltrend path (AUTO_APPROVE + pyramid gated). */
async function autoBuy(coin: WatchCoin, result: ScoreResult, price: number, notify: boolean, cfg: TradingConfig): Promise<void> {
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
    reason: `Crypto monitor STRONG_BUY (score ${result.total})`,
    expression: `F${result.fundamental}/N${result.news}/T${result.technical} → ${result.total} ≥ ${25}`,
    signalId: ref.id,
  });

  if (cfg.AUTO_APPROVE) {
    const res = await executeOrder(buySignal, "crypto-monitor");
    if (notify) {
      await sendTelegramMessage(
        res.status === "executed"
          ? `✅ *Crypto monitor BUY* ${coin.symbol} @ ${entryPrice} (score ${result.total})`
          : `❌ *Crypto monitor BUY not executed* ${coin.symbol}\nexecuteOrder: ${res.status}`
      ).catch(() => {});
    }
  } else if (notify) {
    await sendTelegramMessage(`⏸ *Crypto monitor STRONG_BUY stored* ${coin.symbol} @ ${entryPrice}\nAUTO_APPROVE=false — manual approval required`).catch(() => {});
  }
}

function formatAlert(coin: WatchCoin, result: ScoreResult, price: number): string {
  const label = result.category === "STRONG_BUY" ? "🚀 *STRONG BUY*" : "👀 *WATCHLIST*";
  const priceStr = price >= 1 ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${price.toPrecision(4)}`;
  const reasons = result.reasons.length ? result.reasons.map(r => `✓ ${r}`).join("\n") : "—";
  const risks = result.risks.length ? `\n\n*Risks:*\n${result.risks.map(r => `⚠ ${r}`).join("\n")}` : "";
  return (
    `${label} — *${coin.symbol}* (${coin.coinbaseProductId})\n` +
    `Price: ${priceStr}\n` +
    `Total: ${result.total}/40  (F${result.fundamental} · N${result.news} · T${result.technical})\n\n` +
    `*Reasons:*\n${reasons}${risks}\n\n_/coin ${coin.symbol} for full breakdown_`
  );
}
