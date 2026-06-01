/**
 * Massive REST API client (https://massive.com/docs/rest/crypto/overview)
 *
 * Used by the position liquidator to enrich active RSI-dip docs with
 * multi-timeframe context, so when a bulltrend signal arrives the buy
 * decision can be made instantly off pre-computed data.
 *
 * Crypto only for v1. Symbol format conversion: Coinbase "BTC-USD" → "X:BTCUSD".
 */

import { logger } from "firebase-functions/v2";

const BASE_URL = "https://api.massive.com";

function apiKey(): string {
  const k = process.env.MASSIVE_API_KEY;
  if (!k) throw new Error("MASSIVE_API_KEY env var not set");
  return k;
}

/** Coinbase "BTC-USD" → Massive "X:BTCUSD". Returns null for unsupported shapes. */
export function toMassiveSymbol(coinbaseSymbol: string): string | null {
  const s = (coinbaseSymbol || "").toUpperCase().trim();
  if (!s) return null;
  // Accept "BTC-USD" and "BTC/USD"
  const m = s.match(/^([A-Z0-9]+)[-/]([A-Z]{3,5})$/);
  if (!m) return null;
  return `X:${m[1]}${m[2]}`;
}

async function get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  url.searchParams.set("apiKey", apiKey());
  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Massive ${path} ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export interface MassiveSnapshot {
  price: number | null;
  dayChangePct: number | null;   // today's % change from previous day close
  dayVolume: number | null;      // today's traded volume in base currency
  dayHigh: number | null;
  dayLow: number | null;
  minuteVolume: number | null;   // most recent 1-min bar volume
  updatedMs: number | null;      // last trade timestamp
}

interface SnapshotResp {
  ticker?: {
    day?: { c?: number; h?: number; l?: number; v?: number };
    lastTrade?: { p?: number; t?: number };
    min?: { v?: number };
    todaysChangePerc?: number;
    updated?: number;
  };
  status?: string;
}

export async function fetchSnapshot(massiveSymbol: string): Promise<MassiveSnapshot> {
  const data = await get<SnapshotResp>(
    `/v2/snapshot/locale/global/markets/crypto/tickers/${encodeURIComponent(massiveSymbol)}`,
  );
  const t = data.ticker || {};
  return {
    price: t.lastTrade?.p ?? t.day?.c ?? null,
    dayChangePct: t.todaysChangePerc ?? null,
    dayVolume: t.day?.v ?? null,
    dayHigh: t.day?.h ?? null,
    dayLow: t.day?.l ?? null,
    minuteVolume: t.min?.v ?? null,
    updatedMs: t.lastTrade?.t ?? t.updated ?? null,
  };
}

interface IndicatorResp {
  results?: { values?: Array<{ timestamp: number; value?: number; signal?: number; histogram?: number }> };
}

/** Returns latest RSI value at the given timespan (e.g. "hour", "day"), or null. */
export async function fetchRsi(
  massiveSymbol: string,
  timespan: "minute" | "hour" | "day" = "hour",
  window = 14,
): Promise<number | null> {
  const data = await get<IndicatorResp>(`/v1/indicators/rsi/${encodeURIComponent(massiveSymbol)}`, {
    timespan, window, series_type: "close", order: "desc", limit: 1,
  });
  return data.results?.values?.[0]?.value ?? null;
}

export interface MacdValue {
  value: number | null;     // MACD line
  signal: number | null;    // signal line
  histogram: number | null; // value - signal
}

/** Returns latest MACD triple at the given timespan, or all-nulls. */
export async function fetchMacd(
  massiveSymbol: string,
  timespan: "minute" | "hour" | "day" = "hour",
): Promise<MacdValue> {
  const data = await get<IndicatorResp>(`/v1/indicators/macd/${encodeURIComponent(massiveSymbol)}`, {
    timespan, series_type: "close", order: "desc", limit: 1,
  });
  const v = data.results?.values?.[0];
  return {
    value: v?.value ?? null,
    signal: v?.signal ?? null,
    histogram: v?.histogram ?? null,
  };
}

// ---------------------------------------------------------------------------
// Aggregator used by the liquidator
// ---------------------------------------------------------------------------

export interface MassiveSample {
  at: number;                    // ms epoch when this sample was taken
  snapshot: MassiveSnapshot;
  rsi1h: number | null;
  macd1h: MacdValue;
}

/**
 * Fetch one full sample (snapshot + RSI 1h + MACD 1h) for a Coinbase symbol.
 * Returns null if the symbol cannot be mapped to Massive or any leg throws.
 */
export async function sampleForCoinbaseSymbol(coinbaseSymbol: string): Promise<MassiveSample | null> {
  const m = toMassiveSymbol(coinbaseSymbol);
  if (!m) {
    logger.warn("[MASSIVE] cannot map coinbase symbol", { coinbaseSymbol });
    return null;
  }
  try {
    const [snapshot, rsi1h, macd1h] = await Promise.all([
      fetchSnapshot(m),
      fetchRsi(m, "hour", 14),
      fetchMacd(m, "hour"),
    ]);
    return { at: Date.now(), snapshot, rsi1h, macd1h };
  } catch (err) {
    logger.warn("[MASSIVE] sampleForCoinbaseSymbol failed", { coinbaseSymbol, massive: m, error: String(err) });
    return null;
  }
}
