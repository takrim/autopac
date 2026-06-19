/**
 * Crypto buy-signal scoring — pure functions, no I/O (unit-testable).
 *
 * MVP scope: technical (full) + CoinGecko fundamentals (rank + volume growth)
 * + Google-News sentiment. DefiLlama TVL/stablecoin/revenue are deferred, which
 * caps the fundamental block at 6 (vs the spec's 15), so the category thresholds
 * below are PROVISIONAL.
 *
 * TODO(phase2): once DefiLlama fundamentals land (restoring fundamental max 15
 * and total max 40), revert STRONG_BUY to the spec gate (total ≥ 25,
 * fundamental ≥ 8, technical ≥ 8) and WATCHLIST 18–24.
 */

import { rsiSeries, emaSeries, lastFinite } from "../ta";

export type Category = "STRONG_BUY" | "WATCHLIST" | "AVOID";

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  start?: number;
}

export interface MarketRow {
  marketCapRank: number | null;
  volume24h: number; // USD
  volume7dAvg: number | null; // avg daily USD volume over 7d
  change24hPct: number; // %
  change7dPct: number; // %
}

export interface NewsHeadline {
  sentiment: "bullish" | "bearish" | "neutral";
  title: string;
}

export interface ScoreResult {
  fundamental: number;
  news: number;
  technical: number;
  total: number;
  category: Category;
  reasons: string[];
  risks: string[];
  hasMajorNegativeNews: boolean;
  rsi: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
}

/** Single source of truth for thresholds — provisional MVP values (see file header). */
export const SCORING = {
  STRONG_BUY: { total: 20, technical: 9, fundamental: 4 },
  WATCHLIST_MIN: 14,
  NEAR_EMA_PCT: 0.02, // price within 2% of an EMA counts as "near"
  NEWS_POSITIVE_PER: 2,
  NEWS_POSITIVE_CAP: 6,
  NEWS_NEGATIVE_PER: 3,
  EMA200_RISING_LOOKBACK: 24, // hourly bars (~1 day)
};

export function scoreFundamental(row: MarketRow): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const rank = row.marketCapRank;
  if (rank != null && rank < 50) { score += 3; reasons.push(`Market-cap rank ${rank} (<50)`); }
  else if (rank != null && rank < 100) { score += 2; reasons.push(`Market-cap rank ${rank} (<100)`); }
  else if (rank != null && rank < 200) { score += 1; reasons.push(`Market-cap rank ${rank} (<200)`); }

  if (row.volume7dAvg && row.volume7dAvg > 0) {
    const ratio = row.volume24h / row.volume7dAvg;
    if (ratio > 2) { score += 3; reasons.push(`Volume ${ratio.toFixed(1)}x 7-day average`); }
    else if (ratio > 1.5) { score += 2; reasons.push(`Volume ${ratio.toFixed(1)}x 7-day average`); }
  }
  return { score, reasons };
}

export function scoreNews(headlines: NewsHeadline[]): {
  score: number; reasons: string[]; risks: string[]; hasMajorNegative: boolean;
} {
  let positives = 0;
  let negatives = 0;
  for (const h of headlines) {
    if (h.sentiment === "bullish") positives++;
    else if (h.sentiment === "bearish") negatives++;
  }
  let score = Math.min(positives * SCORING.NEWS_POSITIVE_PER, SCORING.NEWS_POSITIVE_CAP);
  score -= negatives * SCORING.NEWS_NEGATIVE_PER;

  const reasons: string[] = [];
  const risks: string[] = [];
  if (positives > 0) reasons.push(`${positives} positive headline${positives > 1 ? "s" : ""}`);
  if (negatives > 0) risks.push(`${negatives} negative headline${negatives > 1 ? "s" : ""}`);
  return { score, reasons, risks, hasMajorNegative: negatives > 0 };
}

