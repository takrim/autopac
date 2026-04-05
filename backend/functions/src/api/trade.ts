import { Request, Response } from "express";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { TradeApprovalRequest, Signal, Decision, Order } from "../types";
import { CONFIG } from "../config";
import { getBroker } from "../brokers";
import { runRiskChecks } from "../services/risk";
import { logAudit } from "../services/audit";

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

    // Update signal status to FAILED
    const statusMessage = `risk_check_failed: ${riskResult.reason}`;
    await db.collection("signals").doc(signal.id!).update({
      status: "FAILED",
      statusMessage,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { status: statusMessage };
  }

  // Place order via broker
  const broker = getBroker();
  const quantity = CONFIG.TRADE_VALUE_USD / signal.price;

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
