import { CONFIG } from "../config";
import { IBroker } from "./interface";
import { AlpacaBroker } from "./alpaca";
import { CoinbaseBroker } from "./coinbase";

/**
 * Factory: returns the active broker based on config.
 * @param broker - optional override; defaults to CONFIG.ACTIVE_BROKER (env var).
 */
export function getBroker(broker?: string): IBroker {
  switch (broker || CONFIG.ACTIVE_BROKER) {
    case "alpaca":
      return new AlpacaBroker();
    case "coinbase":
      return new CoinbaseBroker();
    default:
      throw new Error(`Unknown broker: ${broker || CONFIG.ACTIVE_BROKER}`);
  }
}
