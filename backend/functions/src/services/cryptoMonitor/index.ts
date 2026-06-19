/**
 * Crypto buy-signal monitor (MVP, notify-only).
 *
 * For each watchlist coin: collect Coinbase candles + CoinGecko market row +
 * Google-News headlines, score (fundamental + news + technical), persist a
 * `coin_metrics` row, and — when a coin scores into STRONG_BUY/WATCHLIST and is
 * not in cooldown — write a `crypto_alerts` row and notify via Telegram (+ push
 * for STRONG_BUY). Never places an order.
 */

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { sendTelegramMessage } from "../telegram";
import { sendCryptoBuyAlertNotification } from "../notification";
import { loadWatchlist, WatchCoin } from "./watchlist";
import { fetchMarketRows, fetch7dAvgVolume, fetchHourlyCandles, fetchHeadlines } from "./data";
import { scoreCoin, MarketRow, ScoreResult, Category } from "./scoring";

const db = getFirestore();
const METRICS_TTL_MS = 14 * 24 * 60 * 60 * 1000; // keep coin_metrics ~14d
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // re-alert same/lower category at most every 6h

const CATEGORY_RANK: Record<Category, number> = { AVOID: 0, WATCHLIST: 1, STRONG_BUY: 2 };

export interface MonitorRunResult {
  scanned: number;
  alerts: number;
  lines: string[];
}

/**
 * Run one monitoring pass.
 * @param opts.onlySymbol limit to a single coin (Telegram /scan).
 * @param opts.notify     send Telegram/push (default true).
 */
export async function runCryptoMonitor(opts?: { onlySymbol?: string; notify?: boolean }): Promise<MonitorRunResult> {
  const notify = opts?.notify ?? true;

  let watchlist = await loadWatchlist();
  if (opts?.onlySymbol) {
    const want = opts.onlySymbol.toUpperCase().replace(/-USD.*$/, "");
    watchlist = watchlist.filter(
      c => c.symbol.toUpperCase() === want || c.coinbaseProductId.toUpperCase() === opts.onlySymbol!.toUpperCase()
    );
  }

  const marketRows = await fetchMarketRows(watchlist.map(c => c.coingeckoId));
  const lines: string[] = [];
  let alerts = 0;

  for (const coin of watchlist) {
    try {
      const cg = marketRows.get(coin.coingeckoId);
      const [candles, vol7d, headlines] = await Promise.all([
        fetchHourlyCandles(coin.coinbaseProductId),
        fetch7dAvgVolume(coin.coingeckoId),
        fetchHeadlines(coin.symbol),
      ]);

      const row: MarketRow = {
        marketCapRank: cg?.market_cap_rank ?? null,
        volume24h: cg?.total_volume ?? 0,
        volume7dAvg: vol7d,
        change24hPct: cg?.price_change_percentage_24h_in_currency ?? 0,
        change7dPct: cg?.price_change_percentage_7d_in_currency ?? 0,
      };

      const result = scoreCoin(candles, row, headlines);
      const price = candles.length ? candles[candles.length - 1].close : (cg?.current_price ?? 0);

      await db.collection("coin_metrics").add({
        symbol: coin.symbol,
        productId: coin.coinbaseProductId,
        timestamp: FieldValue.serverTimestamp(),
        price,
        volume24h: row.volume24h,
        marketCapRank: row.marketCapRank,
        volume7dAvg: row.volume7dAvg,
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

      lines.push(
        `${coin.symbol}: ${result.category} (total ${result.total} — F${result.fundamental}/N${result.news}/T${result.technical})`
      );

      const emitted = await reconcileAlert(coin, result, price, notify);
      if (emitted) alerts++;
    } catch (err) {
      logger.warn("[CRYPTO_MONITOR] coin scoring failed", { symbol: coin.symbol, error: String(err) });
    }
  }

  logger.info("[CRYPTO_MONITOR] run complete", { scanned: watchlist.length, alerts });
  return { scanned: watchlist.length, alerts, lines };
}

/**
 * Update dedup state and emit an alert when warranted. Alerts fire on a category
 * upgrade (e.g. WATCHLIST→STRONG_BUY) or once the cooldown elapses while still in
 * a buy category. AVOID just records state.
 */
async function reconcileAlert(coin: WatchCoin, result: ScoreResult, price: number, notify: boolean): Promise<boolean> {
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
  return true;
}

function formatAlert(coin: WatchCoin, result: ScoreResult, price: number): string {
  const label = result.category === "STRONG_BUY" ? "🚀 *STRONG BUY*" : "👀 *WATCHLIST*";
  const priceStr = price >= 1 ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${price.toPrecision(4)}`;
  const reasons = result.reasons.length ? result.reasons.map(r => `✓ ${r}`).join("\n") : "—";
  const risks = result.risks.length ? `\n\n*Risks:*\n${result.risks.map(r => `⚠ ${r}`).join("\n")}` : "";
  return (
    `${label} — *${coin.symbol}* (${coin.coinbaseProductId})\n` +
    `Price: ${priceStr}\n` +
    `Total: ${result.total}  (F${result.fundamental} · N${result.news} · T${result.technical})\n\n` +
    `*Reasons:*\n${reasons}${risks}`
  );
}
