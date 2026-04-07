import { Request, Response } from "express";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import crypto from "crypto";
import { WebhookPayload, Signal } from "../types";
import { getWebhookSecret, CONFIG, getAlpacaConfig } from "../config";
import { getTradingConfig, TradingConfig } from "../api/config";
import { sendSignalNotification } from "../services/notification";
import { logAudit } from "../services/audit";
import { executeOrder } from "../api/trade";
import { calculateIndicators } from "../services/indicators";

const db = getFirestore();

const REQUIRED_FIELDS: (keyof WebhookPayload)[] = [
  "strategy",
  "symbol",
  "action",
  "timeframe",
  "price",
  "signalTime",
  "secret",
];

/**
 * Validate the webhook payload structure and security.
 */
export function validatePayload(
  body: Record<string, unknown>,
  tradingConfig?: TradingConfig
): { valid: true; payload: WebhookPayload } | { valid: false; error: string } {
  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Validate action
  const action = String(body.action).toUpperCase();
  if (action !== "BUY" && action !== "SELL") {
    return { valid: false, error: "Invalid action — must be BUY or SELL" };
  }

  // Filter by allowed trade directions
  const allowed = tradingConfig?.ALLOWED_DIRECTIONS ?? CONFIG.ALLOWED_DIRECTIONS;
  if (allowed === "LONG" && action === "SELL") {
    return { valid: false, error: "SELL signals are disabled (ALLOWED_DIRECTIONS=LONG)" };
  }
  if (allowed === "SHORT" && action === "BUY") {
    return { valid: false, error: "BUY signals are disabled (ALLOWED_DIRECTIONS=SHORT)" };
  }

  // Filter by order comment — only accept entry signals, not TP/SL exits
  const orderComment = body.orderComment ? String(body.orderComment).trim() : "";
  if (CONFIG.ALLOWED_ORDER_COMMENTS.length > 0 && orderComment) {
    if (!CONFIG.ALLOWED_ORDER_COMMENTS.includes(orderComment)) {
      return { valid: false, error: `Order comment "${orderComment}" not in allowed list (${CONFIG.ALLOWED_ORDER_COMMENTS.join(", ")})` };
    }
  }

  // Validate price is a positive number
  if (typeof body.price !== "number" || body.price <= 0) {
    return { valid: false, error: "Invalid price — must be a positive number" };
  }

  // Validate signalTime is a valid ISO date
  const signalDate = new Date(body.signalTime as string);
  if (isNaN(signalDate.getTime())) {
    return { valid: false, error: "Invalid signalTime — must be ISO 8601" };
  }

  // Check signal freshness (prevent replay attacks)
  const ageSeconds = (Date.now() - signalDate.getTime()) / 1000;
  if (ageSeconds > CONFIG.MAX_SIGNAL_AGE_SECONDS) {
    return {
      valid: false,
      error: `Signal too old (${Math.round(ageSeconds)}s) — max ${CONFIG.MAX_SIGNAL_AGE_SECONDS}s`,
    };
  }
  if (ageSeconds < -60) {
    // Allow 1 min clock skew
    return { valid: false, error: "Signal timestamp is in the future" };
  }

  // Validate secret
  const secret = String(body.secret);
  let webhookSecret: string;
  try {
    webhookSecret = getWebhookSecret();
  } catch {
    return { valid: false, error: "Server configuration error" };
  }

  const secretBuf = Buffer.from(secret);
  const expectedBuf = Buffer.from(webhookSecret);
  if (secretBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(secretBuf, expectedBuf)) {
    return { valid: false, error: "Invalid secret" };
  }

  // Calculate SL and TP from entry price
  const price = body.price as number;
  const slPct = (tradingConfig?.STOP_LOSS_PCT ?? CONFIG.STOP_LOSS_PCT) / 100;
  const tpPct = (tradingConfig?.TAKE_PROFIT_PCT ?? CONFIG.TAKE_PROFIT_PCT) / 100;

  // Determine decimal precision from the price itself (e.g. 0.046 → 3 decimals, 212.45 → 2)
  const priceStr = price.toString();
  const decimalIdx = priceStr.indexOf(".");
  const decimals = decimalIdx === -1 ? 0 : priceStr.length - decimalIdx - 1;
  const precision = Math.max(decimals, 2); // at least 2, but match the price's own precision
  const factor = Math.pow(10, precision);

  const stopLoss = action === "BUY"
    ? Math.round(price * (1 - slPct) * factor) / factor
    : Math.round(price * (1 + slPct) * factor) / factor;

  const takeProfit = action === "BUY"
    ? Math.round(price * (1 + tpPct) * factor) / factor
    : Math.round(price * (1 - tpPct) * factor) / factor;

  return {
    valid: true,
    payload: {
      strategy: String(body.strategy),
      symbol: String(body.symbol).toUpperCase(),
      action: action as "BUY" | "SELL",
      timeframe: String(body.timeframe),
      price,
      stopLoss,
      takeProfit,
      signalTime: signalDate.toISOString(),
      secret: "",
    },
  };
}

