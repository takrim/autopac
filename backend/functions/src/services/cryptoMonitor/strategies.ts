/**
 * Separate alert strategies — pure evaluators over the scorecard (no I/O).
 *
 * Each strategy independently decides whether a coin is an opportunity of its
 * kind. A coin can trigger several; the orchestrator stores all and notifies the
 * single highest-priority actionable one (RISK_BLOCK suppresses buy alerts).
 */

import { ScoreResult } from "./scoring";

export type AlertType =
  | "RISK_BLOCK"
  | "STRONG_BUY"
  | "PULLBACK_BUY_ZONE"
  | "BUY_SETUP"
  | "MOMENTUM_BREAKOUT"
  | "ACCUMULATION_SETUP"
  | "FUNDAMENTAL_WATCH";

/** Higher index = lower priority. RISK_BLOCK first (always wins). */
export const STRATEGY_PRIORITY: AlertType[] = [
  "RISK_BLOCK", "STRONG_BUY", "PULLBACK_BUY_ZONE", "BUY_SETUP",
  "MOMENTUM_BREAKOUT", "ACCUMULATION_SETUP", "FUNDAMENTAL_WATCH",
];
const ACTIONABLE: AlertType[] = ["STRONG_BUY", "PULLBACK_BUY_ZONE", "BUY_SETUP", "MOMENTUM_BREAKOUT", "ACCUMULATION_SETUP"];

export interface StrategyResult {
  name: AlertType;
  triggered: boolean;
  reasons: string[];
  risks: string[];
  action: string;
}

export interface StrategyConfig {
  fundamental_watch: { min_f: number };
  accumulation_setup: { min_f: number; min_t: number; max_24h_change: number; max_7d_change: number };
  buy_setup: { min_f: number; min_t: number; max_rsi: number; max_24h_change: number };
  strong_buy: { min_f: number; min_t: number; min_total: number; max_rsi: number; require_near_ema: boolean };
  momentum_breakout: { min_f: number; min_volume_multiplier: number; min_rsi: number; max_rsi: number; max_24h_change: number };
  pullback_buy_zone: { min_f: number; min_rsi: number; max_rsi: number };
  cooldown_hours: number;
}

/** Default thresholds (STRONG_BUY uses the temporary MVP gate while fundamentals are partial). */
export const STRATEGY_DEFAULTS: StrategyConfig = {
  fundamental_watch: { min_f: 3 },
  accumulation_setup: { min_f: 3, min_t: 5, max_24h_change: 20, max_7d_change: 40 },
  buy_setup: { min_f: 3, min_t: 7, max_rsi: 75, max_24h_change: 20 },
  strong_buy: { min_f: 3, min_t: 9, min_total: 20, max_rsi: 70, require_near_ema: true },
  momentum_breakout: { min_f: 3, min_volume_multiplier: 1.5, min_rsi: 55, max_rsi: 78, max_24h_change: 18 },
  pullback_buy_zone: { min_f: 3, min_rsi: 38, max_rsi: 60 },
  cooldown_hours: 6,
};

// Helpers — null RSI fails any RSI bound (conservative).
const rsiAtMost = (rsi: number | null, max: number) => rsi != null && rsi <= max;
const rsiAtLeast = (rsi: number | null, min: number) => rsi != null && rsi >= min;
const notOverextended = (sc: ScoreResult, max24: number, max7: number) => sc.change24hPct <= max24 && sc.change7dPct <= max7;

export function evaluateRiskBlock(sc: ScoreResult): StrategyResult {
  return {
    name: "RISK_BLOCK",
    triggered: sc.majorBearish,
    reasons: sc.majorBearish ? ["Major bearish catalyst detected (hack/lawsuit/halt/etc.)"] : [],
    risks: ["Do not buy until the event is understood", "Re-check official project channels and reputable news"],
    action: "Avoid for now.",
  };
}

export function evaluateStrongBuy(sc: ScoreResult, cfg = STRATEGY_DEFAULTS): StrategyResult {
  const c = cfg.strong_buy;
  const nearEma = !c.require_near_ema || sc.nearEma20 || sc.nearEma50;
  const triggered = sc.fundamental >= c.min_f && sc.technical >= c.min_t && sc.total >= c.min_total &&
    !sc.majorBearish && rsiAtMost(sc.rsi, c.max_rsi) && nearEma;
  return {
    name: "STRONG_BUY", triggered,
    reasons: ["Strong fundamentals + technicals with a good entry zone", "No major bearish news", "RSI not overbought"],
    risks: ["Still confirm chart and latest news before sizing"],
    action: "Best-quality setup — consider a planned entry with risk management.",
  };
}

