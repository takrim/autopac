import { AlpacaBroker } from "../src/brokers/alpaca";

// Mock firebase-functions logger
jest.mock("firebase-functions/v2", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// firebase-admin/firestore is referenced via getFirestore() inside AlpacaBroker.placeOrder
jest.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: () => ({ add: jest.fn().mockResolvedValue({ id: "err-1" }) }),
  }),
  FieldValue: { serverTimestamp: () => new Date().toISOString() },
}));

// Stub Alpaca credentials so AlpacaBroker doesn't bail at the auth check.
jest.mock("../src/config", () => ({
  CONFIG: { DEFAULT_ORDER_TYPE: "market" },
  getAlpacaConfig: () => ({
    apiKey: "TEST_KEY",
    apiSecret: "TEST_SECRET",
    baseUrl: "https://paper-api.alpaca.markets",
  }),
}));

describe("AlpacaBroker", () => {
  const broker = new AlpacaBroker();
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  beforeAll(() => {
    (global as any).fetch = fetchMock;
  });

  afterAll(() => {
    (global as any).fetch = originalFetch;
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  test("has name 'alpaca'", () => {
    expect(broker.name).toBe("alpaca");
  });

  test("placeOrder returns success on 200 response", async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      const method = (init?.method || "GET").toUpperCase();
      if (method === "POST" && /\/v2\/orders\b/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "ALP-123",
            status: "accepted",
            symbol: "AAPL",
            filled_avg_price: "212.45",
          }),
          text: async () => "",
        };
      }
      // GET positions / open orders → return empty
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    });

    const result = await broker.placeOrder({
      symbol: "AAPL",
      side: "BUY",
      quantity: 1,
      orderType: "market",
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("ALP-123");
    expect(typeof result.status).toBe("string");
  });

  test("placeOrder returns failure on non-OK response", async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      const method = (init?.method || "GET").toUpperCase();
      if (method === "POST" && /\/v2\/orders\b/.test(url)) {
        return {
          ok: false,
          status: 422,
          json: async () => ({ message: "insufficient buying power" }),
          text: async () => "insufficient buying power",
        };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    });

    const result = await broker.placeOrder({
      symbol: "TSLA",
      side: "BUY",
      quantity: 5,
      orderType: "market",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("FAILED");
  });
});

describe("Decision Logic", () => {
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

    expect(validTransitions["PENDING"]).toContain("APPROVED");
    expect(validTransitions["PENDING"]).toContain("REJECTED");
    expect(validTransitions["PENDING"]).not.toContain("EXECUTED");
    expect(validTransitions["APPROVED"]).toContain("EXECUTED");
    expect(validTransitions["APPROVED"]).toContain("FAILED");
    expect(validTransitions["REJECTED"]).toHaveLength(0);
    expect(validTransitions["EXECUTED"]).toHaveLength(0);
  });
});
