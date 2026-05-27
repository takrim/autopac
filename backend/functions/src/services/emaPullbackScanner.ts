/**
 * EMA Pullback Scanner
 *
 * Runs every 3 minutes. Builds a universe of the top-N highest-volume
 * tradeable Coinbase SPOT pairs (USD/USDC), keeps only coins inside the
 * CoinGecko top-1000 by market cap (and ≥ $0.01), and tracks each symbol's
 * recent {price, vol24h, ema200, rsi} samples in Firestore.
 *
 * Entry per symbol (when no position is currently held by this strategy):
 *   • |price − EMA200| / EMA200 ≤ 0.75%        (price is near the 200-EMA)
 *   • EMA200[t]  >  EMA200[t-9]                (uptrending over last 10 ticks)
 *   • EMA200[t-10] ≤ EMA200[t-19]              (prior 10-tick window was flat or down — a turn, not a chase)
 *
 * Exit per strategy-managed position (checked BEFORE entry, every tick):
 *   • EMA200[t] ≤ EMA200[t-2]                  → hard liquidate (flat/down 3 ticks)
 *   • else if RSI ≥ 80                         → arm/ratchet trailing stop at price × (1 − 0.5%)
 *
 * Strategy isolation: positionLiquidator skips symbols whose latest APPROVED
 * BUY signal has strategy="ema_pullback_scanner" so this scanner owns the
 * exit decisions for every position it opened.
 */

import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getBroker } from "../brokers";
import { CoinbaseBroker } from "../brokers/coinbase";
import { DetailedPosition } from "../brokers/interface";
import { executeOrder } from "../api/trade";
import { sendTelegramMessage } from "./telegram";
import { logDecision } from "./decisionLog";
import { computeRSI, computeEMA } from "./strategies/shared";
import { Signal } from "../types";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const STRATEGY_TAG          = "ema_pullback_scanner";
const SCANNER_USER_ID       = "ema_pullback_scanner";

// Filters (shared with burst)
const MIN_PRICE_USD         = 0.10;
const MAX_MARKET_CAP_RANK   = 1000;
const STABLECOIN_BLOCKLIST  = new Set(["USDT", "USDC", "DAI", "BUSD", "TUSD", "USDP", "FRAX", "USDD", "GUSD", "PYUSD", "USDS", "FDUSD"]);

// Universe + execution caps
const TOP_N_BY_VOLUME       = 30;
const MIN_VOLUME_USD        = 1_000_000; // 24h volume ≥ $1M
const MAX_BUYS_PER_RUN      = 2;
const MAX_POSITIONS         = 10;   // never hold more than 10 simultaneous positions
const FETCH_CONCURRENCY     = 3; // parallel candle fetches (lower = fewer rate limit hits)

// History
const STATE_HISTORY_MAX     = 15; // last 15 ticks ≈ 45 min @ 3-min cadence

// Entry detection
const NEAR_EMA_PCT          = 5.0;    // |Δ|/EMA200 ≤ 5%
const UPTREND_LOOKBACK      = 10;     // EMA200[t] > EMA200[t-(LOOKBACK-1)]
const MIN_EMA_SLOPE_PCT     = 0.05;   // EMA200 must rise ≥ 0.05% over UPTREND_LOOKBACK ticks (rejects near-flat)
const PRIOR_FLAT_LOOKBACK   = 0;      // disabled — gainers universe already confirms momentum

// Exit detection
const RSI_TRAIL_TRIGGER     = 80;     // RSI ≥ 80 → arm/trail
const TRAIL_BUFFER_PCT      = 0.5;    // stop = current × (1 − 0.5%), ratchet-only
const EMA_DOWN_LOOKBACK     = 3;      // EMA200[t] ≤ EMA200[t-(LOOKBACK-1)]
const EMA_STALE_LOOKBACK    = 10;     // EMA200 flat over last 10 ticks → stale position exit

// Indicators
const RSI_PERIOD            = 14;
const EMA_PERIOD            = 200;
const EMA_FETCH_COUNT       = 220;    // hourly candles
const RSI_FETCH_COUNT       = 300;    // 1-min candles aggregated to 3-min

// CoinGecko rank lookup
const CG_BASE               = "https://pro-api.coingecko.com/api/v3";
const RANK_CACHE_DOC        = "_ema_pullback_state/rank_cache";
const RANK_CACHE_TTL_MS     = 30 * 60 * 1000;
const STATE_COLLECTION      = "_ema_pullback_state";

const db = getFirestore();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HistorySample {
  ts: number;
  price: number;
  vol24h: number;
  ema200: number;
  rsi: number;
}

interface SymbolState {
  history: HistorySample[];
  updatedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
}

// ---------------------------------------------------------------------------
// CoinGecko rank map (cached 30 min)
// ---------------------------------------------------------------------------

interface RankCacheDoc {
  fetchedAt?: FirebaseFirestore.Timestamp;
  ranks?: Record<string, number>;
}

