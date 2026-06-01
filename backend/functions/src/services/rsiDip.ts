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
    // do not have `exchange`. Re-probe Alpaca-first instead of guessing
    // coinbase (would misroute stock tickers like AAPL to Coinbase).
    if (data.exchange !== "alpaca" && data.exchange !== "coinbase") {
      const probed = await resolveExchangeForSymbol(id);
      if (!probed) {
        logger.warn("[RSI_DIP] legacy dip with no exchange and no probe match; skipping", { symbol: id });
        return null;
      }
      data.exchange = probed;
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
    const needsProbe: { idx: number; symbol: string }[] = [];
    snap.forEach(doc => {
      const d = doc.data() as RsiDipDoc;
      if (!d || !d.dipAt) return;
      const knownExchange: "alpaca" | "coinbase" | null =
        d.exchange === "alpaca" || d.exchange === "coinbase" ? d.exchange : null;
      const idx = out.length;
      out.push({
        symbol: d.symbol || doc.id,
        ageMs: now - d.dipAt.toMillis(),
        price: d.price ?? null,
        rsi: d.rsi ?? null,
        // Tentative; replaced below for legacy docs once we probe.
        exchange: knownExchange || "coinbase",
      });
      if (!knownExchange) needsProbe.push({ idx, symbol: d.symbol || doc.id });
    });
    // Re-probe legacy docs in parallel rather than blanket-defaulting to coinbase
    // (would misroute stock tickers).
    if (needsProbe.length) {
      const probed = await Promise.all(needsProbe.map((p) => resolveExchangeForSymbol(p.symbol)));
      const filteredIdxs = new Set<number>();
      needsProbe.forEach((p, i) => {
        const ex = probed[i];
        if (!ex) {
          filteredIdxs.add(p.idx);
        } else {
          out[p.idx].exchange = ex;
        }
      });
      if (filteredIdxs.size) {
        logger.warn("[RSI_DIP] dropped legacy dips with no probe match", { count: filteredIdxs.size });
      }
      // Drop the unresolvable ones (filter preserves order).
      for (let i = out.length - 1; i >= 0; i--) {
        if (filteredIdxs.has(i)) out.splice(i, 1);
      }
    }
    out.sort((a, b) => a.ageMs - b.ageMs);
    return out;
  } catch (err) {
    logger.warn("[RSI_DIP] listRecentRsiDips failed", { error: String(err) });
    return [];
  }
}
