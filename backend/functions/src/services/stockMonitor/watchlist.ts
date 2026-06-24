/**
 * Stock-monitor watchlist. Defaults to a curated set of liquid US large-caps; an
 * optional Firestore doc `monitor_config/stock_watchlist` ({ symbols: string[] })
 * overrides it without a redeploy.
 */

import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

export const DEFAULT_STOCK_WATCHLIST: string[] = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "AVGO", "NFLX",
  "JPM", "V", "MA", "COST", "WMT", "XOM", "JNJ", "UNH", "HD", "DIS",
  "CRM", "ADBE", "INTC", "QCOM", "BA", "PYPL", "UBER", "PLTR", "COIN", "MU",
];

/** Manual override from `monitor_config/stock_watchlist` ({ symbols: [...] }). */
export async function loadStockWatchlistOverride(): Promise<string[] | null> {
  try {
    const snap = await getFirestore().collection("monitor_config").doc("stock_watchlist").get();
    const symbols = snap.data()?.symbols;
    if (Array.isArray(symbols)) {
      const valid = symbols.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map(s => s.toUpperCase());
      if (valid.length > 0) return valid;
    }
  } catch (err) {
    logger.warn("[STOCK_MONITOR] watchlist override read failed", { error: String(err) });
  }
  return null;
}

/** The active stock universe: Firestore override, else the curated default. */
export async function resolveStockWatchlist(): Promise<string[]> {
  return (await loadStockWatchlistOverride()) ?? DEFAULT_STOCK_WATCHLIST;
}
