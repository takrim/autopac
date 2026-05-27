import { randomUUID } from "crypto";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { CONFIG } from "../config";
import { BacktestCandle, BacktestGrade, BacktestRunDoc, BacktestTrade } from "../types";
import { getStrategy, DEFAULT_STRATEGY_ID } from "./strategies";
import { BacktestStrategy } from "./strategies/interface";

const db = getFirestore();
const COINBASE_CANDLES_BASE = "https://api.coinbase.com/api/v3/brokerage/market/products";

/** Normalise user-supplied ticker to Coinbase product id, e.g. "ETHUSD" → "ETH-USD" */
function normalizeSymbol(raw: string): string {
  const upper = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Insert dash before common quote currencies
  for (const quote of ["USDT", "USD", "BTC", "ETH"]) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return `${upper.slice(0, upper.length - quote.length)}-${quote}`;
    }
  }
  return upper; // already formatted or unknown
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Strategy-driven simulation runner ───────────────────────────────────────

function runSimulationWithStrategy(
  candles: BacktestCandle[],
  strategy: BacktestStrategy,
): BacktestTrade[] {
  const slip = CONFIG.BACKTEST_SLIPPAGE_BPS / 10_000;
  const fee = CONFIG.BACKTEST_FEE_RATE_PER_SIDE;
  const tradeValue = CONFIG.BACKTEST_TRADE_VALUE_USD;
  const [hourStart, hourEnd] = strategy.tradingHoursUtc;

  const points = strategy.buildIndicators(candles);
  const trades: BacktestTrade[] = [];
  let cooldown = 0;
  let i = strategy.warmupCandles;

  while (i < candles.length) {
    if (cooldown > 0) { cooldown--; i++; continue; }

    const c = candles[i];
    const hour = new Date(c.ts * 1000).getUTCHours();
    if (hour < hourStart || hour > hourEnd) { i++; continue; }
    if (!strategy.shouldEnter(candles, points, i)) { i++; continue; }

    const entryPx = c.close * (1 + slip);
    const qty = tradeValue / entryPx;
    const result = strategy.simulateTrade(candles, i, entryPx, qty, slip, fee);

    trades.push({
      symbol: "BTC-USD",
      grade: points[i].grade,
      entryTs: c.ts,
      exitTs: result.exitTs,
      entryPrice: entryPx,
      exitPrice: result.exitPrice,
      qty,
      grossPnl: result.grossPnl,
      netPnl: result.netPnl,
      fees: result.fees,
      slippageCost: result.slippageCost,
      exitReason: result.exitReason,
    });

    i = result.exitIdx + 1;
    cooldown = strategy.cooldownCandles;
  }
  return trades;
}


async function fetchChunk(symbol: string, startSec: number, endSec: number): Promise<BacktestCandle[]> {
  const url = `${COINBASE_CANDLES_BASE}/${symbol}/candles?start=${startSec}&end=${endSec}&granularity=FIVE_MINUTE`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await fetch(url);
    if (resp.ok) {
      const data = (await resp.json()) as {
        candles?: Array<{
          start: string;
          low: string;
          high: string;
          open: string;
          close: string;
          volume: string;
        }>;
      };

      const candles = (data.candles || []).map((c) => ({
        ts: Number(c.start),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
      }));
      return candles;
    }

    if (attempt < 3) {
      await sleep(250 * attempt);
      continue;
    }

    const body = await resp.text().catch(() => "");
    throw new Error(`Coinbase candles request failed (${resp.status}): ${body.slice(0, 200)}`);
  }

  return [];
}

async function updateProgress(runId: string, step: string, detail?: string): Promise<void> {
  const ref = db.collection("_jobs").doc("btc_backtest_5m");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.data()?.runId !== runId) return; // zombie guard: we no longer own the lock
    tx.set(ref, {
      step,
      stepDetail: detail || "",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }).catch(() => {});
}

