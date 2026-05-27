import { Request, Response } from "express";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { TradeApprovalRequest, Signal, Decision, Order } from "../types";
import { CONFIG } from "../config";
import { getTradingConfig, getActiveBrokerSettings, getBrokerSettings } from "./config";
import { getBroker } from "../brokers";
import { runRiskChecks } from "../services/risk";
import { logAudit } from "../services/audit";
import { logDecision } from "../services/decisionLog";

const db = getFirestore();

/**
 * Handle trade approval or rejection.
 * Requires Firebase Auth (enforced by middleware).
 */
export async function handleTradeApproval(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { signalId, action } = req.body as TradeApprovalRequest;

  // Validate input
  if (!signalId || typeof signalId !== "string") {
    res.status(400).json({ error: "Missing or invalid signalId" });
    return;
  }
  if (action !== "APPROVE" && action !== "REJECT") {
    res.status(400).json({ error: "Invalid action — must be APPROVE or REJECT" });
    return;
  }

  // Get signal
  const signalRef = db.collection("signals").doc(signalId);

  try {
    // Use transaction to prevent race conditions
    const result = await db.runTransaction(async (transaction) => {
      const signalSnap = await transaction.get(signalRef);

      if (!signalSnap.exists) {
        return { status: 404, body: { error: "Signal not found" } };
      }

      const signal = { id: signalSnap.id, ...signalSnap.data() } as Signal;

      // Only PENDING signals can be acted on
      if (signal.status !== "PENDING") {
        return {
          status: 409,
          body: { error: `Signal already ${signal.status.toLowerCase()}` },
        };
      }

      // Record decision
      const decision: Decision = {
        signalId,
        userId: user.uid,
        decision: action,
        decisionTime: FieldValue.serverTimestamp(),
      };

      const decisionRef = db.collection("decisions").doc();
      transaction.set(decisionRef, decision);

      if (action === "REJECT") {
        transaction.update(signalRef, {
          status: "REJECTED",
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          status: 200,
          body: { status: "rejected", signalId },
          auditAction: "DECISION_REJECT" as const,
          signal,
        };
      }

      // APPROVE — update status to APPROVED (execution happens after transaction)
      transaction.update(signalRef, {
        status: "APPROVED",
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        status: 200,
        body: { status: "approved", signalId },
        auditAction: "DECISION_APPROVE" as const,
        signal,
        executeOrder: true,
      };
    });

    // Log decision
    if (result.auditAction) {
      await logAudit(result.auditAction, {
        signalId,
        userId: user.uid,
      });
    }

    // Execute order if approved (outside transaction)
    if ("executeOrder" in result && result.executeOrder && result.signal) {
      const orderResult = await executeOrder(result.signal, user.uid);
      res.status(result.status).json({
        ...result.body,
        order: orderResult,
      });
      return;
    }

    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error("[TRADE] Approval failed", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Execute a trade order through the broker.
 */
export async function executeOrder(
  signal: Signal,
  userId: string
): Promise<{ orderId?: string; status: string }> {
  // Run risk checks
  const riskResult = await runRiskChecks(signal);
  if (!riskResult.passed) {
    await logAudit("RISK_CHECK_FAILED", {
      signalId: signal.id,
      userId,
      details: { reason: riskResult.reason },
    });

    await logDecision({
      source: "risk_check",
      outcome: "REJECTED",
      action: signal.action === "SELL" ? "SELL" : "BUY",
      symbol: signal.symbol,
      price: signal.price,
      reason: riskResult.reason ?? "risk check failed",
      expression: `risk_check_failed → ${riskResult.reason ?? "unknown"}`,
      params: {
        signal_strategy: signal.strategy,
        signal_broker: signal.broker,
        signal_price: signal.price,
        signal_stop_loss: signal.stopLoss,
        signal_take_profit: signal.takeProfit,
      },
      signalId: signal.id,
      userId,
    });

    // Update signal status to FAILED
    const statusMessage = `risk_check_failed: ${riskResult.reason}`;
    await db.collection("signals").doc(signal.id!).update({
      status: "FAILED",
      statusMessage,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { status: statusMessage };
  }

  await logDecision({
    source: signal.strategy === "burst_scanner" ? "burst_scanner" : "auto_approve",
    outcome: "ACCEPTED",
    action: signal.action === "SELL" ? "SELL" : "BUY",
    symbol: signal.symbol,
    price: signal.price,
    reason: "risk checks passed — order proceeding",
    expression: `risk_checks_passed ∧ broker=${signal.broker ?? "default"} → place ${signal.action} @ $${signal.price}`,
    params: {
      strategy: signal.strategy,
      stop_loss: signal.stopLoss,
      take_profit: signal.takeProfit,
    },
    signalId: signal.id,
    userId,
  });

  // Place order via broker — use the broker stamped on the signal, not ACTIVE_BROKER
  const tradingConfig = await getTradingConfig();
  const resolvedBroker = (signal.broker as "mock" | "alpaca" | "coinbase") || tradingConfig.ACTIVE_BROKER;
  const broker = getBroker(resolvedBroker);
  const brokerSettings = getBrokerSettings(tradingConfig, resolvedBroker);
  const tradeValueUsd = brokerSettings.tradeValueUsd;
  const quantity = tradeValueUsd / signal.price;

  const order: Order = {
    signalId: signal.id!,
    broker: broker.name,
    orderType: CONFIG.DEFAULT_ORDER_TYPE,
    side: signal.action,
    symbol: signal.symbol,
    quantity,
    status: "PENDING",
    responsePayload: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const orderRef = await db.collection("orders").add(order);

  await logAudit("ORDER_PLACED", {
    signalId: signal.id,
    userId,
    details: { orderId: orderRef.id, broker: broker.name },
  });

  try {
    const brokerResult = await broker.placeOrder({
      symbol: signal.symbol,
      side: signal.action,
      quantity,
      orderType: CONFIG.DEFAULT_ORDER_TYPE,
      stopLoss: signal.stopLoss || undefined,
      takeProfit: signal.takeProfit || undefined,
      tradeValueUsd,
      // Maker-first applies to Coinbase BUYs only — saves 0.25% fee when the
      // limit fills at the bid. Falls back to market if it doesn't fill in ~9s.
      makerFirst: resolvedBroker === "coinbase" && signal.action === "BUY",
    });

    // Update order with result
    await orderRef.update({
      status: brokerResult.success ? brokerResult.status : "FAILED",
      responsePayload: brokerResult.raw || { message: brokerResult.message },
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Log broker errors
    if (!brokerResult.success) {
      await db.collection("broker_errors").add({
        signalId: signal.id,
        orderId: orderRef.id,
        broker: broker.name,
        symbol: signal.symbol,
        side: signal.action,
        error: brokerResult.message,
        raw: brokerResult.raw || null,
        timestamp: FieldValue.serverTimestamp(),
      });
    }

    // Update signal status
    const signalStatus = brokerResult.success ? "EXECUTED" : "FAILED";
    const signalUpdate: Record<string, any> = {
      status: signalStatus,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!brokerResult.success) {
      signalUpdate.statusMessage = brokerResult.message || "Order failed";
    }
    await db.collection("signals").doc(signal.id!).update(signalUpdate);

    await logAudit(brokerResult.success ? "ORDER_FILLED" : "ORDER_FAILED", {
      signalId: signal.id,
      userId,
      details: {
        orderId: orderRef.id,
        brokerOrderId: brokerResult.orderId,
        message: brokerResult.message,
      },
    });

    return {
      orderId: orderRef.id,
      status: brokerResult.success ? "executed" : "failed",
    };
  } catch (err) {
    logger.error("[TRADE] Broker execution failed", err);

    await orderRef.update({
      status: "FAILED",
      responsePayload: { error: String(err) },
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Log broker error
    await db.collection("broker_errors").add({
      signalId: signal.id,
      orderId: orderRef.id,
      broker: broker.name,
      symbol: signal.symbol,
      side: signal.action,
      error: String(err),
      raw: null,
      timestamp: FieldValue.serverTimestamp(),
    });

    await db.collection("signals").doc(signal.id!).update({
      status: "FAILED",
      updatedAt: FieldValue.serverTimestamp(),
    });

    await logAudit("ORDER_FAILED", {
      signalId: signal.id,
      userId,
      details: { orderId: orderRef.id, error: String(err) },
    });

    return { orderId: orderRef.id, status: "failed" };
  }
}

/**
 * Core logic for placing a manual order for a symbol.
 * Used by both the REST API and the Telegram bot.
 */
export async function placeManualOrder(
  symbol: string,
  side: "BUY" | "SELL",
  userId: string,
  priceOverride?: number
): Promise<{
  status: string;
  signalId?: string;
  orderId?: string;
  symbol: string;
  side: string;
  price: number;
  stopLoss: number;
  takeProfit: number;
  error?: string;
}> {
  const tradingConfig = await getTradingConfig();
  const { getBrokerForSymbol } = await import("./config");
  const resolvedBroker = getBrokerForSymbol(tradingConfig, symbol.toUpperCase());
  if (!resolvedBroker) {
    return { status: "error", symbol, side, price: 0, stopLoss: 0, takeProfit: 0, error: `Symbol ${symbol} not in any broker allowlist` };
  }

  const broker = getBroker(resolvedBroker);

  // Pyramid check: if ORDER_PYRAMID is disabled, block a second BUY on the same symbol
  if (side === "BUY" && !tradingConfig.ORDER_PYRAMID) {
    try {
      const existing = await broker.getPosition(symbol.toUpperCase());
      if (existing && existing.qty > 0) {
        return {
          status: "skipped_pyramid_off",
          symbol,
          side,
          price: 0,
          stopLoss: 0,
          takeProfit: 0,
          error: `Pyramid disabled — already holding ${existing.qty} ${symbol}`,
        };
      }
    } catch { /* non-fatal: proceed if position check fails */ }
  }

  let price = priceOverride && priceOverride > 0 ? priceOverride : 0;
  if (price <= 0) {
    try {
      if (broker.name === "coinbase") {
        const cb = broker as any;
        const productId = symbol.includes("-") ? symbol : symbol.replace(/USDT?$/, "") + "-USD";
        const { ok, data } = await cb.request("GET", `/products/${productId}`);
        if (ok && data.price) price = parseFloat(data.price as string);
      }
    } catch { /* fallback */ }
    if (price <= 0) {
      return { status: "error", symbol, side, price: 0, stopLoss: 0, takeProfit: 0, error: "Could not determine current price" };
    }
  }

  const idempotencyKey = `manual-${symbol}-${side}-${Date.now()}`;
  const stopLoss = side === "BUY" ? parseFloat((price * 0.995).toPrecision(8)) : 0;
  const signalData: any = {
    strategy: "manual",
    symbol: symbol.toUpperCase(),
    action: side,
    timeframe: "manual",
    price,
    stopLoss,
    signalTime: new Date().toISOString(),
    status: "APPROVED",
    idempotencyKey,
    broker: resolvedBroker,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const signalRef = await db.collection("signals").add(signalData);
  const signal = { id: signalRef.id, ...signalData } as Signal;

  await logAudit("MANUAL_ORDER", {
    signalId: signalRef.id,
    userId,
    details: { symbol, side, price, broker: resolvedBroker },
  });

  const result = await executeOrder(signal, userId);

  return {
    status: result.status,
    signalId: signalRef.id,
    orderId: result.orderId,
    symbol: symbol.toUpperCase(),
    side,
    price,
    stopLoss,
    takeProfit: 0,
  };
}

/**
 * POST /orders/manual — place a manual buy/sell order for a symbol.
 * Body: { symbol: string, action: "BUY" | "SELL", price?: number }
 * If price is omitted, fetches current market price.
 */
export async function handleManualOrder(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { symbol, action } = req.body;
  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "Missing or invalid symbol" });
    return;
  }
  const side = String(action || "BUY").toUpperCase();
  if (side !== "BUY" && side !== "SELL") {
    res.status(400).json({ error: "action must be BUY or SELL" });
    return;
  }

  try {
    const priceOverride = parseFloat(req.body.price) || undefined;
    const result = await placeManualOrder(symbol, side as "BUY" | "SELL", user.uid, priceOverride);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    logger.error("[TRADE] Manual order failed", { symbol, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
}