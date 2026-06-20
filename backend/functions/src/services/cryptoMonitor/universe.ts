/**
 * Pure universe-eligibility rules for the crypto monitor (no I/O) — shared by the
 * Coinbase-movers fetcher and unit tests.
 */

export const FORBIDDEN_CATEGORY_REGEX = /\b(defi|meme)\b/i;

export const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "DAI", "USDE", "FDUSD", "TUSD", "USDD", "PYUSD", "USDS", "BUSD", "GUSD", "USD",
]);

export interface ResolvedCategory {
  id: string | null;
  categories: string[] | null;
}

/**
 * A mover enters the scored universe only if it is non-stablecoin, has a resolved
 * CoinGecko id, has verifiable categories (fail-closed on unknown), and is not
 * tagged defi/meme.
 */
export function isUniverseEligible(symbol: string, cat: ResolvedCategory): boolean {
  if (!symbol || STABLE_SYMBOLS.has(symbol.toUpperCase())) return false;
  if (!cat.id || cat.categories === null) return false;
  if (cat.categories.some(c => FORBIDDEN_CATEGORY_REGEX.test(c))) return false;
  return true;
}