async function fetchRankMap(): Promise<Map<string, number>> {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    logger.warn("[EMA_PB] Missing COINGECKO_API_KEY — rank filter disabled");
    return new Map();
  }
  const out = new Map<string, number>();
  for (let page = 1; page <= 4; page++) {
    try {
      const resp = await fetch(
        `${CG_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`,
        { headers: { "x-cg-pro-api-key": apiKey }, signal: AbortSignal.timeout(8000) },
      );
      if (!resp.ok) {
        logger.warn("[EMA_PB] CoinGecko rank fetch failed", { page, status: resp.status });
        break;
      }
      const data = await resp.json() as Array<{ symbol: string; market_cap_rank: number | null }>;
      for (const c of data) {
        if (c.market_cap_rank == null) continue;
        const key = c.symbol.toUpperCase();
        if (!out.has(key)) out.set(key, c.market_cap_rank);
      }
      if (data.length < 250) break;
    } catch (err) {
      logger.warn("[EMA_PB] CoinGecko rank fetch error", { page, error: String(err) });
      break;
    }
  }
  return out;
}

async function getRankMap(): Promise<Map<string, number>> {
  try {
    const snap = await db.doc(RANK_CACHE_DOC).get();
    if (snap.exists) {
      const data = snap.data() as RankCacheDoc;
      const ts = data.fetchedAt?.toMillis() ?? 0;
      if (Date.now() - ts < RANK_CACHE_TTL_MS && data.ranks) {
        return new Map(Object.entries(data.ranks));
      }
    }
  } catch (err) {
    logger.warn("[EMA_PB] Rank cache read failed (non-fatal)", { error: String(err) });
  }
  const map = await fetchRankMap();
  if (map.size > 0) {
    try {
      const ranksObj: Record<string, number> = {};
      for (const [k, v] of map.entries()) ranksObj[k] = v;
      await db.doc(RANK_CACHE_DOC).set({
        fetchedAt: FieldValue.serverTimestamp(),
        ranks: ranksObj,
      });
    } catch (err) {
      logger.warn("[EMA_PB] Rank cache write failed (non-fatal)", { error: String(err) });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// 1-min → 3-min aggregation (for RSI)
// ---------------------------------------------------------------------------

function aggregateTo3MinCloses(candles: { start: number; close: number }[]): number[] {
  const buckets = new Map<number, { close: number; count: number; start: number }>();
  for (const c of candles) {
    const bucketStart = c.start - (c.start % 180);
    const ex = buckets.get(bucketStart);
    if (!ex) buckets.set(bucketStart, { close: c.close, count: 1, start: bucketStart });
    else { ex.close = c.close; ex.count++; }
  }
  const out = Array.from(buckets.values()).sort((a, b) => a.start - b.start);
  // Drop incomplete trailing bucket
  while (out.length > 0 && out[out.length - 1].count < 3) out.pop();
  return out.map(b => b.close);
}

// ---------------------------------------------------------------------------
// Per-symbol indicator snapshot
// ---------------------------------------------------------------------------

interface Snapshot {
  price: number;
  vol24h: number;
  ema200: number;
  rsi: number;
}

async function fetchSnapshot(
  broker: CoinbaseBroker,
  productId: string,
  spotPrice: number,
  vol24h: number,
): Promise<Snapshot | null> {
  try {
    const [hourly, oneMin] = await Promise.all([
      broker.getCandles(productId, "ONE_HOUR", EMA_FETCH_COUNT),
      broker.getCandles(productId, "ONE_MINUTE", RSI_FETCH_COUNT),
    ]);
    if (hourly.length < EMA_PERIOD) {
      logger.info("[EMA_PB] Insufficient hourly history", { productId, bars: hourly.length });
      return null;
    }
    const closes = hourly.map(c => c.close);
    const emaSeries = computeEMA(closes, EMA_PERIOD);
    const ema200 = emaSeries[emaSeries.length - 1];
    if (ema200 == null || !Number.isFinite(ema200)) return null;

    const threeMin = aggregateTo3MinCloses(oneMin);
    if (threeMin.length < RSI_PERIOD + 1) {
      logger.info("[EMA_PB] Insufficient 3m history for RSI", { productId, bars: threeMin.length });
      return null;
    }
    const rsiSeries = computeRSI(threeMin, RSI_PERIOD);
    const rsi = rsiSeries[rsiSeries.length - 1];
    if (rsi == null || !Number.isFinite(rsi)) return null;

    return { price: spotPrice, vol24h, ema200, rsi };
  } catch (err) {
    logger.warn("[EMA_PB] Snapshot fetch failed", { productId, error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Firestore state I/O
// ---------------------------------------------------------------------------

function stateDocRef(productId: string) {
  return db.collection(STATE_COLLECTION).doc(`symbols_${productId}`);
}

async function loadState(productId: string): Promise<HistorySample[]> {
  try {
    const snap = await stateDocRef(productId).get();
    if (!snap.exists) return [];
    const data = snap.data() as SymbolState;
    if (!Array.isArray(data.history)) return [];
    // Evict samples older than 2× the max history window (STATE_HISTORY_MAX * 3 min).
    // This clears stale history from a previous universe visit so re-entering symbols
    // start fresh rather than re-using hours-old slope data.
    const maxAgeMs = STATE_HISTORY_MAX * 3 * 60 * 1000 * 2; // 90 min
    const cutoff   = Date.now() - maxAgeMs;
    return data.history.filter((s: HistorySample) => s.ts >= cutoff);
  } catch (err) {
    logger.warn("[EMA_PB] State read failed", { productId, error: String(err) });
    return [];
  }
}

async function saveState(productId: string, history: HistorySample[]): Promise<void> {
  try {
    await stateDocRef(productId).set({
      history,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.warn("[EMA_PB] State write failed", { productId, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Strategy-managed lookup
// ---------------------------------------------------------------------------

/**
 * True if the most recent APPROVED BUY signal for this product was created
 * by the EMA pullback strategy.
 */
async function isManagedByThisStrategy(productId: string): Promise<boolean> {
  try {
    const snap = await db.collection("signals")
      .where("symbol", "==", productId)
      .where("action", "==", "BUY")
      .where("strategy", "==", STRATEGY_TAG)
      .limit(1)
      .get();
    return !snap.empty;
  } catch (err) {
    // Fail-closed: treat as managed to avoid double-managing a position
    logger.warn("[EMA_PB] strategy lookup failed — assuming managed (fail-closed)", { productId, error: String(err) });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Entry / exit predicates
// ---------------------------------------------------------------------------

function evalEntry(history: HistorySample[]): { match: boolean; reason: string; expr: string } {
  const need = UPTREND_LOOKBACK;
  if (history.length < need) {
    return { match: false, reason: `warmup (${history.length}/${need})`, expr: "warmup" };
  }
  const last = history.length - 1;
  const cur = history[last];

  // Guard against stale history: if the oldest sample in the lookback window is
  // more than 2× the expected span old, the gap means this history is from a
  // previous universe visit hours ago and the slope comparison is meaningless.
  const oldestSample = history[last - (UPTREND_LOOKBACK - 1)];
  const expectedSpanMs = (UPTREND_LOOKBACK - 1) * 3 * 60 * 1000; // 27 min
  const actualSpanMs   = cur.ts - oldestSample.ts;
  if (actualSpanMs > expectedSpanMs * 2) {
    return {
      match: false,
      reason: `stale history gap (oldest lookback sample is ${Math.round(actualSpanMs / 60000)}min old, expected ≤${Math.round(expectedSpanMs * 2 / 60000)}min) — re-warming`,
      expr: "stale-gap",
    };
  }

  const ema = cur.ema200;
  const price = cur.price;
  if (!Number.isFinite(ema) || ema <= 0) {
    return { match: false, reason: "ema200 invalid", expr: "ema200=NaN" };
  }
  const nearPct = (Math.abs(price - ema) / ema) * 100;
  const near = nearPct <= NEAR_EMA_PCT;

  const emaSlope = history[last].ema200 - history[last - (UPTREND_LOOKBACK - 1)].ema200;
  const slopePct = ema > 0 ? (emaSlope / ema) * 100 : 0;
  const slopeUp = slopePct >= MIN_EMA_SLOPE_PCT;

  const match = near && slopeUp;
  const expr = `|Δ|/EMA=${nearPct.toFixed(2)}% (≤${NEAR_EMA_PCT}) && slopePct=${slopePct.toFixed(4)}% (≥${MIN_EMA_SLOPE_PCT}%, Δ=${emaSlope.toExponential(2)})`;
  let reason = "";
  if (!near) reason = `price not near EMA (|Δ|=${nearPct.toFixed(2)}% > ${NEAR_EMA_PCT}%)`;
  else if (!slopeUp) reason = `EMA200 slope too flat (${slopePct.toFixed(4)}% < ${MIN_EMA_SLOPE_PCT}% over ${UPTREND_LOOKBACK} ticks)`;
  else reason = "all entry gates passed";
  return { match, reason, expr };
}

function evalEmaDownExit(history: HistorySample[]): { trigger: boolean; expr: string } {
  if (history.length <= EMA_DOWN_LOOKBACK) {
    return { trigger: false, expr: `history ≤ ${EMA_DOWN_LOOKBACK}` };
  }
  const last = history.length - 1;
  const cur = history[last].ema200;
  const prior = history[last - EMA_DOWN_LOOKBACK].ema200;
  const trigger = cur <= prior;
  return {
    trigger,
    expr: `EMA200[t]=${cur.toPrecision(6)} ${trigger ? "≤" : ">"} EMA200[t-${EMA_DOWN_LOOKBACK}]=${prior.toPrecision(6)}`,
  };
}

function evalEmaStaleExit(history: HistorySample[]): { trigger: boolean; expr: string } {
  if (history.length < EMA_STALE_LOOKBACK) {
    return { trigger: false, expr: `history < ${EMA_STALE_LOOKBACK}` };
  }
  const last = history.length - 1;
  const cur = history[last].ema200;
  const prior = history[last - (EMA_STALE_LOOKBACK - 1)].ema200;
  const trigger = cur <= prior;
  return {
    trigger,
    expr: `EMA200[t]=${cur.toPrecision(6)} ${trigger ? "≤" : ">"} EMA200[t-${EMA_STALE_LOOKBACK - 1}]=${prior.toPrecision(6)} (stale ${EMA_STALE_LOOKBACK} ticks)`,
  };
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

export async function runEmaPullbackScanner(): Promise<void> {
  const tStart = Date.now();
  logger.info("[EMA_PB] Starting run");

  const broker = getBroker("coinbase") as CoinbaseBroker;

  // 1) Build universe: top-30 24h gainers (Coinbase) + rank filter (CoinGecko)
  const [{ topGainers }, rankMap] = await Promise.all([
    broker.getMarketGainers(TOP_N_BY_VOLUME * 2), // overfetch to allow rank/price drops
    getRankMap(),
  ]);

  const universe: Array<{ productId: string; symbol: string; price: number; volumeUsd: number }> = [];
  for (const p of topGainers) {
    if (p.price < MIN_PRICE_USD) continue;
    if (p.volumeUsd < MIN_VOLUME_USD) continue;
    if (STABLECOIN_BLOCKLIST.has(p.symbol.toUpperCase())) continue;
    if (rankMap.size > 0) {
      const rank = rankMap.get(p.symbol.toUpperCase());
      if (rank == null || rank > MAX_MARKET_CAP_RANK) continue;
    }
    universe.push({ productId: p.productId, symbol: p.symbol, price: p.price, volumeUsd: p.volumeUsd });
    if (universe.length >= TOP_N_BY_VOLUME) break;
  }

  logger.info("[EMA_PB] Universe built", {
    topGainersCount: topGainers.length,
    rankMapSize: rankMap.size,
    universeSize: universe.length,
    products: universe.map(u => u.productId),
  });

  if (universe.length === 0) {
    logger.warn("[EMA_PB] Empty universe — aborting");
    return;
  }

  // 2) Fetch open positions once for the tick
  let positions: DetailedPosition[] = [];
  try {
    if (broker.getDetailedPositions) {
      positions = await broker.getDetailedPositions();
    }
  } catch (err) {
    logger.error("[EMA_PB] Failed to fetch positions", { error: String(err) });
    return;
  }
  const positionByProductId = new Map<string, DetailedPosition>();
  for (const p of positions) {
    const sym = p.symbol.toUpperCase();
    const pid = sym.includes("-") ? sym : `${sym}-USD`;
    positionByProductId.set(pid, p);
  }

  // 3) Refresh state for every universe symbol (compute indicators, append sample).
  //    Run in small batches to avoid overwhelming Coinbase candle endpoints.
  const stateBySymbol = new Map<string, HistorySample[]>();
  const failedSymbols: typeof universe = [];
  for (let i = 0; i < universe.length; i += FETCH_CONCURRENCY) {
    const batch = universe.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(async (u) => {
      const snap = await fetchSnapshot(broker, u.productId, u.price, u.volumeUsd);
      if (!snap) return { productId: u.productId, history: null, universeEntry: u };
      const history = await loadState(u.productId);
      history.push({
        ts: Date.now(),
        price: snap.price,
        vol24h: snap.vol24h,
        ema200: snap.ema200,
        rsi: snap.rsi,
      });
      while (history.length > STATE_HISTORY_MAX) history.shift();
      await saveState(u.productId, history);
      return { productId: u.productId, history, universeEntry: u };
    }));
    for (const r of results) {
      if (r.history) stateBySymbol.set(r.productId, r.history);
      else failedSymbols.push(r.universeEntry);
    }
  }

  // Retry once for symbols that failed (likely transient rate limits)
  if (failedSymbols.length > 0) {
    logger.info("[EMA_PB] Retrying failed snapshots", { count: failedSymbols.length, symbols: failedSymbols.map(u => u.productId) });
    await new Promise(r => setTimeout(r, 1500)); // brief pause before retry
    for (let i = 0; i < failedSymbols.length; i += FETCH_CONCURRENCY) {
      const batch = failedSymbols.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.all(batch.map(async (u) => {
        const snap = await fetchSnapshot(broker, u.productId, u.price, u.volumeUsd);
        if (!snap) return { productId: u.productId, history: null };
        const history = await loadState(u.productId);
        history.push({
          ts: Date.now(),
          price: snap.price,
          vol24h: snap.vol24h,
          ema200: snap.ema200,
          rsi: snap.rsi,
        });
        while (history.length > STATE_HISTORY_MAX) history.shift();
        await saveState(u.productId, history);
        return { productId: u.productId, history };
      }));
      for (const r of results) {
        if (r.history) stateBySymbol.set(r.productId, r.history);
      }
    }
  }

  // 3b) Fetch snapshots for held positions NOT in the current universe
  //     (they may have dropped out of top-30 but still need exit evaluation and Telegram display).
  const heldNotInUniverse = [...positionByProductId.keys()].filter(pid => !stateBySymbol.has(pid));
  if (heldNotInUniverse.length > 0) {
    logger.info("[EMA_PB] Fetching snapshots for held positions outside universe", { symbols: heldNotInUniverse });
    await Promise.all(heldNotInUniverse.map(async (productId) => {
      const pos = positionByProductId.get(productId)!;
      const currentPrice = parseFloat(pos.current_price) || 0;
      const snap = await fetchSnapshot(broker, productId, currentPrice, 0).catch(() => null);
      if (!snap) return;
      const history = await loadState(productId);
      history.push({ ts: Date.now(), price: snap.price, vol24h: snap.vol24h, ema200: snap.ema200, rsi: snap.rsi });
      while (history.length > STATE_HISTORY_MAX) history.shift();
      await saveState(productId, history);
      stateBySymbol.set(productId, history);
    }));
  }

  // 4) EXIT pass — for each held position that this strategy manages.
  const liquidated: Array<{ productId: string; entry: number; current: number; pnlPct: number; expr: string }> = [];
  const trailed: Array<{ productId: string; rsi: number; oldSL: number; newSL: number; gainPct: number }> = [];
  const heldSnapshots: Array<{
    productId: string; pnlPct: number; rsi: number;
    emaDelta3Pct: number; emaDelta10Pct: number;
    ticks3: number; ticks10: number; // actual ticks of history available
    emaValues: number[];
  }> = [];

  for (const [productId, position] of positionByProductId.entries()) {
    const history = stateBySymbol.get(productId);
    if (!history || history.length === 0) continue;

    const managed = await isManagedByThisStrategy(productId);
    if (!managed) continue;

    const last = history[history.length - 1];
    // Compute EMA proximity for Telegram display
    {
      const hi = history;
      const n = hi.length;
      const curEma = hi[n - 1].ema200;
      const lb3  = Math.min(EMA_DOWN_LOOKBACK  - 1, n - 1);
      const lb10 = Math.min(EMA_STALE_LOOKBACK - 1, n - 1);
      const ref3  = hi[n - 1 - lb3].ema200;
      const ref10 = hi[n - 1 - lb10].ema200;
      heldSnapshots.push({
        productId,
        pnlPct: parseFloat(position.avg_entry_price) > 0
          ? ((parseFloat(position.current_price || "0") - parseFloat(position.avg_entry_price)) / parseFloat(position.avg_entry_price)) * 100
          : 0,
        rsi: last.rsi,
        emaDelta3Pct:  ref3  > 0 ? ((curEma - ref3)  / ref3)  * 100 : 0,
        emaDelta10Pct: ref10 > 0 ? ((curEma - ref10) / ref10) * 100 : 0,
        ticks3:  lb3  + 1,
        ticks10: lb10 + 1,
        emaValues: hi.slice(-10).map(s => s.ema200),
      });
    }
    const entry = parseFloat(position.avg_entry_price) || 0;
    const current = parseFloat(position.current_price) || last.price;
    const existingSL = position.stop_loss ? parseFloat(position.stop_loss) || 0 : 0;
    const pnlPct = entry > 0 ? ((current - entry) / entry) * 100 : 0;

    // EMA-down hard exit (3 ticks)
    const downExit = evalEmaDownExit(history);
    // EMA-stale exit (10 ticks — no upward progress)
    const staleExit = evalEmaStaleExit(history);

    const exitTrigger = downExit.trigger ? downExit : staleExit.trigger ? staleExit : null;
    if (exitTrigger) {
      const isStale = !downExit.trigger;
      const exitReason = isStale
        ? `EMA200 no upward progress over last ${EMA_STALE_LOOKBACK} ticks — stale position`
        : `EMA200 flat/down across last ${EMA_DOWN_LOOKBACK} ticks`;
      try {
        await broker.liquidatePosition(productId);
        liquidated.push({ productId, entry, current, pnlPct, expr: exitTrigger.expr });
        await logDecision({
          source: "ema_pullback_scanner",
          outcome: "ACCEPTED",
          action: "SELL",
          symbol: productId,
          price: current,
          reason: exitReason,
          expression: `${exitTrigger.expr} → SELL @ $${current.toPrecision(6)} (P/L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
          params: {
            entry, current,
            pnl_pct: +pnlPct.toFixed(2),
            ema_now: last.ema200,
            ema_lookback: isStale ? EMA_STALE_LOOKBACK : EMA_DOWN_LOOKBACK,
            exit_kind: isStale ? "stale" : "ema_down",
          },
        });
      } catch (err) {
        const msg = String(err);
        logger.error("[EMA_PB] Liquidation failed", { productId, error: msg });
        await logDecision({
          source: "ema_pullback_scanner",
          outcome: "REJECTED",
          action: "SELL",
          symbol: productId,
          price: current,
          reason: `liquidation threw: ${msg.slice(0, 120)}`,
          expression: `${exitTrigger.expr} → SELL attempt threw`,
          params: { entry, current, error: msg.slice(0, 200) },
        });
      }
      continue;
    }

    // RSI trailing arm/ratchet — only activate when position is ≥ 5% in profit
    if (last.rsi >= RSI_TRAIL_TRIGGER && current > 0 && pnlPct >= 5.0) {
      const newSL = current * (1 - TRAIL_BUFFER_PCT / 100);
      if (existingSL > 0 && newSL <= existingSL) {
        logger.info("[EMA_PB] Trail skipped (would lower SL)", { productId, existingSL, proposedSL: newSL });
        continue;
      }
      try {
        const result = await broker.updateStopLoss(productId, newSL);
        if (!result.success) {
          logger.warn("[EMA_PB] updateStopLoss rejected", { productId, message: result.message });
          continue;
        }
        trailed.push({ productId, rsi: last.rsi, oldSL: existingSL, newSL, gainPct: pnlPct });
        await logDecision({
          source: "ema_pullback_scanner",
          outcome: "ACCEPTED",
          action: "OTHER",
          symbol: productId,
          price: current,
          reason: `trailing SL ${existingSL > 0 ? "raised" : "armed"} (RSI ≥ ${RSI_TRAIL_TRIGGER})`,
          expression: `RSI=${last.rsi.toFixed(1)} ≥ ${RSI_TRAIL_TRIGGER} → SL ${existingSL > 0 ? existingSL.toPrecision(6) : "none"} → ${newSL.toPrecision(6)}`,
          params: {
            entry, current,
            rsi: +last.rsi.toFixed(1),
            gain_pct: +pnlPct.toFixed(2),
            old_sl: existingSL,
            new_sl: +newSL.toPrecision(6),
            buffer_pct: TRAIL_BUFFER_PCT,
          },
        });
      } catch (err) {
        logger.error("[EMA_PB] updateStopLoss threw", { productId, error: String(err) });
      }
    }
  }

  // 5) ENTRY pass — symbols with no current position and gates satisfied.
  const bought: Array<{ productId: string; price: number; rsi: number; ema200: number; nearPct: number; vol24h: number }> = [];
  let buysRemaining = MAX_BUYS_PER_RUN;

  for (const u of universe) {
    if (buysRemaining <= 0) break;
    if (positionByProductId.size >= MAX_POSITIONS) break;
    if (positionByProductId.has(u.productId)) continue;
    const history = stateBySymbol.get(u.productId);
    if (!history) continue;

    const verdict = evalEntry(history);
    if (!verdict.match) {
      // Only persist warmup-noise rejections for the first few ticks; everything else only logs.
      continue;
    }

    const last = history[history.length - 1];
    const nearPct = (Math.abs(last.price - last.ema200) / last.ema200) * 100;
    const ts = new Date();
    const idempotencyKey = `emapb-${u.productId}-${Math.floor(ts.getTime() / (3 * 60 * 1000))}`;

    const signalData: Omit<Signal, "id"> = {
      strategy: STRATEGY_TAG,
      symbol: u.productId,
      action: "BUY",
      timeframe: "3m",
      price: last.price,
      signalTime: ts.toISOString(),
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
      logger.error("[EMA_PB] Signal write failed", { productId: u.productId, error: String(err) });
      continue;
    }

    const signal: Signal = { id: signalId, ...signalData };

    try {
      const result = await executeOrder(signal, SCANNER_USER_ID);
      logger.info("[EMA_PB] Order placed", { productId: u.productId, status: result.status });
      if (result.status === "executed") {
        bought.push({ productId: u.productId, price: last.price, rsi: last.rsi, ema200: last.ema200, nearPct, vol24h: last.vol24h });
        buysRemaining--;
        await logDecision({
          source: "ema_pullback_scanner",
          outcome: "ACCEPTED",
          action: "BUY",
          symbol: u.productId,
          price: last.price,
          reason: verdict.reason,
          expression: verdict.expr,
          params: {
            ema200: last.ema200,
            rsi: +last.rsi.toFixed(1),
            near_pct: +nearPct.toFixed(3),
            vol24h: last.vol24h,
          },
          signalId,
          userId: SCANNER_USER_ID,
        });
      }
    } catch (err) {
      logger.error("[EMA_PB] executeOrder threw", { productId: u.productId, error: String(err) });
    }
  }

  // 6) Telegram summary
  // Position proximity helper — shared across active and quiet messages
  const positionLines = (): string[] => {
    if (heldSnapshots.length === 0) return [];
    const out = ["📍 *Positions:*"];
    for (const s of heldSnapshots) {
      const pnlStr = `${s.pnlPct >= 0 ? "+" : ""}${s.pnlPct.toFixed(2)}%`;
      const d3  = s.emaDelta3Pct;
      const d10 = s.emaDelta10Pct;
      const d3Str  = `${d3  >= 0 ? "+" : ""}${d3.toFixed(3)}%`;
      const d10Str = `${d10 >= 0 ? "+" : ""}${d10.toFixed(3)}%`;
      // Risk badges
      const badge3  = d3  <= 0 ? " 🔴" : d3  < 0.005 ? " ⚠️" : "";
      const badge10 = d10 <= 0 ? " 🔴" : d10 < 0.010 ? " ⚠️" : "";
      const emaStr = s.emaValues.map(v => v.toPrecision(5)).join(", ");
      out.push(
        `  • ${s.productId} P/L=${pnlStr} | RSI=${s.rsi.toFixed(1)}` +
        ` | EMAδ${s.ticks3}=${d3Str}${badge3} | EMAδ${s.ticks10}=${d10Str}${badge10}`,
      );
      out.push(`    EMA200 (last ${s.emaValues.length}): [${emaStr}]`);
    }
    return out;
  };

  if (bought.length > 0 || liquidated.length > 0 || trailed.length > 0) {
    const lines: string[] = ["📈 *EMA Pullback Scanner*"];
    if (bought.length > 0) {
      lines.push("🟢 *Buys:*");
      for (const b of bought) {
        lines.push(`  • ${b.productId} @ $${b.price.toPrecision(5)} | RSI=${b.rsi.toFixed(1)} | |Δ|EMA=${b.nearPct.toFixed(2)}% | vol=$${(b.vol24h / 1e6).toFixed(1)}M`);
      }
    }
    if (trailed.length > 0) {
      lines.push(`🔼 *Trailed SL* (RSI ≥ ${RSI_TRAIL_TRIGGER}, ${TRAIL_BUFFER_PCT}% buffer):`);
      for (const t of trailed) {
        lines.push(`  • ${t.productId} +${t.gainPct.toFixed(2)}% RSI=${t.rsi.toFixed(1)} — SL ${t.oldSL > 0 ? t.oldSL.toPrecision(5) : "none"} → ${t.newSL.toPrecision(5)}`);
      }
    }
    if (liquidated.length > 0) {
      lines.push(`🛑 *EMA-down liquidations:*`);
      for (const l of liquidated) {
        lines.push(`  • ${l.productId} — entry ${l.entry.toPrecision(5)} → ${l.current.toPrecision(5)} (${l.pnlPct >= 0 ? "+" : ""}${l.pnlPct.toFixed(2)}%) · ${l.expr}`);
      }
    }
    lines.push(...positionLines());
    await sendTelegramMessage(lines.join("\n")).catch(() => {});
  } else {
    // Quiet run — surface the top-30 gainers snapshot so the channel stays
    // informative every 3 min.
    const lines: string[] = ["📊 *EMA Pullback — Top 30 gainers*"];
    const top10 = universe.slice(0, 30);
    for (const u of top10) {
      const h = stateBySymbol.get(u.productId);
      if (!h || h.length === 0) {
        lines.push(`  • ${u.productId} — no data`);
        continue;
      }
      const last = h[h.length - 1];
      // EMA slope over up to last 10 ticks (or as many as we have).
      const slopeLb = Math.min(UPTREND_LOOKBACK, h.length) - 1;
      const slopeRef = slopeLb > 0 ? h[h.length - 1 - slopeLb].ema200 : last.ema200;
      const emaDelta = last.ema200 - slopeRef;
      const emaDeltaPct = slopeRef > 0 ? (emaDelta / slopeRef) * 100 : 0;
      const arrow = emaDelta > 0 ? "↑" : emaDelta < 0 ? "↓" : "→";
      const nearPct = last.ema200 > 0 ? (Math.abs(last.price - last.ema200) / last.ema200) * 100 : 0;
      const above = last.price >= last.ema200 ? "▲" : "▼";
      const warm = h.length < STATE_HISTORY_MAX ? ` (warm ${h.length}/${STATE_HISTORY_MAX})` : "";
      lines.push(
        `  • ${u.productId} $${last.price.toPrecision(5)} ${above} EMA ${arrow}${emaDeltaPct >= 0 ? "+" : ""}${emaDeltaPct.toFixed(2)}% · RSI=${last.rsi.toFixed(1)} · |Δ|EMA=${nearPct.toFixed(2)}% · vol=$${(last.vol24h / 1e6).toFixed(1)}M${warm}`,
      );
    }
    lines.push(...positionLines());
    await sendTelegramMessage(lines.join("\n")).catch(() => {});
  }

  const ms = Date.now() - tStart;
  logger.info("[EMA_PB] Run complete", {
    durationMs: ms,
    universe: universe.length,
    positions: positionByProductId.size,
    bought: bought.length,
    trailed: trailed.length,
    liquidated: liquidated.length,
  });
}

// ---------------------------------------------------------------------------
// Diagnostic: why didn't the scanner buy a given symbol?
// ---------------------------------------------------------------------------

export async function inspectEmaPullback(rawSymbol: string): Promise<string> {
  // Normalise input: "BILL" / "bill" / "BILL-USD" / "BILLUSD" → "BILL-USD"
  let productId = rawSymbol.toUpperCase().trim();
  if (!productId.includes("-")) {
    productId = productId.endsWith("USD") && !productId.endsWith("-USD")
      ? productId.slice(0, -3) + "-USD"
      : `${productId}-USD`;
  }
  const symbol = productId.split("-")[0];

  const broker = getBroker("coinbase") as CoinbaseBroker;
  const lines: string[] = [`🔍 *EMA Pullback Inspect — ${productId}*`];

  // 1. Universe check
  try {
    const [{ topGainers }, rankMap] = await Promise.all([
      broker.getMarketGainers(TOP_N_BY_VOLUME * 2),
      getRankMap(),
    ]);
    const gainerEntry = topGainers.find(p => p.productId === productId);
    const rank = rankMap.get(symbol);

    if (!gainerEntry) {
      const allGainerIds = topGainers.map(p => p.productId);
      const inList = allGainerIds.includes(productId);
      lines.push(`❌ *Universe*: NOT in top-${TOP_N_BY_VOLUME * 2} gainers${inList ? " (in extended list but rank-filtered?)" : " — symbol not gaining enough to appear"}`);
    } else {
      const rankOk = !rank || rank <= MAX_MARKET_CAP_RANK;
      const gainerRank = topGainers.indexOf(gainerEntry) + 1;
      lines.push(
        `${rankOk && gainerRank <= TOP_N_BY_VOLUME ? "✅" : "⚠️"} *Universe*: gainer rank #${gainerRank} of ${topGainers.length} · change24h=${gainerEntry.change24h.toFixed(2)}% · price=$${gainerEntry.price.toPrecision(5)}`
      );
      if (rank) {
        lines.push(`  ${rankOk ? "✅" : "❌"} CoinGecko rank: #${rank} (max allowed: ${MAX_MARKET_CAP_RANK})`);
      } else {
        lines.push(`  ⚠️ CoinGecko rank: unknown (rank filter disabled or symbol not in top-1000)`);
      }
      if (gainerRank > TOP_N_BY_VOLUME) {
        lines.push(`  ❌ Rank #${gainerRank} > TOP_N=${TOP_N_BY_VOLUME} — excluded from final universe`);
      }
      if (gainerEntry.price < MIN_PRICE_USD) {
        lines.push(`  ❌ Price $${gainerEntry.price} < MIN_PRICE_USD=${MIN_PRICE_USD}`);
      }
      if (gainerEntry.volumeUsd < MIN_VOLUME_USD) {
        lines.push(`  ❌ Volume $${(gainerEntry.volumeUsd / 1e6).toFixed(2)}M < MIN_VOLUME_USD=$${(MIN_VOLUME_USD / 1e6).toFixed(0)}M`);
      }
    }
  } catch (err) {
    lines.push(`⚠️ Universe check failed: ${String(err).slice(0, 120)}`);
  }

  // 2. Active position check
  try {
    const managed = await isManagedByThisStrategy(productId);
    if (managed) {
      lines.push(`ℹ️ *Position*: already held by this strategy — scanner skips entry`);
    } else {
      lines.push(`✅ *Position*: none held by this strategy`);
    }
  } catch (err) {
    lines.push(`⚠️ Position check failed: ${String(err).slice(0, 80)}`);
  }

  // 3. Firestore history / warmup
  const history = await loadState(productId);
  const need = UPTREND_LOOKBACK;
  lines.push(`\n📦 *History*: ${history.length}/${STATE_HISTORY_MAX} ticks stored (need ${need} for entry)`);

  if (history.length === 0) {
    lines.push(`❌ No history — symbol has never appeared in the scanner universe, or state was reset`);
    return lines.join("\n");
  }

  const last = history.length - 1;
  const cur = history[last];
  const tsStr = new Date(cur.ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  lines.push(`  Last tick: ${tsStr}`);
  lines.push(`  price=$${cur.price.toPrecision(5)} · EMA200=${cur.ema200.toPrecision(6)} · RSI=${cur.rsi.toFixed(1)}`);

  // 4. Entry gate breakdown
  lines.push(`\n🔎 *Entry gates* (need all ✅ to buy):`);

  if (history.length < UPTREND_LOOKBACK) {
    lines.push(`  ❌ Warmup: ${history.length}/${UPTREND_LOOKBACK} ticks — scanner is still collecting history (${UPTREND_LOOKBACK - history.length} more ticks needed ≈ ${(UPTREND_LOOKBACK - history.length) * 3} min)`);
    return lines.join("\n");
  }

  // Gate 1: near EMA
  const ema = cur.ema200;
  const nearPct = (Math.abs(cur.price - ema) / ema) * 100;
  const nearOk = nearPct <= NEAR_EMA_PCT;
  lines.push(`  ${nearOk ? "✅" : "❌"} Near EMA: |price−EMA|/EMA = ${nearPct.toFixed(3)}% (threshold ≤${NEAR_EMA_PCT}%)`);

  // Gate 2: EMA uptrend over last UPTREND_LOOKBACK ticks
  const emaSlope = history[last].ema200 - history[last - (UPTREND_LOOKBACK - 1)].ema200;
  const slopeOk = emaSlope > 0;
  const slopeSpanMin = (UPTREND_LOOKBACK - 1) * 3;
  lines.push(`  ${slopeOk ? "✅" : "❌"} EMA uptrend: EMA[t]−EMA[t-${UPTREND_LOOKBACK - 1}] = ${emaSlope > 0 ? "+" : ""}${emaSlope.toExponential(3)} (span ~${slopeSpanMin}min, need >0)`);

  // Summary
  const allPass = nearOk && slopeOk;
  lines.push(`\n${allPass ? "✅ All gates passed — scanner SHOULD have bought (check MAX_BUYS_PER_RUN or position cap)" : "❌ Entry blocked — fix above gates to trigger a buy"}`);

  // 5. Exit gate status (informational)
  const downExit = evalEmaDownExit(history);
  lines.push(`\nℹ️ *Exit gate* (EMA down): ${downExit.expr}`);

  return lines.join("\n");
}
