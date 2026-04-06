/**
 * Application configuration constants.
 * Sensitive values are loaded from Firebase environment config / Secret Manager.
 */

export const CONFIG = {
  // Trade settings
  TRADE_VALUE_USD: parseFloat(process.env.TRADE_VALUE_USD || "1000"),
  DEFAULT_ORDER_TYPE: "market" as const,

  // Webhook validation
  MAX_SIGNAL_AGE_SECONDS: 300, // 5 minutes - reject stale signals
  WEBHOOK_SECRET_HEADER: "x-webhook-secret",

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: 60_000, // 1 minute
  RATE_LIMIT_MAX_REQUESTS: 30, // per window

  // Risk checks
  MAX_DAILY_TRADES: 50,
  MAX_POSITION_VALUE: 50_000, // USD

  // Stop loss / take profit (percentage from entry price)
  STOP_LOSS_PCT: 0.5,
  TAKE_PROFIT_PCT: 2.0,

  // Allowed trade directions: "BOTH", "LONG", "SHORT"
  ALLOWED_DIRECTIONS: (process.env.ALLOWED_DIRECTIONS || "LONG") as "BOTH" | "LONG" | "SHORT",

  // Only accept signals with these order comments (empty = accept all)
  // LE=Long Entry, SE=Short Entry, LXTP1=Long TP1, SL=Stop Loss, etc.
  ALLOWED_ORDER_COMMENTS: ["LE"] as string[],

  // Broker
  ACTIVE_BROKER: (process.env.ACTIVE_BROKER || "mock") as "mock" | "alpaca",

  // Order pyramiding: allow multiple buys on the same symbol
  ORDER_PYRAMID: process.env.ORDER_PYRAMID === "true",

  // Auto-approve: skip manual approval and execute immediately
  AUTO_APPROVE: process.env.AUTO_APPROVE === "true",

  // Paper trading mode
  PAPER_TRADING: process.env.PAPER_TRADING !== "false",

  // Simulated fee rate per side (entry + exit) to approximate real exchange costs.
  // Default matches Coinbase Advanced taker fee for < $10K/month volume (0.6%).
  // Set SIMULATED_FEE_RATE=0 to disable, or 0.004 for Coinbase maker fee.
  SIMULATED_FEE_RATE: parseFloat(process.env.SIMULATED_FEE_RATE || "0.006"),
} as const;

/**
 * Get the webhook shared secret from env.
 * Never hardcode or expose this value.
 */
export function getWebhookSecret(): string {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("WEBHOOK_SECRET environment variable is not set");
  }
  return secret;
}

/**
 * Get Alpaca API credentials from env.
 */
export function getAlpacaConfig() {
  return {
    apiKey: process.env.ALPACA_API_KEY || "",
    apiSecret: process.env.ALPACA_API_SECRET || "",
    baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
  };
}
