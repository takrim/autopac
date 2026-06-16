import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import express from "express";
import cors from "cors";
import helmet from "helmet";

// Initialize Firebase Admin SDK
initializeApp();

import { requireAuth } from "./middleware/auth";
import { webhookRateLimiter } from "./middleware/rateLimit";
import { handleWebhook, handleBulltrendWebhook, handleBeartrendWebhook } from "./webhooks/tradingview";
import { handleTradeApproval, handleManualOrder } from "./api/trade";
import {
  handleListSignals,
  handleGetSignal,
  handleListOrders,
  handleRegisterToken,
  handleListWebhookErrors,
  handleListBrokerErrors,
  handleListDecisions,
  handleGetTrend,
  handleGetBook,
} from "./api/signals";
import {
  handleGetAccount,
  handleGetPositions,
  handleGetPortfolioHistory,
  handleLiquidatePosition,
  handleUpdateStopLoss,
  handleGetLevels,
  handleGetNews,
} from "./api/alpaca";
import { handleGetConfig, handleUpdateConfig } from "./api/config";
import { handleGetTrending } from "./api/trending";
import { handleTelegramWebhook } from "./webhooks/telegram";

// --- Webhook App (no auth — uses shared secret) ---
const webhookApp = express();
webhookApp.use(helmet());
webhookApp.use(express.json({ limit: "10kb" }));
webhookApp.use(webhookRateLimiter);

webhookApp.post("/tradingview/bulltrend", handleBulltrendWebhook);
webhookApp.post("/tradingview/beartrend", handleBeartrendWebhook);
webhookApp.post("/tradingview", handleWebhook);
webhookApp.post("/telegram", handleTelegramWebhook);

// --- API App (authenticated) ---
const apiApp = express();
apiApp.use(helmet());
apiApp.use(cors({ origin: true }));
apiApp.use(express.json({ limit: "50kb" }));
apiApp.use(requireAuth);

apiApp.post("/trade/approve", handleTradeApproval);
apiApp.post("/orders/manual", handleManualOrder);
apiApp.get("/signals", handleListSignals);
apiApp.get("/signals/:id", handleGetSignal);
apiApp.get("/orders", handleListOrders);
apiApp.get("/webhook-errors", handleListWebhookErrors);
apiApp.get("/broker-errors", handleListBrokerErrors);
apiApp.get("/decisions", handleListDecisions);
apiApp.get("/trend", handleGetTrend);
apiApp.get("/book/:symbol", handleGetBook);
apiApp.post("/fcm-token", handleRegisterToken);
apiApp.get("/account", handleGetAccount);
apiApp.get("/positions", handleGetPositions);
apiApp.delete("/positions/:symbol", handleLiquidatePosition);
apiApp.post("/positions/:symbol/stop-loss", handleUpdateStopLoss);
apiApp.get("/positions/:symbol/levels", handleGetLevels);
apiApp.get("/positions/:symbol/news", handleGetNews);
apiApp.get("/portfolio-history", handleGetPortfolioHistory);
apiApp.get("/config", handleGetConfig);
apiApp.patch("/config", handleUpdateConfig);
apiApp.get("/trending", handleGetTrending);

// --- Export Cloud Functions ---
// invoker: "public" allows HTTP access without Google IAM auth.
// Webhook validates via shared secret; API validates via Firebase Auth middleware.
export const webhook = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
    timeoutSeconds: 120,
    invoker: "public",
    secrets: ["WEBHOOK_SECRET", "ALPACA_API_KEY", "ALPACA_API_SECRET", "COINBASE_API_KEY", "COINBASE_API_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET", "COINGECKO_API_KEY"],
  },
  webhookApp
);

export const api = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
    invoker: "public",
    secrets: [
      "ALPACA_API_KEY",
      "ALPACA_API_SECRET",
      "COINBASE_API_KEY",
      "COINBASE_API_SECRET",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "TELEGRAM_WEBHOOK_SECRET",
    ],
  },
  apiApp
);

// Dedicated Telegram bot function — long timeout so /run can complete the full backtest.
const tgbotApp = express();
tgbotApp.use(helmet());
tgbotApp.use(express.json({ limit: "10kb" }));
tgbotApp.post("/", handleTelegramWebhook);

export const tgbot = onRequest(
  {
    region: "us-central1",
    maxInstances: 1,
    timeoutSeconds: 540,
    invoker: "public",
    secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "COINBASE_API_KEY", "COINBASE_API_SECRET", "GEMINI_API_KEY", "RESEND_API_KEY", "COINGECKO_API_KEY"],
  },
  tgbotApp
);
