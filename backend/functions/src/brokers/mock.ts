import { v4 as uuidv4 } from "uuid";
import { logger } from "firebase-functions/v2";
import { IBroker, BrokerPosition } from "./interface";
import { PlaceOrderParams, PlaceOrderResult } from "../types";

/**
 * Mock broker for testing and paper trading.
 * Simulates order placement with realistic responses.
 */
export class MockBroker implements IBroker {
  readonly name = "mock";

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    logger.info("[MOCK_BROKER] Placing order", params);

    // Simulate a small delay like a real API call
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Simulate 95% success rate
    const success = Math.random() > 0.05;

    if (success) {
      const filledPrice =
        params.orderType === "market"
          ? params.limitPrice
            ? params.limitPrice * (1 + (Math.random() - 0.5) * 0.002) // ±0.1% slippage
            : undefined
          : params.limitPrice;

      return {
        success: true,
        orderId: `MOCK-${uuidv4().slice(0, 8).toUpperCase()}`,
        status: "FILLED",
        filledPrice,
        message: "Order filled successfully (mock)",
        raw: {
          broker: "mock",
          simulatedAt: new Date().toISOString(),
          params,
        },
      };
    }

    return {
      success: false,
      orderId: "",
      status: "FAILED",
      message: "Simulated order failure (mock)",
      raw: {
        broker: "mock",
        simulatedAt: new Date().toISOString(),
        error: "SIMULATED_FAILURE",
      },
    };
  }

  async getPosition(_symbol: string): Promise<BrokerPosition | null> {
    return null;
  }

  async liquidatePosition(symbol: string): Promise<Record<string, unknown>> {
    logger.info("[MOCK_BROKER] Liquidating position", { symbol });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { status: "liquidated", symbol, broker: "mock", simulatedAt: new Date().toISOString() };
  }
}
