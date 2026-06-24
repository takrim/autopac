import { buildMarketRow } from "../src/services/stockMonitor/data";
import { classifyNews, scoreCoin, Candle, NewsHeadline } from "../src/services/cryptoMonitor/scoring";

/** Build a rising daily series with a small pullback at the end. */
function buildSeries(up: number, start: number, step: number, pull: number, pullPct: number, vol = 1_000_000): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < up; i++) closes.push(start + i * step);
  const peak = closes[closes.length - 1];
  for (let i = 1; i <= pull; i++) closes.push(peak * (1 - (pullPct * i) / pull));
  return closes.map((c) => ({ open: c, high: c, low: c, close: c, volume: vol }));
}

const h = (title: string): NewsHeadline => ({ title });

describe("buildMarketRow", () => {
  test("derives avg volume + 7d change, nulls fundamentals", () => {
    // 10 bars, closes 100..109, last-6-back close = 104 → 7d change = (109-104)/104.
    const bars: Candle[] = Array.from({ length: 10 }, (_, i) => ({
      open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1000 + i,
    }));
    const row = buildMarketRow({ price: 109, change24hPct: 1.5, volume24h: 5000 }, bars);

    expect(row.marketCapRank).toBeNull();
    expect(row.tvlChange30dPct).toBeNull();
    expect(row.stablecoinInflow30dPct).toBeNull();
    expect(row.revenueRising).toBeNull();
    expect(row.volume24h).toBe(5000);
    expect(row.change24hPct).toBe(1.5);
    // avg of all 10 volumes (≤20 sessions): (1000..1009) avg = 1004.5
    expect(row.volume7dAvg).toBeCloseTo(1004.5, 5);
    // close 109 vs close 6 bars back (104)
    expect(row.change7dPct).toBeCloseTo(((109 - 104) / 104) * 100, 5);
  });

  test("handles missing snapshot + short history", () => {
    const bars: Candle[] = [{ open: 50, high: 50, low: 50, close: 50, volume: 200 }];
    const row = buildMarketRow(undefined, bars);
    expect(row.volume24h).toBe(200); // falls back to last bar volume
    expect(row.change24hPct).toBe(0);
    expect(row.change7dPct).toBe(0); // <6 bars → 0
  });
});

describe("stock news catalysts", () => {
  test("bullish earnings/guidance", () => {
    expect(classifyNews("Nvidia beats estimates and raises guidance")).toBe("BULLISH");
    expect(classifyNews("Apple announces $90B buyback")).toBe("BULLISH");
    expect(classifyNews("FDA approval granted for new drug")).toBe("BULLISH");
  });
  test("major bearish stock events", () => {
    expect(classifyNews("Company cuts guidance amid profit warning")).toBe("MAJOR_BEARISH");
    expect(classifyNews("DOJ opens antitrust probe")).toBe("MAJOR_BEARISH");
  });
  test("soft bearish downgrade", () => {
    expect(classifyNews("Analyst downgrades the stock to hold")).toBe("SOFT_BEARISH");
  });
});

describe("scoreCoin on stock fixtures", () => {
  const row = buildMarketRow({ price: 100, change24hPct: 2, volume24h: 3_000_000 }, []);

  // NB: stock "fundamental" is a volume proxy only (no Alpaca-basic fundamentals),
  // so the diagnostic combined `category` band can read AVOID even on a clean
  // technical setup — the strategies (technical+news) carry the signal, not the band.
  test("uptrend + bullish news is technically strong and not majorBearish", () => {
    const bars = buildSeries(220, 50, 0.5, 4, 0.03, 3_000_000); // long uptrend, mild pullback
    const r = scoreCoin(bars, { ...row, volume7dAvg: 1_500_000, volume24h: 3_000_000 }, [h("Company beats estimates, raises guidance")]);
    expect(r.technical).toBeGreaterThan(8);
    expect(r.priceAboveEma200).toBe(true);
    expect(r.news).toBeGreaterThan(0);
    expect(r.majorBearish).toBe(false);
  });

  test("downtrend scores low technical", () => {
    const closes: Candle[] = Array.from({ length: 220 }, (_, i) => {
      const c = 200 - i * 0.5; // steady decline
      return { open: c, high: c, low: c, close: c, volume: 1_000_000 };
    });
    const r = scoreCoin(closes, row, []);
    expect(r.priceAboveEma200).toBe(false);
    expect(r.technical).toBeLessThan(8);
  });

  test("major-bearish headline flags RISK_BLOCK input", () => {
    const bars = buildSeries(220, 50, 0.5, 4, 0.03);
    const r = scoreCoin(bars, row, [h("Company cuts guidance amid profit warning")]);
    expect(r.majorBearish).toBe(true);
  });
});
