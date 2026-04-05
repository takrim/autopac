// Mock firebase-admin before any imports that use it
jest.mock("firebase-admin/app", () => ({ initializeApp: jest.fn() }));
jest.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: jest.fn().mockReturnValue({
      add: jest.fn(),
      get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
    }),
  }),
  FieldValue: { serverTimestamp: () => new Date().toISOString() },
}));
jest.mock("firebase-admin/messaging", () => ({
  getMessaging: () => ({
    sendEachForMulticast: jest.fn().mockResolvedValue({ successCount: 0, failureCount: 0, responses: [] }),
  }),
}));
jest.mock("firebase-functions/v2", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { validatePayload } from "../src/webhooks/tradingview";

// Mock the config module
jest.mock("../src/config", () => ({
  getWebhookSecret: () => "TEST_SECRET_KEY",
  CONFIG: {
    MAX_SIGNAL_AGE_SECONDS: 300,
    WEBHOOK_SECRET_HEADER: "x-webhook-secret",
    RATE_LIMIT_WINDOW_MS: 60000,
    RATE_LIMIT_MAX_REQUESTS: 30,
    TRADE_VALUE_USD: 1000,
    DEFAULT_ORDER_TYPE: "market",
    MAX_DAILY_TRADES: 20,
    MAX_POSITION_VALUE: 50000,
    STOP_LOSS_PCT: 0.5,
    TAKE_PROFIT_PCT: 2.0,
    ALLOWED_DIRECTIONS: "BOTH",
    ALLOWED_ORDER_COMMENTS: [],
    ACTIVE_BROKER: "mock",
    ORDER_PYRAMID: false,
    AUTO_APPROVE: false,
    PAPER_TRADING: true,
  },
}));

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    strategy: "EMA_Cross",
    symbol: "AAPL",
    action: "BUY",
    timeframe: "5m",
    price: 212.45,
    stopLoss: 210.8,
    takeProfit: 216.2,
    signalTime: new Date().toISOString(),
    secret: "TEST_SECRET_KEY",
    ...overrides,
  };
}

describe("Webhook Payload Validation", () => {
  test("accepts valid payload", () => {
    const result = validatePayload(validPayload());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.symbol).toBe("AAPL");
      expect(result.payload.action).toBe("BUY");
    }
  });

  test("rejects missing strategy", () => {
    const result = validatePayload(validPayload({ strategy: "" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("strategy");
    }
  });

  test("rejects missing symbol", () => {
    const result = validatePayload(validPayload({ symbol: undefined }));
    expect(result.valid).toBe(false);
  });

  test("rejects missing secret", () => {
    const result = validatePayload(validPayload({ secret: undefined }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("secret");
    }
  });

  test("rejects invalid secret", () => {
    const result = validatePayload(validPayload({ secret: "WRONG_SECRET_!" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Invalid secret");
    }
  });

  test("rejects invalid action", () => {
    const result = validatePayload(validPayload({ action: "HOLD" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("action");
    }
  });

  test("accepts SELL action", () => {
    const result = validatePayload(validPayload({ action: "SELL" }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.action).toBe("SELL");
    }
  });

  test("normalizes action to uppercase", () => {
    const result = validatePayload(validPayload({ action: "buy" }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.action).toBe("BUY");
    }
  });

  test("rejects negative price", () => {
    const result = validatePayload(validPayload({ price: -10 }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("price");
    }
  });

  test("rejects zero price", () => {
    const result = validatePayload(validPayload({ price: 0 }));
    expect(result.valid).toBe(false);
  });

  test("rejects string price", () => {
    const result = validatePayload(validPayload({ price: "212.45" }));
    expect(result.valid).toBe(false);
  });

  test("rejects invalid signalTime", () => {
    const result = validatePayload(validPayload({ signalTime: "not-a-date" }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("signalTime");
    }
  });

  test("rejects stale signal (older than 5 min)", () => {
    const staleTime = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
    const result = validatePayload(validPayload({ signalTime: staleTime }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("too old");
    }
  });

  test("rejects future signal", () => {
    const futureTime = new Date(Date.now() + 120_000).toISOString(); // 2 min from now
    const result = validatePayload(validPayload({ signalTime: futureTime }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("future");
    }
  });

  test("calculates stopLoss from price (input stopLoss is ignored)", () => {
    const result = validatePayload(validPayload({ stopLoss: -5 }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      // SL is auto-calculated as price * (1 - STOP_LOSS_PCT/100)
      expect(result.payload.stopLoss).toBeGreaterThan(0);
    }
  });

  test("calculates takeProfit from price (input takeProfit is ignored)", () => {
    const result = validatePayload(validPayload({ takeProfit: "abc" }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      // TP is auto-calculated as price * (1 + TAKE_PROFIT_PCT/100)
      expect(result.payload.takeProfit).toBeGreaterThan(0);
    }
  });

  test("normalizes symbol to uppercase", () => {
    const result = validatePayload(validPayload({ symbol: "aapl" }));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.symbol).toBe("AAPL");
    }
  });

  test("strips secret from validated payload", () => {
    const result = validatePayload(validPayload());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.secret).toBe("");
    }
  });
});
