/**
 * Shared order book utilities used by both the Telegram bot (/book command)
 * and the TradingView bulltrend gate.
 */

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBookResult {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface BookScore {
  score: number;          // -4 to +4
  signal: "buy" | "neutral" | "sell";
  imbalanceRatio: number;
  depthRatio: number;
  cvdRatio: number;
  reasons: string[];
}

/**
 * Normalise raw symbol (e.g. "ETHUSD", "BTC-USD") into Coinbase Exchange format "ETH-USD".
 */
export function normalizeBookSymbol(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const quote of ["USDT", "USD", "BTC", "ETH"]) {
    if (s.endsWith(quote) && s.length > quote.length)
      return `${s.slice(0, s.length - quote.length)}-${quote}`;
  }
  return raw.toUpperCase();
}

/**
 * Fetch top `depth` bid/ask levels from the Coinbase Exchange public order book.
 * No authentication required.
 */
export async function fetchOrderBook(symbol: string, depth = 50): Promise<OrderBookResult | null> {
  const url = `https://api.exchange.coinbase.com/products/${symbol}/book?level=2`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) return null;
    const data = await resp.json() as {
      bids?: Array<[string, string, number]>;
      asks?: Array<[string, string, number]>;
    };
    if (!data.bids || !data.asks) return null;
    const bids = data.bids.slice(0, depth).map(l => ({ price: Number(l[0]), size: Number(l[1]) }));
    const asks = data.asks.slice(0, depth).map(l => ({ price: Number(l[0]), size: Number(l[1]) }));
    return { bids, asks };
  } catch {
    return null;
  }
}

/**
 * Score the order book snapshot on a -4 to +4 scale.
 *
 *  +2/-2  imbalance ratio (bid qty vs ask qty)
 *  +1/-1  depth within ±1% of mid (tight liquidity tilt)
 *  +1/-1  CVD proxy (total bid$ vs ask$)
 *
 * Returns signal: "buy" (score >= 1), "sell" (score <= -1), "neutral" (score === 0).
 */
export function scoreBook(bids: BookLevel[], asks: BookLevel[]): BookScore {
  const totalBidSize = bids.reduce((s, l) => s + l.size, 0);
  const totalAskSize = asks.reduce((s, l) => s + l.size, 0);
  const totalBidUsd  = bids.reduce((s, l) => s + l.size * l.price, 0);
  const totalAskUsd  = asks.reduce((s, l) => s + l.size * l.price, 0);

  const mid = bids.length > 0 && asks.length > 0
    ? (bids[0].price + asks[0].price) / 2
    : 0;

  const within1pctBidUsd = bids.filter(l => l.price >= mid * 0.99).reduce((s, l) => s + l.size * l.price, 0);
  const within1pctAskUsd = asks.filter(l => l.price <= mid * 1.01).reduce((s, l) => s + l.size * l.price, 0);

  const imbalanceRatio = totalBidSize / (totalAskSize || 1);
  const depthRatio     = within1pctBidUsd / (within1pctAskUsd || 1);
  const cvdRatio       = totalBidUsd / (totalAskUsd || 1);

  let score = 0;
  const reasons: string[] = [];

  // Signal 1: imbalance ratio
  if (imbalanceRatio > 1.5) {
    score += 2;
    reasons.push(`Imbalance: bids dominate (${imbalanceRatio.toFixed(2)}x) — strong buy pressure`);
  } else if (imbalanceRatio > 1.15) {
    score += 1;
    reasons.push(`Imbalance: mild buy pressure (${imbalanceRatio.toFixed(2)}x)`);
  } else if (imbalanceRatio < 0.67) {
    score -= 2;
    reasons.push(`Imbalance: asks dominate (${imbalanceRatio.toFixed(2)}x) — strong sell pressure`);
  } else if (imbalanceRatio < 0.87) {
    score -= 1;
    reasons.push(`Imbalance: mild sell pressure (${imbalanceRatio.toFixed(2)}x)`);
  } else {
    reasons.push(`Imbalance: balanced (${imbalanceRatio.toFixed(2)}x)`);
  }

  // Signal 2: depth within ±1%
  if (depthRatio > 1.2) {
    score += 1;
    reasons.push(`Near depth: more bid liquidity within 1% (ratio ${depthRatio.toFixed(2)}x)`);
  } else if (depthRatio < 0.83) {
    score -= 1;
    reasons.push(`Near depth: more ask liquidity within 1% (ratio ${depthRatio.toFixed(2)}x)`);
  } else {
    reasons.push(`Near depth: balanced (ratio ${depthRatio.toFixed(2)}x)`);
  }

  // Signal 3: CVD proxy
  if (cvdRatio > 1.1) {
    score += 1;
    reasons.push(`CVD: buy-side heavier ($${((totalBidUsd - totalAskUsd) / 1000).toFixed(1)}k delta)`);
  } else if (cvdRatio < 0.91) {
    score -= 1;
    reasons.push(`CVD: sell-side heavier ($${((totalAskUsd - totalBidUsd) / 1000).toFixed(1)}k delta)`);
  } else {
    reasons.push(`CVD: neutral ($${((totalBidUsd - totalAskUsd) / 1000).toFixed(1)}k delta)`);
  }

  const signal: BookScore["signal"] = score >= 1 ? "buy" : score <= -1 ? "sell" : "neutral";
  return { score, signal, imbalanceRatio, depthRatio, cvdRatio, reasons };
}
