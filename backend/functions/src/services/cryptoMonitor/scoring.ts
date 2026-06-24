/**
 * Crypto buy-signal scoring — pure functions, no I/O (unit-testable).
 *
 * Phase 2: full 40-pt spec.
 *   Fundamental (15): market-cap rank + volume growth + DefiLlama TVL growth,
 *                     stablecoin inflows, ecosystem revenue.
 *   News (10):        catalyst classification (positive cap +6, negative −3 each
 *                     floored at −6).
 *   Technical (15):   EMA trend + RSI momentum + pullback + overextension risk.
 *
 * Every rule emits a structured `ScoreCheck` so the Telegram drill-down can show
 * exactly how a coin's score was computed.
 */

import { rsiSeries, emaSeries, lastFinite } from "../ta";

export type Category = "STRONG_BUY" | "WATCHLIST" | "AVOID";

/** A single scored rule. `points` is the score delta (may be 0 or negative). */
export interface ScoreCheck {
  name: string;
  passed: boolean; // true when the rule contributed positively
  points: number;
  expression: string; // human-readable, e.g. "rank 7 (<50) → +3"
  actual?: number | string;
  threshold?: number | string;
  details?: string[]; // supporting items, e.g. matched news headlines
}

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
  // DefiLlama fundamentals — null when the coin has no mapped DeFi ecosystem.
  tvlChange30dPct: number | null;
  stablecoinInflow30dPct: number | null;
  revenueRising: boolean | null;
}

export interface NewsHeadline {
  title: string;
  summary?: string; // optional body/description — used for classification, not display
}

export interface ScoreChecks {
  fundamental: ScoreCheck[];
  news: ScoreCheck[];
  technical: ScoreCheck[];
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
  checks: ScoreChecks;
  newsHeadlines: { title: string; sentiment: Sentiment }[]; // weighed recent news (display)
  newsSentiment: NewsSentiment;
  // --- Scorecard flags consumed by the strategy evaluators ---
  majorBearish: boolean;
  bullishCount: number;
  softBearishCount: number;
  price: number;
  priceAboveEma200: boolean;
  ema50AboveEma200: boolean;
  ema200Rising: boolean;
  nearEma20: boolean; // within 2%
  nearEma50: boolean; // within 3%
  volumeMultiplier: number | null; // 24h volume / 7d avg
  change24hPct: number;
  change7dPct: number;
  marketCapRank: number | null;
}

/** Single source of truth for scoring thresholds. */
export const SCORING = {
  WATCHLIST_MIN: 18, // diagnostic combined category only
  NEAR_EMA20_PCT: 0.02, // price within 2% of EMA20 counts as "near"
  NEAR_EMA50_PCT: 0.03, // price within 3% of EMA50 counts as "near" (pullback)
  // News (4-category): bullish +2 each cap +4, soft-bearish -1 each cap -2,
  // major-bearish sets a block flag (no score penalty — it gates via RISK_BLOCK).
  NEWS_BULLISH_PER: 2,
  NEWS_BULLISH_CAP: 4,
  NEWS_SOFT_BEARISH_PER: -1,
  NEWS_SOFT_BEARISH_CAP: -2,
  EMA200_RISING_LOOKBACK: 24, // hourly bars (~1 day)
};

export type NewsClass = "BULLISH" | "SOFT_BEARISH" | "MAJOR_BEARISH" | "NEUTRAL";