async function fetchHistoricalCandles(runId: string, symbol: string): Promise<BacktestCandle[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - CONFIG.BACKTEST_LOOKBACK_DAYS * 24 * 60 * 60;
  const chunkSec = CONFIG.BACKTEST_CHUNK_CANDLES * CONFIG.BACKTEST_GRANULARITY_SECONDS;
  const totalSec = now - from;

  const all = new Map<number, BacktestCandle>();
  let cursor = from;
  let chunkNum = 0;
  const totalChunks = Math.ceil(totalSec / chunkSec);

  while (cursor < now) {
    const end = Math.min(cursor + chunkSec, now);
    const candles = await fetchChunk(symbol, cursor, end);
    chunkNum++;

    for (const candle of candles) {
      all.set(candle.ts, candle);
    }

    const pct = Math.round((chunkNum / totalChunks) * 100);
    const fromDate = new Date(end * 1000).toISOString().slice(0, 10);
    await updateProgress(runId, "Fetching candles", `${pct}% (chunk ${chunkNum}/${totalChunks}, up to ${fromDate}, ${all.size} candles so far)`);

    cursor = end;
    await sleep(CONFIG.BACKTEST_REQUEST_DELAY_MS);
  }

  return Array.from(all.values()).sort((a, b) => a.ts - b.ts);
}

// ─── Stats summarizer ─────────────────────────────────────────────────────────

function summarize(trades: BacktestTrade[]) {
  let netPnl = 0;
  let grossPnl = 0;
  let totalFees = 0;
  let totalSlippage = 0;
  let wins = 0;
  let losses = 0;
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  let stopCount = 0;
  let targetCount = 0;
  let timeCount = 0;
  let totalHoldCandles = 0;
  let totalVolumeUsd = 0;
  let totalVolumeBtc = 0;
  let winPnlSum = 0;
  let lossPnlSum = 0;

  const pnlByHour = new Map<number, { total: number; count: number }>();
  const pnlByGrade = new Map<BacktestGrade, number>([["A+", 0], ["B", 0], ["WEAK", 0]]);

  for (const t of trades) {
    netPnl += t.netPnl;
    grossPnl += t.grossPnl;
    totalFees += t.fees;
    totalSlippage += t.slippageCost;
    totalVolumeUsd += t.qty * t.entryPrice;
    totalVolumeBtc += t.qty;
    totalHoldCandles += t.exitTs - t.entryTs; // seconds

    if (t.netPnl >= 0) { wins++; winPnlSum += t.netPnl; }
    else { losses++; lossPnlSum += t.netPnl; }

    if (t.exitReason === "stop")   stopCount++;
    else if (t.exitReason === "target") targetCount++;
    else                             timeCount++;

    equity += t.netPnl;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    maxDrawdown = Math.max(maxDrawdown, dd);

    const hour = new Date(t.entryTs * 1000).getUTCHours();
    const byHour = pnlByHour.get(hour) || { total: 0, count: 0 };
    byHour.total += t.netPnl;
    byHour.count += 1;
    pnlByHour.set(hour, byHour);

    pnlByGrade.set(t.grade, (pnlByGrade.get(t.grade) || 0) + t.netPnl);
  }

  const n = trades.length;
  const avgHoldHours = n > 0 ? (totalHoldCandles / n) / 3600 : 0;
  const avgWin  = wins   > 0 ? winPnlSum  / wins   : 0;
  const avgLoss = losses > 0 ? lossPnlSum / losses  : 0;
  const orderSizeUsd = n > 0 ? totalVolumeUsd / n : CONFIG.BACKTEST_TRADE_VALUE_USD;

  let bestHour = -1;
  let bestHourAvg = -Infinity;
  for (const [hour, v] of pnlByHour.entries()) {
    const avg = v.total / Math.max(1, v.count);
    if (avg > bestHourAvg) {
      bestHourAvg = avg;
      bestHour = hour;
    }
  }

  let bestGrade: BacktestGrade = "WEAK";
  let bestGradePnl = -Infinity;
  for (const [g, v] of pnlByGrade.entries()) {
    if (v > bestGradePnl) {
      bestGradePnl = v;
      bestGrade = g;
    }
  }

  return {
    totalTrades: n,
    wins,
    losses,
    winRate: n > 0 ? wins / n : 0,
    netPnl,
    grossPnl,
    totalFees,
    totalSlippage,
    maxDrawdown,
    stopCount,
    targetCount,
    timeCount,
    avgHoldHours,
    totalVolumeUsd,
    totalVolumeBtc,
    orderSizeUsd,
    avgWin,
    avgLoss,
    bestHourUtc: bestHour,
    bestGrade,
  };
}

