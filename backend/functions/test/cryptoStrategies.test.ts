import { ScoreResult } from "../src/services/cryptoMonitor/scoring";
import {
  evaluateFundamentalWatch, evaluateAccumulationSetup, evaluateBuySetup, evaluateStrongBuy,
  evaluateMomentumBreakout, evaluatePullbackBuyZone, evaluateRiskBlock, evaluateAll, selectAlert,
  shouldStack, gainPct,
} from "../src/services/cryptoMonitor/strategies";

/** Minimal scorecard factory — only the fields strategies read need to be set. */
function mk(o: Partial<ScoreResult> = {}): ScoreResult {
  return {
    fundamental: 0, news: 0, technical: 0, total: 0, category: "AVOID",
    reasons: [], risks: [], hasMajorNegativeNews: false,
    rsi: 50, ema20: 100, ema50: 100, ema200: 90,
    checks: { fundamental: [], news: [], technical: [] },
    newsHeadlines: [], newsSentiment: "neutral",
    majorBearish: false, bullishCount: 0, softBearishCount: 0, price: 100,
    priceAboveEma200: true, ema50AboveEma200: true, ema200Rising: true,
    nearEma20: false, nearEma50: false, volumeMultiplier: null,
    change24hPct: 0, change7dPct: 0, marketCapRank: 50,
    ...o,
  };
}

describe("FUNDAMENTAL_WATCH", () => {
  test("F=3 no major => triggers", () => expect(evaluateFundamentalWatch(mk({ fundamental: 3 })).triggered).toBe(true));
  test("F=2 => no", () => expect(evaluateFundamentalWatch(mk({ fundamental: 2 })).triggered).toBe(false));
  test("F=4 major => no", () => expect(evaluateFundamentalWatch(mk({ fundamental: 4, majorBearish: true })).triggered).toBe(false));
});

describe("ACCUMULATION_SETUP", () => {
  test("F=3 T=5 not overextended => triggers", () => expect(evaluateAccumulationSetup(mk({ fundamental: 3, technical: 5 })).triggered).toBe(true));
  test("T=4 => no", () => expect(evaluateAccumulationSetup(mk({ fundamental: 3, technical: 4 })).triggered).toBe(false));
  test("24h change 25% => no", () => expect(evaluateAccumulationSetup(mk({ fundamental: 3, technical: 5, change24hPct: 25 })).triggered).toBe(false));
});

describe("BUY_SETUP", () => {
  test("F=3 T=7 RSI=60 => triggers", () => expect(evaluateBuySetup(mk({ fundamental: 3, technical: 7, rsi: 60 })).triggered).toBe(true));
  test("RSI=80 => no", () => expect(evaluateBuySetup(mk({ fundamental: 3, technical: 7, rsi: 80 })).triggered).toBe(false));
  test("major => no", () => expect(evaluateBuySetup(mk({ fundamental: 3, technical: 7, rsi: 60, majorBearish: true })).triggered).toBe(false));
});

describe("STRONG_BUY (MVP gate)", () => {
  const ok = { fundamental: 3, technical: 9, total: 20, rsi: 65, nearEma20: true };
  test("F=3 T=9 total=20 near EMA => triggers", () => expect(evaluateStrongBuy(mk(ok)).triggered).toBe(true));
  test("T=8 => no", () => expect(evaluateStrongBuy(mk({ ...ok, technical: 8 })).triggered).toBe(false));
  test("not near EMA => no", () => expect(evaluateStrongBuy(mk({ ...ok, nearEma20: false, nearEma50: false })).triggered).toBe(false));
  test("RSI=75 => no", () => expect(evaluateStrongBuy(mk({ ...ok, rsi: 75 })).triggered).toBe(false));
});

describe("MOMENTUM_BREAKOUT", () => {
  const ok = { fundamental: 3, volumeMultiplier: 1.5, rsi: 60, change24hPct: 10 };
  test("triggers", () => expect(evaluateMomentumBreakout(mk(ok)).triggered).toBe(true));
  test("RSI=82 => no", () => expect(evaluateMomentumBreakout(mk({ ...ok, rsi: 82 })).triggered).toBe(false));
  test("24h change 25% => no", () => expect(evaluateMomentumBreakout(mk({ ...ok, change24hPct: 25 })).triggered).toBe(false));
  test("price below EMA200 => no", () => expect(evaluateMomentumBreakout(mk({ ...ok, priceAboveEma200: false })).triggered).toBe(false));
});

describe("PULLBACK_BUY_ZONE", () => {
  const ok = { fundamental: 3, rsi: 50, nearEma50: true };
  test("triggers", () => expect(evaluatePullbackBuyZone(mk(ok)).triggered).toBe(true));
  test("RSI=70 => no", () => expect(evaluatePullbackBuyZone(mk({ ...ok, rsi: 70 })).triggered).toBe(false));
  test("price below EMA200 => no", () => expect(evaluatePullbackBuyZone(mk({ ...ok, priceAboveEma200: false })).triggered).toBe(false));
});

describe("RISK_BLOCK", () => {
  test("major bearish => triggers", () => expect(evaluateRiskBlock(mk({ majorBearish: true })).triggered).toBe(true));
  test("no major => no", () => expect(evaluateRiskBlock(mk({ majorBearish: false })).triggered).toBe(false));
});

describe("stacking + take-profit helpers", () => {
  test("shouldStack: DCA up to the cap, then stop", () => {
    expect(shouldStack(0, 10, 100)).toBe(true);    // first buy
    expect(shouldStack(80, 10, 100)).toBe(true);   // 80 + 10 = 90 ≤ 100
    expect(shouldStack(90, 10, 100)).toBe(true);   // 90 + 10 = 100 ≤ 100
    expect(shouldStack(95, 10, 100)).toBe(false);  // 95 + 10 = 105 > 100
    expect(shouldStack(100, 10, 100)).toBe(false);
  });

  test("gainPct: percent above entry", () => {
    expect(gainPct(100, 104)).toBeCloseTo(4, 5);
    expect(gainPct(100, 100)).toBe(0);
    expect(gainPct(0, 100)).toBeNull();
    expect(gainPct(100, 0)).toBeNull();
  });
});

describe("selectAlert (priority + suppression)", () => {
  test("RISK_BLOCK suppresses buy alerts", () => {
    const sc = mk({ fundamental: 3, technical: 9, total: 20, rsi: 60, nearEma20: true, majorBearish: true });
    const { selected } = selectAlert(evaluateAll(sc));
    expect(selected?.name).toBe("RISK_BLOCK");
  });

  test("picks highest-priority actionable (STRONG_BUY over BUY_SETUP)", () => {
    const sc = mk({ fundamental: 3, technical: 9, total: 20, rsi: 60, nearEma20: true });
    const { selected, triggered } = selectAlert(evaluateAll(sc));
    expect(selected?.name).toBe("STRONG_BUY");
    expect(triggered.map(t => t.name)).toEqual(expect.arrayContaining(["FUNDAMENTAL_WATCH", "BUY_SETUP", "STRONG_BUY"]));
  });

  test("FUNDAMENTAL_WATCH only when nothing actionable", () => {
    const sc = mk({ fundamental: 3, technical: 0 });
    const { selected } = selectAlert(evaluateAll(sc));
    expect(selected?.name).toBe("FUNDAMENTAL_WATCH");
  });
});
