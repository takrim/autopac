import { isUniverseEligible, FORBIDDEN_CATEGORY_REGEX } from "../src/services/cryptoMonitor/universe";

const cat = (id: string | null, categories: string[] | null) => ({ id, categories });

describe("isUniverseEligible", () => {
  const layer1 = cat("solana", ["Layer 1 (L1)", "Smart Contract Platform"]);

  test("normal coin with resolved id + safe categories is eligible", () => {
    expect(isUniverseEligible("SOL", layer1)).toBe(true);
  });

  test("stablecoins are excluded", () => {
    expect(isUniverseEligible("USDC", cat("usd-coin", ["Stablecoins"]))).toBe(false);
    expect(isUniverseEligible("DAI", cat("dai", ["Stablecoins"]))).toBe(false);
  });

  test("missing CoinGecko id is excluded", () => {
    expect(isUniverseEligible("XYZ", cat(null, ["Layer 1 (L1)"]))).toBe(false);
  });

  test("unverifiable categories are excluded (fail-closed)", () => {
    expect(isUniverseEligible("XYZ", cat("xyz", null))).toBe(false);
  });

  test("defi coins are excluded", () => {
    expect(isUniverseEligible("AAVE", cat("aave", ["Decentralized Finance (DeFi)", "Lending/Borrowing"]))).toBe(false);
    expect(isUniverseEligible("UNI", cat("uniswap", ["DeFi", "Decentralized Exchange (DEX)"]))).toBe(false);
  });

  test("meme coins are excluded", () => {
    expect(isUniverseEligible("DOGE", cat("dogecoin", ["Meme"]))).toBe(false);
  });

  test("empty symbol is excluded", () => {
    expect(isUniverseEligible("", layer1)).toBe(false);
  });
});

describe("FORBIDDEN_CATEGORY_REGEX", () => {
  test("matches defi/meme tags (case-insensitive, word-bounded)", () => {
    expect(FORBIDDEN_CATEGORY_REGEX.test("Decentralized Finance (DeFi)")).toBe(true);
    expect(FORBIDDEN_CATEGORY_REGEX.test("Meme")).toBe(true);
    expect(FORBIDDEN_CATEGORY_REGEX.test("Smart Contract Platform")).toBe(false);
    expect(FORBIDDEN_CATEGORY_REGEX.test("Layer 1 (L1)")).toBe(false);
  });
});