const MAJOR_BEARISH_WORDS = [
  "hack", "hacked", "exploit", "breach", "stolen", "drained", "bridge exploit", "sec ", "lawsuit", "sued",
  "subpoena", "criminal investigation", "delist", "delisting", "chain halt", "halt", "halted", "outage",
  "insolvency", "insolvent", "bankrupt", "bankruptcy", "founder arrest", "arrested", "seized", "token unlock",
  "rug pull", "rugpull", "scam", "fraud",
  // Stock catalysts
  "earnings miss", "misses estimates", "cuts guidance", "guidance cut", "profit warning", "recall", "recalls",
  "data breach", "going concern", "default", "delisted", "antitrust", "probe",
];
const BULLISH_NEWS_WORDS = [
  "etf", "approval", "approved", "partnership", "partners with", "integration", "integrates", "listing",
  "listed", "lists", "upgrade", "mainnet", "institutional", "adoption", "ecosystem fund", "grant", "backed",
  "invests", "investment", "buyback", "all-time high", "record high", "revenue growth", "tvl growth",
  // Stock catalysts
  "earnings beat", "beats estimates", "tops estimates", "raises guidance", "raises forecast", "guidance raise",
  "record revenue", "dividend increase", "acquisition", "acquires", "merger", "price target raised",
  "fda approval", "contract win", "stock split", "outperform",
];
const SOFT_BEARISH_WORDS = [
  "falls", "fall", "selloff", "sell-off", "liquidation", "liquidations", "warns", "warning", "crash",
  "volatility", "bearish", "decline", "declines", "plunge", "plummet", "dump", "slump", "tumble", "drop",
  "fear", "downturn", "correction",
  // Stock catalysts (soft)
  "downgrade", "downgraded", "misses", "cuts forecast", "weak guidance", "disappointing", "slowing", "layoffs",
];

/** Classify a headline into one of four news categories (major-bearish wins). */
export function classifyNews(text: string): NewsClass {
  const t = text.toLowerCase();
  if (MAJOR_BEARISH_WORDS.some(k => t.includes(k))) return "MAJOR_BEARISH";
  if (BULLISH_NEWS_WORDS.some(k => t.includes(k))) return "BULLISH";
  if (SOFT_BEARISH_WORDS.some(k => t.includes(k))) return "SOFT_BEARISH";
  return "NEUTRAL";
}

// Broader sentiment lexicon (display "weigh up" — separate from news scoring).
const BULLISH_WORDS = [
  "surge", "soar", "rally", "jump", "gain", "rise", "rises", "climb", "bull", "bullish", "breakout",
  "record", "all-time high", "ath", "upgrade", "adoption", "inflow", "inflows", "accumulate", "buy",
  "partnership", "integration", "launch", "mainnet", "institutional", "approval", "etf", "listing", "support",
];
const BEARISH_WORDS = [
  "crash", "plunge", "plummet", "dump", "sell-off", "selloff", "slump", "tumble", "drop", "fall", "falls",
  "decline", "bear", "bearish", "breakdown", "hack", "exploit", "lawsuit", "sec", "ban", "delist", "outage",
  "halt", "liquidation", "liquidated", "fraud", "scam", "rug", "outflow", "outflows", "downgrade", "fear", "warning",
];

export type Sentiment = "bullish" | "bearish" | "neutral";

/** Lightweight per-headline sentiment for display weighting. */
export function classifySentiment(text: string): Sentiment {
  const t = text.toLowerCase();
  let bull = 0, bear = 0;
  for (const w of BULLISH_WORDS) if (t.includes(w)) bull++;
  for (const w of BEARISH_WORDS) if (t.includes(w)) bear++;
  if (bull > bear) return "bullish";
  if (bear > bull) return "bearish";
  return "neutral";
}

export type NewsSentiment = "bullish" | "bearish" | "mixed" | "neutral";

/** Weigh tagged headlines into an overall sentiment verdict. */
export function weighSentiment(items: { sentiment: Sentiment }[]): NewsSentiment {
  const bull = items.filter(i => i.sentiment === "bullish").length;
  const bear = items.filter(i => i.sentiment === "bearish").length;
  if (bull === 0 && bear === 0) return "neutral";
  if (bull > 0 && bear > 0 && Math.abs(bull - bear) <= 1) return "mixed";
  if (bull > bear) return "bullish";
  if (bear > bull) return "bearish";
  return "mixed";
}

function check(name: string, points: number, expression: string, extra?: { actual?: number | string; threshold?: number | string }): ScoreCheck {
  return { name, passed: points > 0, points, expression, ...extra };
}

