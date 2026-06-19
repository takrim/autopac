/**
 * Crypto-monitor data collection. Thin fetchers over existing services:
 *   - Coinbase hourly candles (CoinbaseBroker.getCandles)
 *   - CoinGecko market rows + 7d volume (pro API)
 *   - Google-News headlines (newsMonitor.fetchNewsForSymbol)
 */

import { logger } from "firebase-functions/v2";
import { getBroker } from "../../brokers";
import { CoinbaseBroker } from "../../brokers/coinbase";
import { fetchNewsForSymbol } from "../newsMonitor";
import { Candle, NewsHeadline } from "./scoring";

const CG_BASE = "https://pro-api.coingecko.com/api/v3";

async function cgGet<T>(path: string): Promise<T | null> {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    logger.error("[CRYPTO_MONITOR] Missing COINGECKO_API_KEY secret");
    return null;
  }
  try {
    const resp = await fetch(`${CG_BASE}${path}`, {
      headers: { "x-cg-pro-api-key": apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      logger.warn("[CRYPTO_MONITOR] CoinGecko request failed", { path, status: resp.status });
      return null;
    }
    return (await resp.json()) as T;
  } catch (err) {
    logger.warn("[CRYPTO_MONITOR] CoinGecko fetch error", { path, error: String(err) });
    return null;
  }
}

export interface CgMarketRow {
  id: string;
  current_price: number;
  market_cap_rank: number | null;
  total_volume: number;
  price_change_percentage_24h_in_currency?: number;
  price_change_percentage_7d_in_currency?: number;
}

/** One batched call for the whole watchlist. Returns map keyed by coingecko id. */
export async function fetchMarketRows(ids: string[]): Promise<Map<string, CgMarketRow>> {
  const map = new Map<string, CgMarketRow>();
  if (ids.length === 0) return map;
  const idsCsv = ids.join(",");
  const data = await cgGet<CgMarketRow[]>(
    `/coins/markets?vs_currency=usd&ids=${encodeURIComponent(idsCsv)}&per_page=250&price_change_percentage=24h,7d`
  );
  if (data) for (const r of data) map.set(r.id, r);
  return map;
}

// 7d average daily volume changes slowly — cache per process for 1h to cut calls.
const vol7dCache = new Map<string, { value: number | null; expiresAt: number }>();
const VOL7D_TTL_MS = 60 * 60 * 1000;

export async function fetch7dAvgVolume(cgId: string): Promise<number | null> {
  const cached = vol7dCache.get(cgId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const data = await cgGet<{ total_volumes: [number, number][] }>(
    `/coins/${encodeURIComponent(cgId)}/market_chart?vs_currency=usd&days=7&interval=daily`
  );
  let value: number | null = null;
  const vols = (data?.total_volumes ?? []).map(v => v[1]).filter(v => Number.isFinite(v));
  if (vols.length > 0) value = vols.reduce((a, b) => a + b, 0) / vols.length;

  vol7dCache.set(cgId, { value, expiresAt: Date.now() + VOL7D_TTL_MS });
  return value;
}

/** Hourly candles (oldest→newest) for EMA200 headroom + RSI. */
export async function fetchHourlyCandles(productId: string): Promise<Candle[]> {
  const broker = getBroker("coinbase") as CoinbaseBroker;
  const candles = await broker.getCandles(productId, "ONE_HOUR", 250);
  return candles.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, start: c.start }));
}

export async function fetchHeadlines(symbol: string): Promise<NewsHeadline[]> {
  const articles = await fetchNewsForSymbol(symbol);
  return articles.map(a => ({ sentiment: a.sentiment, title: a.title }));
}
