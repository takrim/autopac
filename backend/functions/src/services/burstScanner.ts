/**
 * Burst Scanner
 *
 * Runs every 15 minutes. Fetches CoinGecko's top 1h gainers and trending coins,
 * merges + scores them, then auto-executes BUY orders on Coinbase for the top
 * qualified candidates.
 *
 * Scoring:  score = 1h_gain_pct + (trending ? 5 : 0)
 * Filters:  min gain %, min 24h volume, max market-cap rank, Coinbase allowlist.
 * Guards:   per-symbol cooldown (2h), open-position check, max 2 buys per run.
 */

import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getTradingConfig } from "../api/config";
import { getBroker } from "../brokers";
import { CoinbaseBroker } from "../brokers/coinbase";
import { executeOrder } from "../api/trade";
import { sendTelegramMessage } from "./telegram";
import { sendBurstBuyNotification } from "./notification";
import { logDecisions, DecisionLogRecord, DecisionCheck } from "./decisionLog";
import { loadSymbolCache, addToSymbolCache, ZERO_CANDLES_SKIP_REGEX } from "./burstScannerCache";
import { normalizeBookSymbol } from "./orderbook";
import { Signal } from "../types";

// ---------------------------------------------------------------------------
// Thresholds (easy to tune)
// ---------------------------------------------------------------------------

const MIN_GAIN_PCT        = 0.5;        // minimum 1h % gain to qualify
const MIN_PRICE_USD       = 0.01;       // skip sub-penny tokens
const MIN_VOLUME_USD      = 75_000;     // 24h volume floor (USD)
const MAX_MARKET_CAP_RANK = 1000;       // filter out micro-caps
const MAX_BUYS_PER_RUN    = 2;          // cap orders per invocation
const COOLDOWN_HOURS      = 0;          // cooldown disabled (set > 0 to re-enable)
const COOLDOWN_COLLECTION = "_burst_scanner_cooldowns";
const CG_BASE             = "https://pro-api.coingecko.com/api/v3";
const BURST_USER_ID       = "burst_scanner"; // synthetic userId for audit logs

// Cache of symbols known not to be tradeable on Coinbase — TTL 30 days
const NOT_ON_CB_CACHE_DOC = "_burst_cache/notOnCoinbase";
const NOT_ON_CB_TTL_MS    = 30 * 24 * 60 * 60 * 1000;

// Cache of symbols permanently excluded by category filters (e.g. DeFi, Meme) — TTL 90 days
const FORBIDDEN_CACHE_DOC = "_burst_cache/forbidden";
const FORBIDDEN_TTL_MS    = 90 * 24 * 60 * 60 * 1000;

// CoinGecko category names matching this regex trigger a hard skip + forbidden-cache write.
// Word-boundaries avoid false positives like "Refi" matching "fi". Examples that match:
//   "Decentralized Finance (DeFi)", "Meme", "Meme Token", "Dog-Themed Meme".
const FORBIDDEN_CATEGORY_REGEX = /\b(defi|meme)\b/i;

// Fundamental filters (applied via /coins/{id} before RSI/order book check)
const MAX_7D_DROP_PCT      = -25;  // skip if 7d price change is worse than this
// (crypto regularly does -10 to -15% on a single down day; -25% catches genuinely
// broken charts without filtering normal dip-and-rip setups)
// Burst override: if a coin is making a strong move with real volume, ignore the 7d downtrend
// (oversold reversals are exactly the bursts we want to catch — see BILL-USD case study)
const BURST_OVERRIDE_1H_GAIN_PCT = 5;            // 1h gain ≥ 5%
const BURST_OVERRIDE_MIN_VOLUME  = 10_000_000;   // 24h vol ≥ $10M (was $20M)
const MIN_ATH_DISTANCE_PCT = 5;    // skip if within this % of ATH (overbought)
const MAX_FDV_MCAP_RATIO   = 5;    // skip if FDV > 5× market cap (unlock pressure)

const db = getFirestore();

// ---------------------------------------------------------------------------
// CoinGecko types
// ---------------------------------------------------------------------------

interface CgGainer {
  id: string;
  symbol: string;           // e.g. "btc"
  name: string;
  usd: number;              // current price
  usd_24h_vol: number;      // 24h volume in USD
  usd_24h_change: number;   // 1h % change (mapped from markets response)
  market_cap_rank: number;
}

// Raw shape returned by /coins/markets with price_change_percentage=1h
interface CgMarketCoin {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  total_volume: number;
  price_change_percentage_1h_in_currency: number;
  market_cap_rank: number;
}

// Subset of /coins/{id} used for fundamental checks
interface CgCoinDetail {
  categories: string[];
  market_data: {
    price_change_percentage_7d: number | null;
    ath_change_percentage: { usd: number | null };
    market_cap: { usd: number | null };
    fully_diluted_valuation: { usd: number | null };
  };
}

// ---------------------------------------------------------------------------
// CoinGecko fetch helpers
// ---------------------------------------------------------------------------

