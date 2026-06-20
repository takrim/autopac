import {
  scoreFundamental,
  scoreNews,
  scoreTechnical,
  classify,
  classifyNews,
  classifySentiment,
  weighSentiment,
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
      ...baseRow, marketCapRank: 10, volume24h: 210, volume7dAvg: 100,
      tvlChange30dPct: 25, stablecoinInflow30dPct: 12, revenueRising: true,
    });
    expect(r.score).toBe(14);
    expect(sumPoints(r.checks)).toBe(r.score);
  });
});

describe("classifyNews (4 categories)", () => {
  test("major bearish wins", () => {
    expect(classifyNews("Exchange hacked, funds stolen")).toBe("MAJOR_BEARISH");
    expect(classifyNews("SEC lawsuit filed against project")).toBe("MAJOR_BEARISH");
  });
  test("bullish", () => {
    expect(classifyNews("ETF approval boosts adoption")).toBe("BULLISH");
    expect(classifyNews("Major partnership announced")).toBe("BULLISH");
  });
  test("soft bearish (generic) is not major", () => {
    expect(classifyNews("Bitcoin falls after market selloff")).toBe("SOFT_BEARISH");
    expect(classifyNews("Analyst warns of volatility")).toBe("SOFT_BEARISH");
  });
  test("neutral", () => {
    expect(classifyNews("Project releases quarterly report")).toBe("NEUTRAL");
  });
});

describe("scoreNews (v2)", () => {
  test("bullish +2 each capped at +4", () => {
    expect(scoreNews([h("ETF approval"), h("new listing")]).score).toBe(4);
    expect(scoreNews([h("ETF approval"), h("listing"), h("partnership")]).score).toBe(SCORING.NEWS_BULLISH_CAP);
  });

  test("soft bearish -1 each capped at -2; does NOT set major", () => {
    const r = scoreNews([h("Bitcoin falls"), h("crypto selloff"), h("analyst warns")]);
    expect(r.score).toBe(SCORING.NEWS_SOFT_BEARISH_CAP); // -2 cap
    expect(r.majorBearish).toBe(false);
    expect(sumPoints(r.checks)).toBe(r.score);
  });

  test("major bearish sets the block flag", () => {
    const r = scoreNews([h("Protocol exploit drains funds"), h("ETF approval")]);
    expect(r.majorBearish).toBe(true);
    expect(r.bullishCount).toBe(1);
  });

  test("exposes matched headlines in details", () => {
    const r = scoreNews([h("Bitcoin ETF approved"), h("price falls today")]);
    expect(r.checks.find(c => c.name === "bullish_news")?.details).toContain("Bitcoin ETF approved");
    expect(r.checks.find(c => c.name === "soft_bearish_news")?.details).toContain("price falls today");
  });
});

describe("weighed sentiment (display)", () => {
  test("classifySentiment + weighSentiment", () => {
    expect(classifySentiment("Solana surges as volume climbs")).toBe("bullish");
    expect(weighSentiment([{ sentiment: "bullish" }, { sentiment: "bullish" }, { sentiment: "neutral" }])).toBe("bullish");
    expect(weighSentiment([{ sentiment: "bullish" }, { sentiment: "bearish" }])).toBe("mixed");
  });
});

describe("scoreTechnical", () => {
  test("uptrend earns trend points; checks sum to score", () => {
    const t = scoreTechnical(buildSeries(240, 100, 1, 12, 0.05), baseRow);
    expect(t.ema200).not.toBeNull();
    expect(t.score).toBeGreaterThanOrEqual(8);
    expect(sumPoints(t.checks)).toBe(t.score);
  });
  test("overextension risk penalties", () => {
    const candles = buildSeries(240, 100, 1, 12, 0.05);
    const flat = scoreTechnical(candles, baseRow).score;
    const risky = scoreTechnical(candles, { ...baseRow, change24hPct: 25, change7dPct: 45 }).score;
    expect(risky).toBe(flat - 3 - 2);
  });
});

describe("classify (diagnostic band)", () => {
  test("STRONG_BUY band / WATCHLIST / AVOID", () => {
    expect(classify(3, 9, 22, false)).toBe("STRONG_BUY");
    expect(classify(3, 9, 22, true)).toBe("WATCHLIST"); // major bearish blocks the band
    expect(classify(0, 0, 18, false)).toBe("WATCHLIST");
    expect(classify(0, 0, 17, false)).toBe("AVOID");
  });
});

describe("scoreCoin (scorecard)", () => {
  test("populates strategy flags from an uptrend", () => {
    const candles = buildSeries(240, 100, 1, 12, 0.05);
    const row: MarketRow = {
      marketCapRank: 10, volume24h: 210, volume7dAvg: 100, change24hPct: 3, change7dPct: 8,
      tvlChange30dPct: null, stablecoinInflow30dPct: null, revenueRising: null,
    };
    const r = scoreCoin(candles, row, [h("Coin surges on strong volume")]);
    expect(r.priceAboveEma200).toBe(true);
    expect(r.ema50AboveEma200).toBe(true);
    expect(r.volumeMultiplier).toBeCloseTo(2.1, 1);
    expect(r.majorBearish).toBe(false);
    expect(r.newsHeadlines.length).toBe(1);
  });

  test("major bearish news flag flows through", () => {
    const r = scoreCoin([], baseRow, [h("Protocol exploit, funds drained")]);
    expect(r.majorBearish).toBe(true);
  });
});
