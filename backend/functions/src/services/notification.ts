import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions/v2";
import { Signal } from "../types";
import { logAudit } from "./audit";

const db = getFirestore();

/**
 * Send push notification to user about a new signal.
 * Reads FCM tokens from userTokens collection.
 */
export async function sendSignalNotification(signal: Signal): Promise<void> {
  try {
    // In MVP single-user system, get all registered tokens
    const tokensSnap = await db.collection("userTokens").get();

    if (tokensSnap.empty) {
      logger.warn("[NOTIFY] No FCM tokens registered — skipping notification");
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

    const message = {
      notification: {
        title: "New Trade Signal",
        body: `${signal.action} ${signal.symbol} @ ${signal.price}`,
      },
      data: {
        signalId: signal.id || "",
        type: "NEW_SIGNAL",
        action: signal.action,
        symbol: signal.symbol,
        price: String(signal.price),
      },
      tokens,
    };

    const response = await getMessaging().sendEachForMulticast(message);

    // Clean up invalid tokens
    const failedTokens: string[] = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error?.code === "messaging/registration-token-not-registered") {
        failedTokens.push(tokens[idx]);
      }
    });

    if (failedTokens.length > 0) {
      const batch = db.batch();
      const toDelete = await db
        .collection("userTokens")
        .where("token", "in", failedTokens)
        .get();
      toDelete.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      logger.info(`[NOTIFY] Cleaned up ${failedTokens.length} invalid tokens`);
    }

    await logAudit("NOTIFICATION_SENT", {
      signalId: signal.id,
      details: {
        successCount: response.successCount,
        failureCount: response.failureCount,
      },
    });

    logger.info(`[NOTIFY] Sent to ${response.successCount}/${tokens.length} devices`);
  } catch (err) {
    logger.error("[NOTIFY] Failed to send notification", err);
    await logAudit("NOTIFICATION_FAILED", {
      signalId: signal.id,
      details: { error: String(err) },
    });
  }
}
