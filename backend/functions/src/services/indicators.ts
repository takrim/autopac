import { logger } from "firebase-functions/v2";
import { getAlpacaConfig } from "../config";

interface Bar {
  t: string;  // timestamp
  o: number;  // open
  h: number;  // high
  l: number;  // low
  c: number;  // close
  v: number;  // volume
  vw: number; // volume-weighted avg price
}

export interface IndicatorResult {
  rsi: number | null;
  vwap: number | null;
  vwapTrend: "bullish" | "bearish" | "neutral" | null;
  currentPrice: number | null;
  support: number | null;
}

/**
 * Fetch candles from Coinbase public API and convert to Bar format.
 * Tries FIVE_MINUTE first, then falls back to FIFTEEN_MINUTE for low-volume tokens.
 */
async function fetchCoinbaseCandles(symbol: string): Promise<Bar[]> {
  const productId = symbol.includes("-") ? symbol : symbol.replace(/USD$/, "") + "-USD";
  const end = Math.floor(Date.now() / 1000);

  const granularities = [
    { name: "FIVE_MINUTE", seconds: 500 * 5 * 60 },
    { name: "FIFTEEN_MINUTE", seconds: 300 * 15 * 60 },
  ];

  for (const gran of granularities) {
    const start = end - gran.seconds;
    const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(productId)}/candles?start=${start}&end=${end}&granularity=${gran.name}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn("[INDICATORS] Coinbase candles fetch failed", { symbol, productId, granularity: gran.name, status: resp.status });
      continue;
    }

    const data = await resp.json() as Record<string, unknown>;
    const candles = data.candles as Array<Record<string, string>> | undefined;
    if (!candles || candles.length < 15) {
      logger.info("[INDICATORS] Coinbase insufficient candles at granularity", { symbol, granularity: gran.name, count: candles?.length ?? 0 });
      continue;
    }

    logger.info("[INDICATORS] Coinbase candles found", { symbol, granularity: gran.name, count: candles.length });
    // Coinbase candles are newest-first; reverse to oldest-first for RSI calculation
    return candles.reverse().map((c) => ({
      t: c.start,
      o: parseFloat(c.open),
      h: parseFloat(c.high),
      l: parseFloat(c.low),
      c: parseFloat(c.close),
      v: parseFloat(c.volume),
      vw: 0,
    }));
  }

  return [];
}

/**
 * Fetch 15-minute candles from Coinbase public API.
 * Used specifically for support level determination.
 */
