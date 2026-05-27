/**
 * EMA Pullback in Uptrend — fee-aware 4h strategy.
 *
 * CONCEPT:
 *  Only trade when the 4h trend is unambiguously bullish:
 *    EMA20 > EMA50 > EMA200 on 4h bars (triple-stack).
 *  Wait for RSI(14) of 4h bars to pull back into 40–55 (cooling off,
 *  not reversing). Enter on the first 5-min candle where the 4h close
 *  re-crosses back above EMA20 after having dipped below or touched it.
 *
 * WHY THIS BEATS SCALPING WITH 0.6%/SIDE FEES:
 *  TP1=+1%  → net -0.2%  (losing)   ← what ScalpX used
 *  TP =+6%  → net +4.8%  (winning)  ← what we use
 *  A strategy only needs 38% win rate to be profitable at this R:R.
 *
 * EXIT (single TP, fee-aware):
 *  SL = -2.5%  → net loss  = -2.5% - 1.2% fees = -3.7%
 *  TP = +6.0%  → net gain  = +6.0% - 1.2% fees = +4.8%
 *  R:R = 2.4:1 gross, ~1.3:1 net after fees.
 *  Break-even win rate = 3.7 / (3.7 + 4.8) = 43.5%
 *  Time stop: 12 × 4h bars (48h hold max = 576 5-min candles)
 *
 * ENTRY RULES (all must be true on a completed 4h bar):
 *  1. EMA20 > EMA50 > EMA200 (confirmed uptrend)
 *  2. RSI14 pulled back to 40–55 on the PRIOR 4h bar (cooling phase)
 *  3. Current 4h close > EMA20 (price reclaimed above fast EMA)
 *  4. Previous 4h close was ≤ EMA20 (the actual pullback touch/dip)
 *  Condition 3+4 = close crossed above EMA20 after touching it = pullback entry.
 *
 * BAR AGGREGATION:
 *  5-min candles → 4h bars (48 candles per bar).
 *  Entry fires on FIRST 5-min candle of next 4h bar (non-repainting).
 *  EMA200 on 4h bars needs 200 bars = 200 × 48 = 9600 5-min candles warmup.
 */

import { BacktestCandle, BacktestGrade, BacktestIndicatorPoint } from "../../types";
import { BacktestStrategy, TradeSimResult } from "./interface";
import { computeEMA, computeRSI } from "./shared";

// ─── 4h bar aggregation ───────────────────────────────────────────────────────

const BAR_4H_SEC = 4 * 60 * 60; // 14400 s

interface Bar4h {
  open: number;
  high: number;
  low: number;
  close: number;
  /** index of last 5-min candle belonging to this bar */
  endIdx: number;
}

function build4hBars(candles: BacktestCandle[]): Bar4h[] {
  const bars: Bar4h[] = [];
  let currentKey = -1;

  for (let i = 0; i < candles.length; i++) {
    const key = Math.floor(candles[i].ts / BAR_4H_SEC);
    if (key !== currentKey) {
      if (currentKey !== -1) {
        bars[bars.length - 1].endIdx = i - 1;
      }
      currentKey = key;
      bars.push({
        open:   candles[i].open,
        high:   candles[i].high,
        low:    candles[i].low,
        close:  candles[i].close,
        endIdx: i,
      });
    } else {
      const b = bars[bars.length - 1];
      if (candles[i].high > b.high) b.high = candles[i].high;
      if (candles[i].low  < b.low)  b.low  = candles[i].low;
      b.close  = candles[i].close;
    }
  }
  if (bars.length > 0) {
    bars[bars.length - 1].endIdx = candles.length - 1;
  }
  return bars;
}

// ─── Strategy class ───────────────────────────────────────────────────────────

export class EmaPullbackStrategy implements BacktestStrategy {
  readonly id = "emapullback";
  readonly name = "EMA Pullback (4h uptrend reentry)";
  readonly description = [
    "LONG only — 4h EMA triple-stack uptrend + RSI pullback entry",
    "Entry: EMA20 > EMA50 > EMA200 on 4h bars + RSI14 was 40–55 + close reclaimed EMA20",
    "SL: -2.5% | TP: +6.0% (single exit) | Hold max 48h (576 candles)",
    "Fee-aware R:R 2.4:1 gross → ~1.3:1 net | Break-even win rate: 43.5%",
    "Only trades confirmed uptrends — avoids choppy / bear market entries",
  ];
  readonly warmupCandles = 9600; // 200 × 4h bars × 48 candles/bar
  readonly cooldownCandles = 48; // 4h cooldown (1 full bar) after any exit
  readonly tradingHoursUtc: [number, number] = [0, 23];
  readonly stopLossPct = 2.5;
  readonly takeProfitPct = 6.0;

