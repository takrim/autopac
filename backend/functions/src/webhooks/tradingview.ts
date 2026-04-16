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
import { liquidateSymbol } from "../api/alpaca";

const db = getFirestore();

/**
 * Persist a signal decision record to Firestore for full audit trail.
 */
async function logDecision(data: {
  handler: "strategy" | "bulltrend" | "beartrend";
  symbol: string;
  payload: Record<string, unknown>;
  decision: "bought" | "sold" | "rejected" | "skipped" | "error" | "stored";
  reasons: string[];
  rsi?: number | null;
  price?: number | null;
  signalId?: string | null;
  orderId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.collection("signal_decisions").add({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
    });

    // Trim to newest 100 records
    try {
      const countSnap = await db.collection("signal_decisions")
        .orderBy("createdAt", "desc")
        .offset(100)
        .limit(50)
        .get();
      if (!countSnap.empty) {
        const batch = db.batch();
        for (const doc of countSnap.docs) {
          batch.delete(doc.ref);
        }
        await batch.commit();
        logger.info("[DECISION] Trimmed old records", { deleted: countSnap.size });
      }
    } catch (trimErr) {
      // Non-fatal — don't block signal processing
      logger.warn("[DECISION] Trim failed (non-fatal)", { error: String(trimErr) });
    }
  } catch (err) {
    logger.error("[DECISION] Failed to write decision record", { error: String(err), symbol: data.symbol });
  }
}

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

  // Delete old signals and bulltrends for this symbol
  const oneHourAgo = Timestamp.fromDate(new Date(Date.now() - 60 * 60 * 1000));
  try {
    // Get ALL signals for this symbol, then filter in code
    // (avoids needing composite indexes for every status+createdAt combo)
    const allSignals = await db
      .collection("signals")
      .where("symbol", "==", payload.symbol)
      .get();

    const toDelete: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    for (const doc of allSignals.docs) {
      const data = doc.data();
      const status = data.status as string;
      const createdAt = data.createdAt as Timestamp | undefined;

      // Delete if: PENDING/REJECTED (any age) OR older than 1 hour (any status)
      if (status === "PENDING" || status === "REJECTED") {
        toDelete.push(doc);
      } else if (createdAt && createdAt.toMillis() < oneHourAgo.toMillis()) {
        toDelete.push(doc);
      }
    }

    // Also delete old bulltrends
    const allBulltrends = await db
      .collection("bulltrends")
      .where("symbol", "==", payload.symbol)
      .get();

    const oldBulltrends = allBulltrends.docs.filter((doc) => {
      const createdAt = doc.data().createdAt as Timestamp | undefined;
      return createdAt && createdAt.toMillis() < oneHourAgo.toMillis();
    });

    const totalDelete = toDelete.length + oldBulltrends.length;
    if (totalDelete > 0) {
      // Firestore batch limit is 500
      const allDocs = [...toDelete, ...oldBulltrends];
      for (let i = 0; i < allDocs.length; i += 500) {
        const batch = db.batch();
        for (const doc of allDocs.slice(i, i + 500)) {
          batch.delete(doc.ref);
        }
        await batch.commit();
      }
      logger.info("[WEBHOOK] Cleaned up stale data", { symbol: payload.symbol, signals: toDelete.length, bulltrends: oldBulltrends.length });
    }
  } catch (err) {
    logger.warn("[WEBHOOK] Failed to clean up stale data (non-fatal)", { err: String(err) });
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
      logger.warn("[WEBHOOK] Bulltrend correlation check failed (non-fatal)", { symbol: payload.symbol, error: String(err) });
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
    logger.error("[WEBHOOK] Indicator calculation failed (non-fatal)", { signalId: docRef.id, symbol: payload.symbol, error: String(err) });
  }

  // Send push notification only for Strong Buy signals
  const freshDoc = await docRef.get();
  const freshData = freshDoc.data();
  const isStrongBuy = freshData?.strongBuy === true;
  logger.info("[WEBHOOK] Notification decision", {
    signalId: docRef.id,
    symbol: payload.symbol,
    action: payload.action,
    strongBuy: isStrongBuy,
    willNotify: isStrongBuy,
  });
  if (isStrongBuy) {
    try {
      await sendSignalNotification({ ...signal, ...freshData, id: docRef.id } as Signal);
      logger.info("[WEBHOOK] Notification sent for Strong Buy", { signalId: docRef.id, symbol: payload.symbol });
    } catch (err) {
      logger.error("[WEBHOOK] Notification error (non-fatal)", { signalId: docRef.id, error: String(err) });
    }
  }

  logger.info("[WEBHOOK] Signal created", { signalId: docRef.id, symbol: payload.symbol });

  // Log decision
  await logDecision({
    handler: "strategy",
    symbol: payload.symbol,
    payload: { strategy: payload.strategy, action: payload.action, timeframe: payload.timeframe, price: payload.price, signalTime: payload.signalTime },
    decision: isStrongBuy ? "bought" : "stored",
    reasons: isStrongBuy ? ["Strong Buy — strategy + bulltrend correlated"] : ["Strategy signal stored — waiting for bulltrend correlation"],
    rsi: freshData?.rsi ?? null,
    price: payload.price,
    signalId: docRef.id,
    meta: { strongBuy: isStrongBuy, idempotencyKey },
  });

  // Auto-approve: skip manual approval and execute immediately
  if (tradingConfig.AUTO_APPROVE) {
    logger.info("[WEBHOOK] Auto-approve enabled — executing order", { signalId: docRef.id });

    try {
      const orderResult = await executeOrder(signal, "auto-approve");
      res.status(201).json({ status: "auto_executed", signalId: docRef.id, order: orderResult });
    } catch (err) {
      logger.error("[WEBHOOK] Auto-execute failed", { signalId: docRef.id, symbol: payload.symbol, error: String(err) });
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
  const rsiOverride = body.rsi !== undefined ? parseFloat(body.rsi) : NaN;

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

        // Send push notification now that it's a Strong Buy
        try {
          const updatedSnap = await signalDoc.ref.get();
          const updatedSignal = { id: signalDoc.id, ...updatedSnap.data() } as Signal;
          await sendSignalNotification(updatedSignal);
          logger.info("[BULLTREND] Notification sent for Strong Buy", { signalId: signalDoc.id, symbol });
        } catch (notifErr) {
          logger.error("[BULLTREND] Notification error (non-fatal)", { signalId: signalDoc.id, error: String(notifErr) });
        }
      }
    }

    // --- RSI Mode: Auto-buy on bull trend ---
    let rsiOrderResult: Record<string, unknown> | null = null;
    if (!bullishTrend) {
      await logDecision({
        handler: "bulltrend",
        symbol,
        payload: { bullish_trend: bullishTrend, price, volume, time },
        decision: "skipped",
        reasons: ["bullish_trend is false — no buy evaluation"],
        price: !isNaN(price) ? price : null,
        meta: { bulltrendId: bulltrendDoc.id },
      });
    } else {
      try {
        const tradingConfig = await getTradingConfig();
        const mode = tradingConfig.ORDER_MODE || "STRATEGY";
        if (mode === "RSI" || mode === "BOTH") {
          logger.info("[BULLTREND] RSI mode active — evaluating buy decision", { symbol, mode });

          const entryPrice = !isNaN(price) ? price : 0;

          // Use RSI override if provided, otherwise calculate from Alpaca bars
          let buyRsi: number | undefined;
          if (!isNaN(rsiOverride)) {
            buyRsi = parseFloat(rsiOverride.toFixed(2));
            logger.info("[BULLTREND] RSI override provided", { symbol, rsi: buyRsi });
          } else {
            try {
              const indicators = await calculateIndicators(symbol, entryPrice);
              if (indicators.rsi !== null) {
                buyRsi = parseFloat(indicators.rsi.toFixed(2));
              }
              logger.info("[BULLTREND] RSI calculated", { symbol, rsi: buyRsi ?? "unavailable" });
            } catch (indErr) {
              logger.warn("[BULLTREND] RSI calculation failed (non-fatal)", { symbol, error: String(indErr) });
            }
          }

          // RSI Buy validation: only buy if RSI is in oversold zone (25-35, i.e. ±5 of 30)
          const rsiInBuyZone = buyRsi !== undefined && buyRsi >= 25 && buyRsi <= 35;
          const rsiTooHigh = buyRsi !== undefined && buyRsi > 35;
          const rsiUnavailable = buyRsi === undefined;
          const shouldBuy = rsiInBuyZone;

          const buyReasons: string[] = [];
          if (rsiInBuyZone) buyReasons.push(`RSI in buy zone (${buyRsi} is within 25-35)`);
          if (rsiTooHigh) buyReasons.push(`RSI too high (${buyRsi} > 35) — not a good entry`);
          if (rsiUnavailable) buyReasons.push("RSI unavailable — skipping buy (fail-closed)");
          if (buyRsi !== undefined && buyRsi < 25) buyReasons.push(`RSI extremely oversold (${buyRsi} < 25) — caution, may be falling knife`);

          logger.info("[BULLTREND] Buy decision", { symbol, rsi: buyRsi ?? null, rsiInBuyZone, rsiTooHigh, shouldBuy, reasons: buyReasons });

          if (!shouldBuy) {
            logger.info("[BULLTREND] Skipping auto-buy — RSI does not confirm buy", { symbol, rsi: buyRsi });
            // Log rejection decision
            await logDecision({
              handler: "bulltrend",
              symbol,
              payload: { bullish_trend: bullishTrend, price, volume, time, rsiOverride: !isNaN(rsiOverride) ? rsiOverride : null },
              decision: "rejected",
              reasons: buyReasons,
              rsi: buyRsi ?? null,
              price: !isNaN(price) ? price : null,
              meta: { rsiInBuyZone, rsiTooHigh, rsiUnavailable, bulltrendId: bulltrendDoc.id, matchedSignalId },
            });
            // Still store the bulltrend but skip order creation
          } else {

          const rsiSignal: Signal = {
            strategy: "rsi-bulltrend",
            symbol,
            action: "BUY",
            timeframe: "3m",
            price: entryPrice,
            signalTime: time || new Date().toISOString(),
            status: "PENDING",
            strongBuy: rsiInBuyZone,
            bullishTrend: true,
            bulltrendPrice: entryPrice,
            ...(buyRsi !== undefined && { rsi: buyRsi }),
            idempotencyKey: crypto.createHash("sha256").update(`rsi-bull:${symbol}:${Date.now()}`).digest("hex").slice(0, 32),
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          };

          const rsiDocRef = await db.collection("signals").add(rsiSignal);
          rsiSignal.id = rsiDocRef.id;
          logger.info("[BULLTREND] RSI auto-buy signal created", { signalId: rsiDocRef.id, symbol, price: entryPrice, rsi: buyRsi ?? "unavailable" });

          // Send notification
          try {
            await sendSignalNotification({ ...rsiSignal, id: rsiDocRef.id } as Signal);
            logger.info("[BULLTREND] RSI auto-buy notification sent", { signalId: rsiDocRef.id, symbol });
          } catch (notifErr) {
            logger.error("[BULLTREND] RSI notification error (non-fatal)", { signalId: rsiDocRef.id, error: String(notifErr) });
          }

          // Log buy decision
          await logDecision({
            handler: "bulltrend",
            symbol,
            payload: { bullish_trend: bullishTrend, price, volume, time, rsiOverride: !isNaN(rsiOverride) ? rsiOverride : null },
            decision: "bought",
            reasons: buyReasons,
            rsi: buyRsi ?? null,
            price: entryPrice,
            signalId: rsiDocRef.id,
            meta: { rsiInBuyZone, rsiTooHigh, bulltrendId: bulltrendDoc.id, matchedSignalId },
          });

          // Auto-execute if enabled
          if (tradingConfig.AUTO_APPROVE) {
            try {
              rsiOrderResult = await executeOrder(rsiSignal, "rsi-auto");
              logger.info("[BULLTREND] RSI auto-buy order executed", { signalId: rsiDocRef.id, symbol, order: rsiOrderResult });
            } catch (execErr) {
              logger.error("[BULLTREND] RSI auto-buy execution failed", { signalId: rsiDocRef.id, symbol, error: String(execErr) });
            }
          }
          } // end shouldBuy else
        } else {
          await logDecision({
            handler: "bulltrend",
            symbol,
            payload: { bullish_trend: bullishTrend, price, volume, time },
            decision: "skipped",
            reasons: [`ORDER_MODE is ${mode} — RSI auto-buy not active`],
            price: !isNaN(price) ? price : null,
            meta: { mode, bulltrendId: bulltrendDoc.id, matchedSignalId },
          });
        }
      } catch (rsiErr) {
        logger.error("[BULLTREND] RSI auto-buy failed (non-fatal)", { symbol, error: String(rsiErr) });
      }
    } // end bullishTrend else

    res.json({
      status: "stored",
      id: bulltrendDoc.id,
      symbol,
      bullish_trend: bullishTrend,
      matchedSignalId,
      rsiOrder: rsiOrderResult,
    });
  } catch (err) {
    logger.error("[BULLTREND] Error processing webhook", { symbol, bullishTrend, error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * POST /tradingview/beartrend — Receive bear trend signal from TradingView.
 *
 * Stored in the `beartrends` collection.
 * When ORDER_MODE is RSI or BOTH, auto-liquidates the position for this symbol.
 *
 * Expected payload:
 *   { "bear_trend": "true", "symbol": "ETHUSD", "price": "2100.50", "time": "2026-04-06T12:00:00Z", "secret": "..." }
 */
export async function handleBeartrendWebhook(req: Request, res: Response): Promise<void> {
  logger.info("[BEARTREND] Webhook hit", { path: req.path, body: JSON.stringify(req.body || {}).slice(0, 300) });

  const body = req.body || {};

  // --- Validate secret ---
  const secret = String(body.secret || "");
  let webhookSecret: string;
  try {
    webhookSecret = getWebhookSecret();
  } catch {
    logger.error("[BEARTREND] Missing WEBHOOK_SECRET");
    res.status(500).json({ error: "Server configuration error" });
    return;
  }

  const secretBuf = Buffer.from(secret);
  const expectedBuf = Buffer.from(webhookSecret);
  if (secretBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(secretBuf, expectedBuf)) {
    logger.warn("[BEARTREND] Invalid secret");
    res.status(401).json({ error: "Invalid secret" });
    return;
  }

  // --- Validate payload ---
  const symbol = String(body.symbol || "").toUpperCase().trim();
  const bearTrend = String(body.bear_trend || "").toLowerCase().trim() === "true";
  const price = parseFloat(body.price);
  const time = String(body.time || "");
  const rsiOverride = body.rsi !== undefined ? parseFloat(body.rsi) : NaN;

  if (!symbol) {
    res.status(400).json({ error: "Missing symbol" });
    return;
  }

  try {
    // Store in beartrends collection
    const beartrendDoc = await db.collection("beartrends").add({
      symbol,
      bearTrend,
      price: !isNaN(price) ? price : null,
      time: time || null,
      createdAt: FieldValue.serverTimestamp(),
    });

    logger.info("[BEARTREND] Stored", { id: beartrendDoc.id, symbol, bearTrend });

    // --- RSI Mode: Auto-liquidate on bear trend (with RSI validation) ---
    let liquidationResult: Record<string, unknown> | null = null;
    let sellDecision: Record<string, unknown> | null = null;
    if (bearTrend) {
      const tradingConfig = await getTradingConfig();
      const mode = tradingConfig.ORDER_MODE || "STRATEGY";
      if (mode === "RSI" || mode === "BOTH") {
        logger.info("[BEARTREND] RSI mode active — evaluating sell decision", { symbol, mode });

        // Use RSI override if provided, otherwise calculate from Alpaca bars
        let currentRsi: number | null = null;
        if (!isNaN(rsiOverride)) {
          currentRsi = parseFloat(rsiOverride.toFixed(2));
          logger.info("[BEARTREND] RSI override provided", { symbol, rsi: currentRsi });
        } else {
          try {
            const currentPrice = !isNaN(price) ? price : 0;
            const indicators = await calculateIndicators(symbol, currentPrice);
            currentRsi = indicators.rsi !== null ? parseFloat(indicators.rsi.toFixed(2)) : null;
          } catch (indErr) {
            logger.warn("[BEARTREND] RSI calculation failed (non-fatal)", { symbol, error: String(indErr) });
          }
        }

        // Find the most recent BUY signal for this symbol to get buy-time RSI
        let buyRsi: number | null = null;
        try {
          const buySnap = await db
            .collection("signals")
            .where("symbol", "==", symbol)
            .where("action", "==", "BUY")
            .orderBy("createdAt", "desc")
            .limit(1)
            .get();
          if (!buySnap.empty) {
            buyRsi = buySnap.docs[0].data().rsi ?? null;
          }
        } catch (queryErr) {
          logger.warn("[BEARTREND] Buy signal lookup failed (non-fatal)", { symbol, error: String(queryErr) });
        }

        // Sell decision logic:
        // (a) Current RSI < RSI at buy time (momentum faded)
        // (b) Current RSI is in overbought zone: 65-75 (±5 of 70)
        // (c) If RSI unavailable, proceed with sell (fail-open for safety)
        const rsiDroppedBelowBuy = currentRsi !== null && buyRsi !== null && currentRsi < buyRsi;
        const rsiInOverboughtZone = currentRsi !== null && currentRsi >= 65 && currentRsi <= 75;
        const rsiUnavailable = currentRsi === null;
        const shouldSell = rsiDroppedBelowBuy || rsiInOverboughtZone || rsiUnavailable;

        const reasons: string[] = [];
        if (rsiDroppedBelowBuy) reasons.push(`RSI dropped below buy (current=${currentRsi} < buy=${buyRsi})`);
        if (rsiInOverboughtZone) reasons.push(`RSI in overbought zone (${currentRsi} is within 65-75)`);
        if (rsiUnavailable) reasons.push("RSI unavailable — fail-open sell");
        if (!shouldSell) reasons.push(`RSI does not justify sell (current=${currentRsi}, buy=${buyRsi}, not in 65-75 zone)`);

        sellDecision = {
          currentRsi,
          buyRsi,
          rsiDroppedBelowBuy,
          rsiInOverboughtZone,
          rsiUnavailable,
          shouldSell,
          reasons,
        };

        logger.info("[BEARTREND] Sell decision", { symbol, ...sellDecision });

        if (!shouldSell) {
          logger.info("[BEARTREND] Skipping liquidation — RSI does not confirm sell", { symbol, currentRsi, buyRsi });            await logDecision({
              handler: "beartrend",
              symbol,
              payload: { bear_trend: bearTrend, price, time, rsiOverride: !isNaN(rsiOverride) ? rsiOverride : null },
              decision: "rejected",
              reasons,
              rsi: currentRsi,
              price: !isNaN(price) ? price : null,
              meta: { currentRsi, buyRsi, rsiDroppedBelowBuy, rsiInOverboughtZone, rsiUnavailable, beartrendId: beartrendDoc.id },
            });        } else {
          try {
            liquidationResult = await liquidateSymbol(symbol);
            logger.info("[BEARTREND] Auto-liquidation executed", { symbol, reasons, order: liquidationResult });
            await logDecision({
              handler: "beartrend",
              symbol,
              payload: { bear_trend: bearTrend, price, time, rsiOverride: !isNaN(rsiOverride) ? rsiOverride : null },
              decision: "sold",
              reasons,
              rsi: currentRsi,
              price: !isNaN(price) ? price : null,
              meta: { currentRsi, buyRsi, rsiDroppedBelowBuy, rsiInOverboughtZone, rsiUnavailable, beartrendId: beartrendDoc.id, liquidationResult },
            });

            // Send notification about liquidation
            try {
              const liquidSignal = {
                id: beartrendDoc.id,
                action: "SELL",
                symbol,
                price: !isNaN(price) ? price : 0,
                strongBuy: false,
              } as Signal;
              await sendSignalNotification(liquidSignal);
              logger.info("[BEARTREND] Liquidation notification sent", { symbol });
            } catch (notifErr) {
              logger.error("[BEARTREND] Notification error (non-fatal)", { symbol, error: String(notifErr) });
            }
          } catch (liqErr) {
            const errMsg = String(liqErr);
            // "No position found" is expected if we don't hold this symbol
            if (errMsg.includes("No position found")) {
              logger.info("[BEARTREND] No position to liquidate", { symbol });
              await logDecision({
                handler: "beartrend",
                symbol,
                payload: { bear_trend: bearTrend, price, time },
                decision: "skipped",
                reasons: [...reasons, "No position to liquidate"],
                rsi: currentRsi,
                price: !isNaN(price) ? price : null,
                meta: { currentRsi, buyRsi, beartrendId: beartrendDoc.id },
              });
            } else {
              logger.error("[BEARTREND] Auto-liquidation failed", { symbol, error: errMsg });
            }
          }
        }
      } else {
        logger.info("[BEARTREND] STRATEGY mode — skipping auto-liquidation", { symbol, mode });
      }
    }

    res.json({
      status: "stored",
      id: beartrendDoc.id,
      symbol,
      bear_trend: bearTrend,
      sellDecision,
      liquidation: liquidationResult,
    });
  } catch (err) {
    logger.error("[BEARTREND] Error processing webhook", { symbol, bearTrend, error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}