export function scoreFundamental(row: MarketRow): { score: number; checks: ScoreCheck[] } {
  const checks: ScoreCheck[] = [];

  // Market-cap rank
  const rank = row.marketCapRank;
  let rankPts = 0;
  if (rank != null && rank < 50) rankPts = 3;
  else if (rank != null && rank < 100) rankPts = 2;
  else if (rank != null && rank < 200) rankPts = 1;
  checks.push(check("market_cap_rank", rankPts, rank != null ? `rank ${rank} → +${rankPts}` : "rank n/a → +0", { actual: rank ?? "n/a", threshold: "<50/<100/<200" }));

  // Volume growth vs 7d avg
  let volPts = 0;
  let volExpr = "volume 7d avg n/a → +0";
  if (row.volume7dAvg && row.volume7dAvg > 0) {
    const ratio = row.volume24h / row.volume7dAvg;
    if (ratio > 2) volPts = 3;
    else if (ratio > 1.5) volPts = 2;
    volExpr = `volume ${ratio.toFixed(2)}x 7d avg → +${volPts}`;
  }
  checks.push(check("volume_growth", volPts, volExpr, { threshold: ">1.5x/>2x" }));

  // TVL growth (30d) — DefiLlama
  let tvlPts = 0;
  let tvlExpr = "TVL n/a (no DeFi mapping) → +0";
  if (row.tvlChange30dPct != null) {
    if (row.tvlChange30dPct > 20) tvlPts = 3;
    else if (row.tvlChange30dPct > 10) tvlPts = 2;
    tvlExpr = `TVL ${row.tvlChange30dPct >= 0 ? "+" : ""}${row.tvlChange30dPct.toFixed(1)}% 30d → +${tvlPts}`;
  }
  checks.push(check("tvl_growth_30d", tvlPts, tvlExpr, { actual: row.tvlChange30dPct ?? "n/a", threshold: ">10%/>20%" }));

  // Stablecoin inflows (30d) — DefiLlama (chains)
  let stblPts = 0;
  let stblExpr = "stablecoin inflow n/a → +0";
  if (row.stablecoinInflow30dPct != null) {
    if (row.stablecoinInflow30dPct > 10) stblPts = 3;
    else if (row.stablecoinInflow30dPct > 0) stblPts = 2;
    stblExpr = `stablecoin inflow ${row.stablecoinInflow30dPct >= 0 ? "+" : ""}${row.stablecoinInflow30dPct.toFixed(1)}% 30d → +${stblPts}`;
  }
  checks.push(check("stablecoin_inflow_30d", stblPts, stblExpr, { actual: row.stablecoinInflow30dPct ?? "n/a", threshold: ">0%/>10%" }));

  // Ecosystem revenue trend — DefiLlama (fees/revenue)
  let revPts = 0;
  let revExpr = "revenue n/a → +0";
  if (row.revenueRising != null) {
    revPts = row.revenueRising ? 2 : 0;
    revExpr = `revenue ${row.revenueRising ? "rising" : "flat/declining"} → +${revPts}`;
  }
  checks.push(check("ecosystem_revenue", revPts, revExpr));

  const score = checks.reduce((s, c) => s + c.points, 0);
  return { score, checks };
}

