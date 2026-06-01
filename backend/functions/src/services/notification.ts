import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { Signal } from "../types";
import { logAudit } from "./audit";

const db = getFirestore();

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Send push notification to user about a new signal.
 * Uses Expo Push API to deliver to Expo push tokens.
 */
export async function sendSignalNotification(signal: Signal): Promise<void> {
  try {
    // In MVP single-user system, get all registered tokens
    const tokensSnap = await db.collection("userTokens").get();

    if (tokensSnap.empty) {
      logger.warn("[NOTIFY] No push tokens registered — skipping notification");
      return;
    }

    const tokens: string[] = [];
    tokensSnap.forEach((doc) => {
      const data = doc.data();
      if (data.token) {
        tokens.push(data.token);
      }
    });

    if (tokens.length === 0) {
      logger.warn("[NOTIFY] No valid tokens found");
      return;
    }

    // Build Expo push messages
    const isStrongBuy = (signal as unknown as Record<string, unknown>).strongBuy === true;
    const title = isStrongBuy ? "⚡ STRONG BUY" : "New Trade Signal";
    const body = isStrongBuy
      ? `Strong Buy: ${signal.symbol} @ ${signal.price}`
      : `${signal.action} ${signal.symbol} @ ${signal.price}`;

    logger.info("[NOTIFY] Preparing push notification", {
      signalId: signal.id,
      symbol: signal.symbol,
      action: signal.action,
      strongBuy: isStrongBuy,
      tokenCount: tokens.length,
    });

    const messages = tokens.map((token) => ({
      to: token,
      sound: "default" as const,
      title,
      body,
      data: {
        signalId: signal.id || "",
        type: "NEW_SIGNAL",
        action: signal.action,
        symbol: signal.symbol,
        price: String(signal.price),
      },
    }));

    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Expo Push API error: ${response.status} ${errorText}`);
    }

    const result = await response.json() as { data: ExpoPushTicket[] };
    const tickets = result.data;

    let successCount = 0;
    let failureCount = 0;
    const invalidTokens: string[] = [];

    tickets.forEach((ticket, idx) => {
      if (ticket.status === "ok") {
        successCount++;
      } else {
        failureCount++;
        if (ticket.details?.error === "DeviceNotRegistered") {
          invalidTokens.push(tokens[idx]);
        }
        logger.warn("[NOTIFY] Push failed for token", {
          token: tokens[idx].substring(0, 20) + "...",
          error: ticket.message,
        });
      }
    });

    // Clean up invalid tokens
    if (invalidTokens.length > 0) {
      const batch = db.batch();
      const toDelete = await db
        .collection("userTokens")
        .where("token", "in", invalidTokens)
        .get();
      toDelete.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      logger.info(`[NOTIFY] Cleaned up ${invalidTokens.length} invalid tokens`);
    }

    await logAudit("NOTIFICATION_SENT", {
      signalId: signal.id,
      details: { successCount, failureCount },
    });

    logger.info(`[NOTIFY] Sent to ${successCount}/${tokens.length} devices`);
  } catch (err) {
    logger.error("[NOTIFY] Failed to send notification", { signalId: signal.id, symbol: signal.symbol, error: String(err) });
    await logAudit("NOTIFICATION_FAILED", {
      signalId: signal.id,
      details: { error: String(err) },
    });
  }
}

// ---------------------------------------------------------------------------
// Generic push helper + dedicated senders for the Coinbase auto-trading flow
// ---------------------------------------------------------------------------

/**
 * Send a custom push notification to every registered Expo token.
 * Used by burstScanner (buy executed) and positionLiquidator (winning exits).
 */
async function sendPushToAllTokens(
  title: string,
  body: string,
  data: Record<string, string>,
  auditTag: string
): Promise<void> {
  try {
    const tokensSnap = await db.collection("userTokens").get();
    if (tokensSnap.empty) {
      logger.warn("[NOTIFY] No push tokens registered — skipping", { auditTag });
      return;
    }

    const tokens: string[] = [];
    tokensSnap.forEach((doc) => {
      const t = doc.data().token;
      if (t) tokens.push(t);
    });
    if (tokens.length === 0) return;

    const messages = tokens.map((token) => ({
      to: token,
      sound: "default" as const,
      title,
      body,
      data,
    }));

    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Expo Push API error: ${response.status} ${errorText}`);
    }

    const result = await response.json() as { data: ExpoPushTicket[] };
    const tickets = result.data;

    let successCount = 0;
    let failureCount = 0;
    const invalidTokens: string[] = [];

    tickets.forEach((ticket, idx) => {
      if (ticket.status === "ok") successCount++;
      else {
        failureCount++;
        if (ticket.details?.error === "DeviceNotRegistered") invalidTokens.push(tokens[idx]);
      }
    });

    if (invalidTokens.length > 0) {
      const batch = db.batch();
      const toDelete = await db.collection("userTokens").where("token", "in", invalidTokens).get();
      toDelete.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      logger.info(`[NOTIFY] Cleaned up ${invalidTokens.length} invalid tokens`);
    }

    logger.info(`[NOTIFY] ${auditTag} — sent to ${successCount}/${tokens.length} devices (failed: ${failureCount})`);
    await logAudit("NOTIFICATION_SENT", { details: { auditTag, successCount, failureCount, title, body } });
  } catch (err) {
    logger.error("[NOTIFY] Push failed", { auditTag, error: String(err) });
    await logAudit("NOTIFICATION_FAILED", { details: { auditTag, error: String(err) } });
  }
}

