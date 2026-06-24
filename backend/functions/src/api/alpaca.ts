import { Request, Response } from "express";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAlpacaConfig } from "../config";
import { getTradingConfig } from "./config";
import { getBroker } from "../brokers";

function getHeaders() {
  const config = getAlpacaConfig();
  return {
    "APCA-API-KEY-ID": config.apiKey,
    "APCA-API-SECRET-KEY": config.apiSecret,
  };
}

type PerfWindow = {
  realizedPl: number;
  trades: number;
  tradeDetails: Array<{ symbol: string; time: number; qty: number; sellPrice: number; realizedPl: number }>;
};

// Ignore any fills before this date so realized-P&L totals line up with the
// Coinbase reset (May 2, 2026 00:00:00 UTC).
const PNL_RESET_DATE = 1777680000000;

/**
 * Compute Alpaca realized P&L over rolling 1d/1w/1m/1y windows by FIFO-matching
 * SELL fills against BUY fills per symbol. Mirrors the Coinbase
 * getPerformanceMetrics() shape so the two can be merged for the dashboard.
 * Stocks are commission-free on Alpaca, so fees are treated as 0.
 */
async function fetchAlpacaPerformanceMetrics(): Promise<Record<string, PerfWindow>> {
  const config = getAlpacaConfig();
  const nowMs = Date.now();
  const windows: Record<string, number> = {
    "1d": nowMs - 24 * 60 * 60 * 1000,
    "1w": nowMs - 7 * 24 * 60 * 60 * 1000,
    "1m": nowMs - 30 * 24 * 60 * 60 * 1000,
    "1y": nowMs - 365 * 24 * 60 * 60 * 1000,
  };

  const afterIso = new Date(Math.max(PNL_RESET_DATE, windows["1y"])).toISOString();

  // Paginate FILL activities. Alpaca pages via page_token = id of the last row.
  const fills: Array<{ symbol: string; side: string; qty: number; price: number; time: number }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${config.baseUrl}/v2/account/activities/FILL`);
    url.searchParams.set("after", afterIso);
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const resp = await fetch(url.toString(), { headers: getHeaders() });
    if (!resp.ok) break;
    const rows = (await resp.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const a of rows) {
      const symbol = String(a.symbol || "");
      const side = String(a.side || "").toLowerCase();
      const qty = parseFloat(String(a.qty || "0"));
      const price = parseFloat(String(a.price || "0"));
      const time = new Date(String(a.transaction_time || "")).getTime();
      if (!symbol || !(qty > 0) || !(price > 0) || !Number.isFinite(time)) continue;
      fills.push({ symbol, side, qty, price, time });
    }

    pageToken = rows.length > 0 ? (rows[rows.length - 1].id as string) : undefined;
    if (rows.length < 100 || !pageToken) break;
  }

  const result: Record<string, PerfWindow> = {
    "1d": { realizedPl: 0, trades: 0, tradeDetails: [] },
    "1w": { realizedPl: 0, trades: 0, tradeDetails: [] },
    "1m": { realizedPl: 0, trades: 0, tradeDetails: [] },
    "1y": { realizedPl: 0, trades: 0, tradeDetails: [] },
  };

  // Group by symbol into buys/sells (post-reset only).
  const bySym: Record<string, { buys: typeof fills; sells: typeof fills }> = {};
  for (const f of fills) {
    if (f.time < PNL_RESET_DATE) continue;
    const g = (bySym[f.symbol] ||= { buys: [], sells: [] });
    if (f.side === "sell") g.sells.push(f);
    else if (f.side === "buy") g.buys.push(f);
  }

  for (const symbol of Object.keys(bySym)) {
    const sells = bySym[symbol].sells.sort((a, b) => a.time - b.time);
    const buys = bySym[symbol].buys.sort((a, b) => a.time - b.time);
    let bi = 0;
    let buyRemaining = buys.length > 0 ? buys[0].qty : 0;

    for (const sell of sells) {
      let sellRemaining = sell.qty;
      const sellRevenue = sell.qty * sell.price;
      let buyCost = 0;

      while (sellRemaining > 1e-9 && bi < buys.length) {
        const matchQty = Math.min(sellRemaining, buyRemaining);
        buyCost += matchQty * buys[bi].price;
        sellRemaining -= matchQty;
        buyRemaining -= matchQty;
        if (buyRemaining <= 1e-9) {
          bi++;
          buyRemaining = bi < buys.length ? buys[bi].qty : 0;
        }
      }

      // Unmatched quantity (buy fills truncated / outside window) → break-even,
      // so a missing cost basis contributes ~0 rather than fabricated profit.
      if (sellRemaining > 1e-9) buyCost += sellRemaining * sell.price;

      const realizedPl = sellRevenue - buyCost;
      for (const [period, cutoff] of Object.entries(windows)) {
        if (sell.time >= cutoff) {
          result[period].realizedPl += realizedPl;
          result[period].trades += 1;
          result[period].tradeDetails.push({ symbol, time: sell.time, qty: sell.qty, sellPrice: sell.price, realizedPl });
        }
      }
    }
  }

  return result;
}

/**
 * Merge an additional broker's windowed realized-P&L into a base performance
 * object (sums realizedPl/trades, concatenates tradeDetails per window).
 */
function mergePerformance(base: Record<string, unknown>, add: Record<string, PerfWindow>): void {
  for (const period of ["1d", "1w", "1m", "1y"]) {
    const addWin = add[period];
    if (!addWin) continue;
    const baseWin = (base[period] as PerfWindow | undefined) ?? { realizedPl: 0, trades: 0, tradeDetails: [] };
    base[period] = {
      realizedPl: baseWin.realizedPl + addWin.realizedPl,
      trades: baseWin.trades + addWin.trades,
      tradeDetails: [...(baseWin.tradeDetails ?? []), ...addWin.tradeDetails],
    };
  }
}

/**
 * GET /account — proxy Alpaca account info (equity, buying power, P&L).
 */
export async function handleGetAccount(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const config = getAlpacaConfig();
    const resp = await fetch(`${config.baseUrl}/v2/account`, {
      headers: getHeaders(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      logger.error("[API] Alpaca account fetch failed", { status: resp.status, err });
      res.status(502).json({ error: "Failed to fetch account data" });
      return;
    }

    const data = (await resp.json()) as Record<string, unknown>;
    res.json({
      account: {
        equity: data.equity,
        cash: data.cash,
        buying_power: data.buying_power,
        portfolio_value: data.portfolio_value,
        last_equity: data.last_equity,
        long_market_value: data.long_market_value,
        short_market_value: data.short_market_value,
        initial_margin: data.initial_margin,
        maintenance_margin: data.maintenance_margin,
        daytrade_count: data.daytrade_count,
        status: data.status,
        currency: data.currency,
        non_marginable_buying_power: data.non_marginable_buying_power,
      },
    });
  } catch (err) {
    logger.error("[API] Account request error", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /positions — returns open positions across BOTH Alpaca and Coinbase.
 * Each row is stamped with `broker: "alpaca" | "coinbase"`. `cashBalance` and
 * `performance` come from Coinbase (Alpaca cash is exposed via /account).
 */
export async function handleGetPositions(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const tradingConfig = await getTradingConfig();

    const [coinbaseResult, alpacaResult, alpacaPerfResult] = await Promise.allSettled([
      fetchCoinbasePositions(),
      fetchAlpacaPositions(tradingConfig.SIMULATED_FEE_RATE),
      fetchAlpacaPerformanceMetrics(),
    ]);

    const positions: Array<Record<string, unknown>> = [];
    let cashBalance = 0;
    let performance: Record<string, unknown> = {};

    if (coinbaseResult.status === "fulfilled" && coinbaseResult.value) {
      for (const p of coinbaseResult.value.positions) {
        positions.push({ ...p, broker: "coinbase" });
      }
      cashBalance = coinbaseResult.value.cashBalance;
      performance = coinbaseResult.value.performance;
    } else if (coinbaseResult.status === "rejected") {
      logger.warn("[API] Coinbase positions fetch failed", { error: String(coinbaseResult.reason) });
    }

    if (alpacaResult.status === "fulfilled" && alpacaResult.value) {
      for (const p of alpacaResult.value) {
        positions.push({ ...p, broker: "alpaca" });
      }
    } else if (alpacaResult.status === "rejected") {
      logger.warn("[API] Alpaca positions fetch failed", { error: String(alpacaResult.reason) });
    }

    // Merge Alpaca realized P&L into the (Coinbase-sourced) performance windows
    // so closed Alpaca stock trades show up on the dashboard's realized-P&L card.
    if (alpacaPerfResult.status === "fulfilled" && alpacaPerfResult.value) {
      mergePerformance(performance, alpacaPerfResult.value);
    } else if (alpacaPerfResult.status === "rejected") {
      logger.warn("[API] Alpaca performance fetch failed", { error: String(alpacaPerfResult.reason) });
    }

    res.json({ positions, cashBalance, performance });
  } catch (err) {
    logger.error("[API] Positions request error", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Fetch Coinbase positions + cash + perf metrics. Returns null if the broker
 * doesn't expose getDetailedPositions (shouldn't happen in current deployment).
 */
async function fetchCoinbasePositions(): Promise<{
  positions: Array<Record<string, unknown>>;
  cashBalance: number;
  performance: Record<string, unknown>;
} | null> {
  const broker = getBroker("coinbase") as import("../brokers/coinbase").CoinbaseBroker;
  if (!broker.getDetailedPositions) return null;

  const positions = await broker.getDetailedPositions() as unknown as Array<Record<string, unknown>>;

  let cashBalance = 0;
  try {
    cashBalance = await broker.getCashBalance();
  } catch (cashErr) {
    logger.warn("[API] Failed to get Coinbase cash balance (non-fatal)", { error: String(cashErr) });
  }

  let performance: Record<string, unknown> = {};
  try {
    performance = await broker.getPerformanceMetrics();
  } catch (perfErr) {
    logger.warn("[API] Failed to get Coinbase performance metrics (non-fatal)", { error: String(perfErr) });
  }

  return { positions, cashBalance, performance };
}

/**
 * Fetch Alpaca positions with simulated-fees adjustment and stop_loss lookup.
 * Returns the same per-row shape mobile already understands (simulated_fees etc.).
 */
async function fetchAlpacaPositions(feeRate: number): Promise<Array<Record<string, unknown>>> {
  const config = getAlpacaConfig();
  const [resp, ordersResp] = await Promise.all([
    fetch(`${config.baseUrl}/v2/positions`, { headers: getHeaders() }),
    fetch(`${config.baseUrl}/v2/orders?status=open&limit=500`, { headers: getHeaders() }),
  ]);

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Alpaca positions HTTP ${resp.status}: ${err}`);
  }

  const stopPriceBySymbol = new Map<string, string>();
  if (ordersResp.ok) {
    const openOrders = (await ordersResp.json()) as Array<Record<string, unknown>>;
    for (const o of openOrders) {
      const sym = o.symbol as string;
      const side = o.side as string;
      const type = o.type as string;
      if (side === "sell" && (type === "stop" || type === "stop_limit") && o.stop_price) {
        stopPriceBySymbol.set(sym, o.stop_price as string);
      }
    }
  }

  const positions = (await resp.json()) as Array<Record<string, unknown>>;

  return positions.map((p) => {
    const marketValue = parseFloat(p.market_value as string);
    const costBasis = parseFloat(p.cost_basis as string);
    const isCrypto = (p.asset_class as string || "").toLowerCase() === "crypto";

    // Simulate exchange fees only for crypto (stocks are commission-free on Alpaca)
    const effectiveFeeRate = isCrypto ? feeRate : 0;
    const entryFee = costBasis * effectiveFeeRate;
    const exitFee = marketValue * effectiveFeeRate;
    const totalFees = entryFee + exitFee;

    const adjCostBasis = costBasis + entryFee;
    const adjUnrealizedPl = marketValue - adjCostBasis - exitFee;
    const adjUnrealizedPlPct = adjCostBasis > 0 ? adjUnrealizedPl / adjCostBasis : 0;

    const intradayPl = parseFloat((p.unrealized_intraday_pl as string) || "0");
    const adjIntradayPl = intradayPl - exitFee;
    const adjIntradayPlPct = marketValue > 0 ? adjIntradayPl / marketValue : 0;

    return {
      symbol: p.symbol,
      qty: p.qty,
      avg_entry_price: p.avg_entry_price,
      current_price: p.current_price,
      market_value: p.market_value,
      cost_basis: adjCostBasis.toFixed(6),
      unrealized_pl: adjUnrealizedPl.toFixed(6),
      unrealized_plpc: adjUnrealizedPlPct.toFixed(6),
      unrealized_intraday_pl: adjIntradayPl.toFixed(6),
      unrealized_intraday_plpc: adjIntradayPlPct.toFixed(6),
      change_today: p.change_today,
      side: p.side,
      asset_class: p.asset_class,
      simulated_fees: totalFees.toFixed(6),
      fee_rate: effectiveFeeRate,
      ...(stopPriceBySymbol.has(p.symbol as string) && { stop_loss: stopPriceBySymbol.get(p.symbol as string) }),
    };
  });
}