export function scoreTechnical(candles: Candle[], row: MarketRow): {
  score: number; reasons: string[]; risks: string[];
  rsi: number | null; ema20: number | null; ema50: number | null; ema200: number | null;
} {
  const reasons: string[] = [];
  const risks: string[] = [];
  const closes = candles.map(c => c.close);
  const price = closes.length ? closes[closes.length - 1] : 0;

  const ema20arr = emaSeries(closes, 20);
  const ema50arr = emaSeries(closes, 50);
  const ema200arr = emaSeries(closes, 200);
  const rsiArr = rsiSeries(closes, 14);

  const ema20 = lastFinite(ema20arr);
  const ema50 = lastFinite(ema50arr);
  const ema200 = lastFinite(ema200arr);
  const rsi = lastFinite(rsiArr);

  let score = 0;

  // Trend
  if (ema200 != null && price > ema200) { score += 3; reasons.push("Price above EMA200"); }
  if (ema50 != null && ema200 != null && ema50 > ema200) { score += 3; reasons.push("EMA50 above EMA200"); }
  if (ema200 != null) {
    const idx = ema200arr.length - 1;
    const priorIdx = idx - SCORING.EMA200_RISING_LOOKBACK;
    const prior = priorIdx >= 0 ? ema200arr[priorIdx] : NaN;
    if (Number.isFinite(prior) && ema200 > prior) { score += 2; reasons.push("EMA200 rising"); }
  }

  // Momentum
  if (rsi != null) {
    if (rsi >= 40 && rsi <= 65) { score += 2; reasons.push(`RSI ${rsi.toFixed(0)} (40–65)`); }
    else if (rsi > 65 && rsi <= 75) { score += 1; reasons.push(`RSI ${rsi.toFixed(0)} (65–75)`); }
    else if (rsi > 80) { score -= 3; risks.push(`RSI ${rsi.toFixed(0)} overbought (>80)`); }
  }

  // Pullback entry (independent, per spec)
  if (ema20 != null && price > 0 && Math.abs(price - ema20) / ema20 <= SCORING.NEAR_EMA_PCT) {
    score += 2; reasons.push("Pullback near EMA20");
  }
  if (ema50 != null && price > 0 && Math.abs(price - ema50) / ema50 <= SCORING.NEAR_EMA_PCT) {
    score += 3; reasons.push("Pullback near EMA50");
  }

  // Risk (overextended)
  if (row.change24hPct > 20) { score -= 3; risks.push(`Up ${row.change24hPct.toFixed(0)}% in 24h`); }
  if (row.change7dPct > 40) { score -= 2; risks.push(`Up ${row.change7dPct.toFixed(0)}% in 7d`); }

  return { score, reasons, risks, rsi, ema20, ema50, ema200 };
}

export function classify(fundamental: number, technical: number, total: number, hasMajorNegativeNews: boolean): Category {
  if (
    total >= SCORING.STRONG_BUY.total &&
    technical >= SCORING.STRONG_BUY.technical &&
    fundamental >= SCORING.STRONG_BUY.fundamental &&
    !hasMajorNegativeNews
  ) return "STRONG_BUY";
  if (total >= SCORING.WATCHLIST_MIN) return "WATCHLIST";
  return "AVOID";
}

/** Combine all three score blocks into a single result. */
export function scoreCoin(candles: Candle[], row: MarketRow, headlines: NewsHeadline[]): ScoreResult {
  const f = scoreFundamental(row);
  const n = scoreNews(headlines);
  const t = scoreTechnical(candles, row);

  const total = f.score + n.score + t.score;
  const category = classify(f.score, t.score, total, n.hasMajorNegative);

  return {
    fundamental: f.score,
    news: n.score,
    technical: t.score,
    total,
    category,
    reasons: [...f.reasons, ...n.reasons, ...t.reasons],
    risks: [...t.risks, ...n.risks],
    hasMajorNegativeNews: n.hasMajorNegative,
    rsi: t.rsi,
    ema20: t.ema20,
    ema50: t.ema50,
    ema200: t.ema200,
  };
}
