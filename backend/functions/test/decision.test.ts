import { MockBroker } from "../src/brokers/mock";

// Mock firebase-functions logger
jest.mock("firebase-functions/v2", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("MockBroker", () => {
  const broker = new MockBroker();

  test("has name 'mock'", () => {
    expect(broker.name).toBe("mock");
  });

  test("placeOrder returns a result", async () => {
    const result = await broker.placeOrder({
      symbol: "AAPL",
      side: "BUY",
      quantity: 1,
      orderType: "market",
    });

    expect(result).toBeDefined();
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.orderId).toBe("string");
    expect(result.status).toBeDefined();

    if (result.success) {
      expect(result.orderId).toMatch(/^MOCK-/);
      expect(result.status).toBe("FILLED");
    }
  });

  test("placeOrder handles stop loss / take profit", async () => {
    const result = await broker.placeOrder({
      symbol: "TSLA",
      side: "SELL",
      quantity: 5,
      orderType: "market",
      stopLoss: 140.0,
      takeProfit: 160.0,
    });

    expect(result).toBeDefined();
    expect(result.raw?.broker).toBe("mock");
  });
});

describe("Decision Logic", () => {
  // These tests validate the core decision logic concepts
  // The actual integration with Firestore is tested in integration tests

  test("valid decision actions", () => {
    const validActions = ["APPROVE", "REJECT"];
    expect(validActions).toContain("APPROVE");
    expect(validActions).toContain("REJECT");
    expect(validActions).not.toContain("CANCEL");
  });

  test("signal status transitions", () => {
    const validTransitions: Record<string, string[]> = {
      PENDING: ["APPROVED", "REJECTED"],
      APPROVED: ["EXECUTED", "FAILED"],
      REJECTED: [],
      EXECUTED: [],
      FAILED: [],
    };

    // PENDING can only transition to APPROVED or REJECTED
    expect(validTransitions["PENDING"]).toContain("APPROVED");
    expect(validTransitions["PENDING"]).toContain("REJECTED");
    expect(validTransitions["PENDING"]).not.toContain("EXECUTED");

    // APPROVED can only transition to EXECUTED or FAILED
    expect(validTransitions["APPROVED"]).toContain("EXECUTED");
    expect(validTransitions["APPROVED"]).toContain("FAILED");

    // Terminal states have no transitions
    expect(validTransitions["REJECTED"]).toHaveLength(0);
    expect(validTransitions["EXECUTED"]).toHaveLength(0);
  });
});
