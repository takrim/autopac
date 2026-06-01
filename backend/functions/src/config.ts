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
  ACTIVE_BROKER: (process.env.ACTIVE_BROKER || "alpaca") as "alpaca" | "coinbase",

  // Order pyramiding: allow multiple buys on the same symbol
  ORDER_PYRAMID: process.env.ORDER_PYRAMID === "true",

  // Auto-approve: skip manual approval and execute immediately
  AUTO_APPROVE: process.env.AUTO_APPROVE === "true",

  // Simulated fee rate per side (entry + exit) to approximate real exchange costs.
  // Default matches Coinbase Advanced taker fee on the current tier (0.5%).
  // Set SIMULATED_FEE_RATE=0 to disable, or 0.0025 for the maker fee on this tier.
  SIMULATED_FEE_RATE: parseFloat(process.env.SIMULATED_FEE_RATE || "0.005"),

  // Backtest job (BTC-USD, 5-minute candles)
  BACKTEST_LOOKBACK_DAYS: parseInt(process.env.BACKTEST_LOOKBACK_DAYS || "90", 10),
  BACKTEST_GRANULARITY_SECONDS: parseInt(process.env.BACKTEST_GRANULARITY_SECONDS || "300", 10),
  BACKTEST_CHUNK_CANDLES: parseInt(process.env.BACKTEST_CHUNK_CANDLES || "300", 10),
  BACKTEST_REQUEST_DELAY_MS: parseInt(process.env.BACKTEST_REQUEST_DELAY_MS || "120", 10),
  BACKTEST_TRADE_VALUE_USD: parseFloat(process.env.BACKTEST_TRADE_VALUE_USD || "1000"),
  BACKTEST_STOP_LOSS_PCT: parseFloat(process.env.BACKTEST_STOP_LOSS_PCT || "1.0"),
  BACKTEST_TAKE_PROFIT_PCT: parseFloat(process.env.BACKTEST_TAKE_PROFIT_PCT || "3.0"),
  BACKTEST_SLIPPAGE_BPS: parseFloat(process.env.BACKTEST_SLIPPAGE_BPS || "8"),
  BACKTEST_FEE_RATE_PER_SIDE: parseFloat(process.env.BACKTEST_FEE_RATE_PER_SIDE || "0.005"),
  BACKTEST_REPORT_MAX_TRADES: parseInt(process.env.BACKTEST_REPORT_MAX_TRADES || "200", 10),
  BACKTEST_MAX_HOLD_CANDLES: parseInt(process.env.BACKTEST_MAX_HOLD_CANDLES || "36", 10),   // 3h max
  BACKTEST_COOLDOWN_CANDLES: parseInt(process.env.BACKTEST_COOLDOWN_CANDLES || "5", 10),    // 25min cooldown
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

/**
 * Get Coinbase CDP API credentials from env.
 * apiKey: "organizations/{org_id}/apiKeys/{key_id}"
 * apiSecret: EC private key (PEM, ECDSA P-256)
 */
export function getCoinbaseConfig() {
  return {
    apiKey: process.env.COINBASE_API_KEY || "",
    apiSecret: (process.env.COINBASE_API_SECRET || "").replace(/\\n/g, "\n"),
  };
}

/**
 * Get Telegram bot config from env/secrets.
 */
export function getTelegramConfig() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
    enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  };
}
