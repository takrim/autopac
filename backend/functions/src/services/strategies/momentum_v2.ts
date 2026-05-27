import { BacktestCandle, BacktestIndicatorPoint } from "../../types";
import { CONFIG } from "../../config";
import { BacktestStrategy, TradeSimResult } from "./interface";
import { buildCommonIndicators } from "./shared";

/**
 * MomentumV2 — high-conviction RSI + VWAP + volume surge + EMA50 trend filter.
 *
 * Entry (A+ only, long only):
 *   RSI14 52–63 · close > VWAP20×1.002 · RVOL ≥ 2.0× · close < BB Upper
 *   close > EMA50 · candle body ≥ 0.15% · UTC 08–21 only
 *
 * Exit: SL=−1.0%, TP=+3.0%, max hold 3h (36 candles), cooldown 5 candles
 * R:R ratio ~1.8 · break-even win rate ~55%
 */
export class MomentumV2Strategy implements BacktestStrategy {
  readonly id = "momentum";
  readonly name = "Momentum v2";
  readonly description = [
    "Entry: RSI14 52-63, close > VWAP20×1.002, RVOL ≥ 2.0×,",
    "  close < BB Upper, close > EMA50, candle body ≥ 0.15%",
    "Exit: SL=-1.0%, TP=+3.0%, max 3h hold (36 candles)",
    "  5-candle cooldown after each exit",
    "Break-even win rate: ~55%",
  ];
  readonly warmupCandles = 50;
  readonly cooldownCandles = CONFIG.BACKTEST_COOLDOWN_CANDLES;
  readonly tradingHoursUtc: [number, number] = [8, 21];
  readonly takeProfitPct = CONFIG.BACKTEST_TAKE_PROFIT_PCT;
  readonly stopLossPct = CONFIG.BACKTEST_STOP_LOSS_PCT;

  buildIndicators(candles: BacktestCandle[]): BacktestIndicatorPoint[] {
    const points = buildCommonIndicators(candles);
    // Score each candle
    for (let i = 0; i < points.length; i++) {
      points[i].grade = this._score(candles[i], points[i]);
    }
    return points;
  }

  private _score(c: BacktestCandle, p: BacktestIndicatorPoint): "A+" | "B" | "WEAK" {
    const { close, rsi14, vwap20, rvol20, bbUpper20, ema50 } = p;
    const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
    if (
      rsi14 !== null && rsi14 >= 52 && rsi14 <= 63 &&
      vwap20 !== null && close > vwap20 * 1.002 &&
      rvol20 !== null && rvol20 >= 2.0 &&
      bbUpper20 !== null && close < bbUpper20 &&
      ema50 !== null && close > ema50 &&
      bodyPct >= 0.15
    ) return "A+";
    return "WEAK";
  }

  shouldEnter(_candles: BacktestCandle[], points: BacktestIndicatorPoint[], i: number): boolean {
    return points[i].grade === "A+";
  }

  simulateTrade(
    candles: BacktestCandle[],
    entryIdx: number,
    entryPrice: number,
    qty: number,
    slip: number,
    fee: number,
  ): TradeSimResult {
    const stopPct = this.stopLossPct / 100;
    const tpPct = this.takeProfitPct / 100;
    const stop = entryPrice * (1 - stopPct);
    const target = entryPrice * (1 + tpPct);
    const maxHold = CONFIG.BACKTEST_MAX_HOLD_CANDLES;

    for (let i = entryIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      const candlesHeld = i - entryIdx;
      let exitPrice: number | null = null;
      let reason: "stop" | "target" | "time" = "time";

      if (c.low <= stop) { exitPrice = stop * (1 - slip); reason = "stop"; }
      else if (c.high >= target) { exitPrice = target * (1 - slip); reason = "target"; }
      else if (candlesHeld >= maxHold || i === candles.length - 1) {
        exitPrice = c.close * (1 - slip); reason = "time";
      }

      if (exitPrice !== null) {
        const buyNotional = qty * entryPrice;
        const sellNotional = qty * exitPrice;
        const buyFee = buyNotional * fee;
        const sellFee = sellNotional * fee;
        return {
          exitIdx: i,
          exitTs: c.ts,
          exitPrice,
          grossPnl: sellNotional - buyNotional,
          netPnl: sellNotional - buyFee - sellFee - buyNotional,
          fees: buyFee + sellFee,
          slippageCost: 0,
          exitReason: reason,
          entryGrade: "A+",
        };
      }
    }
    // Fallback — end of data
    const last = candles[candles.length - 1];
    const exitPrice = last.close * (1 - slip);
    const buyNotional = qty * entryPrice;
    const sellNotional = qty * exitPrice;
    const buyFee = buyNotional * fee;
    const sellFee = sellNotional * fee;
    return {
      exitIdx: candles.length - 1,
      exitTs: last.ts,
      exitPrice,
      grossPnl: sellNotional - buyNotional,
      netPnl: sellNotional - buyFee - sellFee - buyNotional,
      fees: buyFee + sellFee,
      slippageCost: 0,
      exitReason: "time",
      entryGrade: "A+",
    };
  }
}