async function acquireRunLock(): Promise<string | null> {
  const ref = db.collection("_jobs").doc("btc_backtest_5m");
  const now = Date.now();
  const staleMs = 5 * 60 * 60 * 1000;
  const runId = randomUUID();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as { running?: boolean; startedAtMs?: number } | undefined;
    if (data?.running && data.startedAtMs && now - data.startedAtMs < staleMs) {
      return null;
    }

    tx.set(ref, {
      running: true,
      startedAtMs: now,
      runId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return runId;
  });
}

async function releaseRunLock(success: boolean, message?: string): Promise<void> {
  const ref = db.collection("_jobs").doc("btc_backtest_5m");
  await ref.set({
    running: false,
    lastSuccess: success,
    lastMessage: message || "",
    finishedAtMs: Date.now(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export interface BacktestRunResult {
  symbol: string;
  candleCount: number;
  durationMs: number;
  summary: BacktestRunDoc["summary"];
}

export async function runBtcBacktestJob(opts: {
  trigger?: "scheduled" | "manual";
  failIfLocked?: boolean;
  strategyId?: string;
  symbol?: string;
} = {}): Promise<BacktestRunResult> {
  const trigger = opts.trigger || "scheduled";
  const symbol  = opts.symbol ? normalizeSymbol(opts.symbol) : "BTC-USD";
  const strategy = getStrategy(opts.strategyId ?? DEFAULT_STRATEGY_ID);
  const runId = await acquireRunLock();
  if (!runId) {
    if (opts.failIfLocked) throw new Error("backtest already running");
    logger.info("[BACKTEST] Skipping run: previous run still active");
    return {
      symbol,
      candleCount: 0,
      durationMs: 0,
      summary: {
        totalTrades: 0, wins: 0, losses: 0, winRate: 0,
        netPnl: 0, grossPnl: 0, totalFees: 0, totalSlippage: 0, maxDrawdown: 0,
        stopCount: 0, targetCount: 0, timeCount: 0,
        avgHoldHours: 0, totalVolumeUsd: 0, totalVolumeBtc: 0,
        orderSizeUsd: CONFIG.BACKTEST_TRADE_VALUE_USD, avgWin: 0, avgLoss: 0,
        bestHourUtc: -1, bestGrade: "WEAK",
      },
    };
  }

  const startedAtMs = Date.now();
  try {
    await updateProgress(runId, "Starting", `Strategy: ${strategy.name} on ${symbol} — fetching candles from Coinbase`);
    const candles = await fetchHistoricalCandles(runId, symbol);
    if (candles.length < 1000) throw new Error(`Insufficient candles fetched: ${candles.length}`);

    await updateProgress(runId, "Simulating", `${strategy.name} on ${candles.length} candles`);
    const trades = runSimulationWithStrategy(candles, strategy);

    await updateProgress(runId, "Summarizing", `${trades.length} trades found, computing stats`);
    const summary = summarize(trades);

    const doc: BacktestRunDoc = {
      symbol,
      granularity: "FIVE_MINUTE",
      lookbackDays: CONFIG.BACKTEST_LOOKBACK_DAYS,
      engineVersion: "v3",
      strategyId: strategy.id,
      trigger,
      runStartedAtMs: startedAtMs,
      runCompletedAtMs: Date.now(),
      durationMs: Date.now() - startedAtMs,
      candleCount: candles.length,
      summary,
      sampleTrades: trades.slice(-Math.min(trades.length, CONFIG.BACKTEST_REPORT_MAX_TRADES)),
      createdAt: FieldValue.serverTimestamp(),
    };

    await db.collection("backtest_runs").add(doc);
    logger.info("[BACKTEST] Run completed", {
      strategy: strategy.id,
      candleCount: candles.length,
      trades: summary.totalTrades,
      winRate: summary.winRate,
      netPnl: summary.netPnl,
    });

    await releaseRunLock(true, "ok");
    return { symbol: doc.symbol, candleCount: doc.candleCount, durationMs: doc.durationMs, summary: doc.summary };
  } catch (err) {
    const msg = String(err);
    logger.error("[BACKTEST] Run failed", { error: msg });
    await releaseRunLock(false, msg);
    throw err;
  }
}

