import { Request, Response } from "express";
import { logger } from "firebase-functions/v2";
import { getAlpacaConfig } from "../config";
import { getTradingConfig } from "./config";

function getHeaders() {
  const config = getAlpacaConfig();
  return {
    "APCA-API-KEY-ID": config.apiKey,
    "APCA-API-SECRET-KEY": config.apiSecret,
  };
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
 * GET /positions — proxy Alpaca open positions with P&L.
 */
export async function handleGetPositions(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const config = getAlpacaConfig();
    const resp = await fetch(`${config.baseUrl}/v2/positions`, {
      headers: getHeaders(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      logger.error("[API] Alpaca positions fetch failed", { status: resp.status, err });
      res.status(502).json({ error: "Failed to fetch positions" });
      return;
    }

    const positions = (await resp.json()) as Array<Record<string, unknown>>;
    const tradingConfig = await getTradingConfig();
    const feeRate = tradingConfig.SIMULATED_FEE_RATE;

    const mapped = positions.map((p) => {
      const qty = parseFloat(p.qty as string);
      const entryPrice = parseFloat(p.avg_entry_price as string);
      const currentPrice = parseFloat(p.current_price as string);
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
      };
    });

    res.json({ positions: mapped });
  } catch (err) {
    logger.error("[API] Positions request error", err);
    res.status(500).json({ error: "Internal server error" });
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
    const config = getAlpacaConfig();
    const headers = getHeaders();

    // For crypto, Alpaca uses slash-separated symbols for orders (e.g. "LTC/USD")
    // but positions use concatenated symbols (e.g. "LTCUSD"). Try both for order lookup.
    const cryptoSymbol = symbol.endsWith("USD") && !symbol.includes("/")
      ? symbol.slice(0, -3) + "/USD"
      : symbol;

    // 1. Cancel all open orders for this symbol FIRST
    //    Open stop/limit orders lock the balance and prevent liquidation.
    let cancelledCount = 0;
    try {
      // Try both symbol formats for order lookup
      for (const sym of [symbol, cryptoSymbol]) {
        const ordersResp = await fetch(
          `${config.baseUrl}/v2/orders?status=open&symbols=${encodeURIComponent(sym)}&limit=100`,
          { headers }
        );
        if (ordersResp.ok) {
          const orders = (await ordersResp.json()) as Array<{ id: string }>;
          for (const order of orders) {
            const cancelResp = await fetch(`${config.baseUrl}/v2/orders/${order.id}`, {
              method: "DELETE",
              headers,
            });
            if (cancelResp.ok || cancelResp.status === 204) {
              cancelledCount++;
            }
          }
        }
      }
      if (cancelledCount > 0) {
        logger.info("[API] Cancelled open orders before liquidation", { symbol, cancelledCount });
      }
    } catch (cancelErr) {
      logger.warn("[API] Error cancelling orders for symbol", { symbol, err: String(cancelErr) });
    }

    // 2. Fetch current position to get qty, price, and asset class
    const posSymbol = encodeURIComponent(symbol);
    const posResp = await fetch(`${config.baseUrl}/v2/positions/${posSymbol}`, { headers });
    if (!posResp.ok) {
      res.status(404).json({ error: `Position not found for ${symbol}` });
      return;
    }
    const position = (await posResp.json()) as Record<string, string>;
    const isCrypto = (position.asset_class || "").toLowerCase() === "crypto";

    // Check if market is open for stocks
    const isMarketOpen = (() => {
      const now = new Date();
      const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const day = et.getDay();
      if (day === 0 || day === 6) return false;
      const mins = et.getHours() * 60 + et.getMinutes();
      return mins >= 570 && mins < 960; // 9:30–16:00 ET
    })();

    let closeData: Record<string, unknown>;

    if (!isCrypto && !isMarketOpen) {
      // Extended hours: place a limit sell order at current price with buffer
      const currentPrice = parseFloat(position.current_price || "0");
      const limitPrice = (currentPrice * 0.98).toFixed(2); // 2% below to ensure fill
      const orderResp = await fetch(`${config.baseUrl}/v2/orders`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          qty: position.qty,
          side: "sell",
          type: "limit",
          limit_price: limitPrice,
          time_in_force: "day",
          extended_hours: true,
        }),
      });

      if (!orderResp.ok) {
        let errMsg = await orderResp.text();
        try { const j = JSON.parse(errMsg); if (j.message) errMsg = j.message; } catch {}
        logger.error("[API] Extended hours liquidation failed", { symbol, err: errMsg });
        res.status(502).json({ error: `Failed to liquidate ${symbol}: ${errMsg}` });
        return;
      }
      closeData = (await orderResp.json()) as Record<string, unknown>;
      logger.info("[API] Extended hours limit sell placed", { symbol, qty: position.qty, limitPrice });
    } else {
      // Market hours or crypto: use standard DELETE /positions endpoint
      const closeResp = await fetch(`${config.baseUrl}/v2/positions/${posSymbol}`, {
        method: "DELETE",
        headers,
      });

      if (!closeResp.ok) {
        let errMsg = await closeResp.text();
        try { const j = JSON.parse(errMsg); if (j.message) errMsg = j.message; } catch {}
        errMsg = (errMsg || "Unknown error").toString().trim();
        logger.error("[API] Alpaca position liquidation failed", { symbol, status: closeResp.status, err: errMsg });
        res.status(502).json({ error: `Failed to liquidate ${symbol}: ${errMsg}` });
        return;
      }
      closeData = (await closeResp.json()) as Record<string, unknown>;
    }

    logger.info("[API] Position liquidated", { symbol, cancelledOrders: cancelledCount });
    res.json({
      status: "liquidated",
      symbol,
      order: closeData,
      cancelledOrders: cancelledCount,
    });
  } catch (err) {
    logger.error("[API] Liquidation request error", err);
    res.status(500).json({ error: "Internal server error" });
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