export function scoreNews(headlines: NewsHeadline[]): {
  score: number; checks: ScoreCheck[]; majorBearish: boolean; bullishCount: number; softBearishCount: number;
} {
  const bullish: string[] = [];
  const soft: string[] = [];
  const major: string[] = [];
  for (const h of headlines) {
    const c = classifyNews(`${h.title} ${h.summary ?? ""}`);
    if (c === "MAJOR_BEARISH") major.push(h.title);
    else if (c === "BULLISH") bullish.push(h.title);
    else if (c === "SOFT_BEARISH") soft.push(h.title);
  }

  const bullScore = Math.min(bullish.length * SCORING.NEWS_BULLISH_PER, SCORING.NEWS_BULLISH_CAP);
  const softScore = Math.max(soft.length * SCORING.NEWS_SOFT_BEARISH_PER, SCORING.NEWS_SOFT_BEARISH_CAP);
  const score = bullScore + softScore; // major-bearish does NOT subtract; it blocks via RISK_BLOCK
  const majorBearish = major.length > 0;

  const checks: ScoreCheck[] = [
    {
      ...check("bullish_news", bullScore, `${bullish.length} bullish${bullish.length ? ` (${bullish.slice(0, 2).join("; ").slice(0, 80)})` : ""} → +${bullScore}`, { actual: bullish.length, threshold: `+2 ea, cap +${SCORING.NEWS_BULLISH_CAP}` }),
      details: bullish.slice(0, 5),
    },
    {
      name: "soft_bearish_news",
      passed: soft.length === 0,
      points: softScore,
      expression: `${soft.length} soft-bearish${soft.length ? ` (${soft.slice(0, 2).join("; ").slice(0, 80)})` : ""} → ${softScore}`,
      actual: soft.length,
      threshold: `-1 ea, cap ${SCORING.NEWS_SOFT_BEARISH_CAP}`,
      details: soft.slice(0, 5),
    },
    {
      name: "major_bearish",
      passed: !majorBearish,
      points: 0,
      expression: majorBearish ? `MAJOR bearish: ${major.slice(0, 2).join("; ").slice(0, 80)} → blocks buy alerts` : "no major bearish news",
      actual: major.length,
      details: major.slice(0, 5),
    },
  ];

  return { score, checks, majorBearish, bullishCount: bullish.length, softBearishCount: soft.length };
}

export function scoreTechnical(candles: Candle[], row: MarketRow): {
  score: number; checks: ScoreCheck[];
  rsi: number | null; ema20: number | null; ema50: number | null; ema200: number | null;
} {
  const checks: ScoreCheck[] = [];
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

  // Trend
  const aboveEma200 = ema200 != null && price > ema200;
  checks.push(check("price_above_ema200", aboveEma200 ? 3 : 0, ema200 != null ? `price ${price.toFixed(4)} ${aboveEma200 ? ">" : "≤"} EMA200 ${ema200.toFixed(4)} → +${aboveEma200 ? 3 : 0}` : "EMA200 n/a → +0"));

  const goldenCross = ema50 != null && ema200 != null && ema50 > ema200;
  checks.push(check("ema50_above_ema200", goldenCross ? 3 : 0, ema50 != null && ema200 != null ? `EMA50 ${ema50.toFixed(4)} ${goldenCross ? ">" : "≤"} EMA200 ${ema200.toFixed(4)} → +${goldenCross ? 3 : 0}` : "EMA50/200 n/a → +0"));

  let risingPts = 0;
  let risingExpr = "EMA200 rising n/a → +0";
  if (ema200 != null) {
    const idx = ema200arr.length - 1;
    const prior = idx - SCORING.EMA200_RISING_LOOKBACK >= 0 ? ema200arr[idx - SCORING.EMA200_RISING_LOOKBACK] : NaN;
    if (Number.isFinite(prior)) {
      const rising = ema200 > prior;
      risingPts = rising ? 2 : 0;
      risingExpr = `EMA200 ${rising ? "rising" : "flat/falling"} (vs ${SCORING.EMA200_RISING_LOOKBACK}h ago) → +${risingPts}`;
    }
  }
  checks.push(check("ema200_rising", risingPts, risingExpr));

  // Momentum
  let rsiPts = 0;
  let rsiExpr = "RSI n/a → +0";
  if (rsi != null) {
    if (rsi >= 40 && rsi <= 65) rsiPts = 2;
    else if (rsi > 65 && rsi <= 75) rsiPts = 1;
    else if (rsi > 80) rsiPts = -3;
    rsiExpr = `RSI ${rsi.toFixed(0)} → ${rsiPts >= 0 ? "+" : ""}${rsiPts}`;
  }
  checks.push(check("rsi_momentum", rsiPts, rsiExpr, { actual: rsi ?? "n/a" }));

  // Pullback entry (independent, per spec)
  const nearEma20 = ema20 != null && price > 0 && Math.abs(price - ema20) / ema20 <= SCORING.NEAR_EMA20_PCT;
  checks.push(check("pullback_near_ema20", nearEma20 ? 2 : 0, ema20 != null ? `price ${nearEma20 ? "near" : "off"} EMA20 → +${nearEma20 ? 2 : 0}` : "EMA20 n/a → +0"));
  const nearEma50 = ema50 != null && price > 0 && Math.abs(price - ema50) / ema50 <= SCORING.NEAR_EMA50_PCT;
  checks.push(check("pullback_near_ema50", nearEma50 ? 3 : 0, ema50 != null ? `price ${nearEma50 ? "near" : "off"} EMA50 → +${nearEma50 ? 3 : 0}` : "EMA50 n/a → +0"));

  // Overextension risk
  const risk24 = row.change24hPct > 20 ? -3 : 0;
  checks.push(check("risk_24h", risk24, `24h ${row.change24hPct >= 0 ? "+" : ""}${row.change24hPct.toFixed(0)}% → ${risk24}`, { actual: row.change24hPct, threshold: ">20%" }));
  const risk7 = row.change7dPct > 40 ? -2 : 0;
  checks.push(check("risk_7d", risk7, `7d ${row.change7dPct >= 0 ? "+" : ""}${row.change7dPct.toFixed(0)}% → ${risk7}`, { actual: row.change7dPct, threshold: ">40%" }));

  const score = checks.reduce((s, c) => s + c.points, 0);
  return { score, checks, rsi, ema20, ema50, ema200 };
}

