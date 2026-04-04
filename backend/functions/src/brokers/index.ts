import { CONFIG } from "../config";
import { IBroker } from "./interface";
import { MockBroker } from "./mock";
import { AlpacaBroker } from "./alpaca";

/**
 * Factory: returns the active broker based on config.
 */
export function getBroker(): IBroker {
  switch (CONFIG.ACTIVE_BROKER) {
    case "alpaca":
      return new AlpacaBroker();
    case "mock":
    default:
      return new MockBroker();
  }
}
