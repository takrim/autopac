/**
 * RSI Divergence strategy — plug-and-play alternative to the trend strategy.
 *
 * Selected when `app_config/strategy.active === "divergence"` (see
 * `services/strategyConfig.ts`).
 *
 * Bull-divergence webhook  → immediate BUY (gated). No dip pre-collection.
 * Bear-divergence webhook  → LIQUIDATE the symbol's open position if any.
 *
 * Both share the existing trend strategy's gates where applicable
 * (CoinGecko categories, exchange routing, pyramid, Coinbase-disabled global,
 * Alpaca market hours).
 */

import { Request, Response } from "express";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import crypto from "crypto";

import { getWebhookSecret } from "../../config";
import { Signal } from "../../types";
import { getTradingConfig, getBrokerForSymbol } from "../../api/config";
import { getBroker } from "../../brokers";
import { executeOrder } from "../../api/trade";
import { sendTelegramMessage } from "../telegram";
import { isUsStockMarketOpen } from "../marketHours";
import { resolveExchangeForSymbol } from "../rsiDip";
import {
  logDecision,
  cgFetchCategories,
  FORBIDDEN_CATEGORY_REGEX,
  BULLTREND_STOP_LOSS_PCT,
} from "../../webhooks/tradingview";

const db = getFirestore();

// ---------------------------------------------------------------------------
// Shared payload helpers
// ---------------------------------------------------------------------------

interface ParsedPayload {
  symbol: string;
  price: number;
  time: string;
}