/**
 * Resolve which broker currently holds an open position for `symbol`. Returns
 * null if no broker reports a position. Probes both in parallel.
 */
async function resolveOwningBroker(symbol: string): Promise<"alpaca" | "coinbase" | null> {
  const [cb, al] = await Promise.allSettled([
    getBroker("coinbase").getPosition(symbol),
    getBroker("alpaca").getPosition(symbol),
  ]);
  if (cb.status === "fulfilled" && cb.value && cb.value.qty > 0) return "coinbase";
  if (al.status === "fulfilled" && al.value && al.value.qty > 0) return "alpaca";
  return null;
}

/**
 * Liquidate a position by symbol (reusable, non-HTTP).
 * Resolves the owning broker by probing both, then delegates.
 */
export async function liquidateSymbol(symbol: string): Promise<Record<string, unknown>> {
  const owning = await resolveOwningBroker(symbol);
  if (!owning) {
    throw new Error(`No open position found for ${symbol} on either broker`);
  }
  const broker = getBroker(owning);
  logger.info("[LIQUIDATE] Delegating to broker", { broker: owning, symbol });
  return broker.liquidatePosition(symbol);
}

/**
 * POST /positions/:symbol/stop-loss — update stop loss for a Coinbase position.
 * Body: { stopPrice: number }
 */