async function cgGet<T>(path: string): Promise<T | null> {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    logger.error("[BURST] Missing COINGECKO_API_KEY secret");
    return null;
  }

  try {
    const resp = await fetch(`${CG_BASE}${path}`, {
      headers: { "x-cg-pro-api-key": apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      logger.warn("[BURST] CoinGecko request failed", { path, status: resp.status });
      return null;
    }
    return await resp.json() as T;
  } catch (err) {
    logger.warn("[BURST] CoinGecko fetch error", { path, error: String(err) });
    return null;
  }
}

async function fetchCoinDetail(cgId: string): Promise<CgCoinDetail | null> {
  return cgGet<CgCoinDetail>(
    `/coins/${encodeURIComponent(cgId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false&include_categories_details=true`
  );
}

/**
 * Search CoinGecko by symbol and return the best-matching coin ID.
 * Used to resolve CoinGecko IDs for Coinbase-sourced candidates.
 */
async function searchCoinGeckoId(symbol: string): Promise<string | null> {
  const data = await cgGet<{ coins: Array<{ id: string; symbol: string }> }>(
    `/search?query=${encodeURIComponent(symbol)}`
  );
  if (!data?.coins?.length) return null;
  // Prefer exact symbol match (case-insensitive)
  const exact = data.coins.find(c => c.symbol.toLowerCase() === symbol.toLowerCase());
  return exact?.id ?? data.coins[0]?.id ?? null;
}

async function fetchTopGainers(): Promise<CgGainer[]> {
  const data = await cgGet<CgMarketCoin[]>(
    "/coins/markets?vs_currency=usd&order=price_change_percentage_1h_in_currency_desc&per_page=250&price_change_percentage=1h"
  );
  if (!data) return [];
  return data.map(c => ({
    id: c.id,
    symbol: c.symbol,
    name: c.name,
    usd: c.current_price,
    usd_24h_vol: c.total_volume,
    usd_24h_change: c.price_change_percentage_1h_in_currency ?? 0,
    market_cap_rank: c.market_cap_rank,
  }));
}

async function fetchTrendingSymbols(): Promise<Set<string>> {
  const data = await cgGet<{ coins: Array<{ item: { symbol: string } }> }>("/search/trending");
  if (!data?.coins) return new Set();
  return new Set(data.coins.map(c => c.item.symbol.toUpperCase()));
}

// ---------------------------------------------------------------------------
// Cooldown helpers
// ---------------------------------------------------------------------------

async function isInCooldown(symbol: string): Promise<boolean> {
  const ref = db.collection(COOLDOWN_COLLECTION).doc(symbol);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data()!;
  const triggeredAt: FirebaseFirestore.Timestamp = data.triggeredAt;
  const ageHours = (Date.now() - triggeredAt.toMillis()) / 3_600_000;
  return ageHours < COOLDOWN_HOURS;
}

// ---------------------------------------------------------------------------
// "Not on Coinbase" cache (30-day TTL) — avoids re-processing dead symbols
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Symbol caches — see burstScannerCache.ts for shared load/add helpers.
// ---------------------------------------------------------------------------

async function loadNotOnCoinbaseCache(): Promise<Set<string>> {
  return loadSymbolCache(db.doc(NOT_ON_CB_CACHE_DOC), NOT_ON_CB_TTL_MS, "notOnCoinbase");
}

async function addToNotOnCoinbaseCache(symbols: string[]): Promise<void> {
  return addToSymbolCache(db.doc(NOT_ON_CB_CACHE_DOC), symbols, "notOnCoinbase");
}

async function loadForbiddenCache(): Promise<Set<string>> {
  return loadSymbolCache(db.doc(FORBIDDEN_CACHE_DOC), FORBIDDEN_TTL_MS, "forbidden");
}

async function addToForbiddenCache(symbols: string[]): Promise<void> {
  return addToSymbolCache(db.doc(FORBIDDEN_CACHE_DOC), symbols, "forbidden");
}

async function setCooldown(symbol: string): Promise<void> {
  await db.collection(COOLDOWN_COLLECTION).doc(symbol).set({
    triggeredAt: FieldValue.serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// VIP Strong Buy pickup
// ---------------------------------------------------------------------------

// Freshness window: only act on Strong Buy signals created within the last N minutes.
// Burst scanner runs every 5 min; 7 min gives one cycle + a small buffer so a signal
// arriving just after a run still gets picked up on the next one. Older PENDING
// Strong Buys are flipped to REJECTED with a "stale" reason — the underlying market
// condition that produced the Strong Buy is no longer reliably actionable.
const VIP_FRESHNESS_MS = 7 * 60 * 1000;

interface PendingVipSignal {
  signalId: string;
  productId: string;        // Coinbase product id, e.g. "ETH-USD"
  symbol: string;           // Bare symbol, e.g. "ETH"
  rawSymbol: string;        // Original payload symbol (e.g. "ETHUSD")
  price: number;
  signal: Signal;
}

/**
 * Fetch Strong Buy signals (strategy + bulltrend correlated) that are still PENDING
 * AND created within the last VIP_FRESHNESS_MS window. Stale Strong Buys (PENDING
 * but older than the freshness window) are flipped to REJECTED here and not returned.
 * The strategy webhook no longer auto-executes these — the burst scanner is the sole
 * executor for VIP Strong Buys. Each will be processed before regular gainer candidates,
 * bypassing burst entry rules except: forbidden category, already-holding, cooldown,
 * MAX_OPEN_POSITIONS, MAX_BUYS_PER_RUN.
 */
async function fetchPendingStrongBuys(): Promise<PendingVipSignal[]> {
  try {
    const snap = await db.collection("signals")
      .where("strongBuy", "==", true)
      .where("status", "==", "PENDING")
      .get();
    const out: PendingVipSignal[] = [];
    const staleRejects: Array<{ id: string; ageMs: number }> = [];
    const cutoffMs = Date.now() - VIP_FRESHNESS_MS;

    for (const doc of snap.docs) {
      const data = doc.data() as Signal;
      if (data.action !== "BUY") continue;

      // Determine signal age. Prefer payload signalTime (when TradingView fired);
      // fall back to Firestore createdAt (when we received it).
      let createdMs = 0;
      const sigTime = (data as { signalTime?: string }).signalTime;
      if (sigTime) {
        const t = Date.parse(sigTime);
        if (!isNaN(t)) createdMs = t;
      }
      if (createdMs === 0) {
        const ca = (data as { createdAt?: { toMillis?: () => number } }).createdAt;
        if (ca && typeof ca.toMillis === "function") createdMs = ca.toMillis();
      }

      if (createdMs > 0 && createdMs < cutoffMs) {
        staleRejects.push({ id: doc.id, ageMs: Date.now() - createdMs });
        continue;
      }

      const rawSymbol = String(data.symbol || "").toUpperCase();
      if (!rawSymbol) continue;
      const productId = rawSymbol.includes("-") ? rawSymbol : normalizeBookSymbol(rawSymbol);
      const bareSymbol = productId.split("-")[0];
      out.push({
        signalId: doc.id,
        productId,
        symbol: bareSymbol,
        rawSymbol,
        price: Number(data.price) || 0,
        signal: { id: doc.id, ...data },
      });
    }

    // Flip stale ones to REJECTED so they don't keep showing up next cycle.
    if (staleRejects.length > 0) {
      logger.info("[BURST] VIP stale rejects", { count: staleRejects.length, items: staleRejects });
      await Promise.all(staleRejects.map(s =>
        db.collection("signals").doc(s.id).update({
          status: "REJECTED",
          statusMessage: `VIP rejected: stale Strong Buy (${Math.round(s.ageMs / 1000)}s old, max ${VIP_FRESHNESS_MS / 1000}s)`,
          updatedAt: FieldValue.serverTimestamp(),
        }).catch(() => {})
      ));
    }

    return out;
  } catch (err) {
    logger.warn("[BURST] fetchPendingStrongBuys failed (non-fatal)", { error: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// RSI + order book entry signal helpers
// ---------------------------------------------------------------------------

type EntrySignal = "STRONG_BUY" | "BUY" | "SKIP";

export const RSI_PERIOD = 14;
export const RSI_MA_PERIOD = 9;
export const RSI_BUY_MAX = 45;        // buy only when RSI(14) on 3m is below this (shallow-pullback gainer)

// ── Trend filter (#1): only buy when price is above the 200-EMA on 1-hour bars
export const REQUIRE_TREND_FILTER     = true;
export const TREND_EMA_PERIOD         = 200;
export const TREND_EMA_FETCH_COUNT    = 220;   // small headroom over EMA period

// ── Turn-up confirmation (#4): wait for RSI to exit oversold instead of
// buying while it's still falling.
export const REQUIRE_RSI_TURN_UP      = true;
export const RSI_OVERSOLD             = 30;
export const RSI_TURNUP_LOOKBACK      = 5;     // bars (×3m = 15 minutes)

// ── Bullish divergence (#2): used as a BOOST, never a gate.
// Upgrades BUY → STRONG_BUY when present + OB at least neutral.
const DIVERGENCE_LOOKBACK_BARS = 30;
const SWING_LEFT_RIGHT         = 2;     // bars on each side that must be higher

/**
 * Wilder RSI-14 series over close prices (oldest → newest).
 * Returns array aligned to closes; values before warmup are NaN.
 */
function calculateRSISeries(closes: number[], period = RSI_PERIOD): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Exponential moving average; values before warmup are NaN. SMA seed over `period`. */
function calcEma(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let ema = sum / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/**
 * Find indices of local swing lows in `values`. A swing low at index i means
 * v[i] is the strict minimum across [i-leftRight .. i+leftRight].
 * Returns indices in ascending order.
 */
function findSwingLows(values: number[], leftRight = SWING_LEFT_RIGHT): number[] {
  const out: number[] = [];
  for (let i = leftRight; i < values.length - leftRight; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let isLow = true;
    for (let k = 1; k <= leftRight; k++) {
      if (!(values[i - k] > v) || !(values[i + k] > v)) { isLow = false; break; }
    }
    if (isLow) out.push(i);
  }
  return out;
}

/** Simple moving average of a numeric series; values before warmup are NaN. */
function sma(series: number[], period: number): number[] {
  const out: number[] = new Array(series.length).fill(NaN);
  let sum = 0;
  let count = 0;
  const buf: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) { buf.length = 0; sum = 0; count = 0; continue; }
    buf.push(v); sum += v; count++;
    if (buf.length > period) { sum -= buf.shift() as number; count--; }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

/**
 * Aggregate 1-min candles into 3-min candles aligned to wall-clock 3-min boundaries.
 * Input is sorted oldest → newest. The most recent (possibly incomplete) 3-min
 * bucket is dropped so RSI runs on fully closed bars only.
 */
function aggregateTo3Min(candles: { start: number; open: number; high: number; low: number; close: number; volume: number }[]): { start: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const buckets = new Map<number, { start: number; open: number; high: number; low: number; close: number; volume: number; count: number }>();
  for (const c of candles) {
    const bucketStart = c.start - (c.start % 180);
    const existing = buckets.get(bucketStart);
    if (!existing) {
      buckets.set(bucketStart, { start: bucketStart, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, count: 1 });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume;
      existing.count++;
    }
  }
  const out = Array.from(buckets.values()).sort((a, b) => a.start - b.start);
  // Drop incomplete trailing bucket (fewer than 3 underlying 1-min candles)
  while (out.length > 0 && out[out.length - 1].count < 3) out.pop();
  return out.map(({ count: _c, ...rest }) => rest);
}

/**
 * Classify bid/ask volume imbalance from the top of the order book.
 * ratio = bidVolume / askVolume across the top 10 levels.
 */
export type OrderBookSignal = "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";
function classifyOrderBook(ratio: number): OrderBookSignal {
  if (!Number.isFinite(ratio) || ratio <= 0) return "NEUTRAL"; // unknown → don't block
  if (ratio >= 1.5)  return "STRONG_BUY";
  if (ratio >= 1.2)  return "BUY";
  if (ratio >= 0.85) return "NEUTRAL";
  if (ratio >= 0.6)  return "SELL";
  return "STRONG_SELL";
}

/**
 * Checks RSI-14 on 3-min candles plus order book pressure and trend regime.
 * Aggregates 1-min candles → 3-min bars (matches the TradingView chart the user reads).
 * Strategy: buy oversold gainers (price up but RSI low — momentum reversal entry).
 *
 * Gating order (any failure → SKIP):
 *   1. Order book SELL or STRONG_SELL                 → SKIP
 *   2. Trend filter: price < EMA-200 on 1h            → SKIP (only fade dips in uptrends)
 *   3. RSI ≥ RSI_BUY_MAX (35)                         → SKIP (not oversold)
 *   4. RSI not turning up out of oversold             → SKIP (don't catch falling knife)
 *
 * Boost: bullish RSI divergence (price LL, RSI HL) + OB ≥ NEUTRAL → STRONG_BUY.
 * Otherwise BUY (upgraded to STRONG_BUY when OB is bullish, as before).
 */
export type EntryResult = {
  signal: EntrySignal;
  rsi: number;
  rsiMa: number;
  bidAskRatio: number;
  obSignal: OrderBookSignal;
  aboveTrend: boolean;
  ema200: number;
  rsiTurnedUp: boolean;
  bullishDivergence: boolean;
  skipReason?: string;
};

export async function checkEntrySignal(
  coinbaseBroker: CoinbaseBroker,
  productId: string
): Promise<EntryResult> {
  // RSI-14 on 3-min bars — need ≥15 closed 3-min bars. Fetch 300 one-min candles (5 hours) for
  // headroom on thinly-traded pairs where Coinbase returns no candle for minutes with zero trades.
  // 1-hour candles → EMA-200 trend regime (~9 days of context).
  const [oneMin, hourly, book] = await Promise.all([
    coinbaseBroker.getCandles(productId, "ONE_MINUTE", 300),
    coinbaseBroker.getCandles(productId, "ONE_HOUR", TREND_EMA_FETCH_COUNT),
    coinbaseBroker.getOrderBook(productId, 10),
  ]);
  const bidAskRatio = book.ratio;
  const obSignal = classifyOrderBook(bidAskRatio);

  // ── Compute RSI first so it's always available in the result (even on SKIP) ──
  const threeMin = aggregateTo3Min(oneMin);
  let closes = threeMin.map(c => c.close);
  let rsiTimeframe: "3m" | "5m" = "3m";
  let rsi = -1;
  let rsiMa = -1;
  let rsiSeries: number[] = [];

  // Try 3m first
  if (closes.length >= RSI_PERIOD + 1) {
    rsiSeries = calculateRSISeries(closes);
    const maSeries = sma(rsiSeries, RSI_MA_PERIOD);
    const last = closes.length - 1;
    const r = rsiSeries[last];
    if (Number.isFinite(r)) {
      rsi = r;
      rsiMa = Number.isFinite(maSeries[last]) ? maSeries[last] : r;
    }
  }

  // Fallback: thin pair — fetch native 5m candles directly (denser than aggregated 1m)
  if (rsi < 0) {
    logger.info("[BURST] 3m RSI unavailable, falling back to 5m", {
      symbol: productId, oneMinBars: oneMin.length, threeMinBars: closes.length,
    });
    const fiveMin = await coinbaseBroker.getCandles(productId, "FIVE_MINUTE", 100);
    const fiveCloses = fiveMin.map(c => c.close);
    if (fiveCloses.length >= RSI_PERIOD + 1) {
      const series = calculateRSISeries(fiveCloses);
      const maSeries = sma(series, RSI_MA_PERIOD);
      const last = fiveCloses.length - 1;
      const r = series[last];
      if (Number.isFinite(r)) {
        rsi = r;
        rsiMa = Number.isFinite(maSeries[last]) ? maSeries[last] : r;
        rsiSeries = series;
        closes = fiveCloses;
        rsiTimeframe = "5m";
        logger.info("[BURST] 5m RSI fallback succeeded", {
          symbol: productId, fiveMinBars: fiveCloses.length, rsi: rsi.toFixed(1),
        });
      }
    }
  }

  // ── Compute trend regime so aboveTrend is always populated ──
  let aboveTrend = true;
  let ema200 = -1;
  let lastHourClose = -1;
  if (hourly.length >= TREND_EMA_PERIOD) {
    const hourlyCloses = hourly.map(c => c.close);
    const emaSeries = calcEma(hourlyCloses, TREND_EMA_PERIOD);
    ema200 = emaSeries[emaSeries.length - 1];
    lastHourClose = hourlyCloses[hourlyCloses.length - 1];
    aboveTrend = Number.isFinite(ema200) && lastHourClose > ema200;
  } else {
    logger.info("[BURST] Trend filter skipped — insufficient hourly history", {
      symbol: productId, hourlyBars: hourly.length,
    });
  }

  // ── Gate 1: hard block on bearish order book pressure ──────────────────
  if (obSignal === "SELL" || obSignal === "STRONG_SELL") {
    return {
      signal: "SKIP", rsi, rsiMa, bidAskRatio, obSignal,
      aboveTrend, ema200, rsiTurnedUp: false, bullishDivergence: false,
      skipReason: `order book ${obSignal} (ratio ${bidAskRatio.toFixed(2)})`,
    };
  }

  // ── Gate 2: 200-EMA trend filter on 1-hour bars ────────────────────────
  if (REQUIRE_TREND_FILTER && hourly.length >= TREND_EMA_PERIOD && !aboveTrend) {
    return {
      signal: "SKIP", rsi, rsiMa, bidAskRatio, obSignal,
      aboveTrend, ema200, rsiTurnedUp: false, bullishDivergence: false,
      skipReason: `below 200-EMA on 1h (downtrend) — price $${lastHourClose.toPrecision(4)} vs EMA $${ema200.toPrecision(4)}`,
    };
  }

  // RSI required — reject symbols with insufficient history or invalid RSI on both 3m and 5m
  if (closes.length < RSI_PERIOD + 1 || rsi < 0) {
    return {
      signal: "SKIP", rsi, rsiMa, bidAskRatio, obSignal,
      aboveTrend, ema200, rsiTurnedUp: false, bullishDivergence: false,
      skipReason: `RSI unavailable on 3m and 5m (only ${closes.length} ${rsiTimeframe} bars)`,
    };
  }

  const last = closes.length - 1;

  // ── Gate 3: oversold entry — RSI must be below threshold ───────────────
  if (rsi >= RSI_BUY_MAX) {
    return {
      signal: "SKIP", rsi, rsiMa, bidAskRatio, obSignal,
      aboveTrend, ema200, rsiTurnedUp: false, bullishDivergence: false,
      skipReason: `RSI ${rsi.toFixed(1)} ≥ ${RSI_BUY_MAX} (not oversold)`,
    };
  }

  // ── Gate 4: turn-up confirmation ───────────────────────────────────────
  const windowStart = Math.max(1, last - RSI_TURNUP_LOOKBACK + 1);
  let windowMin = Infinity;
  for (let i = windowStart; i <= last; i++) {
    const v = rsiSeries[i];
    if (Number.isFinite(v) && v < windowMin) windowMin = v;
  }
  const prevRsi = rsiSeries[last - 1];
  const rising = Number.isFinite(prevRsi) && rsi > prevRsi;
  const dippedOversold = windowMin <= RSI_OVERSOLD;
  const exitedOversold = rsi > RSI_OVERSOLD;
  const rsiTurnedUp = rising && dippedOversold && exitedOversold;

  if (REQUIRE_RSI_TURN_UP && !rsiTurnedUp) {
    const why = !dippedOversold
      ? `no recent oversold dip (min RSI ${windowMin === Infinity ? "?" : windowMin.toFixed(1)} > ${RSI_OVERSOLD} over last ${RSI_TURNUP_LOOKBACK} bars)`
      : !rising
        ? `RSI still falling (${Number.isFinite(prevRsi) ? prevRsi.toFixed(1) : "?"} → ${rsi.toFixed(1)})`
        : `RSI ${rsi.toFixed(1)} still ≤ ${RSI_OVERSOLD} (not yet exited oversold)`;
    return {
      signal: "SKIP", rsi, rsiMa, bidAskRatio, obSignal,
      aboveTrend, ema200, rsiTurnedUp: false, bullishDivergence: false,
      skipReason: `turn-up not confirmed — ${why}`,
    };
  }

  // ── Boost: bullish RSI divergence ──────────────────────────────────────
  let bullishDivergence = false;
  const divStart = Math.max(SWING_LEFT_RIGHT, last - DIVERGENCE_LOOKBACK_BARS + 1);
  const divCloses = closes.slice(divStart);
  const divRsi    = rsiSeries.slice(divStart);
  const swingIdxs = findSwingLows(divCloses, SWING_LEFT_RIGHT);
  if (swingIdxs.length >= 2) {
    const a = swingIdxs[swingIdxs.length - 2];
    const b = swingIdxs[swingIdxs.length - 1];
    const priceLL = divCloses[b] < divCloses[a];
    const rsiHL   = Number.isFinite(divRsi[a]) && Number.isFinite(divRsi[b]) && divRsi[b] > divRsi[a];
    bullishDivergence = priceLL && rsiHL;
  }

  const obBullish = obSignal === "BUY" || obSignal === "STRONG_BUY";
  const obNeutralOrBetter = obSignal !== "NEUTRAL" ? obBullish : true;
  const upgrade = obBullish || (bullishDivergence && obNeutralOrBetter);
  return {
    signal: upgrade ? "STRONG_BUY" : "BUY",
    rsi, rsiMa, bidAskRatio, obSignal,
    aboveTrend, ema200, rsiTurnedUp, bullishDivergence,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runBurstScanner(): Promise<void> {
  logger.info("[BURST] Starting burst scanner run");

  const tradingConfig = await getTradingConfig();

  // Burst scanner intentionally ignores the user-managed Coinbase allowlist.
  // The DeFi-category filter, price/gain/volume/rank gates, and RSI/EMA/order-book
  // checks already screen candidates; non-Coinbase symbols naturally drop out at the
  // candle-fetch step. Other code paths (mobile UI, TradingView webhooks, /api/trade)
  // still honour `brokerSettings.coinbase.allowedSymbols`.
  // To re-enable for the scanner, restore the Firestore-driven population.
  const coinbaseAllowlist = new Set<string>();

  // Load 30-day cache of symbols known NOT to be tradeable on Coinbase
  // (populated below when candle fetch returns 0 bars — a reliable not-on-CB signal).
  const notOnCbCache = await loadNotOnCoinbaseCache();
  if (notOnCbCache.size > 0) {
    logger.info("[BURST] Loaded notOnCoinbase cache", { size: notOnCbCache.size });
  }

  // Load 90-day cache of symbols permanently excluded by category filters (DeFi etc.)
  const forbiddenCache = await loadForbiddenCache();
  if (forbiddenCache.size > 0) {
    logger.info("[BURST] Loaded forbidden cache", { size: forbiddenCache.size });
  }
  const newForbidden: string[] = [];
  const notOnCbThisRun: string[] = [];

  // Init broker first — needed for Coinbase market data + RSI checks
  const broker = getBroker("coinbase") as CoinbaseBroker;

  // Fetch CoinGecko + Coinbase trending data in parallel
  const [gainers, trendingSymbols, cbMarket] = await Promise.all([
    fetchTopGainers(),
    fetchTrendingSymbols(),
    broker.getMarketGainers(50).catch(() => ({ topGainers: [] as Array<{ productId: string; symbol: string; change24h: number; price: number; volumeUsd: number }> })),
  ]);
  const cbTopSet = new Set(cbMarket.topGainers.map(g => g.symbol.toUpperCase()));

  if (gainers.length === 0) {
    logger.warn("[BURST] No gainers returned from CoinGecko — possible API issue");
    await sendTelegramMessage("⚠️ *Burst Scanner* — CoinGecko returned no data (possible API error).").catch(() => {});
    return;
  }

  // Merge Coinbase-only trending coins (not in CoinGecko top 250) into the candidate pool
  const cgSymbolSet = new Set(gainers.map(g => g.symbol.toUpperCase()));
  for (const cbg of cbMarket.topGainers) {
    if (!cgSymbolSet.has(cbg.symbol.toUpperCase()) && cbg.volumeUsd >= MIN_VOLUME_USD) {
      gainers.push({
        id: "",                          // no CoinGecko ID — fundamental checks skipped
        symbol: cbg.symbol.toLowerCase(),
        name: cbg.symbol,
        usd: cbg.price,
        usd_24h_vol: cbg.volumeUsd,
        usd_24h_change: cbg.change24h,   // 24h change (Coinbase only has 24h; CoinGecko uses 1h)
        market_cap_rank: 0,              // unknown — rank filter bypassed below
      });
    }
  }
  logger.info("[BURST] Merged candidates", { coinGecko: gainers.length - cbMarket.topGainers.length, coinbaseOnly: gainers.filter(g => g.id === "").length });

  // Pre-filter: drop symbols permanently excluded by past category checks (DeFi etc.)
  // saves a CoinGecko /coins/{id} fundamental fetch per cycle.
  if (forbiddenCache.size > 0) {
    const beforeCount = gainers.length;
    for (let i = gainers.length - 1; i >= 0; i--) {
      const pid = `${gainers[i].symbol.toUpperCase()}-USD`;
      if (forbiddenCache.has(pid)) gainers.splice(i, 1);
    }
    if (beforeCount !== gainers.length) {
      logger.info("[BURST] Filtered forbidden (category-excluded) symbols", {
        before: beforeCount, after: gainers.length, dropped: beforeCount - gainers.length,
      });
    }
  }

  // Pre-filter: drop symbols previously confirmed not on Coinbase (30-day TTL).
  if (notOnCbCache.size > 0) {
    const beforeCount = gainers.length;
    for (let i = gainers.length - 1; i >= 0; i--) {
      const pid = `${gainers[i].symbol.toUpperCase()}-USD`;
      if (notOnCbCache.has(pid)) gainers.splice(i, 1);
    }
    if (beforeCount !== gainers.length) {
      logger.info("[BURST] Filtered notOnCoinbase (cached) symbols", {
        before: beforeCount, after: gainers.length, dropped: beforeCount - gainers.length,
      });
    }
  }

  // Collect symbols not on Coinbase so we can cache them for 30 days,
  // and drop them from gainers entirely to avoid wasted work + noise in reports.
  if (coinbaseAllowlist.size > 0) {
    const beforeCount = gainers.length;
    for (let i = gainers.length - 1; i >= 0; i--) {
      const pid = `${gainers[i].symbol.toUpperCase()}-USD`;
      if (!coinbaseAllowlist.has(pid)) {
        if (!notOnCbCache.has(pid)) notOnCbThisRun.push(pid);
        gainers.splice(i, 1);
      }
    }
    logger.info("[BURST] Filtered to Coinbase-tradeable gainers", {
      before: beforeCount, after: gainers.length, newlyCached: notOnCbThisRun.length,
    });
    // Persist new not-on-Coinbase entries (30-day TTL) — fire-and-forget
    if (notOnCbThisRun.length > 0) {
      await addToNotOnCoinbaseCache(notOnCbThisRun);
    }
  }

  // Resolve CoinGecko IDs for Coinbase-only candidates (needed for fundamental checks + categories)
  const cbOnlyGainers = gainers.filter(g => g.id === "");
  if (cbOnlyGainers.length > 0) {
    const resolvedIds = await Promise.all(
      cbOnlyGainers.map(g => searchCoinGeckoId(g.symbol).catch(() => null))
    );
    cbOnlyGainers.forEach((g, i) => {
      if (resolvedIds[i]) g.id = resolvedIds[i]!;
    });
    logger.info("[BURST] Resolved CoinGecko IDs for Coinbase-only coins", {
      resolved: cbOnlyGainers.filter(g => g.id !== "").length,
      unresolved: cbOnlyGainers.filter(g => g.id === "").length,
    });

    // Replace Coinbase's 24h change with CoinGecko's true 1h change for resolved coins
    // (and pull market_cap_rank). Coinbase only reports 24h, but our filter is for 1h.
    const resolved = cbOnlyGainers.filter(g => g.id !== "");
    if (resolved.length > 0) {
      const idsCsv = resolved.map(g => g.id).join(",");
      const markets = await cgGet<CgMarketCoin[]>(
        `/coins/markets?vs_currency=usd&ids=${encodeURIComponent(idsCsv)}&price_change_percentage=1h`
      ).catch(() => null);
      if (markets) {
        const byId = new Map(markets.map(m => [m.id, m]));
        for (const g of resolved) {
          const m = byId.get(g.id);
          if (!m) continue;
          g.usd_24h_change = m.price_change_percentage_1h_in_currency ?? 0; // now actually 1h
          g.market_cap_rank = m.market_cap_rank ?? 0;
        }
        logger.info("[BURST] Refreshed 1h change for Coinbase-only coins", { count: markets.length });
      }
    }

    // Drop Coinbase-only candidates with no resolved CoinGecko ID — their gain is 24h, not 1h
    const unresolvedSymbols = new Set(cbOnlyGainers.filter(g => g.id === "").map(g => g.symbol));
    if (unresolvedSymbols.size > 0) {
      const before = gainers.length;
      for (let i = gainers.length - 1; i >= 0; i--) {
        if (gainers[i].id === "" && unresolvedSymbols.has(gainers[i].symbol)) gainers.splice(i, 1);
      }
      logger.info("[BURST] Dropped Coinbase-only coins without CoinGecko 1h data", { dropped: before - gainers.length });
    }
  }

  // Score and filter candidates (allowlist checked in the loop for reporting)
  const candidates = gainers
    .filter(g => {
      if (g.usd < MIN_PRICE_USD) return false;
      if (g.usd_24h_change < MIN_GAIN_PCT) return false;
      if (g.usd_24h_vol < MIN_VOLUME_USD) return false;
      if (g.market_cap_rank !== 0 && g.market_cap_rank > MAX_MARKET_CAP_RANK) return false;
      return true;
    })
    .map(g => ({
      ...g,
      productId: `${g.symbol.toUpperCase()}-USD`,
      score: g.usd_24h_change + (trendingSymbols.has(g.symbol.toUpperCase()) ? 5 : 0) + (cbTopSet.has(g.symbol.toUpperCase()) ? 3 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  logger.info("[BURST] Scored candidates", { count: candidates.length });

  const MAX_OPEN_POSITIONS = 6;

  if (candidates.length === 0) {
    logger.info("[BURST] No qualifying candidates this run");

    // Show the top 5 movers with rejection reasons + RSI
    const top5Gainers = [...gainers]
      .sort((a, b) => b.usd_24h_change - a.usd_24h_change)
      .slice(0, 5);

    const top5Rsis = await Promise.all(
      top5Gainers.map(g =>
        checkEntrySignal(broker, `${g.symbol.toUpperCase()}-USD`)
          .catch(() => ({
            signal: "BUY" as EntrySignal, rsi: -1, rsiMa: -1, bidAskRatio: 1, obSignal: "NEUTRAL" as OrderBookSignal,
            aboveTrend: true, ema200: -1, rsiTurnedUp: false, bullishDivergence: false,
          }))
      )
    );

    const top5 = top5Gainers.map((g, i) => {
      const pid = `${g.symbol.toUpperCase()}-USD`;
      const rsiVal = top5Rsis[i].rsi;
      const obSig = top5Rsis[i].obSignal;
      const obRatio = top5Rsis[i].bidAskRatio;
      const above = top5Rsis[i].aboveTrend;
      const turned = top5Rsis[i].rsiTurnedUp;
      const div = top5Rsis[i].bullishDivergence;
      const rsiStr = rsiVal >= 0 ? `RSI=${rsiVal.toFixed(0)}` : "RSI=N/A";
      const obStr = `OB=${obSig}(${obRatio.toFixed(2)})`;
      const trendStr = above ? "trend✓" : "trend✗";
      const reasons: string[] = [];
      if (g.usd < MIN_PRICE_USD)                   reasons.push(`price $${g.usd} < $${MIN_PRICE_USD} (sub-penny)`);
      if (g.usd_24h_change < MIN_GAIN_PCT)         reasons.push(`1h gain ${g.usd_24h_change.toFixed(2)}% < ${MIN_GAIN_PCT}%`);
      if (g.usd_24h_vol < MIN_VOLUME_USD)           reasons.push(`vol $${(g.usd_24h_vol/1_000).toFixed(0)}K < $${(MIN_VOLUME_USD/1_000).toFixed(0)}K`);
      if (g.market_cap_rank !== 0 && g.market_cap_rank > MAX_MARKET_CAP_RANK)  reasons.push(`rank ${g.market_cap_rank} > ${MAX_MARKET_CAP_RANK}`);
      if (coinbaseAllowlist.size > 0 && !coinbaseAllowlist.has(pid)) reasons.push("not in Coinbase allowlist");
      if (obSig === "SELL" || obSig === "STRONG_SELL") reasons.push(`order book ${obSig} (ratio ${obRatio.toFixed(2)})`);
      if (REQUIRE_TREND_FILTER && !above)           reasons.push(`below 200-EMA on 1h (downtrend)`);
      if (rsiVal >= RSI_BUY_MAX)                    reasons.push(`RSI ${rsiVal.toFixed(0)} ≥ ${RSI_BUY_MAX} (not oversold)`);
      if (REQUIRE_RSI_TURN_UP && rsiVal >= 0 && rsiVal < RSI_BUY_MAX && !turned) reasons.push(`RSI turn-up not confirmed`);
      const divStr = div ? " 🔥div" : "";
      const why = reasons.length > 0 ? ` ❌ ${reasons.join(", ")}` : " ✅ passed all filters (NOTE: should have been a candidate — investigate)";
      const priceStr = g.usd != null ? `$${g.usd.toPrecision(4)}` : "$?";
      return `• *${pid}* ${priceStr} 1h=+${g.usd_24h_change.toFixed(2)}% ${rsiStr} ${trendStr} ${obStr}${divStr} vol=$${(g.usd_24h_vol/1_000_000).toFixed(1)}M rank=${g.market_cap_rank}${why}`;
    }).join("\n");

    await sendTelegramMessage(
      `📊 *Burst Scanner* — no qualifying candidates\n\n*Top 5 movers & why skipped:*\n${top5 || "none"}`
    ).catch(() => {});

    // Log top-5 rejected movers for queryability
    const top5Pids = new Set(top5Gainers.map(g => `${g.symbol.toUpperCase()}-USD`));
    const top5Records = top5Gainers.map((g, i) => {
      const pid = `${g.symbol.toUpperCase()}-USD`;
      const rsiVal = top5Rsis[i].rsi;
      const above = top5Rsis[i].aboveTrend;
      const turned = top5Rsis[i].rsiTurnedUp;
      const reasons: string[] = [];
      if (g.usd < MIN_PRICE_USD)                   reasons.push(`price $${g.usd} < $${MIN_PRICE_USD}`);
      if (g.usd_24h_change < MIN_GAIN_PCT)         reasons.push(`1h gain ${g.usd_24h_change.toFixed(2)}% < ${MIN_GAIN_PCT}%`);
      if (g.usd_24h_vol < MIN_VOLUME_USD)           reasons.push(`vol $${(g.usd_24h_vol/1_000).toFixed(0)}K < $${(MIN_VOLUME_USD/1_000).toFixed(0)}K`);
      if (g.market_cap_rank !== 0 && g.market_cap_rank > MAX_MARKET_CAP_RANK)  reasons.push(`rank ${g.market_cap_rank} > ${MAX_MARKET_CAP_RANK}`);
      if (coinbaseAllowlist.size > 0 && !coinbaseAllowlist.has(pid)) reasons.push("not in Coinbase allowlist");
      if (REQUIRE_TREND_FILTER && !above)           reasons.push(`below 200-EMA on 1h (downtrend)`);
      if (rsiVal >= RSI_BUY_MAX)                    reasons.push(`RSI ${rsiVal.toFixed(0)} ≥ ${RSI_BUY_MAX} (not oversold)`);
      if (REQUIRE_RSI_TURN_UP && rsiVal >= 0 && rsiVal < RSI_BUY_MAX && !turned) reasons.push(`RSI turn-up not confirmed`);
      const reason = reasons[0] ?? "no qualifying candidates";
      return {
        source: "burst_scanner" as const,
        outcome: "REJECTED" as const,
        action: "BUY" as const,
        symbol: pid,
        price: g.usd,
        reason,
        expression: `price=$${g.usd} | gain1h=+${g.usd_24h_change.toFixed(2)}% | vol=$${(g.usd_24h_vol/1_000).toFixed(0)}K | rank=${g.market_cap_rank}${rsiVal >= 0 ? ` | RSI=${rsiVal.toFixed(0)}` : ""} → ${reasons.join("; ") || "below cohort threshold"}`,
        params: {
          price: g.usd,
          gain1h: +g.usd_24h_change.toFixed(2),
          volume_usd: g.usd_24h_vol,
          market_cap_rank: g.market_cap_rank,
          rsi: rsiVal >= 0 ? +rsiVal.toFixed(1) : null,
          top5: true,
        },
      };
    });

    // Log lightweight rejection records for every other gainer scanned this run
    // (no RSI/order-book — those calls are reserved for top-5 to avoid blowing
    // CoinGecko/Coinbase rate limits). These records make the decision dataset
    // consistent across "normal" and "no-candidate" runs.
    const restRecords = gainers
      .filter(g => !top5Pids.has(`${g.symbol.toUpperCase()}-USD`))
      .map(g => {
        const pid = `${g.symbol.toUpperCase()}-USD`;
        const reasons: string[] = [];
        if (g.usd < MIN_PRICE_USD)                   reasons.push(`price $${g.usd} < $${MIN_PRICE_USD}`);
        if (g.usd_24h_change < MIN_GAIN_PCT)         reasons.push(`1h gain ${g.usd_24h_change.toFixed(2)}% < ${MIN_GAIN_PCT}%`);
        if (g.usd_24h_vol < MIN_VOLUME_USD)          reasons.push(`vol $${(g.usd_24h_vol/1_000).toFixed(0)}K < $${(MIN_VOLUME_USD/1_000).toFixed(0)}K`);
        if (g.market_cap_rank !== 0 && g.market_cap_rank > MAX_MARKET_CAP_RANK) reasons.push(`rank ${g.market_cap_rank} > ${MAX_MARKET_CAP_RANK}`);
        if (coinbaseAllowlist.size > 0 && !coinbaseAllowlist.has(pid))         reasons.push("not in Coinbase allowlist");
        const reason = reasons[0] ?? "below cohort threshold";
        return {
          source: "burst_scanner" as const,
          outcome: "REJECTED" as const,
          action: "BUY" as const,
          symbol: pid,
          price: g.usd,
          reason,
          expression: `price=$${g.usd} | gain1h=+${g.usd_24h_change.toFixed(2)}% | vol=$${(g.usd_24h_vol/1_000).toFixed(0)}K | rank=${g.market_cap_rank} → ${reasons.join("; ") || "below cohort threshold"}`,
          params: {
            price: g.usd,
            gain1h: +g.usd_24h_change.toFixed(2),
            volume_usd: g.usd_24h_vol,
            market_cap_rank: g.market_cap_rank,
            rsi: null,
            top5: false,
          },
        };
      });

    await logDecisions([...top5Records, ...restRecords]).catch(() => {});
    return;
  }

  // Fetch open Coinbase positions — skip entire run if at max capacity
  const heldSymbols = new Set<string>();
  try {
    if (broker.getDetailedPositions) {
      const positions = await broker.getDetailedPositions();
      for (const p of positions) {
        heldSymbols.add(p.symbol.toUpperCase());
      }
      if (positions.length >= MAX_OPEN_POSITIONS) {
        logger.info("[BURST] Max open positions reached — skipping run", { count: positions.length });
        await sendTelegramMessage(`⏸ *Burst Scanner* — skipped (${positions.length}/${MAX_OPEN_POSITIONS} positions open).`).catch(() => {});
        return;
      }
    }
  } catch (err) {
    logger.warn("[BURST] Could not fetch positions (non-fatal)", { error: String(err) });
  }

  // NOTE: stop loss / take profit are intentionally NOT set on burst orders.
  // The position monitor handles exits via RSI: liquidate on RSI<30 (cut) or RSI≥70 (take profit).
  void tradingConfig;

  const bought: Array<{
    id: string; signal: EntrySignal; rsi: number; ratio: number; obSignal: OrderBookSignal;
    gain: number; vol: number; rank: number; score: number;
    cgTrending: boolean; cbTrending: boolean;
    change7d?: number; athChangePct?: number; fdvRatio?: number;
    categories: string[];
  }> = [];
  const skipped: Array<{ productId: string; gain: number; vol: number; rank: number; reason: string; rsi?: number; obSignal?: OrderBookSignal; ratio?: number; categories?: string[] }> = [];
  const cgIdMap = new Map(candidates.map(c => [c.productId, c.id]));

  // ─── VIP Strong Buys ──────────────────────────────────────────────────────
  // Strategy webhook + bulltrend correlation produces Strong Buy signals that bypass
  // all burst entry rules (gain/volume/rank/RSI/order-book/fundamentals). The only
  // guards that still apply: forbidden category, already-holding, cooldown, and the
  // run-wide caps (MAX_OPEN_POSITIONS, MAX_BUYS_PER_RUN). Processed BEFORE regular
  // gainer candidates so VIPs get priority on the per-run buy budget.
  const vipBought: Array<{ id: string; signalId: string; price: number; categories: string[]; bulltrendPrice?: number; bulltrendVolume?: number }> = [];
  const vipSkipped: Array<{ productId: string; signalId: string; reason: string }> = [];
  const vipPending = await fetchPendingStrongBuys();
  if (vipPending.length > 0) {
    logger.info("[BURST] VIP Strong Buys found", { count: vipPending.length, symbols: vipPending.map(v => v.productId) });
  }

  for (const vip of vipPending) {
    if (vipBought.length + bought.length >= MAX_BUYS_PER_RUN) {
      logger.info("[BURST] VIP queue paused — MAX_BUYS_PER_RUN reached", { remaining: vipPending.length - vipBought.length - vipSkipped.length });
      break;
    }
    if (heldSymbols.size + vipBought.length >= MAX_OPEN_POSITIONS) {
      logger.info("[BURST] VIP queue paused — MAX_OPEN_POSITIONS reached", { held: heldSymbols.size, vipBought: vipBought.length });
      break;
    }

    const { productId, symbol: bareSymbol, signalId, signal: vipSignal, price: vipPrice } = vip;

    // Forbidden category check — cache first, then resolve via CG if needed.
    // Fail-open on CG outage: Strong Buy implies high confidence; don't block on third-party failure.
    let vipCategories: string[] = [];
    if (forbiddenCache.has(productId)) {
      logger.info("[BURST] VIP SKIP: forbidden cache hit", { signalId, symbol: productId });
      vipSkipped.push({ productId, signalId, reason: "forbidden category (cached)" });
      await db.collection("signals").doc(signalId).update({
        status: "REJECTED",
        statusMessage: "VIP rejected: forbidden category (cached)",
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
      continue;
    }
    try {
      const cgId = await searchCoinGeckoId(bareSymbol).catch(() => null);
      if (cgId) {
        const detail = await fetchCoinDetail(cgId);
        if (detail) {
          vipCategories = detail.categories ?? [];
          const matched = vipCategories.filter(c => FORBIDDEN_CATEGORY_REGEX.test(c));
          if (matched.length > 0) {
            logger.info("[BURST] VIP SKIP: forbidden category", { signalId, symbol: productId, matched });
            vipSkipped.push({ productId, signalId, reason: `forbidden category excluded (${matched.join(", ")})` });
            if (!forbiddenCache.has(productId)) newForbidden.push(productId);
            await db.collection("signals").doc(signalId).update({
              status: "REJECTED",
              statusMessage: `VIP rejected: forbidden category (${matched.join(", ")})`,
              updatedAt: FieldValue.serverTimestamp(),
            }).catch(() => {});
            continue;
          }
        }
      }
    } catch (err) {
      logger.warn("[BURST] VIP category lookup failed — failing open", { signalId, symbol: productId, error: String(err) });
    }

    // Already holding
    if (heldSymbols.has(productId) || heldSymbols.has(bareSymbol.toUpperCase())) {
      logger.info("[BURST] VIP SKIP: already holding", { signalId, symbol: productId });
      vipSkipped.push({ productId, signalId, reason: "already holding this position" });
      await db.collection("signals").doc(signalId).update({
        status: "REJECTED",
        statusMessage: "VIP rejected: already holding",
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
      continue;
    }

    // Cooldown
    if (await isInCooldown(productId)) {
      logger.info("[BURST] VIP SKIP: in cooldown", { signalId, symbol: productId });
      vipSkipped.push({ productId, signalId, reason: `in cooldown (< ${COOLDOWN_HOURS}h since last buy)` });
      await db.collection("signals").doc(signalId).update({
        status: "REJECTED",
        statusMessage: "VIP rejected: in cooldown",
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
      continue;
    }

    // Flip to APPROVED so executeOrder is happy; broker placement updates status onward.
    try {
      await db.collection("signals").doc(signalId).update({
        status: "APPROVED",
        statusMessage: "VIP approved by burst scanner",
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      logger.error("[BURST] VIP failed to flip status APPROVED", { signalId, error: String(err) });
      vipSkipped.push({ productId, signalId, reason: "status update failed" });
      continue;
    }

    // executeOrder uses signal.symbol → broker placement. Override the symbol on the
    // payload we pass so Coinbase sees the product id (e.g. ETH-USD), not "ETHUSD".
    const orderSignal: Signal = { ...vipSignal, id: signalId, symbol: productId, status: "APPROVED" };

    logger.info("[BURST] VIP executing order", { signalId, symbol: productId, price: vipPrice });
    try {
      const result = await executeOrder(orderSignal, BURST_USER_ID);
      logger.info("[BURST] VIP order result", { signalId, symbol: productId, status: result.status });
      if (result.status === "executed") {
        try {
          await sendBurstBuyNotification(productId, vipPrice, signalId);
        } catch (notifErr) {
          logger.warn("[BURST] VIP push notification failed (non-fatal)", { signalId, symbol: productId, error: String(notifErr) });
        }
        vipBought.push({
          id: productId,
          signalId,
          price: vipPrice,
          categories: vipCategories,
          bulltrendPrice: vipSignal.bulltrendPrice,
          bulltrendVolume: vipSignal.bulltrendVolume,
        });
        heldSymbols.add(productId);
        heldSymbols.add(bareSymbol.toUpperCase());
        await setCooldown(productId);
      } else {
        vipSkipped.push({ productId, signalId, reason: `executeOrder: ${result.status}` });
      }
    } catch (err) {
      logger.error("[BURST] VIP executeOrder threw", { signalId, symbol: productId, error: String(err) });
      vipSkipped.push({ productId, signalId, reason: "executeOrder error" });
    }
  }

  for (const candidate of candidates) {
    if (bought.length + vipBought.length >= MAX_BUYS_PER_RUN) break;

    const { productId, symbol, usd: price, score, usd_24h_change, usd_24h_vol, market_cap_rank } = candidate;

    // Skip if not in the Coinbase allowlist
    if (coinbaseAllowlist.size > 0 && !coinbaseAllowlist.has(productId)) {
      logger.info("[BURST] Not in allowlist — skipping", { symbol: productId });
      skipped.push({ productId, gain: usd_24h_change, vol: usd_24h_vol, rank: market_cap_rank, reason: "not in Coinbase allowlist" });
      continue;
    }

    // Skip if already holding this symbol
    if (heldSymbols.has(productId) || heldSymbols.has(symbol.toUpperCase())) {
      logger.info("[BURST] Already holding — skipping", { symbol: productId });
      skipped.push({ productId, gain: usd_24h_change, vol: usd_24h_vol, rank: market_cap_rank, reason: "already holding this position" });
      continue;
    }

    // Skip if in cooldown
    if (await isInCooldown(productId)) {
      logger.info("[BURST] In cooldown — skipping", { symbol: productId });
      skipped.push({ productId, gain: usd_24h_change, vol: usd_24h_vol, rank: market_cap_rank, reason: `in cooldown (< ${COOLDOWN_HOURS}h since last buy)` });
      continue;
    }

    // Fundamental checks via /coins/{id}: 7d trend, ATH proximity, FDV/MCap ratio
    // Coinbase-sourced candidates (id="") have no CoinGecko ID — skip these checks
    let fundChange7d: number | undefined;
    let fundAthChange: number | undefined;
    let fundFdvRatio: number | undefined;
    let fundCategories: string[] = [];
    try {
      const detail = candidate.id ? await fetchCoinDetail(candidate.id) : null;
      if (detail) {
        const md = detail.market_data;
        const change7d     = md.price_change_percentage_7d ?? 0;
        const athChangePct = md.ath_change_percentage?.usd ?? -50; // negative = below ATH
        const mcap         = md.market_cap?.usd ?? 0;
        const fdv          = md.fully_diluted_valuation?.usd ?? 0;
        const fdvRatio     = mcap > 0 ? fdv / mcap : 1;

        const cats = detail.categories ?? [];
        // Hard skip: ignore any coin tagged as DeFi or Meme (per user preference —
        // these segments tend to bleed faster on short-horizon bursts and carry
        // unique risk profiles). Matched symbols are added to the forbidden cache.
        const forbiddenMatched = cats.filter(c => FORBIDDEN_CATEGORY_REGEX.test(c));
        if (forbiddenMatched.length > 0) {
          logger.info("[BURST] Category SKIP: forbidden", { symbol: productId, matched: forbiddenMatched });
          skipped.push({ productId, gain: usd_24h_change, vol: usd_24h_vol, rank: market_cap_rank, reason: `forbidden category excluded (${forbiddenMatched.join(", ")})`, categories: cats });
          if (!forbiddenCache.has(productId)) newForbidden.push(productId);
          continue;
        }
        const burstOverride = usd_24h_change >= BURST_OVERRIDE_1H_GAIN_PCT && usd_24h_vol >= BURST_OVERRIDE_MIN_VOLUME;
        if (change7d < MAX_7D_DROP_PCT && !burstOverride) {
          logger.info("[BURST] Fundamental SKIP: 7d drop", { symbol: productId, change7d });
          skipped.push({ productId, gain: usd_24h_change, vol: usd_24h_vol, rank: market_cap_rank, reason: `7d trend ${change7d.toFixed(1)}% < ${MAX_7D_DROP_PCT}% (downtrending)`, categories: cats });
          continue;
        }
        if (change7d < MAX_7D_DROP_PCT && burstOverride) {
          logger.info("[BURST] 7d downtrend override: strong burst on oversold coin", {
            symbol: productId,
            change7d: change7d.toFixed(1),
            gain1h: usd_24h_change.toFixed(2),
            vol: usd_24h_vol,
          });
        }
        // athChangePct is negative (e.g. -5 means 5% below ATH)
        if (athChangePct > -MIN_ATH_DISTANCE_PCT) {
          logger.info("[BURST] Fundamental SKIP: near ATH", { symbol: productId, athChangePct });
          skipped.push({ productId, gain: usd_24h_change, vol: usd_24h_vol, rank: market_cap_rank, reason: `too close to ATH (${athChangePct.toFixed(1)}%, need ≤ -${MIN_ATH_DISTANCE_PCT}%)`, categories: cats });
          continue;
        }
        if (fdvRatio > MAX_FDV_MCAP_RATIO) {
          logger.info("[BURST] Fundamental SKIP: high FDV/MCap", { symbol: productId, fdvRatio: fdvRatio.toFixed(2) });
          skipped.push({ productId, gain: usd_24h_change, vol: usd_24h_vol, rank: market_cap_rank, reason: `FDV/MCap ${fdvRatio.toFixed(1)}× > ${MAX_FDV_MCAP_RATIO}× (unlock pressure)`, categories: cats });
          continue;
        }

        // All fundamentals passed — capture for buy record
        fundChange7d  = change7d;
        fundAthChange = athChangePct;
        fundFdvRatio  = fdvRatio;
        fundCategories = cats;

        logger.info("[BURST] Fundamental OK", {
          symbol: productId,
          change7d: change7d.toFixed(1),
          athChangePct: athChangePct.toFixed(1),
          fdvRatio: fdvRatio.toFixed(2),
        });
      }
    } catch (err) {
      logger.warn("[BURST] Fundamental check failed — proceeding", { symbol: productId, error: String(err) });
    }

    // Check RSI-14 on 3-min candles vs 9-SMA, and order book pressure, before committing
    let entryResult: EntryResult;
    try {
      entryResult = await checkEntrySignal(broker, productId);
    } catch (err) {
      logger.warn("[BURST] Entry signal check failed — treating as BUY", { symbol: productId, error: String(err) });
      entryResult = {
        signal: "BUY", rsi: -1, rsiMa: -1, bidAskRatio: 1, obSignal: "NEUTRAL",
        aboveTrend: true, ema200: -1, rsiTurnedUp: false, bullishDivergence: false,
      };
    }

    if (entryResult.signal === "SKIP") {
      logger.info("[BURST] Entry signal SKIP", {
        symbol: productId,
        rsi: entryResult.rsi.toFixed(1),
        rsiMa: entryResult.rsiMa.toFixed(1),
        bidAskRatio: entryResult.bidAskRatio.toFixed(2),
        obSignal: entryResult.obSignal,
        aboveTrend: entryResult.aboveTrend,
        reason: entryResult.skipReason,
      });
      const skipReason = entryResult.skipReason
        ?? `RSI ${entryResult.rsi.toFixed(1)} ≤ MA ${entryResult.rsiMa.toFixed(1)} (bearish on 3m)`;
      // Detect symbols not on Coinbase: zero candles returned by candle fetch.
      if (ZERO_CANDLES_SKIP_REGEX.test(skipReason) && !notOnCbCache.has(productId)) {
        notOnCbThisRun.push(productId);
      }
      skipped.push({ productId, gain: usd_24h_change, vol: usd_24h_vol, rank: market_cap_rank, reason: skipReason, rsi: entryResult.rsi, obSignal: entryResult.obSignal, ratio: entryResult.bidAskRatio });
      continue;
    }

    logger.info("[BURST] Entry signal OK", {
      symbol: productId,
      signal: entryResult.signal,
      rsi: entryResult.rsi.toFixed(1),
      rsiMa: entryResult.rsiMa.toFixed(1),
      bidAskRatio: entryResult.bidAskRatio.toFixed(2),
      obSignal: entryResult.obSignal,
      aboveTrend: entryResult.aboveTrend,
      rsiTurnedUp: entryResult.rsiTurnedUp,
      bullishDivergence: entryResult.bullishDivergence,
    });

    const idempotencyKey = `burst-${productId}-${Date.now()}`;

    const signalData: Omit<Signal, "id"> = {
      strategy: "burst_scanner",
      symbol: productId,
      action: "BUY",
      timeframe: "1h",
      price,
      // No stopLoss / takeProfit — position monitor liquidates on RSI<30 or RSI≥70
      signalTime: new Date().toISOString(),
      status: "APPROVED",
      idempotencyKey,
      broker: "coinbase",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    let signalId: string;
    try {
      const ref = await db.collection("signals").add(signalData);
      signalId = ref.id;
    } catch (err) {
      logger.error("[BURST] Failed to write signal", { symbol: productId, error: String(err) });
      continue;
    }

    const signal: Signal = { id: signalId, ...signalData };

    logger.info("[BURST] Executing order", {
      symbol: productId,
      price,
      score: score.toFixed(2),
      gain1h: `${usd_24h_change.toFixed(2)}%`,
      signal: entryResult.signal,
    });

    try {
      const result = await executeOrder(signal, BURST_USER_ID);
      logger.info("[BURST] Order result", { symbol: productId, status: result.status });

      if (result.status === "executed") {
        try {
          await sendBurstBuyNotification(productId, price, signalId);
        } catch (notifErr) {
          logger.warn("[BURST] Push notification failed (non-fatal)", { signalId, symbol: productId, error: String(notifErr) });
        }
        bought.push({
          id: productId,
          signal: entryResult.signal,
          rsi: entryResult.rsi,
          ratio: entryResult.bidAskRatio,
          obSignal: entryResult.obSignal,
          gain: usd_24h_change,
          vol: usd_24h_vol,
          rank: market_cap_rank,
          score,
          cgTrending: trendingSymbols.has(symbol.toUpperCase()),
          cbTrending: cbTopSet.has(symbol.toUpperCase()),
          change7d: fundChange7d,
          athChangePct: fundAthChange,
          fdvRatio: fundFdvRatio,
          categories: fundCategories,
        });
        await setCooldown(productId);
      } else {
        skipped.push({ productId, gain: usd_24h_change, vol: usd_24h_vol, rank: market_cap_rank, reason: result.status, rsi: entryResult.rsi });
      }
    } catch (err) {
      logger.error("[BURST] executeOrder threw", { symbol: productId, error: String(err) });
      skipped.push({ productId, gain: usd_24h_change, vol: usd_24h_vol, rank: market_cap_rank, reason: "error", rsi: entryResult.rsi });
    }
  }

  // Enrich skipped items: fetch RSI + categories in parallel for items missing them
  const noRsiItems = skipped.filter(s => s.rsi === undefined);
  const noCatItems = skipped.filter(s => s.categories === undefined);
  await Promise.all([
    ...noRsiItems.map(async (s) => {
      const r = await checkEntrySignal(broker, s.productId)
        .catch(() => ({ rsi: -1, bidAskRatio: 1 }));
      s.rsi = r.rsi;
    }),
    ...noCatItems.map(async (s) => {
      const cgId = cgIdMap.get(s.productId);
      if (!cgId) { s.categories = []; return; }
      const d = await fetchCoinDetail(cgId).catch(() => null);
      s.categories = d?.categories ?? [];
    }),
  ]);

  // Post-enrichment sweep: any skipped item whose categories match the forbidden
  // regex gets added to the cache, even if it was tripped by another check first
  // (7d drop, ATH, cooldown, already-holding, etc.) or if the first CG fetch
  // returned stale/empty categories. This is the safety net for cases where
  // the in-loop check missed the tag.
  for (const s of skipped) {
    if (!s.categories || s.categories.length === 0) continue;
    if (forbiddenCache.has(s.productId) || newForbidden.includes(s.productId)) continue;
    const matched = s.categories.filter(c => FORBIDDEN_CATEGORY_REGEX.test(c));
    if (matched.length > 0) {
      logger.info("[BURST] Post-skip forbidden tag detected", { symbol: s.productId, matched, primaryReason: s.reason });
      newForbidden.push(s.productId);
    }
  }

  // Persist newly-forbidden symbols (DeFi etc.) so future cycles pre-filter them.
  if (newForbidden.length > 0) {
    logger.info("[BURST] Adding to forbidden cache", { count: newForbidden.length, symbols: newForbidden });
    await addToForbiddenCache(newForbidden);
  }

  // Persist newly-discovered not-on-Coinbase symbols (30-day TTL).
  if (notOnCbThisRun.length > 0) {
    logger.info("[BURST] Adding to notOnCoinbase cache", { count: notOnCbThisRun.length, symbols: notOnCbThisRun });
    await addToNotOnCoinbaseCache(notOnCbThisRun);
  }

  // Clarify skip reason for symbols not listed on Coinbase (RSI=N/A means no candle data)
  for (const s of skipped) {
    if (s.rsi === -1 && s.reason === "not in Coinbase allowlist") s.reason = "symbol not listed on Coinbase";
  }

  // ── Persist structured decision logs (queryable from Telegram /decisions) ──
  const decisionRecords: DecisionLogRecord[] = [];
  for (const b of bought) {
    const checks: DecisionCheck[] = [
      { name: "min_gain_pct",      passed: true, expression: `gain1h=+${b.gain.toFixed(2)}% ≥ ${MIN_GAIN_PCT}%`,      actual: +b.gain.toFixed(2),  threshold: MIN_GAIN_PCT },
      { name: "min_volume_usd",    passed: true, expression: `vol=$${(b.vol/1_000).toFixed(0)}K ≥ $${(MIN_VOLUME_USD/1_000).toFixed(0)}K`, actual: b.vol, threshold: MIN_VOLUME_USD },
      { name: "max_market_cap_rank", passed: true, expression: b.rank > 0 ? `rank=${b.rank} ≤ ${MAX_MARKET_CAP_RANK}` : "rank=N/A (coinbase-only)", actual: b.rank, threshold: MAX_MARKET_CAP_RANK },
      { name: "coinbase_allowlist", passed: true, expression: "in Coinbase allowlist" },
      { name: "not_already_held",  passed: true, expression: "not already held" },
      { name: "cooldown",          passed: true, expression: `no active cooldown (>${COOLDOWN_HOURS}h since last buy)` },
      { name: "rsi_oversold_entry", passed: true, expression: b.rsi >= 0 ? `RSI=${b.rsi.toFixed(0)} < ${RSI_BUY_MAX}` : "RSI=N/A", actual: b.rsi, threshold: RSI_BUY_MAX },
    ];
    if (b.change7d   !== undefined) checks.push({ name: "7d_trend",  passed: true, expression: `7d=${b.change7d.toFixed(1)}% ≥ ${MAX_7D_DROP_PCT}%`, actual: +b.change7d.toFixed(2), threshold: MAX_7D_DROP_PCT });
    if (b.athChangePct !== undefined) checks.push({ name: "ath_distance", passed: true, expression: `ATH gap=${b.athChangePct.toFixed(1)}% ≤ -${MIN_ATH_DISTANCE_PCT}%`, actual: +b.athChangePct.toFixed(2), threshold: -MIN_ATH_DISTANCE_PCT });
    if (b.fdvRatio   !== undefined) checks.push({ name: "fdv_mcap_ratio", passed: true, expression: `FDV/MCap=${b.fdvRatio.toFixed(2)}× ≤ ${MAX_FDV_MCAP_RATIO}×`, actual: +b.fdvRatio.toFixed(2), threshold: MAX_FDV_MCAP_RATIO });
    checks.push({ name: "bid_ask_ratio", passed: true, expression: `bid/ask ratio=${b.ratio.toFixed(2)}`, actual: +b.ratio.toFixed(2) });

    decisionRecords.push({
      source: "burst_scanner",
      outcome: "ACCEPTED",
      action: "BUY",
      symbol: b.id,
      reason: `entry=${b.signal} — passed all filters`,
      expression: checks.map(c => c.expression).join(" ∧ "),
      params: {
        gain1h: +b.gain.toFixed(2),
        volume_usd: b.vol,
        market_cap_rank: b.rank,
        rsi: b.rsi >= 0 ? +b.rsi.toFixed(1) : null,
        bid_ask_ratio: +b.ratio.toFixed(2),
        score: +b.score.toFixed(2),
        change_7d: b.change7d !== undefined ? +b.change7d.toFixed(2) : null,
        ath_change_pct: b.athChangePct !== undefined ? +b.athChangePct.toFixed(2) : null,
        fdv_mcap_ratio: b.fdvRatio !== undefined ? +b.fdvRatio.toFixed(2) : null,
        cg_trending: b.cgTrending,
        cb_trending: b.cbTrending,
        categories: b.categories,
        entry_signal: b.signal,
      },
      checks,
    });
  }
  for (const s of skipped) {
    decisionRecords.push({
      source: "burst_scanner",
      outcome: "REJECTED",
      action: "BUY",
      symbol: s.productId,
      reason: s.reason,
      expression: `gain1h=${s.gain >= 0 ? "+" : ""}${s.gain.toFixed(2)}% | vol=$${(s.vol/1_000).toFixed(0)}K | rank=${s.rank}${s.rsi !== undefined && s.rsi >= 0 ? ` | RSI=${s.rsi.toFixed(0)}` : ""} → ${s.reason}`,
      params: {
        gain1h: +s.gain.toFixed(2),
        volume_usd: s.vol,
        market_cap_rank: s.rank,
        rsi: s.rsi !== undefined && s.rsi >= 0 ? +s.rsi.toFixed(1) : null,
        categories: s.categories ?? [],
      },
    });
  }
  await logDecisions(decisionRecords).catch(() => {});

  // Telegram summary
  const lines = ["📈 *Burst Scanner* — run complete"];

  // VIP Strong Buys section — only shown when there's something to report
  if (vipBought.length > 0 || vipSkipped.length > 0) {
    const vipLines: string[] = [];
    if (vipBought.length > 0) {
      const items = vipBought.map(v => {
        const btParts: string[] = [];
        if (v.bulltrendPrice !== undefined) btParts.push(`btPrice=$${v.bulltrendPrice}`);
        if (v.bulltrendVolume !== undefined) btParts.push(`btVol=${v.bulltrendVolume}`);
        const btStr = btParts.length > 0 ? ` (${btParts.join(", ")})` : "";
        const catStr = v.categories.length > 0 ? `\n    🏷 ${v.categories.slice(0, 3).join(", ")}` : "";
        return `• *${v.id}* @ $${v.price}${btStr}${catStr}`;
      });
      vipLines.push(`✨ *VIP Bought (Strong Buy):*\n${items.join("\n")}`);
    }
    if (vipSkipped.length > 0) {
      const items = vipSkipped.map(v => `• *${v.productId}* ❌ ${v.reason}`);
      vipLines.push(`✨ *VIP Skipped (Strong Buy):*\n${items.join("\n")}`);
    }
    lines.push(vipLines.join("\n"));
  }
  if (bought.length > 0) {
    const boughtLines = bought.map(b => {
      const rsiStr   = b.rsi >= 0 ? `RSI=${b.rsi.toFixed(0)}` : "RSI=N/A";
      const volStr   = b.vol >= 1_000_000 ? `$${(b.vol/1_000_000).toFixed(1)}M` : `$${(b.vol/1_000).toFixed(0)}K`;
      const trendParts: string[] = [];
      if (b.cgTrending) trendParts.push("CoinGecko");
      if (b.cbTrending) trendParts.push("Coinbase");
      const trendStr = trendParts.length > 0 ? ` trending=${trendParts.join("+")}` : "";
      const fundParts: string[] = [];
      if (b.change7d   !== undefined) fundParts.push(`7d=${b.change7d >= 0 ? "+" : ""}${b.change7d.toFixed(1)}%`);
      if (b.athChangePct !== undefined) fundParts.push(`ATH=${b.athChangePct.toFixed(1)}%`);
      if (b.fdvRatio   !== undefined) fundParts.push(`FDV=${b.fdvRatio.toFixed(1)}x`);
      const fundStr  = fundParts.length > 0 ? `\n    📐 ${fundParts.join(" | ")}` : "";
      const catStr   = b.categories.length > 0 ? `\n    🏷 ${b.categories.slice(0, 3).join(", ")}` : "";

      // Explicit list of checks that passed for this buy
      const checks: string[] = [];
      checks.push(`1h gain ${b.gain.toFixed(2)}% ≥ ${MIN_GAIN_PCT}%`);
      checks.push(`vol ${volStr} ≥ $${(MIN_VOLUME_USD/1_000).toFixed(0)}K`);
      if (b.rank > 0) checks.push(`rank ${b.rank} ≤ ${MAX_MARKET_CAP_RANK}`);
      checks.push("in Coinbase allowlist");
      checks.push("not already held");
      checks.push("no active cooldown");
      if (b.change7d   !== undefined) checks.push(`7d ${b.change7d.toFixed(1)}% ≥ ${MAX_7D_DROP_PCT}%`);
      if (b.athChangePct !== undefined) checks.push(`ATH gap ${b.athChangePct.toFixed(1)}% ≤ -${MIN_ATH_DISTANCE_PCT}%`);
      if (b.fdvRatio   !== undefined) checks.push(`FDV/MCap ${b.fdvRatio.toFixed(1)}× ≤ ${MAX_FDV_MCAP_RATIO}×`);
      if (b.rsi >= 0) checks.push(`RSI ${b.rsi.toFixed(0)} < ${RSI_BUY_MAX} (oversold entry)`);
      checks.push(`bid/ask ratio ${b.ratio.toFixed(2)}`);
      const checksStr = `\n    ✅ ${checks.join("\n    ✅ ")}`;

      return (
        `• *${b.id}* [${b.signal}]\n` +
        `    📊 1h=+${b.gain.toFixed(2)}% | ${rsiStr} | OB=${b.obSignal}(${b.ratio.toFixed(2)}) | vol=${volStr} | rank=${b.rank} | score=${b.score.toFixed(1)}${trendStr}` +
        fundStr + catStr + checksStr
      );
    });
    lines.push(`✅ *Bought:*\n${boughtLines.join("\n\n")}`);
  } else if (vipBought.length >= MAX_BUYS_PER_RUN) {
    lines.push(`⏸ Regular scan skipped — VIP cap reached (${vipBought.length}/${MAX_BUYS_PER_RUN}); ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} not evaluated`);
  } else if (vipBought.length > 0) {
    lines.push(`⏭ No additional non-VIP buys this run (${vipBought.length} VIP filled ${vipBought.length}/${MAX_BUYS_PER_RUN} cap slot${vipBought.length === 1 ? "" : "s"})`);
  } else {
    lines.push("⏭ No buys executed this run");
  }
  if (skipped.length > 0) {
    // Cap to top 15 by absolute gain so the message stays under Telegram's 4096-char limit
    const topSkipped = [...skipped]
      .sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain))
      .slice(0, 15);
    const skippedLines = topSkipped.map(s => {
      const rsiVal = s.rsi ?? -1;
      const rsiStr = rsiVal >= 0 ? `RSI=${rsiVal.toFixed(0)}` : "RSI=N/A";
      const obStr = s.obSignal ? ` OB=${s.obSignal}(${(s.ratio ?? 0).toFixed(2)})` : "";
      const volStr = s.vol >= 1_000_000 ? `$${(s.vol / 1_000_000).toFixed(1)}M` : `$${(s.vol / 1_000).toFixed(0)}K`;
      const cats = s.categories && s.categories.length > 0 ? ` [${s.categories.slice(0, 2).join(", ")}]` : "";
      return `• *${s.productId}* 1h=${s.gain >= 0 ? "+" : ""}${s.gain.toFixed(2)}% ${rsiStr}${obStr} vol=${volStr} rank=${s.rank}${cats} ❌ ${s.reason}`;
    });
    const truncatedSuffix = skipped.length > topSkipped.length
      ? `\n…and ${skipped.length - topSkipped.length} more skipped (truncated for Telegram length).`
      : "";
    lines.push(`⏩ *Skipped (top ${topSkipped.length} of ${skipped.length}):*\n${skippedLines.join("\n")}${truncatedSuffix}`);
  }

  try {
    await sendTelegramMessage(lines.join("\n"));
  } catch (err) {
    logger.error("[BURST] Failed to send Telegram summary", { error: String(err), messageLen: lines.join("\n").length });
  }
}