function checkSecret(body: Record<string, unknown>): boolean {
  try {
    const secret = String(body.secret || "");
    const expected = getWebhookSecret();
    const a = Buffer.from(secret);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parsePayload(body: Record<string, unknown>): ParsedPayload | null {
  const symbol = String(body.symbol || "").toUpperCase().trim();
  if (!symbol) return null;
  const price = parseFloat(String(body.price));
  const time = String(body.time || "");
  return { symbol, price, time };
}

// ---------------------------------------------------------------------------
// Bull-divergence: immediate buy (gated)
// ---------------------------------------------------------------------------

export async function runBulltrendDivergence(req: Request, res: Response): Promise<void> {
  logger.info("[BULLDIV] Webhook hit", { body: JSON.stringify(req.body || {}).slice(0, 300) });
  const body = (req.body || {}) as Record<string, unknown>;

  if (!checkSecret(body)) {
    await sendTelegramMessage(`🚫 *Bull divergence skip*\nInvalid webhook secret`).catch(() => {});
    res.status(401).json({ error: "Invalid secret" });
    return;
  }

  const parsed = parsePayload(body);
  if (!parsed) {
    await sendTelegramMessage(`🚫 *Bull divergence skip*\nMissing symbol`).catch(() => {});
    res.status(400).json({ error: "Missing symbol" });
    return;
  }
  const { symbol, price, time } = parsed;

  // ── Broker resolution (per-symbol allowlist) ──────────────────────────
  let broker: "alpaca" | "coinbase";
  let tradingConfig;
  try {
    tradingConfig = await getTradingConfig();
    const resolved = getBrokerForSymbol(tradingConfig, symbol);
    if (!resolved) {
      await sendTelegramMessage(`🚫 *Bull divergence skip* ${symbol}\nNot in any broker allowlist`).catch(() => {});
      await logDecision({
        handler: "bulltrend", symbol,
        payload: { price, time, source: "divergence" },
        decision: "skipped", reasons: ["Symbol not in any broker allowlist"],
        price: Number.isFinite(price) ? price : null,
        bookScore: null, bookSignal: null, bookReasons: null,
        volumeSpike: null, volumeRatio: null,
        meta: { strategy: "divergence" },
      });
      res.status(200).json({ status: "skipped_not_in_allowlist", symbol });
      return;
    }
    broker = resolved;
  } catch (err) {
    logger.error("[BULLDIV] Config load failed", { error: String(err) });
    await sendTelegramMessage(`❌ *Bull divergence skip* ${symbol}\nConfig load failed: ${String(err).slice(0, 200)}`).catch(() => {});
    res.status(500).json({ error: "Config load failed" });
    return;
  }

  // ── Audit row ─────────────────────────────────────────────────────────
  const bulltrendDoc = await db.collection("bulltrends").add({
    symbol,
    price: Number.isFinite(price) ? price : null,
    time: time || null,
    source: "divergence",
    createdAt: FieldValue.serverTimestamp(),
  });

  // Coinbase buys are enabled alongside Alpaca (no broker-disable gate).

  // ── Pyramid guard ─────────────────────────────────────────────────────
  if (!tradingConfig.ORDER_PYRAMID) {
    try {
      const b = getBroker(broker);
      const existing = await b.getPosition(symbol);
      if (existing && existing.qty > 0) {
        await sendTelegramMessage(`🚫 *Bull divergence skip* ${symbol}\nPyramid disabled — already holding ${existing.qty}`).catch(() => {});
        await logDecision({
          handler: "bulltrend", symbol,
          payload: { price, time, source: "divergence" },
          decision: "skipped", reasons: [`Pyramid disabled — already holding ${existing.qty}`],
          broker, price: Number.isFinite(price) ? price : null,
          bookScore: null, bookSignal: null, bookReasons: null,
          volumeSpike: null, volumeRatio: null,
          meta: { strategy: "divergence", bulltrendId: bulltrendDoc.id, existingQty: existing.qty },
        });
        res.json({ status: "stored", id: bulltrendDoc.id, symbol, pyramidBlocked: true });
        return;
      }
    } catch (err) {
      logger.warn("[BULLDIV] Pyramid check failed, allowing order", { err: String(err) });
    }
  }

  // ── CoinGecko category fail-closed gate ───────────────────────────────
  const { id: cgId, categories } = await cgFetchCategories(symbol);
  if (categories === null) {
    await sendTelegramMessage(`🚫 *Bull divergence skip* ${symbol}\nCoinGecko categories unavailable — fail-closed`).catch(() => {});
    await logDecision({
      handler: "bulltrend", symbol,
      payload: { price, time, source: "divergence" },
      decision: "rejected", reasons: ["CoinGecko categories unavailable — fail-closed"],
      broker, price: Number.isFinite(price) ? price : null,
      bookScore: null, bookSignal: null, bookReasons: null,
      volumeSpike: null, volumeRatio: null,
      meta: { strategy: "divergence", bulltrendId: bulltrendDoc.id, cgId },
    });
    res.json({ status: "stored", id: bulltrendDoc.id, symbol, categoryUnavailable: true });
    return;
  }
  const forbidden = categories.filter(c => FORBIDDEN_CATEGORY_REGEX.test(c));
  if (forbidden.length > 0) {
    await sendTelegramMessage(`🚫 *Bull divergence skip* ${symbol}\nForbidden category: ${forbidden.join(", ")}`).catch(() => {});
    await logDecision({
      handler: "bulltrend", symbol,
      payload: { price, time, source: "divergence" },
      decision: "skipped", reasons: [`Forbidden category: ${forbidden.join(", ")}`],
      broker, price: Number.isFinite(price) ? price : null,
      bookScore: null, bookSignal: null, bookReasons: null,
      volumeSpike: null, volumeRatio: null,
      meta: { strategy: "divergence", bulltrendId: bulltrendDoc.id, cgId, categories, forbidden },
    });
    res.json({ status: "stored", id: bulltrendDoc.id, symbol, forbidden, cgId });
    return;
  }

  // ── Alpaca market-hours gate (04:00–20:00 ET Mon–Fri) ─────────────────
  if (broker === "alpaca" && !isUsStockMarketOpen()) {
    await sendTelegramMessage(`⏸ *Bull divergence deferred* ${symbol}\nAlpaca market closed — skip`).catch(() => {});
    await logDecision({
      handler: "bulltrend", symbol,
      payload: { price, time, source: "divergence" },
      decision: "skipped", reasons: ["Alpaca market closed (outside 04:00–20:00 ET)"],
      broker, price: Number.isFinite(price) ? price : null,
      bookScore: null, bookSignal: null, bookReasons: null,
      volumeSpike: null, volumeRatio: null,
      meta: { strategy: "divergence", bulltrendId: bulltrendDoc.id },
    });
    res.json({ status: "stored", id: bulltrendDoc.id, symbol, marketClosed: true });
    return;
  }

  // ── Create PENDING BUY + execute ─────────────────────────────────────
  const entryPrice = Number.isFinite(price) ? price : 0;
  const buySignal: Signal = {
    strategy: "bulltrend-divergence",
    symbol,
    action: "BUY",
    timeframe: "3m",
    price: entryPrice,
    signalTime: time || new Date().toISOString(),
    status: "PENDING",
    bullishTrend: true,
    bulltrendPrice: entryPrice,
    broker,
    stopLoss: parseFloat((entryPrice * (1 - BULLTREND_STOP_LOSS_PCT / 100)).toFixed(8)),
    idempotencyKey: crypto.createHash("sha256")
      .update(`bulldiv:${symbol}:${Date.now()}`)
      .digest("hex").slice(0, 32),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const signalRef = await db.collection("signals").add(buySignal);
  buySignal.id = signalRef.id;
  logger.info("[BULLDIV] Buy signal created", { signalId: signalRef.id, symbol, price: entryPrice });

  await logDecision({
    handler: "bulltrend", symbol,
    payload: { price, time, source: "divergence" },
    decision: "bought",
    reasons: [`Bull divergence — categories OK (${categories.join(", ") || "none"})`],
    broker, price: entryPrice, signalId: signalRef.id,
    bookScore: null, bookSignal: null, bookReasons: null,
    volumeSpike: null, volumeRatio: null,
    meta: { strategy: "divergence", bulltrendId: bulltrendDoc.id, cgId, categories },
  });

  let orderResult: Record<string, unknown> | null = null;
  if (tradingConfig.AUTO_APPROVE) {
    try {
      orderResult = await executeOrder(buySignal, "bulltrend-divergence");
      const orderStatus = (orderResult as { status?: string } | null)?.status;
      if (orderStatus !== "executed") {
        await sendTelegramMessage(`❌ *Bull divergence BUY not executed* ${symbol}\nexecuteOrder returned: ${orderStatus ?? "unknown"}`).catch(() => {});
      }
    } catch (err) {
      logger.error("[BULLDIV] Order execution failed", { signalId: signalRef.id, symbol, error: String(err) });
      await sendTelegramMessage(`❌ *Bull divergence BUY failed* ${symbol}\nexecuteOrder threw: ${String(err).slice(0, 250)}`).catch(() => {});
    }
  } else {
    await sendTelegramMessage(`⏸ *Bull divergence stored* ${symbol} @ ${entryPrice}\nAUTO_APPROVE=false`).catch(() => {});
  }

  res.json({
    status: "bought",
    id: bulltrendDoc.id, signalId: signalRef.id, symbol,
    categories, cgId, order: orderResult,
  });
}

// ---------------------------------------------------------------------------
// Bear-divergence: liquidate position if held
// ---------------------------------------------------------------------------

export async function runBeartrendDivergence(req: Request, res: Response): Promise<void> {
  logger.info("[BEARDIV] Webhook hit", { body: JSON.stringify(req.body || {}).slice(0, 300) });
  const body = (req.body || {}) as Record<string, unknown>;

  if (!checkSecret(body)) {
    await sendTelegramMessage(`🚫 *Bear divergence skip*\nInvalid webhook secret`).catch(() => {});
    res.status(401).json({ error: "Invalid secret" });
    return;
  }

  const parsed = parsePayload(body);
  if (!parsed) {
    await sendTelegramMessage(`🚫 *Bear divergence skip*\nMissing symbol`).catch(() => {});
    res.status(400).json({ error: "Missing symbol" });
    return;
  }
  const { symbol, price, time } = parsed;

  // ── Exchange resolve (Alpaca first, Coinbase fallback) ────────────────
  let brokerName: "alpaca" | "coinbase";
  try {
    const resolved = await resolveExchangeForSymbol(symbol);
    if (!resolved) {
      await sendTelegramMessage(`🚫 *Bear divergence skip* ${symbol}\nNot tradeable on Alpaca or Coinbase`).catch(() => {});
      await logDecision({
        handler: "beartrend", symbol,
        payload: { price, time, source: "divergence" },
        decision: "skipped", reasons: ["Symbol not tradeable on Alpaca or Coinbase"],
        price: Number.isFinite(price) ? price : null,
        bookScore: null, bookSignal: null, bookReasons: null,
        volumeSpike: null, volumeRatio: null,
        meta: { strategy: "divergence" },
      });
      res.status(200).json({ status: "skipped_no_exchange", symbol });
      return;
    }
    brokerName = resolved;
  } catch (err) {
    logger.error("[BEARDIV] Exchange resolution failed", { error: String(err) });
    await sendTelegramMessage(`❌ *Bear divergence skip* ${symbol}\nExchange resolution failed: ${String(err).slice(0, 200)}`).catch(() => {});
    res.status(500).json({ error: "Exchange resolution failed" });
    return;
  }

  // ── Audit row ─────────────────────────────────────────────────────────
  const beartrendDoc = await db.collection("beartrends").add({
    symbol,
    price: Number.isFinite(price) ? price : null,
    time: time || null,
    source: "divergence",
    intent: "liquidate",
    createdAt: FieldValue.serverTimestamp(),
  });

  // ── Position lookup ───────────────────────────────────────────────────
  let position;
  try {
    const broker = getBroker(brokerName);
    position = await broker.getPosition(symbol);
  } catch (err) {
    logger.error("[BEARDIV] getPosition failed", { symbol, error: String(err) });
    await sendTelegramMessage(`❌ *Bear divergence skip* ${symbol}\ngetPosition failed: ${String(err).slice(0, 200)}`).catch(() => {});
    res.status(500).json({ error: "getPosition failed" });
    return;
  }

  if (!position || position.qty <= 0) {
    await sendTelegramMessage(`ℹ️ *Bear divergence* ${symbol}\nNo open position to liquidate`).catch(() => {});
    await logDecision({
      handler: "beartrend", symbol,
      payload: { price, time, source: "divergence" },
      decision: "skipped", reasons: ["No open position to liquidate"],
      broker: brokerName, price: Number.isFinite(price) ? price : null,
      bookScore: null, bookSignal: null, bookReasons: null,
      volumeSpike: null, volumeRatio: null,
      meta: { strategy: "divergence", beartrendId: beartrendDoc.id },
    });
    res.json({ status: "stored", id: beartrendDoc.id, symbol, noPosition: true });
    return;
  }

  // ── Alpaca market-hours gate ──────────────────────────────────────────
  if (brokerName === "alpaca" && !isUsStockMarketOpen()) {
    await sendTelegramMessage(`⏸ *Bear divergence deferred* ${symbol}\nAlpaca market closed — liquidation skipped`).catch(() => {});
    await logDecision({
      handler: "beartrend", symbol,
      payload: { price, time, source: "divergence" },
      decision: "skipped", reasons: ["Alpaca market closed (outside 04:00–20:00 ET) — liquidation deferred"],
      broker: brokerName, price: Number.isFinite(price) ? price : null,
      bookScore: null, bookSignal: null, bookReasons: null,
      volumeSpike: null, volumeRatio: null,
      meta: { strategy: "divergence", beartrendId: beartrendDoc.id, qty: position.qty },
    });
    res.json({ status: "stored", id: beartrendDoc.id, symbol, marketClosed: true });
    return;
  }

  // ── Liquidate ─────────────────────────────────────────────────────────
  try {
    const broker = getBroker(brokerName);
    const result = await broker.liquidatePosition(symbol);
    logger.info("[BEARDIV] Liquidated", { symbol, broker: brokerName, qty: position.qty, result });
    await sendTelegramMessage(
      `📤 *Bear divergence — LIQUIDATED* ${symbol}\nbroker=${brokerName} qty=${position.qty} px=${Number.isFinite(price) ? price : "n/a"}`,
    ).catch(() => {});
    await logDecision({
      handler: "beartrend", symbol,
      payload: { price, time, source: "divergence" },
      decision: "sold",
      reasons: ["Bear divergence — liquidated full position"],
      broker: brokerName, price: Number.isFinite(price) ? price : null,
      bookScore: null, bookSignal: null, bookReasons: null,
      volumeSpike: null, volumeRatio: null,
      meta: { strategy: "divergence", beartrendId: beartrendDoc.id, qty: position.qty, result },
    });
    res.json({ status: "liquidated", id: beartrendDoc.id, symbol, qty: position.qty, result });
  } catch (err) {
    logger.error("[BEARDIV] liquidatePosition threw", { symbol, error: String(err) });
    await sendTelegramMessage(`❌ *Bear divergence LIQUIDATION failed* ${symbol}\n${String(err).slice(0, 250)}`).catch(() => {});
    await logDecision({
      handler: "beartrend", symbol,
      payload: { price, time, source: "divergence" },
      decision: "error",
      reasons: [`liquidatePosition threw: ${String(err).slice(0, 200)}`],
      broker: brokerName, price: Number.isFinite(price) ? price : null,
      bookScore: null, bookSignal: null, bookReasons: null,
      volumeSpike: null, volumeRatio: null,
      meta: { strategy: "divergence", beartrendId: beartrendDoc.id, qty: position.qty },
    });
    res.status(500).json({ error: "Liquidation failed" });
  }
}
