/**
 * Pluggable strategy selector for the bull/bear trend webhooks.
 *
 * Reads `app_config/strategy.active` from Firestore. Allowed values:
 *   - "trend"      → current strategy: bear collects RSI dips, bull buys on
 *                    a recent dip after CoinGecko category gate.
 *   - "divergence" → bull-divergence alert = immediate buy (gated). Bear-
 *                    divergence alert = liquidate the symbol's position.
 *
 * Cached for 30 s to avoid a Firestore round-trip per webhook hit. Flipping
 * the flag in the Firestore console propagates within the TTL.
 */

import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

export type StrategyName = "trend" | "divergence";

const DEFAULT: StrategyName = "trend";
const TTL_MS = 30_000;

const db = getFirestore();
let cache: { value: StrategyName; expiresAt: number } | null = null;

/** Resolve the currently-active strategy. Defaults to "trend" on any error. */
export async function getActiveStrategy(): Promise<StrategyName> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  try {
    const snap = await db.collection("app_config").doc("strategy").get();
    const raw = String(snap.data()?.active ?? DEFAULT).toLowerCase();
    const value: StrategyName = raw === "divergence" ? "divergence" : "trend";
    cache = { value, expiresAt: Date.now() + TTL_MS };
    return value;
  } catch (err) {
    logger.warn("[STRATEGY_CFG] read failed — defaulting to trend", { error: String(err) });
    return DEFAULT;
  }
}