/**
 * Generate an idempotency key to detect duplicate signals.
 * Based on strategy + symbol + action + signalTime.
 */
function generateIdempotencyKey(payload: WebhookPayload): string {
  const raw = `${payload.strategy}:${payload.symbol}:${payload.action}:${payload.signalTime}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/**
 * Handle incoming TradingView webhook.
 */
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  // Also check header-based secret
  const headerSecret = req.headers[CONFIG.WEBHOOK_SECRET_HEADER];
  if (headerSecret) {
    // If header is present, use it as an additional check
    try {
      const expected = getWebhookSecret();
      const hBuf = Buffer.from(String(headerSecret));
      const eBuf = Buffer.from(expected);
      if (hBuf.length !== eBuf.length || !crypto.timingSafeEqual(hBuf, eBuf)) {
        res.status(401).json({ error: "Invalid webhook secret" });
        return;
      }
    } catch {
      // Fall through to payload validation
    }
  }

  await logAudit("SIGNAL_RECEIVED", {
    details: { ip: req.ip, strategy: req.body?.strategy, symbol: req.body?.symbol },
  });

  // Load user-configurable trading settings from Firestore
  let tradingConfig: TradingConfig;
  try {
    tradingConfig = await getTradingConfig();
  } catch (err) {
    logger.error("[WEBHOOK] Failed to load trading config", err);
    res.status(500).json({ error: "Failed to load trading config" });
    return;
  }

  // Validate payload
  const validation = validatePayload(req.body || {}, tradingConfig);
  if (!validation.valid) {
    logger.warn("[WEBHOOK] Invalid payload", { error: validation.error });

    // Log error to webhook_errors collection
    const sanitizedBody = { ...req.body };
    delete sanitizedBody.secret; // Never store the secret attempt
    await db.collection("webhook_errors").add({
      error: validation.error,
      receivedBody: sanitizedBody,
      ip: req.ip || "unknown",
      timestamp: FieldValue.serverTimestamp(),
    });

    res.status(400).json({ error: validation.error });
    return;
  }

  const { payload } = validation;
  const idempotencyKey = generateIdempotencyKey(payload);

  // Check for duplicate signal
  const existing = await db
    .collection("signals")
    .where("idempotencyKey", "==", idempotencyKey)
    .limit(1)
    .get();

  if (!existing.empty) {
    await logAudit("SIGNAL_DUPLICATE", { details: { idempotencyKey } });
    logger.info("[WEBHOOK] Duplicate signal detected", { idempotencyKey });
    res.status(200).json({ status: "duplicate", signalId: existing.docs[0].id });
    return;
  }

  // Pyramid check: query Alpaca for an actual open position on this symbol
  if (!tradingConfig.ORDER_PYRAMID && payload.action === "BUY") {
    try {
      const alpacaConfig = getAlpacaConfig();
      const isCrypto = payload.symbol.endsWith("USD") || payload.symbol.endsWith("USDT") || payload.symbol.includes("/");
      const alpacaSymbol = isCrypto && !payload.symbol.includes("/")
        ? payload.symbol.replace(/USDT?$/, "") + "/USD"
        : payload.symbol;

      // Alpaca positions API uses no-slash format (ETHUSD not ETH/USD)
      const posSymbol = alpacaSymbol.replace("/", "");
      const posResp = await fetch(
        `${alpacaConfig.baseUrl}/v2/positions/${encodeURIComponent(posSymbol)}`,
        {
          headers: {
            "APCA-API-KEY-ID": alpacaConfig.apiKey,
            "APCA-API-SECRET-KEY": alpacaConfig.apiSecret,
          },
        }
      );

      if (posResp.ok) {
        const posData = await posResp.json() as Record<string, unknown>;
        const qty = parseFloat(posData.qty as string || "0");
        if (qty > 0) {
          logger.info("[WEBHOOK] Pyramid disabled — skipping BUY, Alpaca position exists", { symbol: alpacaSymbol, qty });
          res.status(200).json({ status: "skipped_pyramid_off", symbol: payload.symbol });
          return;
        }
      }
    } catch (err) {
      logger.warn("[WEBHOOK] Pyramid check failed, allowing order", { err: String(err) });
    }
  }

  // Delete stale PENDING and REJECTED signals for this symbol
  try {
    const staleSnap = await db
      .collection("signals")
      .where("symbol", "==", payload.symbol)
      .where("status", "in", ["PENDING", "REJECTED"])
      .get();

    if (!staleSnap.empty) {
      const batch = db.batch();
      for (const doc of staleSnap.docs) {
        batch.delete(doc.ref);
      }
      await batch.commit();
      logger.info("[WEBHOOK] Deleted stale signals", { symbol: payload.symbol, count: staleSnap.size });
    }
  } catch (err) {
    logger.warn("[WEBHOOK] Failed to delete stale signals (non-fatal)", { err: String(err) });
  }

  // Store signal
  const signal: Signal = {
    strategy: payload.strategy,
    symbol: payload.symbol,
    action: payload.action as "BUY" | "SELL",
    timeframe: payload.timeframe,
    price: payload.price,
    stopLoss: payload.stopLoss,
    takeProfit: payload.takeProfit,
    signalTime: payload.signalTime,
    status: "PENDING",
    idempotencyKey,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const docRef = await db.collection("signals").add(signal);
  signal.id = docRef.id;

  await logAudit("SIGNAL_VALIDATED", { signalId: docRef.id });

  // Calculate RSI(14) and VWAP for the signal — non-blocking, don't fail the webhook
  try {
    const indicators = await calculateIndicators(payload.symbol, payload.price);
    const indicatorUpdate: Record<string, unknown> = {};
    if (indicators.rsi !== null) {
      indicatorUpdate.rsi = parseFloat(indicators.rsi.toFixed(2));
      indicatorUpdate.rsiTrend = indicators.rsi < 30 ? "bullish" : indicators.rsi > 70 ? "bearish" : "neutral";
      indicatorUpdate.rsiConfidence = indicators.rsi < 20 || indicators.rsi > 80 ? "strong" : indicators.rsi < 30 || indicators.rsi > 70 ? "confirmed" : "early";
    }
    if (indicators.vwap !== null) {
      indicatorUpdate.vwapTrend = indicators.vwapTrend;
      indicatorUpdate.vwapPrice = parseFloat(indicators.vwap.toFixed(4));
    }
    if (Object.keys(indicatorUpdate).length > 0) {
      indicatorUpdate.rsiUpdatedAt = FieldValue.serverTimestamp();
      indicatorUpdate.vwapUpdatedAt = FieldValue.serverTimestamp();
      indicatorUpdate.updatedAt = FieldValue.serverTimestamp();
      await docRef.update(indicatorUpdate);
      logger.info("[WEBHOOK] Indicators attached to signal", { signalId: docRef.id, ...indicatorUpdate });
    }
  } catch (err) {
    logger.error("[WEBHOOK] Indicator calculation failed (non-fatal)", { err: String(err) });
  }

  // Send push notification
  try {
    await sendSignalNotification(signal);
  } catch (err) {
    // Don't fail the webhook if notification fails
    logger.error("[WEBHOOK] Notification error (non-fatal)", err);
  }

  logger.info("[WEBHOOK] Signal created", { signalId: docRef.id, symbol: payload.symbol });

  // Auto-approve: skip manual approval and execute immediately
  if (tradingConfig.AUTO_APPROVE) {
    logger.info("[WEBHOOK] Auto-approve enabled — executing order", { signalId: docRef.id });

    try {
      const orderResult = await executeOrder(signal, "auto-approve");
      res.status(201).json({ status: "auto_executed", signalId: docRef.id, order: orderResult });
    } catch (err) {
      logger.error("[WEBHOOK] Auto-execute failed", err);
      res.status(201).json({ status: "created_execution_failed", signalId: docRef.id });
    }
    return;
  }

  res.status(201).json({ status: "created", signalId: docRef.id });
}
/**
 * POST /tradingview/rsi — Receive RSI trend signals from TradingView.
 *
 * Only accepts and stores the RSI data if there is a PENDING signal for the symbol.
 * Otherwise the update is rejected — we don't store stale/orphan indicator data.
 *
 * Expected payload:
 *   { "symbol": "ETHUSD", "price": 2100.50, "rsitrend": "bullish", "confidence": "early", "secret": "..." }
 */
export async function handleRsiWebhook(req: Request, res: Response): Promise<void> {
  logger.info("[RSI] Webhook hit", { path: req.path, body: JSON.stringify(req.body || {}).slice(0, 300) });

  const body = req.body || {};

  // --- Validate secret ---
  const secret = String(body.secret || "");
  let webhookSecret: string;
  try {
    webhookSecret = getWebhookSecret();
  } catch {
    logger.error("[RSI] Missing WEBHOOK_SECRET");
    res.status(500).json({ error: "Server configuration error" });
    return;
  }

  const secretBuf = Buffer.from(secret);
  const expectedBuf = Buffer.from(webhookSecret);
  if (secretBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(secretBuf, expectedBuf)) {
    logger.warn("[RSI] Invalid secret");
    res.status(401).json({ error: "Invalid secret" });
    return;
  }

  // --- Validate payload ---
  const symbol = String(body.symbol || "").toUpperCase().trim();
  const rsitrend = String(body.rsitrend || "").toLowerCase().trim();
  const confidence = String(body.confidence || "").toLowerCase().trim();
  const price = parseFloat(body.price);

  if (!symbol) {
    res.status(400).json({ error: "Missing symbol" });
    return;
  }

  const validTrends = ["bullish", "bearish", "neutral"];
  if (!rsitrend || !validTrends.includes(rsitrend)) {
    res.status(400).json({ error: `Invalid rsitrend — must be one of: ${validTrends.join(", ")}` });
    return;
  }

  const validConfidences = ["early", "confirmed", "strong"];
  if (!confidence || !validConfidences.includes(confidence)) {
    res.status(400).json({ error: `Invalid confidence — must be one of: ${validConfidences.join(", ")}` });
    return;
  }

  try {
    // --- Find the most recent PENDING signal for this symbol ---
    const pendingSnap = await db
      .collection("signals")
      .where("symbol", "==", symbol)
      .where("status", "==", "PENDING")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (pendingSnap.empty) {
      logger.info("[RSI] No pending signal for symbol — rejecting", { symbol, rsitrend, confidence });
      res.status(404).json({ error: `No pending signal for ${symbol}`, rsitrend, confidence });
      return;
    }

    // --- Update the pending signal with RSI trend data ---
    const signalDoc = pendingSnap.docs[0];
    const update: Record<string, unknown> = {
      rsiTrend: rsitrend,
      rsiConfidence: confidence,
      rsiUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!isNaN(price) && price > 0) {
      update.rsiPrice = price;
    }

    await signalDoc.ref.update(update);

    logger.info("[RSI] Updated pending signal", { signalId: signalDoc.id, symbol, rsitrend, confidence, price });
    res.json({ status: "accepted", signalId: signalDoc.id, symbol, rsitrend, confidence });
  } catch (err) {
    logger.error("[RSI] Error processing RSI webhook", { symbol, rsitrend, confidence, err: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * POST /tradingview/vwap — Receive VWAP trend signals from TradingView.
 *
 * Only accepts if there is a PENDING signal for the symbol.
 *
 * Expected payload:
 *   { "symbol": "ETHUSD", "price": 2100.50, "vwaptrend": "bullish", "secret": "..." }
 */
export async function handleVwapWebhook(req: Request, res: Response): Promise<void> {
  logger.info("[VWAP] Webhook hit", { path: req.path, body: JSON.stringify(req.body || {}).slice(0, 300) });

  const body = req.body || {};

  // --- Validate secret ---
  const secret = String(body.secret || "");
  let webhookSecret: string;
  try {
    webhookSecret = getWebhookSecret();
  } catch {
    logger.error("[VWAP] Missing WEBHOOK_SECRET");
    res.status(500).json({ error: "Server configuration error" });
    return;
  }

  const secretBuf = Buffer.from(secret);
  const expectedBuf = Buffer.from(webhookSecret);
  if (secretBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(secretBuf, expectedBuf)) {
    logger.warn("[VWAP] Invalid secret");
    res.status(401).json({ error: "Invalid secret" });
    return;
  }

  // --- Validate payload ---
  const symbol = String(body.symbol || "").toUpperCase().trim();
  const vwaptrend = String(body.vwaptrend || "").toLowerCase().trim();
  const price = parseFloat(body.price);

  if (!symbol) {
    res.status(400).json({ error: "Missing symbol" });
    return;
  }

  const validTrends = ["bullish", "bearish", "neutral"];
  if (!vwaptrend || !validTrends.includes(vwaptrend)) {
    res.status(400).json({ error: `Invalid vwaptrend — must be one of: ${validTrends.join(", ")}` });
    return;
  }

  try {
    const pendingSnap = await db
      .collection("signals")
      .where("symbol", "==", symbol)
      .where("status", "==", "PENDING")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (pendingSnap.empty) {
      logger.info("[VWAP] No pending signal for symbol — rejecting", { symbol, vwaptrend });
      res.status(404).json({ error: `No pending signal for ${symbol}`, vwaptrend });
      return;
    }

    const signalDoc = pendingSnap.docs[0];
    const update: Record<string, unknown> = {
      vwapTrend: vwaptrend,
      vwapUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!isNaN(price) && price > 0) {
      update.vwapPrice = price;
    }

    await signalDoc.ref.update(update);

    logger.info("[VWAP] Updated pending signal", { signalId: signalDoc.id, symbol, vwaptrend, price });
    res.json({ status: "accepted", signalId: signalDoc.id, symbol, vwaptrend });
  } catch (err) {
    logger.error("[VWAP] Error processing VWAP webhook", { symbol, vwaptrend, err: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}