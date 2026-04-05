/**
 * Integration test: simulates TradingView signal → approve → order flow.
 *
 * This test mocks Firebase Admin services to test the full flow
 * without requiring a live Firebase project.
 */

// --- Firebase Admin Mocks ---

const mockAdd = jest.fn().mockResolvedValue({ id: "signal-123" });
const mockGet = jest.fn();
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockDoc = jest.fn().mockReturnValue({
  get: jest.fn().mockResolvedValue({
    exists: true,
    id: "signal-123",
    data: () => ({
      strategy: "EMA_Cross",
      symbol: "AAPL",
      action: "BUY",
      timeframe: "5m",
      price: 212.45,
      stopLoss: 210.8,
      takeProfit: 216.2,
      signalTime: new Date().toISOString(),
      status: "PENDING",
      idempotencyKey: "abc123",
    }),
  }),
  update: mockUpdate,
});

// Build a chainable mock that handles any depth of .where().count().get() etc.
function chainable(overrides: Record<string, any> = {}): any {
  const self: any = {
    add: mockAdd,
    doc: mockDoc,
    get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
    where: jest.fn().mockImplementation(() => chainable(overrides)),
    orderBy: jest.fn().mockImplementation(() => chainable(overrides)),
    limit: jest.fn().mockImplementation(() => chainable(overrides)),
    count: jest.fn().mockImplementation(() => ({
      get: jest.fn().mockResolvedValue({ data: () => ({ count: 0 }) }),
    })),
    ...overrides,
  };
  return self;
}

const mockCollection = jest.fn().mockImplementation(() => chainable());

const mockRunTransaction = jest.fn().mockImplementation(async (fn: Function) => {
  const transaction = {
    get: jest.fn().mockResolvedValue({
      exists: true,
      id: "signal-123",
      data: () => ({
        strategy: "EMA_Cross",
        symbol: "AAPL",
        action: "BUY",
        timeframe: "5m",
        price: 212.45,
        stopLoss: 210.8,
        takeProfit: 216.2,
        signalTime: new Date().toISOString(),
        status: "PENDING",
        idempotencyKey: "abc123",
      }),
    }),
    set: jest.fn(),
    update: jest.fn(),
  };
  return fn(transaction);
});

jest.mock("firebase-admin/app", () => ({
  initializeApp: jest.fn(),
}));

jest.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: mockCollection,
    runTransaction: mockRunTransaction,
  }),
  FieldValue: {
    serverTimestamp: () => new Date().toISOString(),
  },
  Timestamp: {
    fromDate: (d: Date) => d,
  },
}));

jest.mock("firebase-admin/messaging", () => ({
  getMessaging: () => ({
    sendEachForMulticast: jest.fn().mockResolvedValue({
      successCount: 0,
      failureCount: 0,
      responses: [],
    }),
  }),
}));

jest.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: jest.fn().mockResolvedValue({ uid: "user-123" }),
  }),
}));

jest.mock("firebase-functions/v2", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("firebase-functions/v2/https", () => ({
  onRequest: jest.fn((opts: any, handler: any) => handler),
}));

jest.mock("../src/config", () => ({
  getWebhookSecret: () => "TEST_SECRET_KEY",
  getAlpacaConfig: () => ({
    apiKey: "",
    apiSecret: "",
    baseUrl: "https://paper-api.alpaca.markets",
  }),
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

// Import after mocks
import { handleWebhook } from "../src/webhooks/tradingview";
import { handleTradeApproval } from "../src/api/trade";

function mockReq(body: any = {}, headers: any = {}, params: any = {}): any {
  return {
    body,
    headers,
    params,
    ip: "127.0.0.1",
    user: undefined,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("Integration: Signal → Approve → Order Flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdd.mockResolvedValue({ id: "signal-123" });
  });

  test("Step 1: Webhook receives and stores a valid signal", async () => {
    const req = mockReq({
      strategy: "EMA_Cross",
      symbol: "AAPL",
      action: "BUY",
      timeframe: "5m",
      price: 212.45,
      stopLoss: 210.8,
      takeProfit: 216.2,
      signalTime: new Date().toISOString(),
      secret: "TEST_SECRET_KEY",
    });

    const res = mockRes();
    await handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "created",
        signalId: "signal-123",
      })
    );
  });

  test("Step 2: User approves the signal and order is placed", async () => {
    const req = mockReq({
      signalId: "signal-123",
      action: "APPROVE",
    });
    req.user = { uid: "user-123" };

    const res = mockRes();
    await handleTradeApproval(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const jsonCall = res.json.mock.calls[0][0];
    expect(jsonCall.status).toBe("approved");
    expect(jsonCall.order).toBeDefined();
  });

  test("Step 3: User rejects a signal", async () => {
    const req = mockReq({
      signalId: "signal-123",
      action: "REJECT",
    });
    req.user = { uid: "user-123" };

    const res = mockRes();
    await handleTradeApproval(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rejected",
        signalId: "signal-123",
      })
    );
  });

  test("Webhook rejects invalid secret", async () => {
    const req = mockReq({
      strategy: "EMA_Cross",
      symbol: "AAPL",
      action: "BUY",
      timeframe: "5m",
      price: 212.45,
      signalTime: new Date().toISOString(),
      secret: "WRONG_SECRET_!",
    });

    const res = mockRes();
    await handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("Approve requires authentication", async () => {
    const req = mockReq({
      signalId: "signal-123",
      action: "APPROVE",
    });
    // No user attached

    const res = mockRes();
    await handleTradeApproval(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