async function fetchCoinbase15MinCandles(symbol: string): Promise<Bar[]> {
  const productId = symbol.includes("-") ? symbol : symbol.replace(/USD$/, "") + "-USD";
  const end = Math.floor(Date.now() / 1000);
  // 300 candles × 15 min = 75 hours of data
  const start = end - 300 * 15 * 60;
  const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(productId)}/candles?start=${start}&end=${end}&granularity=FIFTEEN_MINUTE`;

  const resp = await fetch(url);
  if (!resp.ok) {
    logger.warn("[INDICATORS] Coinbase 15m candles fetch failed", { symbol, productId, status: resp.status });
    return [];
  }

  const data = await resp.json() as Record<string, unknown>;
  const candles = data.candles as Array<Record<string, string>> | undefined;
  if (!candles || candles.length === 0) return [];

  // Coinbase returns newest-first; reverse to oldest-first
  return candles.reverse().map((c) => ({
    t: c.start,
    o: parseFloat(c.open),
    h: parseFloat(c.high),
    l: parseFloat(c.low),
    c: parseFloat(c.close),
    v: parseFloat(c.volume),
    vw: 0,
  }));
}

/**
 * Fetch recent bars from Alpaca and calculate RSI(14) and VWAP.
 * Falls back to Coinbase candles if Alpaca has insufficient data and activeBroker is "coinbase".
 */
export async function calculateIndicators(symbol: string, currentPrice: number, activeBroker?: string): Promise<IndicatorResult> {
  const result: IndicatorResult = { rsi: null, vwap: null, vwapTrend: null, currentPrice, support: null };

  try {
    const config = getAlpacaConfig();
    const headers = {
      "APCA-API-KEY-ID": config.apiKey,
      "APCA-API-SECRET-KEY": config.apiSecret,
    };

    const isCrypto = symbol.endsWith("USD") || symbol.includes("/");

    // Need ~20 bars for RSI(14) — use 5-min bars for intraday
    let bars: Bar[] = [];

    if (isCrypto) {
      const cryptoSymbol = symbol.includes("/") ? symbol : symbol.replace(/USD$/, "") + "/USD";
      const resp = await fetch(
        `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(cryptoSymbol)}&timeframe=3Min&limit=500`,
        { headers }
      );
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        const barMap = data.bars as Record<string, Bar[]> | undefined;
        if (barMap) {
          bars = barMap[cryptoSymbol] || [];
        }
      } else {
        logger.warn("[INDICATORS] Crypto bars fetch failed", { symbol, status: resp.status });
      }
    } else {
      const resp = await fetch(
        `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=3Min&limit=500`,
        { headers }
      );
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        bars = (data.bars as Bar[]) || [];
      } else {
        logger.warn("[INDICATORS] Stock bars fetch failed", { symbol, status: resp.status });
      }
    }

    // Fallback to Coinbase candles if Alpaca has insufficient data
    if (bars.length < 15 && isCrypto && activeBroker === "coinbase") {
      logger.info("[INDICATORS] Alpaca returned insufficient bars, falling back to Coinbase candles", { symbol, alpacaBars: bars.length });
      try {
        bars = await fetchCoinbaseCandles(symbol);
        logger.info("[INDICATORS] Coinbase candles fetched", { symbol, count: bars.length });
      } catch (cbErr) {
        logger.warn("[INDICATORS] Coinbase candle fallback failed", { symbol, error: String(cbErr) });
      }
    }

    if (bars.length < 15) {
      logger.warn("[INDICATORS] Not enough bars for indicators", { symbol, count: bars.length, source: bars.length > 0 ? "partial" : "none" });
      return result;
    }

    // Calculate RSI(14)
    result.rsi = calcRSI(bars.map((b) => b.c), 14);

    // Calculate VWAP from today's bars
    result.vwap = calcVWAP(bars);

    // Determine VWAP trend
    if (result.vwap !== null) {
      if (currentPrice > result.vwap * 1.001) {
        result.vwapTrend = "bullish";
      } else if (currentPrice < result.vwap * 0.999) {
        result.vwapTrend = "bearish";
      } else {
        result.vwapTrend = "neutral";
      }
    }

    logger.info("[INDICATORS] Calculated", { symbol, rsi: result.rsi?.toFixed(1), vwap: result.vwap?.toFixed(4), vwapTrend: result.vwapTrend });

    // Calculate support level from 15-min candles (for stop loss placement)
    if (activeBroker === "coinbase") {
      try {
        const bars15m = await fetchCoinbase15MinCandles(symbol);
        if (bars15m.length >= 5) {
          result.support = calcSupportLevel(bars15m, currentPrice);
          logger.info("[INDICATORS] Support level", { symbol, support: result.support?.toFixed(6) ?? "none", bars: bars15m.length });
        }
      } catch (supErr) {
        logger.warn("[INDICATORS] Support level calculation failed (non-fatal)", { symbol, error: String(supErr) });
      }
    }
  } catch (err) {
    logger.error("[INDICATORS] Error calculating indicators", { symbol, err: String(err) });
  }

  return result;
}

/**
 * RSI(period) from an array of close prices.
 */
function calcRSI(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Smooth with remaining bars
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Find the most recent pivot low below the current price from a bar array.
 * A pivot low is a bar whose low is strictly less than the `wing` bars on each side.
 * Returns the most recent such low that is below currentPrice, or null if none found.
 */
function calcSupportLevel(bars: Bar[], currentPrice: number, wing = 2): number | null {
  let lastSupport: number | null = null;

  for (let i = wing; i < bars.length - wing; i++) {
    const low = bars[i].l;
    let isPivot = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (bars[j].l <= low) { isPivot = false; break; }
    }
    if (isPivot && low < currentPrice) {
      lastSupport = low;
    }
  }

  return lastSupport;
}

/**
 * VWAP — cumulative (typical price × volume) / cumulative volume.
 */
function calcVWAP(bars: Bar[]): number | null {
  if (bars.length === 0) return null;

  let cumTPV = 0; // cumulative (typical price × volume)
  let cumVol = 0;

  for (const bar of bars) {
    const tp = (bar.h + bar.l + bar.c) / 3;
    cumTPV += tp * bar.v;
    cumVol += bar.v;
  }

  if (cumVol === 0) return null;
  return cumTPV / cumVol;
}
