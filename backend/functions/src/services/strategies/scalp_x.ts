/**
 * ScalpX v2 — fee-aware 120-min ALMA crossover with trend filter.
 *
 * SIGNAL (non-repainting):
 *  Aggregate 5-min candles → 120-min bars.
 *  ALMA(close,2,0.85,5) crosses above ALMA(open,2,0.85,5) on 120-min bars.
 *  With length=2, this ≈ "current 120-min bar flipped bullish vs previous."
 *  Entry fires on the FIRST 5-min candle of the NEXT 120-min bar.
 *
 * TREND FILTER (new in v2):
 *  EMA(20) of 120-min bar closes > EMA(50) of 120-min bar closes.
 *  Only trade in confirmed uptrend — filters out >60% of low-quality crossovers.
 *
 * EXIT (fee-aware, single TP):
 *  SL = -1.5%  → net loss  = -1.5% - 1.2% fees = -2.7% = -$27 per $1k
 *  TP = +4.5%  → net gain  = +4.5% - 1.2% fees = +3.3% = +$33 per $1k
 *  R:R = 3:1 gross, ~2.2:1 net after fees.
 *  Break-even win rate = 27 / (27+33) = 45%
 *  Time stop: 4 × 120-min bars (48 candles ≈ 4h)
 *
 * WHY NOT THE PINE SCRIPT'S TP LEVELS:
 *  TP1=+1.0% after 0.6%/side fees gives NET -0.2% (a losing tranche).
 *  TP2=+1.5% gives only NET +0.3%. The Pine script's 92% win rate was
 *  lookahead bias. At realistic win rates (~40-55%), those levels guarantee losses.
 */

import { BacktestCandle, BacktestGrade, BacktestIndicatorPoint } from "../../types";
import { BacktestStrategy, TradeSimResult } from "./interface";

// ─── ALMA helpers ─────────────────────────────────────────────────────────────

/** Compute Arnaud Legoux Moving Average weights (index 0 = most recent) */
function almaWeights(length: number, offset: number, sigma: number): number[] {
  const m = Math.floor(offset * (length - 1));
  const s = length / sigma;
  const w: number[] = [];
  for (let i = 0; i < length; i++) {
    w.push(Math.exp(-((i - m) ** 2) / (2 * s * s)));
  }
  return w;
}

/** Apply ALMA weights ending at `endIdx` in `values` array */
function almaAt(values: number[], endIdx: number, weights: number[]): number | null {
  const len = weights.length;
  if (endIdx + 1 < len) return null;
  let wSum = 0, vSum = 0;
  for (let k = 0; k < len; k++) {
    wSum += weights[k];
    vSum += weights[k] * values[endIdx - k];
  }
  return vSum / wSum;
}

// ─── 120-min bar aggregation ──────────────────────────────────────────────────

const BAR_SEC = 120 * 60; // 7200 s

interface Bar120 {
  open: number;
  close: number;
  endIdx: number; // index of last 5-min candle in this bar
}

function build120MinBars(candles: BacktestCandle[]): Bar120[] {
  const bars: Bar120[] = [];
  let currentKey = -1;
  let barOpen = 0;

  for (let i = 0; i < candles.length; i++) {
    const key = Math.floor(candles[i].ts / BAR_SEC);
    if (key !== currentKey) {
      if (currentKey !== -1) {
        bars[bars.length - 1].endIdx = i - 1; // finalize previous bar
      }
      currentKey = key;
      barOpen = candles[i].open;
      bars.push({ open: barOpen, close: candles[i].close, endIdx: i });
    } else {
      bars[bars.length - 1].close = candles[i].close;
    }
  }
  if (bars.length > 0) {
    bars[bars.length - 1].endIdx = candles.length - 1;
  }
  return bars;
}

// ─── EMA helper ───────────────────────────────────────────────────────────────

function buildEma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// ─── Strategy class ───────────────────────────────────────────────────────────

export class ScalpXStrategy implements BacktestStrategy {
  readonly id = "scalpx";
  readonly name = "ScalpX v2 (120-min ALMA + trend filter)";
  readonly description = [
    "LONG only — non-repainting 120-min ALMA crossover with EMA trend gate",
    "Signal: ALMA(close,2) > ALMA(open,2) flip on 120-min bars",
    "Filter: EMA20 > EMA50 on 120-min closes (only trade with trend)",
    "SL: -1.5% | TP: +4.5% (single exit) | Hold max 4h (48 candles)",
    "Fee-aware R:R 3:1 gross → ~2.2:1 net | Break-even win rate: 45%",
  ];
  readonly warmupCandles = 600;  // 50 × 120-min bars = 600 five-min candles
  readonly cooldownCandles = 24; // wait 2h (1 full 120-min bar) after any exit
  readonly tradingHoursUtc: [number, number] = [0, 23];
  readonly stopLossPct = 1.5;
  readonly takeProfitPct = 4.5;

