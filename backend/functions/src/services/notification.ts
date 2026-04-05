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
    const messages = tokens.map((token) => ({
      to: token,
      sound: "default" as const,
      title: "New Trade Signal",
      body: `${signal.action} ${signal.symbol} @ ${signal.price}`,
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
    logger.error("[NOTIFY] Failed to send notification", err);
    await logAudit("NOTIFICATION_FAILED", {
      signalId: signal.id,
      details: { error: String(err) },
    });
  }
}
