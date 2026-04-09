import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { AuditAction, AuditEntry } from "../types";
import { logger } from "firebase-functions/v2";

const db = getFirestore();

/**
 * Log an action to the audit trail.
 * All system actions are recorded for compliance and debugging.
 */
export async function logAudit(
  action: AuditAction,
  opts: {
    signalId?: string;
    userId?: string;
    details?: Record<string, unknown>;
  } = {}
): Promise<void> {
  const entry: AuditEntry = {
    action,
    signalId: opts.signalId,
    userId: opts.userId,
    details: opts.details,
    timestamp: FieldValue.serverTimestamp(),
  };

  try {
    await db.collection("audit").add(entry);
    logger.info(`[AUDIT] ${action}`, { signalId: opts.signalId, userId: opts.userId });
  } catch (err) {
    // Audit logging should never block main flow — log error and continue
    logger.error("[AUDIT] Failed to write audit entry", { action, error: String(err) });
  }
}