/**
 * Push fired by burstScanner when an auto-buy succeeds on Coinbase.
 * Example body: "Burst BUY: BTC-USD @ $43,210.55"
 */
export async function sendBurstBuyNotification(
  symbol: string,
  price: number,
  signalId: string
): Promise<void> {
  const priceStr = price >= 1
    ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : `$${price.toPrecision(4)}`;
  await sendPushToAllTokens(
    "💥 Burst BUY",
    `Burst BUY: ${symbol} @ ${priceStr}`,
    { type: "BURST_BUY", signalId, symbol, price: String(price) },
    "BURST_BUY"
  );
}

/**
 * Push fired by positionLiquidator when a position exits with positive P/L.
 * `reason` is a short human label: "RSI cut", "trailing stop", "external close".
 */
export async function sendExitNotification(
  symbol: string,
  pnlPct: number,
  reason: string,
  signalId: string = ""
): Promise<void> {
  const sign = pnlPct >= 0 ? "+" : "";
  await sendPushToAllTokens(
    "💰 Position Closed",
    `SOLD: ${symbol} ${sign}${pnlPct.toFixed(2)}% (${reason})`,
    { type: "POSITION_EXIT", signalId, symbol, pnlPct: pnlPct.toFixed(2), reason },
    "EXIT_WIN"
  );
}

/**
 * Push fired when the bulltrend webhook auto-executes a BUY after category check.
 */
export async function sendBulltrendBuyNotification(
  symbol: string,
  price: number,
  signalId: string
): Promise<void> {
  const priceStr = price >= 1
    ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : `$${price.toPrecision(4)}`;
  await sendPushToAllTokens(
    "🐂 Bulltrend BUY",
    `Bulltrend BUY: ${symbol} @ ${priceStr}`,
    { type: "BULLTREND_BUY", signalId, symbol, price: String(price) },
    "BULLTREND_BUY"
  );
}

/**
 * Push fired by positionLiquidator when a trailing stop is armed or raised.
 */
export async function sendTrailingStopNotification(
  symbol: string,
  newSL: number,
  gainPct: number,
  raised: boolean
): Promise<void> {
  const slStr = newSL >= 1
    ? `$${newSL.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : `$${newSL.toPrecision(4)}`;
  const sign = gainPct >= 0 ? "+" : "";
  await sendPushToAllTokens(
    raised ? "🔼 Trailing Stop Raised" : "🛡️ Trailing Stop Armed",
    `${symbol}: SL → ${slStr} (P/L ${sign}${gainPct.toFixed(2)}%)`,
    { type: "TRAILING_STOP", symbol, newSL: String(newSL), gainPct: gainPct.toFixed(2), raised: String(raised) },
    raised ? "TRAILING_STOP_RAISED" : "TRAILING_STOP_ARMED"
  );
}

/**
 * Generic push fired by executeOrder() after any successful BUY, regardless of
 * the originating strategy (bulltrend, manual, auto-approve, etc.).
 */
export async function sendBuyExecutedNotification(
  symbol: string,
  price: number,
  strategy: string,
  signalId: string
): Promise<void> {
  const priceStr = price >= 1
    ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : `$${price.toPrecision(4)}`;
  await sendPushToAllTokens(
    "✅ BUY executed",
    `${strategy}: ${symbol} @ ${priceStr}`,
    { type: "BUY_EXECUTED", signalId, symbol, price: String(price), strategy },
    "BUY_EXECUTED"
  );
}
