/**
 * Crypto-monitor data collection. Thin fetchers over existing services + the
 * keyless DefiLlama API and CoinGecko's news feed.
 */

import { logger } from "firebase-functions/v2";
import { getBroker } from "../../brokers";
import { CoinbaseBroker } from "../../brokers/coinbase";
import { fetchNewsForSymbol } from "../newsMonitor";
import { sendTelegramMessage } from "../telegram";
import { cgFetchCategories } from "../../webhooks/tradingview";
import { Candle, NewsHeadline } from "./scoring";
import { DefiLlamaRef, WatchCoin, DEFAULT_WATCHLIST } from "./watchlist";
import { isUniverseEligible } from "./universe";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const CG_BASE = "https://pro-api.coingecko.com/api/v3";
const LLAMA_BASE = "https://api.llama.fi";

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

async function llamaGet<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${LLAMA_BASE}${path}`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      logger.warn("[CRYPTO_MONITOR] DefiLlama request failed", { path, status: resp.status });
      return null;
    }
    return (await resp.json()) as T;
  } catch (err) {
    logger.warn("[CRYPTO_MONITOR] DefiLlama fetch error", { path, error: String(err) });
    return null;
  }
}

// ── CoinGecko market rows ────────────────────────────────────────────────────

export interface CgMarketRow {
  id: string;
  symbol?: string;
  current_price: number;
  market_cap_rank: number | null;
  total_volume: number;
  price_change_percentage_24h_in_currency?: number;
  price_change_percentage_7d_in_currency?: number;
}

/** Resolve a ticker symbol to its CoinGecko id (prefers an exact symbol match). */
export async function searchCoinGeckoId(symbol: string): Promise<string | null> {
  const data = await cgGet<{ coins?: Array<{ id: string; symbol: string }> }>(`/search?query=${encodeURIComponent(symbol)}`);
  if (!data?.coins?.length) return null;
  const exact = data.coins.find(c => c.symbol.toLowerCase() === symbol.toLowerCase());
  return exact?.id ?? data.coins[0]?.id ?? null;
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

// 7d average daily volume changes slowly — cache per process for 1h.
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

// ── Coinbase candles ─────────────────────────────────────────────────────────

export async function fetchHourlyCandles(productId: string): Promise<Candle[]> {
  const broker = getBroker("coinbase") as CoinbaseBroker;
  const candles = await broker.getCandles(productId, "ONE_HOUR", 250);
  return candles.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, start: c.start }));
}

// ── Dynamic gainers universe ─────────────────────────────────────────────────

const GAINERS_SLOT = 15; // up to this many top gainers in the universe
const LOSERS_SLOT = 10; // up to this many top losers (oversold dip candidates)
const MOVERS_CANDIDATES = 50; // Coinbase movers to consider (each side) before filtering

// CoinGecko category/id lookups change slowly — cache per symbol for 24h.
const catCache = new Map<string, { id: string | null; categories: string[] | null; expiresAt: number }>();
const CAT_TTL_MS = 24 * 60 * 60 * 1000;

async function resolveCategory(symbol: string): Promise<{ id: string | null; categories: string[] | null }> {
  const cached = catCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const res = await cgFetchCategories(symbol);
  catCache.set(symbol, { ...res, expiresAt: Date.now() + CAT_TTL_MS });
  return res;
}

type Mover = { productId: string; symbol: string; change24h: number };

/**
 * Build the watchlist from Coinbase's top 24h movers — gainers and losers
 * (oversold dip candidates) — excluding stablecoins and any coin whose CoinGecko
 * categories match defi/meme. Resolves the CoinGecko id along the way (needed for
 * scoring) and reuses DefiLlama slugs from DEFAULT_WATCHLIST when known. Coins
 * whose category can't be verified are skipped (fail-closed). Returns an empty
 * list (no hardcoded fallback) and alerts via Telegram if the feed is down.
 */
export async function fetchMoversWatchlist(): Promise<WatchCoin[]> {
  const broker = getBroker("coinbase") as CoinbaseBroker;

  const MAX_ATTEMPTS = 3;
  let gainers: Mover[] = [];
  let losers: Mover[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const [g, l] = await Promise.all([
        broker.getMarketGainers(MOVERS_CANDIDATES),
        broker.getMarketLosers(MOVERS_CANDIDATES),
      ]);
      gainers = g.topGainers ?? [];
      losers = l.topLosers ?? [];
    } catch (err) {
      logger.warn("[CRYPTO_MONITOR] Coinbase movers attempt failed", { attempt, error: String(err) });
    }
    if (gainers.length > 0 || losers.length > 0) break;
    if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
  }
  if (gainers.length === 0 && losers.length === 0) {
    logger.error("[CRYPTO_MONITOR] Coinbase movers feed unavailable after retries");
    await sendTelegramMessage(
      `⚠️ *Crypto Monitor* — Coinbase movers feed unavailable after ${MAX_ATTEMPTS} attempts. No universe scored this run.`
    ).catch(() => {});
    return [];
  }

  const defiBySymbol = new Map(
    DEFAULT_WATCHLIST.filter(c => c.defillama).map(c => [c.symbol.toUpperCase(), c.defillama!])
  );

  const out: WatchCoin[] = [];
  const seen = new Set<string>();

  // Fill up to `slot` coins from `movers` that pass the stablecoin + defi/meme gate.
  const fillFrom = async (movers: Mover[], slot: number): Promise<void> => {
    let added = 0;
    for (const m of movers) {
      if (added >= slot) break;
      const symbol = (m.symbol ?? "").toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      const cat = await resolveCategory(symbol);
      if (!isUniverseEligible(symbol, cat)) continue; // non-stable, has id, non-defi/meme
      seen.add(symbol);
      out.push({ symbol, coinbaseProductId: m.productId, coingeckoId: cat.id!, defillama: defiBySymbol.get(symbol) });
      added++;
    }
  };

  await fillFrom(gainers, GAINERS_SLOT);
  await fillFrom(losers, LOSERS_SLOT);
  return out;
}

// ── DefiLlama fundamentals (keyless; 6h cache, slow-moving) ──────────────────

export interface DefiMetrics {
  tvlChange30dPct: number | null;
  stablecoinInflow30dPct: number | null;
  revenueRising: boolean | null;
}

const defiCache = new Map<string, { value: DefiMetrics; expiresAt: number }>();
const DEFI_TTL_MS = 6 * 60 * 60 * 1000;

/** % change of a chronological daily series vs ~30 entries ago. */
function pctChange30d(series: number[]): number | null {
  const vals = series.filter(v => Number.isFinite(v));
  if (vals.length < 2) return null;
  const last = vals[vals.length - 1];
  const past = vals[Math.max(0, vals.length - 31)];
  if (!past) return null;
  return ((last - past) / past) * 100;
}

export async function fetchDefiMetrics(ref?: DefiLlamaRef): Promise<DefiMetrics> {
  const none: DefiMetrics = { tvlChange30dPct: null, stablecoinInflow30dPct: null, revenueRising: null };
  if (!ref) return none;

  const key = `${ref.kind}:${ref.slug}`;
  const cached = defiCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const out: DefiMetrics = { ...none };

  if (ref.kind === "chain") {
    const tvl = await llamaGet<Array<{ date: number; tvl: number }>>(`/v2/historicalChainTvl/${encodeURIComponent(ref.slug)}`);
    if (Array.isArray(tvl)) out.tvlChange30dPct = pctChange30d(tvl.map(p => p.tvl));

    const stbl = await llamaGet<Array<{ totalCirculatingUSD?: Record<string, number>; totalCirculating?: Record<string, number> }>>(
      `/stablecoincharts/${encodeURIComponent(ref.slug)}`
    );
    if (Array.isArray(stbl)) {
      const series = stbl.map(p => {
        const usd = p.totalCirculatingUSD ?? p.totalCirculating ?? {};
        return Object.values(usd).reduce((a, b) => a + (Number(b) || 0), 0);
      });
      out.stablecoinInflow30dPct = pctChange30d(series);
    }
  } else {
    const proto = await llamaGet<{ tvl?: Array<{ date: number; totalLiquidityUSD: number }> }>(`/protocol/${encodeURIComponent(ref.slug)}`);
    if (proto?.tvl) out.tvlChange30dPct = pctChange30d(proto.tvl.map(p => p.totalLiquidityUSD));

    const fees = await llamaGet<{ total7d?: number; total30d?: number }>(`/summary/fees/${encodeURIComponent(ref.slug)}?dataType=dailyRevenue`);
    if (fees && typeof fees.total7d === "number" && typeof fees.total30d === "number" && fees.total30d > 0) {
      out.revenueRising = fees.total7d / 7 > fees.total30d / 30;
    }
  }

  defiCache.set(key, { value: out, expiresAt: Date.now() + DEFI_TTL_MS });
  return out;
}

// ── News (newsdata.io crypto feed, per-coin Google-News fallback) ────────────

const NEWSDATA_BASE = "https://newsdata.io/api/1";

interface NewsDataArticle {
  title?: string;
  description?: string;
  coin?: string[] | null; // symbol tags, e.g. ["btc"] (Crypto endpoint only)
}

// Per-symbol newsdata cache so frequent (5-min) runs stay within the free tier
// (~200/day). A symbol is refetched at most once per TTL; stale symbols across a
// run are batched into a single call.
const newsDataCache = new Map<string, { headlines: NewsHeadline[]; expiresAt: number }>();
const NEWSDATA_TTL_MS = 30 * 60 * 1000;

/**
 * Fetch newsdata.io crypto news grouped by uppercase coin symbol, cached 30 min
 * per symbol. Only stale symbols are fetched (batched). Returns null only when no
 * key is set; otherwise returns the cache-backed map (callers still merge Google).
 */
export async function fetchNewsDataHeadlines(symbols: string[]): Promise<Map<string, NewsHeadline[]> | null> {
  const apiKey = process.env.NEWSDATA_API_KEY;
  if (!apiKey || symbols.length === 0) return null;

  const now = Date.now();
  const wanted = symbols.map(s => s.toUpperCase());
  const stale = wanted.filter(s => { const c = newsDataCache.get(s); return !c || c.expiresAt <= now; });

  if (stale.length > 0) {
    const coins = stale.map(s => s.toLowerCase()).join(",");
    let fresh: Map<string, NewsHeadline[]> | null = null;
    try {
      const url = `${NEWSDATA_BASE}/crypto?apikey=${encodeURIComponent(apiKey)}&coin=${encodeURIComponent(coins)}&language=en`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const data = (await resp.json()) as { status?: string; results?: NewsDataArticle[] };
        if (data.status === "success" && Array.isArray(data.results)) {
          fresh = new Map<string, NewsHeadline[]>();
          for (const a of data.results) {
            const title = (a.title ?? "").trim();
            if (!title) continue;
            const summary = (a.description ?? "").trim() || undefined;
            for (const c of a.coin ?? []) {
              const key = String(c).toUpperCase();
              const list = fresh.get(key) ?? [];
              list.push({ title, summary });
              fresh.set(key, list);
            }
          }
        }
      } else {
        logger.warn("[CRYPTO_MONITOR] newsdata request failed", { status: resp.status });
      }
    } catch (err) {
      logger.warn("[CRYPTO_MONITOR] newsdata fetch error", { error: String(err) });
    }
    // Cache every stale symbol (results or empty) so we don't refetch until TTL —
    // even on failure, which conserves the daily budget (Google fills the gap).
    for (const s of stale) newsDataCache.set(s, { headlines: fresh?.get(s) ?? [], expiresAt: now + NEWSDATA_TTL_MS });
  }

  const map = new Map<string, NewsHeadline[]>();
  for (const s of wanted) {
    const c = newsDataCache.get(s);
    if (c && c.headlines.length) map.set(s, c.headlines);
  }
  return map;
}

/** Google-News headlines for one coin (titles only). */
export async function fetchGoogleHeadlines(symbol: string): Promise<NewsHeadline[]> {
  const articles = await fetchNewsForSymbol(symbol);
  return articles.map(a => ({ title: a.title }));
}

/** Merge headlines from multiple sources, de-duped by normalized title. */
export function mergeHeadlines(...lists: NewsHeadline[][]): NewsHeadline[] {
  const seen = new Set<string>();
  const out: NewsHeadline[] = [];
  for (const list of lists) {
    for (const h of list) {
      const key = h.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(h);
    }
  }
  return out.slice(0, 12);
}
