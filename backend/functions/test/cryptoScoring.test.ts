import {
  scoreFundamental,
  scoreNews,
  scoreTechnical,
  classify,
  classifyCatalyst,
  scoreCoin,
  SCORING,
  Candle,
  MarketRow,
  NewsHeadline,
  ScoreCheck,
} from "../src/services/cryptoMonitor/scoring";

const baseRow: MarketRow = {
  marketCapRank: 500,
  volume24h: 0,
  volume7dAvg: null,
  change24hPct: 0,
  change7dPct: 0,
  tvlChange30dPct: null,
  stablecoinInflow30dPct: null,
  revenueRising: null,
};

const sumPoints = (checks: ScoreCheck[]) => checks.reduce((s, c) => s + c.points, 0);

/** Build closes: `up` linear-rising bars, then `pull` bars retracing `pullPct`. */
function buildSeries(up: number, start: number, step: number, pull: number, pullPct: number): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < up; i++) closes.push(start + i * step);
  const peak = closes[closes.length - 1];
  for (let i = 1; i <= pull; i++) closes.push(peak * (1 - (pullPct * i) / pull));
  return closes.map((c) => ({ open: c, high: c, low: c, close: c, volume: 1 }));
}

const h = (title: string): NewsHeadline => ({ title });

describe("scoreFundamental", () => {
  test("rank tiers", () => {
    expect(scoreFundamental({ ...baseRow, marketCapRank: 10 }).score).toBe(3);
    expect(scoreFundamental({ ...baseRow, marketCapRank: 80 }).score).toBe(2);
    expect(scoreFundamental({ ...baseRow, marketCapRank: 150 }).score).toBe(1);
    expect(scoreFundamental({ ...baseRow, marketCapRank: 500 }).score).toBe(0);
  });

  test("volume + TVL + stablecoin + revenue stack", () => {
    const r = scoreFundamental({
      ...baseRow,
      marketCapRank: 10, // +3
      volume24h: 210, volume7dAvg: 100, // 2.1x → +3
      tvlChange30dPct: 25, // +3
      stablecoinInflow30dPct: 12, // +3
      revenueRising: true, // +2
    });
    expect(r.score).toBe(14);
    expect(sumPoints(r.checks)).toBe(r.score);
  });

  test("DefiLlama components are 0 when null (non-DeFi coin)", () => {
    const r = scoreFundamental({ ...baseRow, marketCapRank: 10 });
    expect(r.score).toBe(3);
    expect(r.checks.find(c => c.name === "tvl_growth_30d")!.points).toBe(0);
    expect(r.checks.find(c => c.name === "ecosystem_revenue")!.points).toBe(0);
  });

  test("TVL / stablecoin tiers", () => {
    expect(scoreFundamental({ ...baseRow, tvlChange30dPct: 15 }).score).toBe(2);
    expect(scoreFundamental({ ...baseRow, tvlChange30dPct: 25 }).score).toBe(3);
    expect(scoreFundamental({ ...baseRow, stablecoinInflow30dPct: 5 }).score).toBe(2);
    expect(scoreFundamental({ ...baseRow, stablecoinInflow30dPct: 15 }).score).toBe(3);
  });
});

describe("classifyCatalyst", () => {
  test("positive / negative / none", () => {
    expect(classifyCatalyst("Bitcoin spot ETF approved")).toBe("positive");
    expect(classifyCatalyst("Solana announces major partnership with Visa")).toBe("positive");
    expect(classifyCatalyst("Exchange hacked, funds stolen")).toBe("negative");
    expect(classifyCatalyst("SEC charges firm with fraud")).toBe("negative"); // negative wins over any positive
    expect(classifyCatalyst("Price trades sideways in quiet session")).toBe("none");
  });
});

describe("scoreNews", () => {
  test("positive catalysts +2 each capped at +6", () => {
    expect(scoreNews([h("ETF approval"), h("new listing")]).score).toBe(4);
    expect(scoreNews([h("ETF approval"), h("listing"), h("partnership"), h("upgrade live")]).score).toBe(SCORING.NEWS_POSITIVE_CAP);
  });

  test("negatives -3 each, floored at -6, flag major negative", () => {
    const r = scoreNews([h("partnership"), h("exploit drains funds"), h("lawsuit filed"), h("token delisted")]);
    expect(r.score).toBe(SCORING.NEWS_FLOOR); // 2 - 9 = -7 → floored -6
    expect(r.hasMajorNegative).toBe(true);
    expect(sumPoints(r.checks)).toBe(r.score);
  });

  test("no news → 0", () => {
    const r = scoreNews([]);
    expect(r.score).toBe(0);
    expect(r.hasMajorNegative).toBe(false);
  });
});

