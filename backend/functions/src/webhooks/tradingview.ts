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

  // Check for recent bulltrend signal within 9 minutes → Strong Buy
  if (payload.action === "BUY") {
    try {
      const cutoff = new Date(Date.now() - 9 * 60 * 1000);
      const bulltrendSnap = await db
        .collection("bulltrends")
        .where("symbol", "==", payload.symbol)
        .where("bullishTrend", "==", true)
        .where("createdAt", ">=", cutoff)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (!bulltrendSnap.empty) {
        const bt = bulltrendSnap.docs[0].data();
        await docRef.update({
          strongBuy: true,
          bullishTrend: true,
          bulltrendPrice: bt.price || null,
          bulltrendVolume: bt.volume || null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        logger.info("[WEBHOOK] Recent bulltrend found → Strong Buy", { signalId: docRef.id, symbol: payload.symbol });
      }
    } catch (err) {
      logger.warn("[WEBHOOK] Bulltrend correlation check failed (non-fatal)", { err: String(err) });
    }
  }

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
 * POST /tradingview/bulltrend — Receive bull trend confirmation from TradingView.
 *
 * Always stored in the `bulltrends` collection.
 * If a PENDING buy signal exists for this symbol within 6–9 minutes, marks it as Strong Buy.
 *
 * Expected payload:
 *   { "bullish_trend": "true", "symbol": "ETHUSD", "price": "2100.50", "volume": "1234567", "time": "2026-04-06T12:00:00Z", "secret": "..." }
 */
export async function handleBulltrendWebhook(req: Request, res: Response): Promise<void> {
  logger.info("[BULLTREND] Webhook hit", { path: req.path, body: JSON.stringify(req.body || {}).slice(0, 300) });

  const body = req.body || {};

  // --- Validate secret ---
  const secret = String(body.secret || "");
  let webhookSecret: string;
  try {
    webhookSecret = getWebhookSecret();
  } catch {
    logger.error("[BULLTREND] Missing WEBHOOK_SECRET");
    res.status(500).json({ error: "Server configuration error" });
    return;
  }

  const secretBuf = Buffer.from(secret);
  const expectedBuf = Buffer.from(webhookSecret);
  if (secretBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(secretBuf, expectedBuf)) {
    logger.warn("[BULLTREND] Invalid secret");
    res.status(401).json({ error: "Invalid secret" });
    return;
  }

  // --- Validate payload ---
  const symbol = String(body.symbol || "").toUpperCase().trim();
  const bullishTrend = String(body.bullish_trend || "").toLowerCase().trim() === "true";
  const price = parseFloat(body.price);
  const volume = parseFloat(body.volume);
  const time = String(body.time || "");

  if (!symbol) {
    res.status(400).json({ error: "Missing symbol" });
    return;
  }

  try {
    // Always store in bulltrends collection
    const bulltrendDoc = await db.collection("bulltrends").add({
      symbol,
      bullishTrend,
      price: !isNaN(price) ? price : null,
      volume: !isNaN(volume) ? volume : null,
      time: time || null,
      createdAt: FieldValue.serverTimestamp(),
    });

    logger.info("[BULLTREND] Stored", { id: bulltrendDoc.id, symbol, bullishTrend });

    // Check if a PENDING buy signal exists for this symbol within the 6–9 min window
    let matchedSignalId: string | null = null;
    if (bullishTrend) {
      const windowStart = new Date(Date.now() - 9 * 60 * 1000); // 9 min ago
      const windowEnd = new Date(Date.now() - 6 * 60 * 1000);   // 6 min ago — but also allow recent ones
      // Look for any PENDING signal created in the last 9 minutes
      const cutoff = new Date(Date.now() - 9 * 60 * 1000);

      const pendingSnap = await db
        .collection("signals")
        .where("symbol", "==", symbol)
        .where("status", "==", "PENDING")
        .where("createdAt", ">=", cutoff)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (!pendingSnap.empty) {
        const signalDoc = pendingSnap.docs[0];
        const signalCreated = signalDoc.data().createdAt?.toDate?.() as Date | undefined;
        const ageMinutes = signalCreated ? (Date.now() - signalCreated.getTime()) / 60000 : 0;

        await signalDoc.ref.update({
          strongBuy: true,
          bullishTrend: true,
          bulltrendPrice: !isNaN(price) ? price : null,
          bulltrendVolume: !isNaN(volume) ? volume : null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        matchedSignalId = signalDoc.id;
        logger.info("[BULLTREND] Matched PENDING signal → Strong Buy", { signalId: signalDoc.id, symbol, ageMinutes: ageMinutes.toFixed(1) });
      }
    }

    res.json({
      status: "stored",
      id: bulltrendDoc.id,
      symbol,
      bullish_trend: bullishTrend,
      matchedSignalId,
    });
  } catch (err) {
    logger.error("[BULLTREND] Error processing webhook", { symbol, bullishTrend, err: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}