export function evaluatePullbackBuyZone(sc: ScoreResult, cfg = STRATEGY_DEFAULTS): StrategyResult {
  const c = cfg.pullback_buy_zone;
  const triggered = sc.fundamental >= c.min_f && sc.priceAboveEma200 && sc.ema50AboveEma200 &&
    rsiAtLeast(sc.rsi, c.min_rsi) && rsiAtMost(sc.rsi, c.max_rsi) && (sc.nearEma20 || sc.nearEma50) && !sc.majorBearish;
  return {
    name: "PULLBACK_BUY_ZONE", triggered,
    reasons: ["Uptrend intact (price > EMA200, EMA50 > EMA200)", "RSI in a healthy pullback range", "Price pulled back to EMA support"],
    risks: ["Avoid if price closes below EMA200", "Confirm support holds before entry"],
    action: "Consider entry only if the chart confirms support.",
  };
}

export function evaluateBuySetup(sc: ScoreResult, cfg = STRATEGY_DEFAULTS): StrategyResult {
  const c = cfg.buy_setup;
  const triggered = sc.fundamental >= c.min_f && sc.technical >= c.min_t && !sc.majorBearish &&
    rsiAtMost(sc.rsi, c.max_rsi) && sc.change24hPct <= c.max_24h_change;
  return {
    name: "BUY_SETUP", triggered,
    reasons: ["Acceptable fundamentals with decent technical alignment", "RSI not overbought", "Price not excessively pumped"],
    risks: ["Manually confirm the chart and latest news"],
    action: "Reasonable buy candidate — confirm before entering.",
  };
}

export function evaluateMomentumBreakout(sc: ScoreResult, cfg = STRATEGY_DEFAULTS): StrategyResult {
  const c = cfg.momentum_breakout;
  const triggered = sc.fundamental >= c.min_f && sc.volumeMultiplier != null && sc.volumeMultiplier >= c.min_volume_multiplier &&
    sc.priceAboveEma200 && sc.ema50AboveEma200 && rsiAtLeast(sc.rsi, c.min_rsi) && rsiAtMost(sc.rsi, c.max_rsi) &&
    sc.change24hPct <= c.max_24h_change && !sc.majorBearish;
  return {
    name: "MOMENTUM_BREAKOUT", triggered,
    reasons: ["Strength + momentum (volume surge, bullish trend, RSI in momentum range)"],
    risks: ["This is NOT a pullback entry", "Avoid chasing if the candle is extended", "Use smaller size or wait for a retest"],
    action: "Watch for breakout confirmation or wait for a pullback.",
  };
}

export function evaluateAccumulationSetup(sc: ScoreResult, cfg = STRATEGY_DEFAULTS): StrategyResult {
  const c = cfg.accumulation_setup;
  const triggered = sc.fundamental >= c.min_f && sc.technical >= c.min_t && !sc.majorBearish &&
    notOverextended(sc, c.max_24h_change, c.max_7d_change);
  return {
    name: "ACCUMULATION_SETUP", triggered,
    reasons: ["Decent fundamentals + technicals, not overextended"],
    risks: ["Not yet a high-confidence buy"],
    action: "Watch closely; small staged entries only.",
  };
}

export function evaluateFundamentalWatch(sc: ScoreResult, cfg = STRATEGY_DEFAULTS): StrategyResult {
  const c = cfg.fundamental_watch;
  const triggered = sc.fundamental >= c.min_f && !sc.majorBearish;
  return {
    name: "FUNDAMENTAL_WATCH", triggered,
    reasons: ["Fundamentally acceptable — worth monitoring for a better technical entry"],
    risks: [],
    action: "Monitor for a technical entry.",
  };
}

/** Evaluate all strategies (priority order). */
export function evaluateAll(sc: ScoreResult, cfg = STRATEGY_DEFAULTS): StrategyResult[] {
  return [
    evaluateRiskBlock(sc),
    evaluateStrongBuy(sc, cfg),
    evaluatePullbackBuyZone(sc, cfg),
    evaluateBuySetup(sc, cfg),
    evaluateMomentumBreakout(sc, cfg),
    evaluateAccumulationSetup(sc, cfg),
    evaluateFundamentalWatch(sc, cfg),
  ];
}

const priorityOf = (a: AlertType) => STRATEGY_PRIORITY.indexOf(a);

/**
 * Pick the alert to notify. RISK_BLOCK suppresses buy alerts; otherwise the
 * highest-priority triggered actionable alert, else FUNDAMENTAL_WATCH.
 */
export function selectAlert(results: StrategyResult[]): { selected: StrategyResult | null; triggered: StrategyResult[] } {
  const triggered = results.filter(r => r.triggered);
  const risk = triggered.find(r => r.name === "RISK_BLOCK");
  if (risk) return { selected: risk, triggered };

  const actionable = triggered.filter(r => ACTIONABLE.includes(r.name)).sort((a, b) => priorityOf(a.name) - priorityOf(b.name));
  if (actionable.length > 0) return { selected: actionable[0], triggered };

  const watch = triggered.find(r => r.name === "FUNDAMENTAL_WATCH");
  return { selected: watch ?? null, triggered };
}
