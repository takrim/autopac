import { BacktestCandle, BacktestGrade, BacktestIndicatorPoint } from "../../types";

/** Result returned by a strategy's simulateTrade() */
export interface TradeSimResult {
  /** Index in the candles array where the trade exited */
  exitIdx: number;
  exitTs: number;
  /** Blended exit price (weighted average for multi-TP strategies) */
  exitPrice: number;
  grossPnl: number;
  netPnl: number;
  fees: number;
  slippageCost: number;
  exitReason: "stop" | "target" | "time";
  entryGrade: BacktestGrade;
}

/**
 * Strategy Pattern interface for backtest strategies.
 * Each strategy encapsulates its own indicator computation,
 * entry signal logic, and trade simulation (supporting multi-TP etc).
 */
export interface BacktestStrategy {
  /** Unique short id used in /run <id> and /strategy <id> commands */
  readonly id: string;
  /** Human-readable display name */
  readonly name: string;
  /** Multi-line description for the /strategy command */
  readonly description: string[];
  /** Minimum candles needed before any signal can fire */
  readonly warmupCandles: number;
  /** Candles to wait after an exit before the next entry */
  readonly cooldownCandles: number;
  /** Inclusive UTC hour window for entries: [startHour, endHour] */
  readonly tradingHoursUtc: [number, number];
  /** Primary take-profit % (gross, for display) */
  readonly takeProfitPct: number;
  /** Stop-loss % (gross, for display) */
  readonly stopLossPct: number;

  /**
   * Compute indicator values for every candle in the array.
   * Returns an array of the same length as candles.
   */
  buildIndicators(candles: BacktestCandle[]): BacktestIndicatorPoint[];

  /**
   * Return true if candle[i] qualifies as an entry signal.
   * Called only when not in a position and cooldown has elapsed.
   */
  shouldEnter(candles: BacktestCandle[], points: BacktestIndicatorPoint[], i: number): boolean;

  /**
   * Walk forward from entryIdx and simulate the full trade lifecycle.
   * Handles SL/TP checks, multi-TP partial exits, time stops, etc.
   *
   * @param candles      Full candle array
   * @param entryIdx     Index of the entry candle
   * @param entryPrice   Actual fill price (already includes slippage)
   * @param qty          Quantity in BTC
   * @param slip         Slippage fraction (e.g. 0.0008 for 8 BPS)
   * @param feeRate      Fee fraction per side (e.g. 0.006 for 0.6%)
   */
  simulateTrade(
    candles: BacktestCandle[],
    entryIdx: number,
    entryPrice: number,
    qty: number,
    slip: number,
    feeRate: number,
  ): TradeSimResult;
}
