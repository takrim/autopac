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
 * GET /positions — returns open positions with P&L, routed by active broker.
 */
export async function handleGetPositions(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const tradingConfig = await getTradingConfig();

    // If active broker supports detailed positions, use it
    if (tradingConfig.ACTIVE_BROKER === "coinbase") {
      const broker = getBroker(tradingConfig.ACTIVE_BROKER) as import("../brokers/coinbase").CoinbaseBroker;
      if (broker.getDetailedPositions) {
        const positions = await broker.getDetailedPositions();

        // Get USD cash balance from Coinbase accounts
        let cashBalance = 0;
        try {
          const cbData = await broker.getCashBalance();
          cashBalance = cbData;
        } catch (cashErr) {
          logger.warn("[API] Failed to get cash balance (non-fatal)", { error: String(cashErr) });
        }

        // Compute performance metrics from Coinbase fill history
        let performance: Record<string, unknown> = {};
        try {
          performance = await broker.getPerformanceMetrics();
        } catch (perfErr) {
          logger.warn("[API] Failed to get performance metrics (non-fatal)", { error: String(perfErr) });
        }

        res.json({ positions, cashBalance, performance });
        return;
      }
    }

    // Default: Alpaca positions with simulated fees
    const config = getAlpacaConfig();
    const [resp, ordersResp] = await Promise.all([
      fetch(`${config.baseUrl}/v2/positions`, { headers: getHeaders() }),
      fetch(`${config.baseUrl}/v2/orders?status=open&limit=500`, { headers: getHeaders() }),
    ]);

    if (!resp.ok) {
      const err = await resp.text();
      logger.error("[API] Alpaca positions fetch failed", { status: resp.status, err });
      res.status(502).json({ error: "Failed to fetch positions" });
      return;
    }

    // Build a map of symbol -> stop_price from open stop/stop_limit orders
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
        ...(stopPriceBySymbol.has(p.symbol as string) && { stop_loss: stopPriceBySymbol.get(p.symbol as string) }),
      };
    });

    res.json({ positions: mapped });
  } catch (err) {
    logger.error("[API] Positions request error", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Liquidate a position by symbol (reusable, non-HTTP).
 * Delegates to the active broker's liquidatePosition method.
 * Returns the order data on success, throws on failure.
 */
export async function liquidateSymbol(symbol: string): Promise<Record<string, unknown>> {
  const { getTradingConfig } = await import("./config");
  const tradingConfig = await getTradingConfig();
  const broker = getBroker(tradingConfig.ACTIVE_BROKER);
  logger.info("[LIQUIDATE] Delegating to broker", { broker: broker.name, symbol });
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
    const tradingConfig = await getTradingConfig();
    // Always use the active broker — same as /positions endpoint.
    const broker = getBroker(tradingConfig.ACTIVE_BROKER) as import("../brokers/coinbase").CoinbaseBroker | import("../brokers/alpaca").AlpacaBroker;
    const resolvedBroker = tradingConfig.ACTIVE_BROKER;
    const result = await (broker as any).updateStopLoss(symbol, stopPrice);
    if (!result.success) {
      logger.error("[API] updateStopLoss broker failed", { symbol, stopPrice, message: result.message });
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
    res.json({ status: "updated", symbol, stopPrice, orderId: result.orderId, message: result.message });
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