/** Diagnostic combined band only — actionable alerts come from the strategies. */
export function classify(fundamental: number, technical: number, total: number, majorBearish: boolean): Category {
  if (total >= 22 && fundamental >= 3 && technical >= 9 && !majorBearish) return "STRONG_BUY";
  if (total >= SCORING.WATCHLIST_MIN) return "WATCHLIST";
  return "AVOID";
}

const checkOn = (checks: ScoreCheck[], name: string): boolean => (checks.find(c => c.name === name)?.points ?? 0) > 0;

/** Combine all three score blocks into a full scorecard (consumed by strategies). */
export function scoreCoin(candles: Candle[], row: MarketRow, headlines: NewsHeadline[]): ScoreResult {
  const f = scoreFundamental(row);
  const n = scoreNews(headlines);
  const t = scoreTechnical(candles, row);

  const total = f.score + n.score + t.score;
  const category = classify(f.score, t.score, total, n.majorBearish);
  const price = candles.length ? candles[candles.length - 1].close : 0;

  const checks: ScoreChecks = { fundamental: f.checks, news: n.checks, technical: t.checks };
  const reasons = [...f.checks, ...n.checks, ...t.checks].filter(c => c.points > 0).map(c => c.expression);
  const risks = [...t.checks, ...n.checks].filter(c => c.points < 0).map(c => c.expression);

  // Weigh all recent headlines (not just catalysts) for the display.
  const newsHeadlines = headlines.map(h => ({ title: h.title, sentiment: classifySentiment(`${h.title} ${h.summary ?? ""}`) }));
  const newsSentiment = weighSentiment(newsHeadlines);

  const volumeMultiplier = row.volume7dAvg && row.volume7dAvg > 0 ? row.volume24h / row.volume7dAvg : null;

  return {
    fundamental: f.score,
    news: n.score,
    technical: t.score,
    total,
    category,
    reasons,
    risks,
    hasMajorNegativeNews: n.majorBearish,
    rsi: t.rsi,
    ema20: t.ema20,
    ema50: t.ema50,
    ema200: t.ema200,
    checks,
    newsHeadlines,
    newsSentiment,
    majorBearish: n.majorBearish,
    bullishCount: n.bullishCount,
    softBearishCount: n.softBearishCount,
    price,
    priceAboveEma200: checkOn(t.checks, "price_above_ema200"),
    ema50AboveEma200: checkOn(t.checks, "ema50_above_ema200"),
    ema200Rising: checkOn(t.checks, "ema200_rising"),
    nearEma20: checkOn(t.checks, "pullback_near_ema20"),
    nearEma50: checkOn(t.checks, "pullback_near_ema50"),
    volumeMultiplier,
    change24hPct: row.change24hPct,
    change7dPct: row.change7dPct,
    marketCapRank: row.marketCapRank,
  };
}