describe("scoreTechnical", () => {
  test("uptrend earns trend points; checks sum to score", () => {
    const candles = buildSeries(240, 100, 1, 12, 0.05);
    const t = scoreTechnical(candles, baseRow);
    expect(t.ema200).not.toBeNull();
    expect(t.score).toBeGreaterThanOrEqual(8);
    expect(sumPoints(t.checks)).toBe(t.score);
  });

  test("monotonic ramp is overbought (RSI>80 penalty)", () => {
    const t = scoreTechnical(buildSeries(220, 100, 1, 0, 0), baseRow);
    expect(t.rsi!).toBeGreaterThan(80);
    expect(t.checks.find(c => c.name === "rsi_momentum")!.points).toBe(-3);
  });

  test("overextension risk penalties", () => {
    const candles = buildSeries(240, 100, 1, 12, 0.05);
    const flat = scoreTechnical(candles, baseRow).score;
    const risky = scoreTechnical(candles, { ...baseRow, change24hPct: 25, change7dPct: 45 }).score;
    expect(risky).toBe(flat - 3 - 2);
  });
});

describe("classify (spec thresholds)", () => {
  test("STRONG_BUY requires total≥25, F≥8, T≥8, no major negative", () => {
    expect(classify(8, 8, 25, false)).toBe("STRONG_BUY");
    expect(classify(7, 8, 25, false)).toBe("WATCHLIST"); // F gate
    expect(classify(8, 7, 25, false)).toBe("WATCHLIST"); // T gate
    expect(classify(8, 8, 24, false)).toBe("WATCHLIST"); // total gate
    expect(classify(8, 8, 25, true)).toBe("WATCHLIST"); // negative news
  });

  test("WATCHLIST / AVOID boundary at 18", () => {
    expect(classify(0, 0, 18, false)).toBe("WATCHLIST");
    expect(classify(0, 0, 17, false)).toBe("AVOID");
  });
});

describe("scoreCoin (integration)", () => {
  test("strong fundamentals + good news + healthy uptrend → STRONG_BUY", () => {
    const candles = buildSeries(240, 100, 1, 12, 0.05);
    const row: MarketRow = {
      marketCapRank: 10, volume24h: 210, volume7dAvg: 100,
      change24hPct: 3, change7dPct: 8,
      tvlChange30dPct: 25, stablecoinInflow30dPct: 12, revenueRising: true,
    };
    const news = [h("major partnership announced"), h("new exchange listing")];
    const r = scoreCoin(candles, row, news);
    expect(r.fundamental).toBeGreaterThanOrEqual(8);
    expect(r.technical).toBeGreaterThanOrEqual(8);
    expect(r.total).toBe(r.fundamental + r.news + r.technical);
    expect(r.category).toBe("STRONG_BUY");
    // breakdown integrity
    expect(sumPoints(r.checks.fundamental)).toBe(r.fundamental);
    expect(sumPoints(r.checks.news)).toBe(r.news);
    expect(sumPoints(r.checks.technical)).toBe(r.technical);
  });

  test("weak inputs → AVOID", () => {
    const r = scoreCoin([], baseRow, []);
    expect(r.technical).toBe(0);
    expect(r.category).toBe("AVOID");
  });

  test("major negative news blocks STRONG_BUY even with strong scores", () => {
    const candles = buildSeries(240, 100, 1, 12, 0.05);
    const row: MarketRow = {
      marketCapRank: 10, volume24h: 210, volume7dAvg: 100, change24hPct: 3, change7dPct: 8,
      tvlChange30dPct: 25, stablecoinInflow30dPct: 12, revenueRising: true,
    };
    const r = scoreCoin(candles, row, [h("protocol exploit, funds drained")]);
    expect(r.hasMajorNegativeNews).toBe(true);
    expect(r.category).not.toBe("STRONG_BUY");
  });
});
