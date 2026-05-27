/**
 * Symbol-set caches for the burst scanner (notOnCoinbase, forbidden-categories, …).
 *
 * Stored shape in Firestore:
 *   { symbols: { "SYM-USD": <unix-ms-timestamp>, … } }
 *
 * IMPORTANT: writes MUST use a nested object — `set({ symbols: { K: V } }, { merge: true })` —
 * NOT dotted keys. Firestore's `set({merge:true})` treats top-level object keys as literal
 * field names (so `{"symbols.K": v}` creates a flat field named "symbols.K" instead of a
 * nested map). Tests in `burstScannerCache.test.ts` lock this in.
 */

import { logger } from "firebase-functions/v2";
import type { DocumentReference } from "firebase-admin/firestore";

/** Detects the "no candle data" entry-signal skip reason used to mark a symbol as not-on-Coinbase. */
export const ZERO_CANDLES_SKIP_REGEX = /RSI unavailable on 3m and 5m \(only 0 /;

/**
 * Load a symbol cache. Expired entries are GC'd lazily (the full `symbols` map is rewritten
 * with only the surviving keys, so deletes don't rely on dotted-key field paths).
 */
export async function loadSymbolCache(
  doc: DocumentReference,
  ttlMs: number,
  label: string,
): Promise<Set<string>> {
  try {
    const snap = await doc.get();
    if (!snap.exists) return new Set();
    const symbols = (snap.data()?.symbols ?? {}) as Record<string, number>;
    const now = Date.now();
    const valid = new Set<string>();
    const remaining: Record<string, number> = {};
    let expiredCount = 0;
    for (const [sym, ts] of Object.entries(symbols)) {
      if (typeof ts === "number" && now - ts < ttlMs) {
        valid.add(sym);
        remaining[sym] = ts;
      } else {
        expiredCount++;
      }
    }
    if (expiredCount > 0) {
      await doc.set({ symbols: remaining }).catch(() => {});
    }
    return valid;
  } catch (err) {
    logger.warn(`[BURST] Failed to load ${label} cache (non-fatal)`, { error: String(err) });
    return new Set();
  }
}

/**
 * Append symbols to a cache (timestamp = now). Uses nested-object write so the merge
 * correctly targets the `symbols` map instead of creating literal "symbols.<KEY>" fields.
 */
export async function addToSymbolCache(
  doc: DocumentReference,
  symbols: string[],
  label: string,
): Promise<void> {
  if (symbols.length === 0) return;
  try {
    const now = Date.now();
    const nested: Record<string, number> = {};
    for (const s of symbols) nested[s] = now;
    await doc.set({ symbols: nested }, { merge: true });
  } catch (err) {
    logger.warn(`[BURST] Failed to update ${label} cache (non-fatal)`, { error: String(err) });
  }
}
