import { Request, Response } from "express";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import crypto from "crypto";
import { WebhookPayload, Signal } from "../types";
import { getWebhookSecret, CONFIG } from "../config";
import { getTradingConfig, TradingConfig, getActiveBrokerSettings, getBrokerForSymbol } from "../api/config";
import { sendSignalNotification, sendBulltrendBuyNotification } from "../services/notification";
import { sendTelegramMessage } from "../services/telegram";
import { logAudit } from "../services/audit";
import { executeOrder } from "../api/trade";
import { calculateIndicators } from "../services/indicators";
import { getBroker } from "../brokers";
import { fetchOrderBook, scoreBook, normalizeBookSymbol } from "../services/orderbook";
import { getActiveStrategy } from "../services/strategyConfig";
import { resolveExchangeForSymbol } from "../services/rsiDip";
import { runBulltrendDivergence, runBeartrendLiquidate } from "../services/strategies/divergence";

const db = getFirestore();

// ---------------------------------------------------------------------------
// CoinGecko category lookup — used by bulltrend webhook to skip defi/meme
// ---------------------------------------------------------------------------
const CG_BASE = "https://pro-api.coingecko.com/api/v3";
export const FORBIDDEN_CATEGORY_REGEX = /\b(defi|meme)\b/i;

// Bulltrend-specific initial stop-loss (overrides global STOP_LOSS_PCT for this entry path).
export const BULLTREND_STOP_LOSS_PCT = 2.0;

/**
 * Resolve a trading symbol (e.g. "ETHUSD", "BTCUSDT") to a CoinGecko coin id,
 * then fetch its categories.
 *
 * Returns `{ id, categories }`. `categories` is `null` when the API failed
 * or no match was found — callers should treat that as fail-closed.
 */
export async function cgFetchCategories(symbol: string): Promise<{ id: string | null; categories: string[] | null }> {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    logger.error("[BULLTREND] Missing COINGECKO_API_KEY secret");
    return { id: null, categories: null };
  }

  // Strip common quote-currency suffixes (USDT/USDC/USD) for symbol lookup
  const baseSymbol = symbol.replace(/(USDT|USDC|USD)$/i, "").toLowerCase();
  if (!baseSymbol) return { id: null, categories: null };

  try {
    // 1) Resolve symbol → coin id via /search
    const searchResp = await fetch(
      `${CG_BASE}/search?query=${encodeURIComponent(baseSymbol)}`,
      { headers: { "x-cg-pro-api-key": apiKey }, signal: AbortSignal.timeout(8000) }
    );
    if (!searchResp.ok) {
      logger.warn("[BULLTREND] CoinGecko /search failed", { symbol, status: searchResp.status });
      return { id: null, categories: null };
    }
    const searchData = await searchResp.json() as { coins?: Array<{ id: string; symbol: string; market_cap_rank?: number }> };
    const coins = searchData?.coins ?? [];
    if (!coins.length) return { id: null, categories: null };

    // Prefer exact symbol match (case-insensitive); among ties, lowest market_cap_rank wins
    const exactMatches = coins.filter(c => c.symbol.toLowerCase() === baseSymbol);
    const ranked = (exactMatches.length ? exactMatches : coins)
      .slice()
      .sort((a, b) => (a.market_cap_rank ?? 9e9) - (b.market_cap_rank ?? 9e9));
    const cgId = ranked[0]?.id ?? null;
    if (!cgId) return { id: null, categories: null };

    // 2) Fetch full coin detail for categories
    const detailResp = await fetch(
      `${CG_BASE}/coins/${encodeURIComponent(cgId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`,
      { headers: { "x-cg-pro-api-key": apiKey }, signal: AbortSignal.timeout(8000) }
    );
    if (!detailResp.ok) {
      logger.warn("[BULLTREND] CoinGecko /coins failed", { symbol, cgId, status: detailResp.status });
      return { id: cgId, categories: null };
    }
    const detail = await detailResp.json() as { categories?: Array<string | null> };
    const categories = (detail.categories ?? []).filter((c): c is string => typeof c === "string" && c.length > 0);
    return { id: cgId, categories };
  } catch (err) {
    logger.warn("[BULLTREND] CoinGecko fetch error", { symbol, error: String(err) });
    return { id: null, categories: null };
  }
}