export async function handleUpdateStopLoss(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { symbol } = req.params;
  const stopPrice = parseFloat(req.body?.stopPrice);

  if (!symbol) {
    res.status(400).json({ error: "Missing symbol" });
    return;
  }
  if (isNaN(stopPrice) || stopPrice <= 0) {
    res.status(400).json({ error: "Invalid stopPrice" });
    return;
  }

  try {
    const resolvedBroker = await resolveOwningBroker(symbol);
    if (!resolvedBroker) {
      res.status(404).json({ error: `No open position found for ${symbol} on either broker` });
      return;
    }
    const broker = getBroker(resolvedBroker);
    if (!broker.updateStopLoss) {
      res.status(400).json({ error: `Broker ${resolvedBroker} does not support stop-loss updates` });
      return;
    }
    const result = await broker.updateStopLoss(symbol, stopPrice);
    if (!result.success) {
      logger.error("[API] updateStopLoss broker failed", { broker: resolvedBroker, symbol, stopPrice, message: result.message });
      await getFirestore().collection("broker_errors").add({
        broker: resolvedBroker,
        action: "updateStopLoss",
        userId: user.uid,
        symbol,
        stopPrice,
        error: result.message,
        timestamp: FieldValue.serverTimestamp(),
      });
      res.status(500).json({ error: result.message });
      return;
    }
    res.json({ status: "updated", symbol, stopPrice, broker: resolvedBroker, orderId: result.orderId, message: result.message });
  } catch (err) {
    logger.error("[API] updateStopLoss error", { symbol, error: String(err) });
    await getFirestore().collection("broker_errors").add({
      broker: "unknown",
      action: "updateStopLoss",
      userId: user?.uid,
      symbol,
      stopPrice,
      error: String(err),
      timestamp: FieldValue.serverTimestamp(),
    });
    res.status(500).json({ error: String(err) });
  }
}

