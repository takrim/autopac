import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import express from "express";
import cors from "cors";
import helmet from "helmet";

// Initialize Firebase Admin SDK
initializeApp();

import { requireAuth } from "./middleware/auth";
import { webhookRateLimiter } from "./middleware/rateLimit";
import { handleWebhook, handleRsiWebhook, handleVwapWebhook } from "./webhooks/tradingview";
import { handleTradeApproval } from "./api/trade";
import {
  handleListSignals,
  handleGetSignal,
  handleListOrders,
  handleRegisterToken,
  handleListWebhookErrors,
  handleListBrokerErrors,
} from "./api/signals";
import {
  handleGetAccount,
  handleGetPositions,
  handleGetPortfolioHistory,
  handleLiquidatePosition,
} from "./api/alpaca";
import { handleGetConfig, handleUpdateConfig } from "./api/config";

// --- Webhook App (no auth — uses shared secret) ---
const webhookApp = express();
webhookApp.use(helmet());
webhookApp.use(express.json({ limit: "10kb" }));
webhookApp.use(webhookRateLimiter);

webhookApp.post("/tradingview/rsi", handleRsiWebhook);
webhookApp.post("/tradingview/vwap", handleVwapWebhook);
webhookApp.post("/tradingview", handleWebhook);

// --- API App (authenticated) ---
const apiApp = express();
apiApp.use(helmet());
apiApp.use(cors({ origin: true }));
apiApp.use(express.json({ limit: "50kb" }));
apiApp.use(requireAuth);

apiApp.post("/trade/approve", handleTradeApproval);
apiApp.get("/signals", handleListSignals);
apiApp.get("/signals/:id", handleGetSignal);
apiApp.get("/orders", handleListOrders);
apiApp.get("/webhook-errors", handleListWebhookErrors);
apiApp.get("/broker-errors", handleListBrokerErrors);
apiApp.post("/fcm-token", handleRegisterToken);
apiApp.get("/account", handleGetAccount);
apiApp.get("/positions", handleGetPositions);
apiApp.delete("/positions/:symbol", handleLiquidatePosition);
apiApp.get("/portfolio-history", handleGetPortfolioHistory);
apiApp.get("/config", handleGetConfig);
apiApp.patch("/config", handleUpdateConfig);

// --- Export Cloud Functions ---
// invoker: "public" allows HTTP access without Google IAM auth.
// Webhook validates via shared secret; API validates via Firebase Auth middleware.
export const webhook = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
    timeoutSeconds: 120,
    invoker: "public",
    secrets: ["WEBHOOK_SECRET", "ALPACA_API_KEY", "ALPACA_API_SECRET"],
  },
  webhookApp
);

export const api = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
    invoker: "public",
    secrets: ["ALPACA_API_KEY", "ALPACA_API_SECRET"],
  },
  apiApp
);
