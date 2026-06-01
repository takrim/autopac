/**
 * RSI Dip collector — bridge between the beartrend webhook (which records
 * dips) and the bulltrend webhook (which requires a recent dip before buying).
 *
 * Storage: `rsi_dips` Firestore collection. Doc id = uppercase symbol.
 * Newest dip per symbol overwrites the prior one.
 */

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

const db = getFirestore();
const COLL = "rsi_dips";

export interface RsiDipDoc {
  symbol: string;
  price: number | null;
  rsi: number | null;
  cgId: string | null;
  categories: string[];
  dipAt: Timestamp;
  lastBeartrendId: string | null;
}

/** Upsert dip row for `symbol`; doc id = uppercase symbol. */
export async function recordRsiDip(
  symbol: string,
  payload: { price: number | null; rsi: number | null; beartrendId: string | null },
  cgId: string | null,
  categories: string[],
): Promise<string> {
  const id = symbol.toUpperCase();
  await db.collection(COLL).doc(id).set({
    symbol: id,
    price: payload.price,
    rsi: payload.rsi,
    cgId,
    categories,
    dipAt: FieldValue.serverTimestamp(),
    lastBeartrendId: payload.beartrendId,
  });
  return id;
}

/**
 * Look up the most recent dip for `symbol` and return it only if `dipAt`
 * is within `withinMs` of now. Returns `null` if missing or stale.
 */
export async function getRecentRsiDip(
  symbol: string,
  withinMs: number,
): Promise<{ data: RsiDipDoc; ageMs: number } | null> {
  const id = symbol.toUpperCase();
  try {
    const snap = await db.collection(COLL).doc(id).get();
    if (!snap.exists) return null;
    const data = snap.data() as RsiDipDoc | undefined;
    if (!data || !data.dipAt) return null;
    const dipMs = data.dipAt.toMillis();
    const ageMs = Date.now() - dipMs;
    if (ageMs > withinMs) return null;
    return { data, ageMs };
  } catch (err) {
    logger.warn("[RSI_DIP] getRecentRsiDip failed", { symbol: id, error: String(err) });
    return null;
  }
}

/**
 * Return all dips whose `dipAt` is within `withinMs` of now, newest first.
 * Used by the liquidator heartbeat to surface currently-armed buy candidates.
 */
export async function listRecentRsiDips(
  withinMs: number,
): Promise<{ symbol: string; ageMs: number; price: number | null; rsi: number | null }[]> {
  try {
    const cutoff = Timestamp.fromMillis(Date.now() - withinMs);
    const snap = await db.collection(COLL).where("dipAt", ">=", cutoff).get();
    const now = Date.now();
    const out: { symbol: string; ageMs: number; price: number | null; rsi: number | null }[] = [];
    snap.forEach(doc => {
      const d = doc.data() as RsiDipDoc;
      if (!d || !d.dipAt) return;
      out.push({
        symbol: d.symbol || doc.id,
        ageMs: now - d.dipAt.toMillis(),
        price: d.price ?? null,
        rsi: d.rsi ?? null,
      });
    });
    out.sort((a, b) => a.ageMs - b.ageMs);
    return out;
  } catch (err) {
    logger.warn("[RSI_DIP] listRecentRsiDips failed", { error: String(err) });
    return [];
  }
}
