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
}

/**
 * Fetch recent bars from Alpaca and calculate RSI(14) and VWAP.
 */
export async function calculateIndicators(symbol: string, currentPrice: number): Promise<IndicatorResult> {
  const result: IndicatorResult = { rsi: null, vwap: null, vwapTrend: null, currentPrice };

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

    if (bars.length < 15) {
      logger.warn("[INDICATORS] Not enough bars for indicators", { symbol, count: bars.length });
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

    logger.info("[INDICATORS] Calculated", { symbol, rsi: result.rsi?.toFixed(1), vwap: result.vwap?.toFixed(2), vwapTrend: result.vwapTrend });
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