/**
 * DELETE /positions/:symbol — liquidate a position and cancel open orders for that symbol.
 */
export async function handleLiquidatePosition(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { symbol } = req.params;
  if (!symbol) {
    res.status(400).json({ error: "Missing symbol" });
    return;
  }

  try {
    const closeData = await liquidateSymbol(symbol);
    res.json({
      status: "liquidated",
      symbol,
      order: closeData,
    });
  } catch (err) {
    logger.error("[API] Liquidation request error", { symbol, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
}

/**
 * GET /portfolio-history — proxy Alpaca portfolio history for chart data.
 */
export async function handleGetPortfolioHistory(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const config = getAlpacaConfig();
    const period = (req.query.period as string) || "1W";
    const timeframe = (req.query.timeframe as string) || "1D";

    // Validate inputs
    const validPeriods = ["1D", "1W", "1M", "3M", "1A"];
    const validTimeframes = ["1Min", "5Min", "15Min", "1H", "1D"];
    if (!validPeriods.includes(period) || !validTimeframes.includes(timeframe)) {
      res.status(400).json({ error: "Invalid period or timeframe" });
      return;
    }

    const resp = await fetch(
      `${config.baseUrl}/v2/account/portfolio/history?period=${period}&timeframe=${timeframe}`,
      { headers: getHeaders() }
    );

    if (!resp.ok) {
      const err = await resp.text();
      logger.error("[API] Portfolio history fetch failed", { status: resp.status, err });
      res.status(502).json({ error: "Failed to fetch portfolio history" });
      return;
    }

    const data = await resp.json();
    res.json({ history: data });
  } catch (err) {
    logger.error("[API] Portfolio history error", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
/**
 * GET /positions/:symbol/levels — compute support/resistance levels from candle data.
 * Returns pivot lows (support) and pivot highs (resistance) from daily candles.
 */
export async function handleGetLevels(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { symbol } = req.params;
  if (!symbol) { res.status(400).json({ error: "Missing symbol" }); return; }

  try {
    const tradingConfig = await getTradingConfig();
    const broker = getBroker(tradingConfig.ACTIVE_BROKER);

    if (broker.name !== "coinbase") {
      res.status(400).json({ error: "Levels only supported for Coinbase" });
      return;
    }

    const cb = broker as import("../brokers/coinbase").CoinbaseBroker;
    const productId = symbol.includes("-") ? symbol : symbol.replace(/USDT?$/, "") + "-USD";

    // Fetch daily candles for last 90 days
    const now = Math.floor(Date.now() / 1000);
    const start = now - 90 * 24 * 3600;
    const { ok, data } = await (cb as any).request(
      "GET",
      `/products/${productId}/candles?start=${start}&end=${now}&granularity=ONE_DAY`
    );

    if (!ok) {
      logger.error("[API] Candles fetch failed", { symbol, data });
      res.status(502).json({ error: "Failed to fetch candle data" });
      return;
    }

    const candles = (data.candles as Array<{ start: string; low: string; high: string; open: string; close: string; volume: string }>) || [];
    if (candles.length < 5) {
      res.json({ supports: [], resistances: [] });
      return;
    }

    // Sort candles by time ascending
    const sorted = candles
      .map(c => ({ time: parseInt(c.start), low: parseFloat(c.low), high: parseFloat(c.high), close: parseFloat(c.close) }))
      .sort((a, b) => a.time - b.time);

    // Find pivot lows (support) and pivot highs (resistance) using 2-bar lookback/lookahead
    const supports: number[] = [];
    const resistances: number[] = [];

    for (let i = 2; i < sorted.length - 2; i++) {
      const curr = sorted[i];
      // Pivot low: lower than both neighbors
      if (curr.low < sorted[i-1].low && curr.low < sorted[i-2].low &&
          curr.low < sorted[i+1].low && curr.low < sorted[i+2].low) {
        supports.push(curr.low);
      }
      // Pivot high: higher than both neighbors
      if (curr.high > sorted[i-1].high && curr.high > sorted[i-2].high &&
          curr.high > sorted[i+1].high && curr.high > sorted[i+2].high) {
        resistances.push(curr.high);
      }
    }

    // Also add recent daily low/high as levels
    const last5 = sorted.slice(-5);
    const recentLow = Math.min(...last5.map(c => c.low));
    const recentHigh = Math.max(...last5.map(c => c.high));

    // Deduplicate (cluster levels within 1.5% of each other)
    const cluster = (levels: number[]): number[] => {
      const sorted = [...levels].sort((a, b) => a - b);
      const result: number[] = [];
      for (const level of sorted) {
        if (result.length === 0 || Math.abs(level - result[result.length - 1]) / result[result.length - 1] > 0.015) {
          result.push(level);
        }
      }
      return result;
    };

    const currentPrice = sorted[sorted.length - 1].close;

    res.json({
      supports: cluster([...supports, recentLow]).filter(l => l < currentPrice).sort((a, b) => b - a).slice(0, 8),
      resistances: cluster([...resistances, recentHigh]).filter(l => l > currentPrice).sort((a, b) => a - b).slice(0, 8),
      currentPrice,
    });
  } catch (err) {
    logger.error("[API] Levels request error", { symbol, error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /positions/:symbol/news — fetch recent news for a crypto symbol.
 * Uses Google News RSS feed (no API key needed).
 */
export async function handleGetNews(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { symbol } = req.params;
  if (!symbol) { res.status(400).json({ error: "Missing symbol" }); return; }

  try {
    // Extract base symbol and build search query
    const base = symbol.replace(/-USD$/, "").replace(/USDT?$/, "");
    // Map common tickers to full names for better results
    const nameMap: Record<string, string> = {
      BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", ADA: "Cardano",
      DOT: "Polkadot", XRP: "Ripple", DOGE: "Dogecoin", AVAX: "Avalanche",
      LINK: "Chainlink", MATIC: "Polygon", SUI: "Sui", NEAR: "NEAR Protocol",
      ARB: "Arbitrum", OP: "Optimism", APT: "Aptos", ICP: "Internet Computer",
    };
    const name = nameMap[base] || base;
    const query = encodeURIComponent(`${name} crypto`);

    const resp = await fetch(
      `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { Accept: "application/xml" } }
    );

    if (!resp.ok) {
      res.json({ news: [] });
      return;
    }

    const xml = await resp.text();
    // Parse RSS XML manually (no external deps)
    const articles: Array<{ id: string; title: string; url: string; summary: string; source: string; imageUrl: string; publishedAt: number }> = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    let idx = 0;
    while ((match = itemRegex.exec(xml)) !== null && idx < 10) {
      const item = match[1];
      const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1") || "";
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || "";
      const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "";
      const source = item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1") || "";
      articles.push({
        id: String(idx),
        title: title.trim(),
        url: link.trim(),
        summary: "",
        source: source.trim(),
        imageUrl: "",
        publishedAt: pubDate ? new Date(pubDate).getTime() : Date.now(),
      });
      idx++;
    }

    res.json({ news: articles });
  } catch (err) {
    logger.error("[API] News request error", { symbol, error: String(err) });
    res.json({ news: [] });
  }
}

/**
 * GET /positions/:symbol/fills — per-tranche DCA buy breakdown for a held
 * Coinbase position (the individual buys that built the current holding) plus a
 * position summary. Crypto/Coinbase only.
 */
export async function handleGetPositionFills(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { symbol } = req.params;
  if (!symbol) { res.status(400).json({ error: "Missing symbol" }); return; }

  // Crypto symbols carry a -USD product suffix; bare tickers are equities → Alpaca.
  const isCrypto = /-USD$/i.test(symbol) || /USD[CT]?$/i.test(symbol);
  try {
    const tradingConfig = await getTradingConfig();
    if (isCrypto) {
      const productId = /-USD$/i.test(symbol) ? symbol.toUpperCase() : `${symbol.toUpperCase()}-USD`;
      const broker = getBroker("coinbase") as import("../brokers/coinbase").CoinbaseBroker;
      const result = await broker.getPositionBuys(productId);
      res.json({ position: result, stackMaxUsd: tradingConfig.MONITOR_STACK_MAX_USD });
    } else {
      const broker = getBroker("alpaca") as import("../brokers/alpaca").AlpacaBroker;
      const result = await broker.getPositionBuys(symbol.toUpperCase());
      res.json({ position: result, stackMaxUsd: tradingConfig.STOCK_MONITOR_STACK_MAX_USD });
    }
  } catch (err) {
    logger.error("[API] Position fills error", { symbol, error: String(err) });
    res.status(500).json({ error: "Failed to fetch position fills" });
  }
}