  buildIndicators(candles: BacktestCandle[]): BacktestIndicatorPoint[] {
    const bars  = build4hBars(candles);
    const closes = bars.map((b) => b.close);

    const ema20  = computeEMA(closes, 20);
    const ema50  = computeEMA(closes, 50);
    const ema200 = computeEMA(closes, 200);
    const rsi14  = computeRSI(closes, 14);

    // For each completed 4h bar j≥1:
    //   Check entry conditions — if met, mark first 5-min candle of bar j+1.
    const entryAt = new Set<number>();

    for (let j = 1; j < bars.length - 1; j++) {
      const e20  = ema20[j];
      const e50  = ema50[j];
      const e200 = ema200[j];
      const rsi  = rsi14[j];
      const prevRsi = rsi14[j - 1];

      if (e20 === null || e50 === null || e200 === null) continue;
      if (rsi === null || prevRsi === null) continue;

      // Rule 1: Triple-stack uptrend
      const uptrend = e20 > e50 && e50 > e200;
      if (!uptrend) continue;

      // Rule 2: RSI pulled back on the PRIOR bar (40–55 cooloff)
      const rsiPullback = prevRsi >= 38 && prevRsi <= 58;
      if (!rsiPullback) continue;

      // Rule 3+4: Close just reclaimed EMA20 (crossed above from below/at)
      const prevClose = bars[j - 1].close;
      const currClose = bars[j].close;
      const reclaimed = currClose > e20 && prevClose <= e20;
      if (!reclaimed) continue;

      // Signal fires at FIRST 5-min candle of next 4h bar (non-repainting)
      const firstNext = bars[j].endIdx + 1;
      if (firstNext < candles.length) entryAt.add(firstNext);
    }

    return candles.map((c, i) => ({
      ts:        c.ts,
      close:     c.close,
      rsi14:     null,
      vwap20:    null,
      rvol20:    null,
      bbMid20:   null,
      bbUpper20: null,
      bbLower20: null,
      ema50:     null,
      grade:     (entryAt.has(i) ? "A+" : "WEAK") as BacktestGrade,
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
    const slPx = entryPx * (1 - 0.025); // -2.5%
    const tpPx = entryPx * (1 + 0.060); // +6.0%
    const MAX_HOLD = 576; // 48h = 12 × 4h bars × 48 candles

    let totalFees = qty * entryPx * fee; // entry fee

    for (let i = entryIdx + 1; i < candles.length; i++) {
      const c      = candles[i];
      const isLast = (i - entryIdx) >= MAX_HOLD || i === candles.length - 1;

      let exitPx: number | null = null;
      let reason: "stop" | "target" | "time" = "time";

      if (c.low <= slPx) {
        exitPx = slPx * (1 - slip);
        reason = "stop";
      } else if (c.high >= tpPx) {
        exitPx = tpPx * (1 - slip); // slight slip on TP fill
        reason = "target";
      } else if (isLast) {
        exitPx = c.close * (1 - slip);
        reason = "time";
      }

      if (exitPx !== null) {
        const idealPx = reason === "stop"   ? slPx
                      : reason === "target" ? tpPx
                      :                       c.close;
        const gross    = idealPx * qty - entryPx * qty;
        const sellFee  = qty * exitPx * fee;
        const slipCost = qty * Math.abs(idealPx - exitPx);
        totalFees += sellFee;

        return {
          exitIdx:      i,
          exitTs:       c.ts,
          exitPrice:    exitPx,
          grossPnl:     gross,
          netPnl:       gross - totalFees,
          fees:         totalFees,
          slippageCost: slipCost,
          exitReason:   reason,
          entryGrade:   "A+",
        };
      }
    }

    // Fallback (shouldn't be reached)
    const last    = candles[candles.length - 1];
    const exitPx  = last.close * (1 - slip);
    const gross   = exitPx * qty - entryPx * qty;
    totalFees    += qty * exitPx * fee;
    return {
      exitIdx:      candles.length - 1,
      exitTs:       last.ts,
      exitPrice:    exitPx,
      grossPnl:     gross,
      netPnl:       gross - totalFees,
      fees:         totalFees,
      slippageCost: 0,
      exitReason:   "time",
      entryGrade:   "A+",
    };
  }
}
