import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

const db = getFirestore();

const COLLECTION = "decision_logs";
const RETENTION_DAYS = 7;

export type DecisionOutcome = "ACCEPTED" | "REJECTED";
export type DecisionSource =
  | "burst_scanner"
  | "risk_check"
  | "manual_buy"
  | "webhook"
  | "auto_approve"
  | "liquidator";

/**
 * A single check evaluated during a trade decision.
 * Stored as part of `checks[]` so the full chain is queryable.
 */
export interface DecisionCheck {
  name: string;            // e.g. "min_gain_pct"
  passed: boolean;
  expression: string;      // human-readable, e.g. "gain1h=+3.20% ≥ 3% ✓"
  actual?: number | string;
  threshold?: number | string;
}

export interface DecisionLogRecord {
  source: DecisionSource;
  outcome: DecisionOutcome;
  action: "BUY" | "SELL" | "OTHER";
  symbol: string;
  price?: number;
  reason: string;          // short headline ("RSI ≥ 70 (overbought)" / "passed all filters")
  expression: string;      // one-line readable formula chain
  params?: Record<string, unknown>;
  checks?: DecisionCheck[];
  signalId?: string;
  userId?: string;
}

/**
 * Write a structured trade-decision log entry to Firestore.
 * Fire-and-forget — never blocks the caller, never throws.
 */
export async function logDecision(rec: DecisionLogRecord): Promise<void> {
  try {
    const now = Date.now();
    const expiresAt = Timestamp.fromMillis(now + RETENTION_DAYS * 24 * 60 * 60 * 1000);
    // Strip undefined values — Firestore rejects them (params may have optional fields)
    const safeRec = Object.fromEntries(
      Object.entries({ ...rec, timestamp: FieldValue.serverTimestamp(), expiresAt })
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [
          k,
          v !== null && typeof v === "object" && !Array.isArray(v) && !(v as object).constructor?.name?.includes("Transform")
            ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, vv]) => vv !== undefined))
            : v,
        ])
    );
    await db.collection(COLLECTION).add(safeRec);
  } catch (err) {
    logger.error("[DECISION_LOG] Failed to write", { error: String(err), symbol: rec.symbol });
  }
}

/**
 * Batch variant — used by burstScanner at end-of-run to flush many records in parallel.
 */
export async function logDecisions(recs: DecisionLogRecord[]): Promise<void> {
  if (recs.length === 0) return;
  await Promise.all(recs.map(r => logDecision(r)));
}

export interface QueryDecisionsOpts {
  symbol?: string;
  outcome?: DecisionOutcome;
  source?: DecisionSource;
  sinceMs?: number;        // epoch ms — defaults to 24h ago
  limit?: number;          // defaults to 25
}

export interface DecisionLogResult extends DecisionLogRecord {
  id: string;
  timestamp: Date;
}

/**
 * Query recent decisions for the Telegram /decisions command.
 * If `symbol` is provided, filters by exact match (case-insensitive on canonical form).
 */
export async function queryDecisions(opts: QueryDecisionsOpts = {}): Promise<DecisionLogResult[]> {
  const sinceMs = opts.sinceMs ?? (Date.now() - 24 * 60 * 60 * 1000);
  const limit   = Math.min(opts.limit ?? 25, 100);

  let q = db.collection(COLLECTION)
    .where("timestamp", ">=", Timestamp.fromMillis(sinceMs))
    .orderBy("timestamp", "desc") as FirebaseFirestore.Query;

  if (opts.symbol) {
    q = q.where("symbol", "==", opts.symbol.toUpperCase());
  }
  if (opts.outcome) {
    q = q.where("outcome", "==", opts.outcome);
  }
  if (opts.source) {
    q = q.where("source", "==", opts.source);
  }

  const snap = await q.limit(limit).get();
  return snap.docs.map(d => {
    const data = d.data() as DecisionLogRecord & { timestamp?: Timestamp };
    return {
      id: d.id,
      ...data,
      timestamp: data.timestamp ? data.timestamp.toDate() : new Date(0),
    };
  });
}