/**
 * Fetch the last 5 filled stop-loss orders across all symbols.
 * Returned as plain data to be merged into the rejected signal's meta.
 */
async function getRecentStopFills(symbol: string): Promise<Array<Record<string, unknown>>> {
  try {
    const tradingConfig = await getTradingConfig();
    const broker = getBroker(tradingConfig.ACTIVE_BROKER);

    if (broker.name === "alpaca") {
      const { getAlpacaConfig } = await import("../config");
      const config = getAlpacaConfig();
      const headers = {
        "APCA-API-KEY-ID": config.apiKey,
        "APCA-API-SECRET-KEY": config.apiSecret,
        "Content-Type": "application/json",
      };
      const resp = await fetch(
        `${config.baseUrl}/v2/orders?status=closed&limit=50&direction=desc`,
        { headers }
      );
      if (resp.ok) {
        const orders = (await resp.json()) as Array<Record<string, unknown>>;
        return orders
          .filter((o) => o.side === "sell" && (o.type === "stop" || o.type === "stop_limit") && o.status === "filled")
          .slice(0, 5)
          .map((o) => ({
            orderId: o.id,
            symbol: o.symbol,
            stop_price: o.stop_price,
            limit_price: o.limit_price,
            filled_at: o.filled_at,
            filled_qty: o.filled_qty,
            filled_avg_price: o.filled_avg_price,
          }));
      }
    } else if (broker.name === "coinbase") {
      const cb = broker as import("../brokers/coinbase").CoinbaseBroker;
      const { ok, data } = await (cb as any).request("GET", "/orders/historical/batch?order_status=FILLED&limit=50");
      if (ok) {
        const orders = (data.orders as Array<Record<string, unknown>> | undefined) || [];
        return orders
          .filter((o) => {
            if (o.side !== "SELL") return false;
            const cfg = o.order_configuration as Record<string, unknown> | undefined;
            return !!(cfg?.stop_limit_stop_limit_gtc || cfg?.stop_limit_stop_limit_gtd);
          })
          .slice(0, 5)
          .map((o) => {
            const cfg = o.order_configuration as Record<string, unknown> | undefined;
            const sl = (cfg?.stop_limit_stop_limit_gtc || cfg?.stop_limit_stop_limit_gtd) as Record<string, string> | undefined;
            return {
              orderId: o.order_id,
              symbol: o.product_id,
              stop_price: sl?.stop_price,
              limit_price: sl?.limit_price,
              filled_at: o.last_fill_time,
              filled_qty: o.filled_size,
              filled_avg_price: o.average_filled_price,
            };
          });
      }
    }
  } catch (err) {
    logger.warn("[DEBUG] getRecentStopFills failed (non-fatal)", { symbol, error: String(err) });
  }
  return [];
}
/**
 * Persist a signal decision record to Firestore for full audit trail.
 */
