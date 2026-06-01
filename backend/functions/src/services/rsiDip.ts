/**
 * RSI Dip collector — bridge between the beartrend webhook (which records
 * dips) and the bulltrend webhook (which requires a recent dip before buying).
 *
 * Storage: `rsi_dips` Firestore collection. Doc id = uppercase symbol.
 * Newest dip per symbol overwrites the prior one.
 */

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { getBroker } from "../brokers";

const db = getFirestore();
const COLL = "rsi_dips";

/**
 * Probe Alpaca first, then Coinbase. Returns the first exchange the symbol
 * exists on, or null if neither carries it.
 */
export async function resolveExchangeForSymbol(
  symbol: string,
): Promise<"alpaca" | "coinbase" | null> {
  try {
    const alpaca = getBroker("alpaca");
    if (alpaca.assetExists && await alpaca.assetExists(symbol)) return "alpaca";
  } catch (err) {
    logger.warn("[RSI_DIP] alpaca probe failed", { symbol, err: String(err) });
  }
  try {
    const coinbase = getBroker("coinbase");
    if (coinbase.assetExists && await coinbase.assetExists(symbol)) return "coinbase";
  } catch (err) {
    logger.warn("[RSI_DIP] coinbase probe failed", { symbol, err: String(err) });
  }
  return null;
}

export interface RsiDipDoc {
  symbol: string;
  price: number | null;
  rsi: number | null;
  cgId: string | null;
  categories: string[];
  /** Exchange where this symbol is tradeable. Alpaca is probed first, Coinbase is fallback. */
  exchange: "alpaca" | "coinbase";
  dipAt: Timestamp;
  lastBeartrendId: string | null;
}

/** Upsert dip row for `symbol`; doc id = uppercase symbol. */
export async function recordRsiDip(
  symbol: string,
  payload: { price: number | null; rsi: number | null; beartrendId: string | null },
  cgId: string | null,
  categories: string[],
  exchange: "alpaca" | "coinbase",
): Promise<string> {
  const id = symbol.toUpperCase();
  await db.collection(COLL).doc(id).set({
    symbol: id,
    price: payload.price,
    rsi: payload.rsi,
    cgId,
    categories,
    exchange,
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
    // Backfill: dips written before the per-symbol exchange routing feature
    // do not have `exchange`; treat them as coinbase.
    if (data.exchange !== "alpaca" && data.exchange !== "coinbase") {
      data.exchange = "coinbase";
    }
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
): Promise<{ symbol: string; ageMs: number; price: number | null; rsi: number | null; exchange: "alpaca" | "coinbase" }[]> {
  try {
    const cutoff = Timestamp.fromMillis(Date.now() - withinMs);
    const snap = await db.collection(COLL).where("dipAt", ">=", cutoff).get();
    const now = Date.now();
    const out: { symbol: string; ageMs: number; price: number | null; rsi: number | null; exchange: "alpaca" | "coinbase" }[] = [];
    snap.forEach(doc => {
      const d = doc.data() as RsiDipDoc;
      if (!d || !d.dipAt) return;
      const exchange: "alpaca" | "coinbase" =
        d.exchange === "alpaca" || d.exchange === "coinbase" ? d.exchange : "coinbase";
      out.push({
        symbol: d.symbol || doc.id,
        ageMs: now - d.dipAt.toMillis(),
        price: d.price ?? null,
        rsi: d.rsi ?? null,
        exchange,
      });
    });
    out.sort((a, b) => a.ageMs - b.ageMs);
    return out;
  } catch (err) {
    logger.warn("[RSI_DIP] listRecentRsiDips failed", { error: String(err) });
    return [];
  }
}
