import { CONFIG } from "../config";
import { IBroker } from "./interface";
import { MockBroker } from "./mock";
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
    case "mock":
    default:
      return new MockBroker();
  }
}