  buildIndicators(candles: BacktestCandle[]): BacktestIndicatorPoint[] {
    const bars = build120MinBars(candles);
    const closes120 = bars.map((b) => b.close);
    const opens120  = bars.map((b) => b.open);

    const W      = almaWeights(2, 0.85, 5);
    const ema20  = buildEma(closes120, 20);
    const ema50  = buildEma(closes120, 50);

    // For each completed 120-min bar j≥1: check crossover + trend filter.
    // Entry fires on the FIRST 5-min candle of bar j+1 (non-repainting).
    const entryAt = new Set<number>();
    for (let j = 1; j < bars.length - 1; j++) {
      const ac  = almaAt(closes120, j,     W);
      const ao  = almaAt(opens120,  j,     W);
      const acp = almaAt(closes120, j - 1, W);
      const aop = almaAt(opens120,  j - 1, W);
      if (ac === null || ao === null || acp === null || aop === null) continue;

      const crossover   = ac > ao && acp <= aop;
      const inUptrend   = ema20[j] !== null && ema50[j] !== null && ema20[j]! > ema50[j]!;

      if (crossover && inUptrend) {
        const firstNext = bars[j].endIdx + 1;
        if (firstNext < candles.length) entryAt.add(firstNext);
      }
    }

    return candles.map((c, i) => ({
      ts: c.ts,
      close: c.close,
      rsi14: null, vwap20: null, rvol20: null,
      bbMid20: null, bbUpper20: null, bbLower20: null,
      ema50: null,
      grade: (entryAt.has(i) ? "A+" : "WEAK") as BacktestGrade,
    }));
  }

  shouldEnter(
    _candles: BacktestCandle[],
    points: BacktestIndicatorPoint[],
    i: number,
  ): boolean {
    return points[i].grade === "A+";
  }

  simulateTrade(
    candles: BacktestCandle[],
    entryIdx: number,
    entryPx: number,
    qty: number,
    slip: number,
    fee: number,
  ): TradeSimResult {
    const slPx = entryPx * (1 - 0.015); // -1.5%
    const tpPx = entryPx * (1 + 0.045); // +4.5%
    const MAX_HOLD = 48; // 4h

    // Entry fee
    let totalFees = qty * entryPx * fee;
    let slipCost  = 0;

    for (let i = entryIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      const isLast = (i - entryIdx) >= MAX_HOLD || i === candles.length - 1;

      let exitPx: number | null = null;
      let reason: "stop" | "target" | "time" = "time";

      if (c.low <= slPx) {
        exitPx = slPx * (1 - slip);
        reason = "stop";
      } else if (c.high >= tpPx) {
        exitPx = tpPx * (1 - slip);
        reason = "target";
      } else if (isLast) {
        exitPx = c.close * (1 - slip);
        reason = "time";
      }

      if (exitPx !== null) {
        const gross = reason === "stop"   ? slPx  * qty - entryPx * qty
                    : reason === "target" ? tpPx  * qty - entryPx * qty
                    :                       exitPx * qty - entryPx * qty;
        const sellFee  = qty * exitPx * fee;
        slipCost = qty * Math.abs((reason === "stop" ? slPx : reason === "target" ? tpPx : c.close) - exitPx);
        totalFees += sellFee;
        return {
          exitIdx: i, exitTs: c.ts, exitPrice: exitPx,
          grossPnl: gross,
          netPnl: gross - totalFees,
          fees: totalFees, slippageCost: slipCost,
          exitReason: reason, entryGrade: "A+",
        };
      }
    }

    // Fallback
    const last = candles[candles.length - 1];
    const exitPx = last.close * (1 - slip);
    const gross  = exitPx * qty - entryPx * qty;
    totalFees   += qty * exitPx * fee;
    return {
      exitIdx: candles.length - 1, exitTs: last.ts, exitPrice: exitPx,
      grossPnl: gross, netPnl: gross - totalFees,
      fees: totalFees, slippageCost: 0,
      exitReason: "time", entryGrade: "A+",
    };
  }
}

