import { BacktestCandle, BacktestIndicatorPoint } from "../../types";

// ─── Pure math helpers ────────────────────────────────────────────────────────

export function sma(values: number[], end: number, period: number): number | null {
  if (end + 1 < period) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += values[i];
  return sum / period;
}

export function stdev(values: number[], end: number, period: number): number | null {
  const mean = sma(values, end, period);
  if (mean === null) return null;
  let acc = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const d = values[i] - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / period);
}

export function computeRSI(closes: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gains += ch; else losses += Math.abs(ch);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? Math.abs(ch) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function computeEMA(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/**
 * Arnaud Legoux Moving Average.
 * offset=0.85 biases the Gaussian kernel toward the most recent bars (responsive).
 * sigma controls the width of the bell curve (higher = smoother).
 * Matches Pine Script: ta.alma(src, length, offset, sigma)
 */
export function computeALMA(
  values: number[],
  length: number,
  offset = 0.85,
  sigma = 6,
): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < length) return out;
  const m = Math.floor(offset * (length - 1));
  const s = length / sigma;
  const weights: number[] = [];
  let wSum = 0;
  for (let k = 0; k < length; k++) {
    const w = Math.exp(-((k - m) ** 2) / (2 * s * s));
    weights.push(w);
    wSum += w;
  }
  // k=0 → oldest value (values[i - length + 1]), k=length-1 → newest (values[i])
  for (let i = length - 1; i < values.length; i++) {
    let weighted = 0;
    for (let k = 0; k < length; k++) {
      weighted += weights[k] * values[i - (length - 1) + k];
    }
    out[i] = weighted / wSum;
  }
  return out;
}

// ─── Common indicator builder (shared by strategies that need RSI/VWAP/BB/EMA50) ─

export function buildCommonIndicators(candles: BacktestCandle[]): BacktestIndicatorPoint[] {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const rsi14 = computeRSI(closes, 14);
  const ema50arr = computeEMA(closes, 50);

  return candles.map((c, i) => {
    const vwap20 = (() => {
      if (i + 1 < 20) return null;
      let pv = 0, vv = 0;
      for (let j = i - 19; j <= i; j++) {
        const typical = (candles[j].high + candles[j].low + candles[j].close) / 3;
        pv += typical * candles[j].volume;
        vv += candles[j].volume;
      }
      return vv > 0 ? pv / vv : null;
    })();

    const volSma20 = sma(volumes, i, 20);
    const rvol20 = volSma20 && volSma20 > 0 ? c.volume / volSma20 : null;
    const bbMid20 = sma(closes, i, 20);
    const bbStd20 = stdev(closes, i, 20);
    const bbUpper20 = bbMid20 !== null && bbStd20 !== null ? bbMid20 + 2 * bbStd20 : null;
    const bbLower20 = bbMid20 !== null && bbStd20 !== null ? bbMid20 - 2 * bbStd20 : null;

    return {
      ts: c.ts,
      close: c.close,
      rsi14: rsi14[i],
      vwap20,
      rvol20,
      bbMid20,
      bbUpper20,
      bbLower20,
      ema50: ema50arr[i],
      grade: "WEAK" as const,
    };
  });
}