export async function logDecision(data: {
  handler: "strategy" | "bulltrend" | "beartrend";
  symbol: string;
  payload: Record<string, unknown>;
  decision: "bought" | "sold" | "rejected" | "skipped" | "error" | "stored";
  reasons: string[];
  broker?: string;
  rsi?: number | null;
  price?: number | null;
  signalId?: string | null;
  orderId?: string | null;
  // ── Book analysis ───────────────────────────────────────────────────
  bookScore?: number | null;
  bookSignal?: string | null;
  bookReasons?: string[] | null;
  // ── Volume spike ────────────────────────────────────────────────────
  volumeSpike?: boolean | null;
  volumeRatio?: number | null;
  // ── Extra context ────────────────────────────────────────────────────
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

  // Resolve which broker handles this symbol — independent of ACTIVE_BROKER
  const signalBroker = getBrokerForSymbol(tradingConfig, payload.symbol);
  if (!signalBroker) {
    logger.info("[WEBHOOK] Symbol not in any broker allowlist", { symbol: payload.symbol });
    res.status(200).json({ status: "skipped_not_in_allowlist", symbol: payload.symbol });
    return;
  }

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

  // Pyramid check: query resolved broker for an open position on this symbol
  if (!tradingConfig.ORDER_PYRAMID && payload.action === "BUY") {
    try {
      const broker = getBroker(signalBroker);
      const position = await broker.getPosition(payload.symbol);

      if (position && position.qty > 0) {
        logger.info("[WEBHOOK] Pyramid disabled — skipping BUY, position exists", { broker: broker.name, symbol: payload.symbol, qty: position.qty });
        res.status(200).json({ status: "skipped_pyramid_off", symbol: payload.symbol });
        return;
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
    broker: signalBroker,
    idempotencyKey,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const docRef = await db.collection("signals").add(signal);
  signal.id = docRef.id;

  await logAudit("SIGNAL_VALIDATED", { signalId: docRef.id });

  // Calculate RSI(14) and VWAP for the signal — non-blocking, don't fail the webhook
  try {
    const indicators = await calculateIndicators(payload.symbol, payload.price, signalBroker);
    const indicatorUpdate: Record<string, unknown> = {};
    if (indicators.rsi !== null) {
      indicatorUpdate.rsi = parseFloat(indicators.rsi.toFixed(4));
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
    // DISABLED — push notifications now come from the Coinbase auto-trading flow
    // try {
    //   await sendSignalNotification({ ...signal, ...freshData, id: docRef.id } as Signal);
    //   logger.info("[WEBHOOK] Notification sent for Strong Buy", { signalId: docRef.id, symbol: payload.symbol });
    // } catch (err) {
    //   logger.error("[WEBHOOK] Notification error (non-fatal)", { signalId: docRef.id, error: String(err) });
    // }
    logger.info("[WEBHOOK] Strong Buy push suppressed (legacy flow disabled)", { signalId: docRef.id, symbol: payload.symbol });
  }

  logger.info("[WEBHOOK] Signal created", { signalId: docRef.id, symbol: payload.symbol });

  // Log decision
  await logDecision({
    handler: "strategy",
    symbol: payload.symbol,
    payload: { strategy: payload.strategy, action: payload.action, timeframe: payload.timeframe, price: payload.price, signalTime: payload.signalTime },
    decision: isStrongBuy ? "bought" : "stored",
    reasons: isStrongBuy ? ["Strong Buy"] : ["Strategy signal stored"],
    broker: signalBroker,
    rsi: freshData?.rsi ?? null,
    price: payload.price,
    signalId: docRef.id,
    volumeSpike: null,
    volumeRatio: null,
    bookScore: null,
    bookSignal: null,
    bookReasons: null,
    meta: { strongBuy: isStrongBuy, idempotencyKey },
  });

  // Strong Buys are executed by the burst scanner (VIP pathway), NOT here.
  // Leave the signal as PENDING; burst scanner picks it up next cycle (≤5 min),
  // applies forbidden-category / held / cooldown / position-cap guards, then buys.
  if (isStrongBuy) {
    logger.info("[WEBHOOK] Strong Buy queued for burst scanner pickup", { signalId: docRef.id, symbol: payload.symbol });
    res.status(201).json({ status: "queued_for_burst_scanner", signalId: docRef.id });
    return;
  }

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
 * Simplified flow:
 *   1. Validate secret + payload, resolve broker, store in `bulltrends` collection.
 *   2. If bullish_trend is false → store-only, no buy.
 *   3. Pyramid guard — skip if already holding when ORDER_PYRAMID is off.
 *   4. CoinGecko category lookup — skip buy if categories include defi or meme.
 *   5. Otherwise: create a PENDING BUY signal and (if AUTO_APPROVE) execute it.
 *
 * Expected payload:
 *   { "bullish_trend": "true", "symbol": "ETHUSD", "price": "2100.50", "volume": "1234567", "time": "2026-04-06T12:00:00Z", "secret": "..." }
 */
export async function handleBulltrendWebhook(req: Request, res: Response): Promise<void> {
  logger.info("[BULLTREND] Webhook hit", { path: req.path, body: JSON.stringify(req.body || {}).slice(0, 300) });

  // Strategy dispatch — divergence path is fully self-contained.
  if ((await getActiveStrategy()) === "divergence") {
    return runBulltrendDivergence(req, res);
  }

  const body = req.body || {};

  // --- Validate secret ---
  const secret = String(body.secret || "");
  let webhookSecret: string;
  try {
    webhookSecret = getWebhookSecret();
  } catch {
    logger.error("[BULLTREND] Missing WEBHOOK_SECRET");
    await sendTelegramMessage(`❌ *Bulltrend skip*\nServer misconfig — WEBHOOK_SECRET missing`).catch(() => {});
    res.status(500).json({ error: "Server configuration error" });
    return;
  }

  const secretBuf = Buffer.from(secret);
  const expectedBuf = Buffer.from(webhookSecret);
  if (secretBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(secretBuf, expectedBuf)) {
    logger.warn("[BULLTREND] Invalid secret");
    await sendTelegramMessage(`🚫 *Bulltrend skip*\nInvalid webhook secret`).catch(() => {});
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
    await sendTelegramMessage(`🚫 *Bulltrend skip*\nMissing symbol in payload`).catch(() => {});
    res.status(400).json({ error: "Missing symbol" });
    return;
  }

  // --- Resolve broker for this symbol (independent of ACTIVE_BROKER) ---
  let tradingConfig: TradingConfig;
  let bulltrendBroker: "alpaca" | "coinbase";
  try {
    tradingConfig = await getTradingConfig();
    // Route by asset availability: trade on Alpaca if the ticker exists there,
    // otherwise fall back to Coinbase. Skip only if neither carries it.
    const resolved = await resolveExchangeForSymbol(symbol);
    if (!resolved) {
      logger.info("[BULLTREND] Symbol not tradeable on Alpaca or Coinbase", { symbol });
      await sendTelegramMessage(`🚫 *Bulltrend skip* ${symbol}\nNot tradeable on Alpaca or Coinbase`).catch(() => {});
      await logDecision({
        handler: "bulltrend",
        symbol,
        payload: { bullish_trend: bullishTrend, price, volume, time },
        decision: "skipped",
        reasons: ["Symbol not tradeable on Alpaca or Coinbase"],
        broker: tradingConfig.ACTIVE_BROKER,
        price: !isNaN(price) ? price : null,
        bookScore: null, bookSignal: null, bookReasons: null,
        volumeSpike: null, volumeRatio: null,
      });
      res.status(200).json({ status: "skipped_no_exchange", symbol });
      return;
    }
    bulltrendBroker = resolved;
  } catch (err) {
    logger.error("[BULLTREND] Config load failed", { error: String(err) });
    await sendTelegramMessage(`❌ *Bulltrend skip* ${symbol}\nConfig load failed: ${String(err).slice(0, 200)}`).catch(() => {});
    res.status(500).json({ error: "Config load failed" });
    return;
  }

  try {
    // --- Always store in bulltrends collection (history/audit) ---
    const bulltrendDoc = await db.collection("bulltrends").add({
      symbol,
      bullishTrend,
      price: !isNaN(price) ? price : null,
      volume: !isNaN(volume) ? volume : null,
      time: time || null,
      createdAt: FieldValue.serverTimestamp(),
    });
    logger.info("[BULLTREND] Stored", { id: bulltrendDoc.id, symbol, bullishTrend });

    // --- Skip buy evaluation when bullish_trend is false ---
    if (!bullishTrend) {
      await sendTelegramMessage(`ℹ️ *Bulltrend stored* ${symbol}\nbullish_trend=false — no buy evaluation`).catch(() => {});
      await logDecision({
        handler: "bulltrend",
        symbol,
        payload: { bullish_trend: bullishTrend, price, volume, time },
        decision: "skipped",
        reasons: ["bullish_trend is false — no buy evaluation"],
        broker: bulltrendBroker,
        price: !isNaN(price) ? price : null,
        bookScore: null, bookSignal: null, bookReasons: null,
        volumeSpike: null, volumeRatio: null,
        meta: { bulltrendId: bulltrendDoc.id },
      });
      res.json({ status: "stored", id: bulltrendDoc.id, symbol, bullish_trend: bullishTrend });
      return;
    }

    // Broker is resolved by asset availability (Alpaca first, else Coinbase).
    // RSI-dip pre-gate removed: a bullish_trend alert buys directly. Coinbase
    // buys are enabled alongside Alpaca.

    // --- Pyramid guard: block duplicate buy if position already exists ---
    if (!tradingConfig.ORDER_PYRAMID) {
      try {
        const broker = getBroker(bulltrendBroker);
        const existingPos = await broker.getPosition(symbol);
        if (existingPos && existingPos.qty > 0) {
          logger.info("[BULLTREND] Pyramid disabled — skipping BUY, position exists", {
            broker: broker.name, symbol, qty: existingPos.qty,
          });
          await sendTelegramMessage(`🚫 *Bulltrend skip* ${symbol}\nPyramid disabled — already holding ${existingPos.qty}`).catch(() => {});
          await logDecision({
            handler: "bulltrend",
            symbol,
            payload: { bullish_trend: bullishTrend, price, volume, time },
            decision: "skipped",
            reasons: [`Pyramid disabled — already holding ${existingPos.qty} ${symbol}`],
            broker: bulltrendBroker,
            price: !isNaN(price) ? price : null,
            bookScore: null, bookSignal: null, bookReasons: null,
            volumeSpike: null, volumeRatio: null,
            meta: { existingQty: existingPos.qty, bulltrendId: bulltrendDoc.id },
          });
          res.json({
            status: "stored",
            id: bulltrendDoc.id,
            symbol,
            bullish_trend: bullishTrend,
            pyramidBlocked: true,
          });
          return;
        }
      } catch (pyramidErr) {
        logger.warn("[BULLTREND] Pyramid check failed, allowing order", { err: String(pyramidErr) });
        await sendTelegramMessage(`⚠️ *Bulltrend* ${symbol}\nPyramid check failed (allowing order): ${String(pyramidErr).slice(0, 200)}`).catch(() => {});
      }
    }

    // --- CoinGecko category check (fail-closed if unavailable) ---
    const { id: cgId, categories } = await cgFetchCategories(symbol);
    if (categories === null) {
      logger.warn("[BULLTREND] CoinGecko categories unavailable — fail-closed skip", { symbol, cgId });
      await sendTelegramMessage(`🚫 *Bulltrend skip* ${symbol}\nCoinGecko categories unavailable (cgId=${cgId ?? "none"}) — fail-closed`).catch(() => {});
      await logDecision({
        handler: "bulltrend",
        symbol,
        payload: { bullish_trend: bullishTrend, price, volume, time },
        decision: "rejected",
        reasons: ["CoinGecko categories unavailable — fail-closed skip"],
        broker: bulltrendBroker,
        price: !isNaN(price) ? price : null,
        bookScore: null, bookSignal: null, bookReasons: null,
        volumeSpike: null, volumeRatio: null,
        meta: { bulltrendId: bulltrendDoc.id, cgId },
      });
      res.json({
        status: "stored",
        id: bulltrendDoc.id,
        symbol,
        bullish_trend: bullishTrend,
        categoryUnavailable: true,
      });
      return;
    }

    const forbidden = categories.filter(c => FORBIDDEN_CATEGORY_REGEX.test(c));
    if (forbidden.length > 0) {
      logger.info("[BULLTREND] Forbidden category — skipping buy", { symbol, cgId, forbidden });
      await sendTelegramMessage(`🚫 *Bulltrend skip* ${symbol}\nForbidden category: ${forbidden.join(", ")}`).catch(() => {});
      await logDecision({
        handler: "bulltrend",
        symbol,
        payload: { bullish_trend: bullishTrend, price, volume, time },
        decision: "skipped",
        reasons: [`Forbidden category: ${forbidden.join(", ")}`],
        broker: bulltrendBroker,
        price: !isNaN(price) ? price : null,
        bookScore: null, bookSignal: null, bookReasons: null,
        volumeSpike: null, volumeRatio: null,
        meta: { bulltrendId: bulltrendDoc.id, cgId, categories, forbidden },
      });
      res.json({
        status: "stored",
        id: bulltrendDoc.id,
        symbol,
        bullish_trend: bullishTrend,
        forbidden,
        cgId,
      });
      return;
    }

    // --- Buy: create signal and (if AUTO_APPROVE) execute ---
    const entryPrice = !isNaN(price) ? price : 0;
    const buySignal: Signal = {
      strategy: "bulltrend-category",
      symbol,
      action: "BUY",
      timeframe: "3m",
      price: entryPrice,
      signalTime: time || new Date().toISOString(),
      status: "PENDING",
      bullishTrend: true,
      bulltrendPrice: entryPrice,
      broker: bulltrendBroker,
      stopLoss: parseFloat(
        (entryPrice * (1 - BULLTREND_STOP_LOSS_PCT / 100)).toFixed(8)
      ),
      idempotencyKey: crypto
        .createHash("sha256")
        .update(`bulltrend-cat:${symbol}:${Date.now()}`)
        .digest("hex")
        .slice(0, 32),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const signalRef = await db.collection("signals").add(buySignal);
    buySignal.id = signalRef.id;
    logger.info("[BULLTREND] Buy signal created", {
      signalId: signalRef.id, symbol, price: entryPrice, cgId, categories,
    });

    await logDecision({
      handler: "bulltrend",
      symbol,
      payload: { bullish_trend: bullishTrend, price, volume, time },
      decision: "bought",
      reasons: [
        `CoinGecko category passed (not defi/meme): ${categories.join(", ") || "(none)"}`,
      ],
      broker: bulltrendBroker,
      price: entryPrice,
      signalId: signalRef.id,
      bookScore: null, bookSignal: null, bookReasons: null,
      volumeSpike: null, volumeRatio: null,
      meta: { bulltrendId: bulltrendDoc.id, cgId, categories },
    });

    let orderResult: Record<string, unknown> | null = null;
    if (tradingConfig.AUTO_APPROVE) {
      try {
        orderResult = await executeOrder(buySignal, "bulltrend-category");
        logger.info("[BULLTREND] Order executed", {
          signalId: signalRef.id, symbol, order: orderResult,
        });
        const orderStatus = (orderResult as { status?: string } | null)?.status;
        if (orderStatus === "executed") {
          // Buy push notification is fired inside executeOrder() now.
        } else {
          await sendTelegramMessage(`❌ *Bulltrend BUY not executed* ${symbol}\nexecuteOrder returned: ${orderStatus ?? "unknown"}`).catch(() => {});
        }
      } catch (execErr) {
        logger.error("[BULLTREND] Order execution failed", {
          signalId: signalRef.id, symbol, error: String(execErr),
        });
        await sendTelegramMessage(`❌ *Bulltrend BUY failed* ${symbol}\nexecuteOrder threw: ${String(execErr).slice(0, 250)}`).catch(() => {});
      }
    } else {
      await sendTelegramMessage(`⏸ *Bulltrend signal stored* ${symbol} @ ${entryPrice}\nAUTO_APPROVE=false — manual approval required`).catch(() => {});
    }

    res.json({
      status: "bought",
      id: bulltrendDoc.id,
      signalId: signalRef.id,
      symbol,
      bullish_trend: bullishTrend,
      categories,
      cgId,
      order: orderResult,
    });
  } catch (err) {
    logger.error("[BULLTREND] Error processing webhook", {
      symbol, bullishTrend, error: String(err),
    });
    await sendTelegramMessage(`❌ *Bulltrend webhook error* ${symbol}\n${String(err).slice(0, 300)}`).catch(() => {});
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * POST /tradingview/beartrend — liquidate the symbol's open position.
 *
 * A beartrend alert always exits the position (full liquidation) on whichever
 * broker holds it, regardless of the active bull strategy. The legacy
 * trend-mode RSI-dip collector is retired: bulltrend now buys directly without
 * a pre-collected dip, so there is nothing left to collect dips for.
 *
 * Expected payload:
 *   { "symbol": "ETHUSD", "price": "2100.50", "time": "...", "secret": "..." }
 */
export async function handleBeartrendWebhook(req: Request, res: Response): Promise<void> {
  logger.info("[BEARTREND] Webhook hit", { path: req.path, body: JSON.stringify(req.body || {}).slice(0, 300) });
  return runBeartrendLiquidate(req, res);
}
