import { BacktestStrategy } from "./interface";
import { MomentumV2Strategy } from "./momentum_v2";
import { ScalpXStrategy } from "./scalp_x";

export const DEFAULT_STRATEGY_ID = "momentum";

const REGISTRY: Record<string, BacktestStrategy> = {
  momentum:    new MomentumV2Strategy(),
  scalpx:      new ScalpXStrategy(),
};

/** Returns the strategy by id, falling back to the default. */
export function getStrategy(id?: string): BacktestStrategy {
  return REGISTRY[id ?? ""] ?? REGISTRY[DEFAULT_STRATEGY_ID];
}

/** Returns all registered strategies. */
export function listStrategies(): BacktestStrategy[] {
  return Object.values(REGISTRY);
}
