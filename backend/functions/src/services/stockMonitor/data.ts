/**
 * Stock-monitor data layer — all from the Alpaca Market Data API (basic / IEX).
 *   • snapshots  → latest price, 24h % change, daily volume
 *   • daily bars → EMA/RSI inputs + derived avg-volume and 7d % change
 *   • news       → catalyst headlines (classified by the shared scoring logic)
 *
 * No fundamentals exist on the basic plan, so the MarketRow's DeFi/rank fields
 * are null and the "fundamental" score comes from relative volume only.
 */

import { logger } from "firebase-functions/v2";
import { getAlpacaConfig } from "../../config";
import { Candle, MarketRow, NewsHeadline } from "../cryptoMonitor/scoring";

const DATA_URL = "https://data.alpaca.markets";

function headers(): Record<string, string> {
  const cfg = getAlpacaConfig();
  return {
    "APCA-API-KEY-ID": cfg.apiKey,
    "APCA-API-SECRET-KEY": cfg.apiSecret,
    "Content-Type": "application/json",
  };
}

export interface StockSnapshot {
  price: number;
  change24hPct: number;
  volume24h: number;
}

/** Batch snapshots for the whole watchlist (one call). symbol → snapshot. */
export async function fetchStockSnapshots(symbols: string[]): Promise<Map<string, StockSnapshot>> {
  const out = new Map<string, StockSnapshot>();
  if (symbols.length === 0) return out;
  try {
    const url = `${DATA_URL}/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(","))}&feed=iex`;
    const resp = await fetch(url, { headers: headers() });
    if (!resp.ok) {
      logger.warn("[STOCK_MONITOR] snapshots fetch failed", { status: resp.status });
      return out;
    }
    const data = await resp.json() as Record<string, {
      latestTrade?: { p: number };
      dailyBar?: { c: number; v: number };
      prevDailyBar?: { c: number };
    }>;
    for (const [symbol, snap] of Object.entries(data)) {
      if (!snap?.dailyBar) continue;
      const price = snap.latestTrade?.p ?? snap.dailyBar.c;
      const prevClose = snap.prevDailyBar?.c ?? 0;
      const change24hPct = prevClose > 0 ? ((snap.dailyBar.c - prevClose) / prevClose) * 100 : 0;
      out.set(symbol.toUpperCase(), { price, change24hPct, volume24h: snap.dailyBar.v });
    }
  } catch (err) {
    logger.warn("[STOCK_MONITOR] snapshots error", { error: String(err) });
  }
  return out;
}

/** Daily OHLCV bars (oldest-first) for EMA200/RSI. ~220 sessions of headroom. */
export async function fetchDailyBars(symbol: string, limit = 220): Promise<Candle[]> {
  try {
    const url = `${DATA_URL}/v2/stocks/bars?symbols=${encodeURIComponent(symbol)}&timeframe=1Day&limit=${limit}&feed=iex&sort=asc`;
    const resp = await fetch(url, { headers: headers() });
    if (!resp.ok) {
      logger.warn("[STOCK_MONITOR] bars fetch failed", { symbol, status: resp.status });
      return [];
    }
    const data = await resp.json() as { bars?: Record<string, Array<Record<string, string | number>>> };
    const raw = data.bars?.[symbol] ?? [];
    return raw.map(b => ({
      start: Math.floor(new Date(String(b.t)).getTime() / 1000),
      open: Number(b.o) || 0,
      high: Number(b.h) || 0,
      low: Number(b.l) || 0,
      close: Number(b.c) || 0,
      volume: Number(b.v) || 0,
    })).filter(c => Number.isFinite(c.start));
  } catch (err) {
    logger.warn("[STOCK_MONITOR] bars error", { symbol, error: String(err) });
    return [];
  }
}

// --- News (batched, 30-min in-process cache) ---
const NEWS_CACHE = new Map<string, { at: number; headlines: NewsHeadline[] }>();
const NEWS_TTL_MS = 30 * 60 * 1000;

/** Batch Alpaca news for the watchlist, grouped by symbol. Cached ~30 min. */
export async function fetchAlpacaNews(symbols: string[]): Promise<Map<string, NewsHeadline[]>> {
  const out = new Map<string, NewsHeadline[]>();
  const now = Date.now();
  const stale = symbols.filter(s => {
    const c = NEWS_CACHE.get(s.toUpperCase());
    if (c && now - c.at < NEWS_TTL_MS) { out.set(s.toUpperCase(), c.headlines); return false; }
    return true;
  });
  if (stale.length === 0) return out;

  try {
    const url = `https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(stale.join(","))}&limit=50&sort=desc`;
    const resp = await fetch(url, { headers: headers() });
    if (!resp.ok) {
      logger.warn("[STOCK_MONITOR] news fetch failed", { status: resp.status });
      // cache empties briefly so a 429/422 storm doesn't hammer the API
      for (const s of stale) { const u = s.toUpperCase(); out.set(u, []); NEWS_CACHE.set(u, { at: now, headlines: [] }); }
      return out;
    }
    const data = await resp.json() as { news?: Array<{ headline?: string; summary?: string; symbols?: string[] }> };
    const grouped = new Map<string, NewsHeadline[]>();
    for (const a of data.news ?? []) {
      if (!a.headline) continue;
      for (const sym of a.symbols ?? []) {
        const u = sym.toUpperCase();
        if (!stale.includes(u)) continue;
        const list = grouped.get(u) ?? [];
        list.push({ title: a.headline, summary: a.summary });
        grouped.set(u, list);
      }
    }
    for (const s of stale) {
      const u = s.toUpperCase();
      const headlines = grouped.get(u) ?? [];
      out.set(u, headlines);
      NEWS_CACHE.set(u, { at: now, headlines });
    }
  } catch (err) {
    logger.warn("[STOCK_MONITOR] news error", { error: String(err) });
    for (const s of stale) out.set(s.toUpperCase(), []);
  }
  return out;
}

/** Build the scoring MarketRow from a snapshot + daily bars (no fundamentals). */
export function buildMarketRow(snapshot: StockSnapshot | undefined, bars: Candle[]): MarketRow {
  // Average daily volume over the last ~20 sessions (relative-volume proxy).
  const recent = bars.slice(-20);
  const volume7dAvg = recent.length ? recent.reduce((s, b) => s + b.volume, 0) / recent.length : null;
  // 7d (~5 trading sessions) % change from daily closes.
  let change7dPct = 0;
  if (bars.length >= 6) {
    const last = bars[bars.length - 1].close;
    const prior = bars[bars.length - 6].close;
    if (prior > 0) change7dPct = ((last - prior) / prior) * 100;
  }
  return {
    marketCapRank: null, // no fundamentals on Alpaca basic
    volume24h: snapshot?.volume24h ?? (bars.length ? bars[bars.length - 1].volume : 0),
    volume7dAvg,
    change24hPct: snapshot?.change24hPct ?? 0,
    change7dPct,
    tvlChange30dPct: null,
    stablecoinInflow30dPct: null,
    revenueRising: null,
  };
}
