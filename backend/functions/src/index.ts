import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
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
import { sendTelegramMessage } from "./services/telegram";
// import { runBurstScanner } from "./services/burstScanner"; // disabled
import { runPositionLiquidator } from "./services/positionLiquidator";
import { runDecisionAnalyzer } from "./services/decisionAnalyzer";
import { analyzeStoredDecisionWithAI } from "./services/aiBurstAnalyze";
import { sendEmail } from "./services/email";
// import { runNewsMonitor } from "./services/newsMonitor";

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

// Burst scanner — DISABLED. Export removed so next deploy deletes the function.
// To re-enable, uncomment the export below.
// export const burstScanner = onSchedule(
//   {
//     region: "us-central1",
//     schedule: "every 5 minutes",
//     timeoutSeconds: 300,
//     maxInstances: 1,
//     secrets: ["COINGECKO_API_KEY", "COINBASE_API_KEY", "COINBASE_API_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
//   },
//   async () => {
//     try {
//       await runBurstScanner();
//     } catch (err) {
//       const msg = String(err);
//       logger.error("[BURST_SCANNER] Scheduled run failed", { error: msg });
//       await sendTelegramMessage(`⚠️ Burst Scanner FAILED:\n${msg}`).catch(() => {});
//     }
//   }
// );

// Scheduled news monitor — every 10 minutes.
// Fetches Google News for active BUY signals + open positions, scores headlines
// for bullish sentiment, and sends a Telegram digest of symbols with positive momentum.
// export const newsMonitor = onSchedule(
//   {
//     region: "us-central1",
//     schedule: "every 10 minutes",
//     timeoutSeconds: 300,
//     maxInstances: 1,
//     secrets: ["COINBASE_API_KEY", "COINBASE_API_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
//   },
//   async () => {
//     try {
//       await runNewsMonitor();
//     } catch (err) {
//       const msg = String(err);
//       logger.error("[NEWS_MONITOR] Scheduled run failed", { error: msg });
//       await sendTelegramMessage(`⚠️ News Monitor FAILED:\n${msg}`).catch(() => {});
//     }
//   }
// );

// Position liquidator — every 1 minute.
// For each open Coinbase position, checks the last 3 completed 1-min candles.
// If all 3 are red (close < open) it immediately liquidates the position.
export const positionLiquidator = onSchedule(
  {
    region: "us-central1",
    schedule: "every 1 minutes",
    timeoutSeconds: 120,
    maxInstances: 1,
    secrets: ["COINBASE_API_KEY", "COINBASE_API_SECRET", "ALPACA_API_KEY", "ALPACA_API_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "MASSIVE_API_KEY"],
  },
  async () => {
    try {
      await runPositionLiquidator();
    } catch (err) {
      const msg = String(err);
      logger.error("[POSITION_LIQUIDATOR] Scheduled run failed", { error: msg });
      await sendTelegramMessage(`⚠️ Position Liquidator FAILED:\n${msg}`).catch(() => {});
    }
  }
);

// Daily decision analyzer — every 24h.
// Pulls last 24h of decision_logs, asks Gemini for a deep analysis, emails the report.
export const decisionAnalyzer = onSchedule(
  {
    region: "us-central1",
    schedule: "every 24 hours",
    timeoutSeconds: 540,
    maxInstances: 1,
    secrets: ["GEMINI_API_KEY", "RESEND_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
  },
  async () => {
    try {
      await runDecisionAnalyzer();
    } catch (err) {
      const msg = String(err);
      logger.error("[DECISION_ANALYZER] Scheduled run failed", { error: msg });
      await sendTelegramMessage(`⚠️ Decision Analyzer FAILED:\n${msg}`).catch(() => {});
    }
  }
);

// Burst buy AI analyzer — Firestore trigger fired when burst_scanner writes a
// new ACCEPTED decision_log entry. Decoupled from the burst scanner cycle so
// Gemini calls never extend the scanner's runtime. Each accepted buy gets its
// own analysis email + telegram report. Skips REJECTED entries and non-burst
// sources to avoid noise.
const AIBURST_EMAIL_TO_DEFAULT = process.env.ANALYSIS_EMAIL_TO || "cliqueadmin@helpables.org";
export const burstBuyAnalyzer = onDocumentCreated(
  {
    document: "decision_logs/{id}",
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: ["GEMINI_API_KEY", "RESEND_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    if (data.source !== "burst_scanner") return;
    if (data.outcome !== "ACCEPTED") return;
    const symbol = String(data.symbol || "").toUpperCase();
    if (!symbol) return;

    logger.info("[BURST_AI_TRIGGER] New burst buy — running analysis", { symbol, decisionId: event.params.id });
    try {
      const report = await analyzeStoredDecisionWithAI(symbol, { outcome: "ACCEPTED" });
      if (!report) {
        logger.warn("[BURST_AI_TRIGGER] No snapshot found for symbol", { symbol });
        return;
      }
      const to = process.env.ANALYSIS_EMAIL_TO || AIBURST_EMAIL_TO_DEFAULT;
      const subject = `AutoPac Burst AI Analysis — ${symbol} (executed buy)`;
      const emailRes = await sendEmail({ to, subject, html: report.html, text: report.text });
      if (!emailRes.ok) {
        logger.warn("[BURST_AI_TRIGGER] Email send failed", { symbol, error: emailRes.error });
      }
      try {
        const header = `🤖 Auto AI Analysis — ${symbol} (burst buy)`;
        const body = report.text.length > 3800 ? report.text.slice(0, 3800) + "\n…(truncated — see email)" : report.text;
        await sendTelegramMessage(`${header}\n${body}`);
      } catch (tgErr) {
        logger.warn("[BURST_AI_TRIGGER] Telegram send failed", { symbol, error: String(tgErr) });
      }
    } catch (err) {
      logger.error("[BURST_AI_TRIGGER] Analysis failed", { symbol, error: String(err) });
    }
  }
);
