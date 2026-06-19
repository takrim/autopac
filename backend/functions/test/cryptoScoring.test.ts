import {
  scoreFundamental,
  scoreNews,
  scoreTechnical,
  classify,
  scoreCoin,
  SCORING,
  Candle,
  MarketRow,
  NewsHeadline,
} from "../src/services/cryptoMonitor/scoring";

const baseRow: MarketRow = {
  marketCapRank: 500,
  volume24h: 0,
  volume7dAvg: null,
  change24hPct: 0,
  change7dPct: 0,
};

/** Build closes: `up` linear-rising bars, then `pull` bars retracing `pullPct`. */
function buildSeries(up: number, start: number, step: number, pull: number, pullPct: number): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < up; i++) closes.push(start + i * step);
  const peak = closes[closes.length - 1];
  for (let i = 1; i <= pull; i++) closes.push(peak * (1 - (pullPct * i) / pull));
  return closes.map((c) => ({ open: c, high: c, low: c, close: c, volume: 1 }));
}

describe("scoreFundamental", () => {
  test("rank tiers", () => {
    expect(scoreFundamental({ ...baseRow, marketCapRank: 10 }).score).toBe(3);
    expect(scoreFundamental({ ...baseRow, marketCapRank: 80 }).score).toBe(2);
    expect(scoreFundamental({ ...baseRow, marketCapRank: 150 }).score).toBe(1);
    expect(scoreFundamental({ ...baseRow, marketCapRank: 500 }).score).toBe(0);
    expect(scoreFundamental({ ...baseRow, marketCapRank: null }).score).toBe(0);
  });

  test("volume growth tiers (additive with rank)", () => {
    expect(scoreFundamental({ ...baseRow, marketCapRank: 10, volume24h: 160, volume7dAvg: 100 }).score).toBe(3 + 2);
    expect(scoreFundamental({ ...baseRow, marketCapRank: 10, volume24h: 210, volume7dAvg: 100 }).score).toBe(3 + 3);
    expect(scoreFundamental({ ...baseRow, marketCapRank: 10, volume24h: 140, volume7dAvg: 100 }).score).toBe(3);
  });
});

describe("scoreNews", () => {
  const h = (sentiment: NewsHeadline["sentiment"]): NewsHeadline => ({ sentiment, title: sentiment });

  test("positive catalysts +2 each, capped at +6", () => {
    expect(scoreNews([h("bullish"), h("bullish")]).score).toBe(4);
    expect(scoreNews([h("bullish"), h("bullish"), h("bullish"), h("bullish")]).score).toBe(SCORING.NEWS_POSITIVE_CAP);
  });

  test("negative catalysts -3 each and flag major negative", () => {
    const r = scoreNews([h("bullish"), h("bearish")]);
    expect(r.score).toBe(2 - 3);
    expect(r.hasMajorNegative).toBe(true);
  });

  test("neutral headlines ignored", () => {
    const r = scoreNews([h("neutral"), h("neutral")]);
    expect(r.score).toBe(0);
    expect(r.hasMajorNegative).toBe(false);
  });
});

describe("scoreTechnical", () => {
  test("uptrend earns trend points and exposes finite indicators", () => {
    // Needs > 200 + EMA200_RISING_LOOKBACK candles so the rising check has a
    // finite EMA200 value to compare against (prod fetches 250 hourly bars).
    const candles = buildSeries(240, 100, 1, 12, 0.05);
    const t = scoreTechnical(candles, baseRow);
    expect(t.ema200).not.toBeNull();
    expect(t.ema50! > t.ema200!).toBe(true);
    expect(t.reasons).toEqual(expect.arrayContaining(["Price above EMA200", "EMA50 above EMA200", "EMA200 rising"]));
    expect(t.score).toBeGreaterThanOrEqual(8);
  });

  test("monotonic ramp is overbought (RSI>80 penalty)", () => {
    const candles = buildSeries(220, 100, 1, 0, 0);
    const t = scoreTechnical(candles, baseRow);
    expect(t.rsi!).toBeGreaterThan(80);
    expect(t.risks.some((r) => r.includes("overbought"))).toBe(true);
  });

  test("overextended price applies risk penalties", () => {
    const candles = buildSeries(210, 100, 1, 12, 0.05);
    const flat = scoreTechnical(candles, baseRow).score;
    const risky = scoreTechnical(candles, { ...baseRow, change24hPct: 25, change7dPct: 45 }).score;
    expect(risky).toBe(flat - 3 - 2);
  });

  test("too few candles → null indicators, no trend points", () => {
    const t = scoreTechnical(buildSeries(10, 100, 1, 0, 0), baseRow);
    expect(t.ema200).toBeNull();
    expect(t.reasons).toHaveLength(0);
  });
});

describe("classify", () => {
  test("STRONG_BUY requires all gates", () => {
    expect(classify(4, 9, 20, false)).toBe("STRONG_BUY");
    expect(classify(3, 9, 20, false)).toBe("WATCHLIST"); // fundamental gate fails
    expect(classify(4, 8, 20, false)).toBe("WATCHLIST"); // technical gate fails
    expect(classify(4, 9, 20, true)).toBe("WATCHLIST"); // negative news blocks
  });

  test("WATCHLIST / AVOID boundary", () => {
    expect(classify(0, 0, SCORING.WATCHLIST_MIN, false)).toBe("WATCHLIST");
    expect(classify(0, 0, SCORING.WATCHLIST_MIN - 1, false)).toBe("AVOID");
  });
});

describe("scoreCoin (integration)", () => {
  test("strong fundamentals + good news + healthy uptrend is not AVOID", () => {
    const candles = buildSeries(210, 100, 1, 12, 0.05);
    const row: MarketRow = { marketCapRank: 10, volume24h: 210, volume7dAvg: 100, change24hPct: 3, change7dPct: 8 };
    const news: NewsHeadline[] = [{ sentiment: "bullish", title: "partnership" }, { sentiment: "bullish", title: "listing" }];
    const r = scoreCoin(candles, row, news);
    expect(r.fundamental).toBe(6);
    expect(r.news).toBe(4);
    expect(r.category).not.toBe("AVOID");
    expect(r.total).toBe(r.fundamental + r.news + r.technical);
  });

  test("weak inputs score AVOID", () => {
    const r = scoreCoin([], baseRow, []);
    expect(r.technical).toBe(0);
    expect(r.category).toBe("AVOID");
  });
});
