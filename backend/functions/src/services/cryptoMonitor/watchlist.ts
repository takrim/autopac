/**
 * Crypto-monitor watchlist. Defaults to a curated, Coinbase-tradable set; an
 * optional Firestore doc `monitor_config/watchlist` ({ coins: WatchCoin[] }) can
 * override it without a redeploy.
 */

import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

export interface WatchCoin {
  symbol: string; // display, e.g. "SOL"
  coinbaseProductId: string; // "SOL-USD"
  coingeckoId: string; // "solana"
}

export const DEFAULT_WATCHLIST: WatchCoin[] = [
  { symbol: "BTC", coinbaseProductId: "BTC-USD", coingeckoId: "bitcoin" },
  { symbol: "ETH", coinbaseProductId: "ETH-USD", coingeckoId: "ethereum" },
  { symbol: "SOL", coinbaseProductId: "SOL-USD", coingeckoId: "solana" },
  { symbol: "LINK", coinbaseProductId: "LINK-USD", coingeckoId: "chainlink" },
  { symbol: "SUI", coinbaseProductId: "SUI-USD", coingeckoId: "sui" },
  { symbol: "AVAX", coinbaseProductId: "AVAX-USD", coingeckoId: "avalanche-2" },
  { symbol: "NEAR", coinbaseProductId: "NEAR-USD", coingeckoId: "near" },
  { symbol: "AAVE", coinbaseProductId: "AAVE-USD", coingeckoId: "aave" },
  { symbol: "UNI", coinbaseProductId: "UNI-USD", coingeckoId: "uniswap" },
  { symbol: "ARB", coinbaseProductId: "ARB-USD", coingeckoId: "arbitrum" },
  { symbol: "OP", coinbaseProductId: "OP-USD", coingeckoId: "optimism" },
  { symbol: "INJ", coinbaseProductId: "INJ-USD", coingeckoId: "injective-protocol" },
];

function isValidCoin(c: unknown): c is WatchCoin {
  const o = c as Record<string, unknown>;
  return !!o && typeof o.symbol === "string" && typeof o.coinbaseProductId === "string" && typeof o.coingeckoId === "string";
}

/** Load the active watchlist (Firestore override, else the default constant). */
export async function loadWatchlist(): Promise<WatchCoin[]> {
  try {
    const snap = await getFirestore().collection("monitor_config").doc("watchlist").get();
    const coins = snap.data()?.coins;
    if (Array.isArray(coins)) {
      const valid = coins.filter(isValidCoin);
      if (valid.length > 0) return valid;
    }
  } catch (err) {
    logger.warn("[CRYPTO_MONITOR] watchlist override read failed — using default", { error: String(err) });
  }
  return DEFAULT_WATCHLIST;
}
