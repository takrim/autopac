import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { IBroker, BrokerPosition, DetailedPosition, Candle } from "./interface";
import { PlaceOrderParams, PlaceOrderResult } from "../types";
import { getAlpacaConfig, CONFIG } from "../config";

/**
 * Alpaca broker implementation.
 * Uses Alpaca Trading API v2 for order placement.
 * Set ALPACA_BASE_URL to paper-api.alpaca.markets for paper trading.
 */
export class AlpacaBroker implements IBroker {
  readonly name = "alpaca";

  private getConfig() {
    return getAlpacaConfig();
  }

  private getHeaders() {
    const config = this.getConfig();
    return {
      "APCA-API-KEY-ID": config.apiKey,
      "APCA-API-SECRET-KEY": config.apiSecret,
      "Content-Type": "application/json",
    };
  }

  // Tiny per-process TTL cache for assetExists probes (15 min).
  private static assetCache = new Map<string, { exists: boolean; expiresAt: number }>();
  private static readonly ASSET_TTL_MS = 15 * 60 * 1000;

  /**
   * Check whether a symbol is tradeable on Alpaca.
   * Normalizes crypto symbols ("BTCUSD" → "BTC/USD") for the /v2/assets lookup.
   * Returns false on 404, true on 200, false on any other error (fail-closed).
   */
  async assetExists(symbol: string): Promise<boolean> {
    const config = this.getConfig();
    if (!config.apiKey || !config.apiSecret) {
      logger.warn("[ALPACA] assetExists: credentials missing");
      return false;
    }

    const isCrypto = symbol.endsWith("USD") || symbol.endsWith("USDT") || symbol.includes("/");
    const alpacaSymbol = isCrypto && !symbol.includes("/")
      ? symbol.replace(/USDT?$/, "") + "/USD"
      : symbol.toUpperCase();

    const cacheKey = alpacaSymbol;
    const cached = AlpacaBroker.assetCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.exists;

    try {
      const resp = await fetch(
        `${config.baseUrl}/v2/assets/${encodeURIComponent(alpacaSymbol)}`,
        { headers: this.getHeaders() }
      );
      let exists = false;
      if (resp.ok) {
        try {
          const data = await resp.json() as { tradable?: boolean; status?: string };
          exists = data.tradable === true && data.status === "active";
          if (!exists) {
            logger.info("[ALPACA] assetExists: asset present but not tradable/active", {
              symbol: alpacaSymbol, tradable: data.tradable, status: data.status,
            });
          }
        } catch {
          exists = false;
        }
      }
      AlpacaBroker.assetCache.set(cacheKey, {
        exists,
        expiresAt: Date.now() + AlpacaBroker.ASSET_TTL_MS,
      });
      if (!resp.ok && resp.status !== 404) {
        logger.warn("[ALPACA] assetExists non-404 error", { symbol: alpacaSymbol, status: resp.status });
      }
      return exists;
    } catch (err) {
      logger.warn("[ALPACA] assetExists fetch error", { symbol: alpacaSymbol, err: String(err) });
      return false;
    }
  }

  private async submitOrder(body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const config = this.getConfig();
    const response = await fetch(`${config.baseUrl}/v2/orders`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    const data = await response.json() as Record<string, unknown>;
    return { ok: response.ok, data };
  }

  /**
   * Cancel all open orders for a symbol.
   * Called before placing a new entry to clear stale SL/TP from previous trades.
   */
  private async cancelOpenOrders(symbol: string): Promise<void> {
    const config = this.getConfig();
    try {
      const resp = await fetch(
        `${config.baseUrl}/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}`,
        { headers: this.getHeaders() }
      );
      if (!resp.ok) {
        logger.warn("[ALPACA] Failed to fetch open orders for cancel", { symbol });
        return;
      }
      const orders = await resp.json() as Array<Record<string, unknown>>;
      if (orders.length === 0) return;

      logger.info("[ALPACA] Cancelling open orders before new entry", { symbol, count: orders.length });
      for (const order of orders) {
        try {
          await fetch(`${config.baseUrl}/v2/orders/${order.id}`, {
            method: "DELETE",
            headers: this.getHeaders(),
          });
          logger.info("[ALPACA] Cancelled order", { id: order.id, type: order.type, side: order.side });
        } catch (err) {
          logger.warn("[ALPACA] Failed to cancel order", { id: order.id, err: String(err) });
        }
      }
    } catch (err) {
      logger.warn("[ALPACA] cancelOpenOrders error", { symbol, err: String(err) });
    }
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    const config = this.getConfig();

    if (!config.apiKey || !config.apiSecret) {
      return {
        success: false,
        orderId: "",
        status: "FAILED",
        message: "Alpaca API credentials not configured",
      };
    }

    // Alpaca crypto symbols use "BTC/USD" format, not "BTCUSD"
    const isCrypto = params.symbol.endsWith("USD") || params.symbol.endsWith("USDT") || params.symbol.includes("/");
    const symbol = isCrypto && !params.symbol.includes("/")
      ? params.symbol.replace(/USDT?$/, "") + "/USD"
      : params.symbol;

    // For stocks: always use limit order at signal price with extended_hours enabled.
    // This allows fills during pre-market and after-hours sessions.
    const orderBody: Record<string, unknown> = {
      symbol,
      side: params.side.toLowerCase(),
      type: isCrypto ? params.orderType : "limit",
      time_in_force: isCrypto ? "gtc" : "day",
    };

    const tradeValue = params.tradeValueUsd || CONFIG.TRADE_VALUE_USD;

    if (!isCrypto) {
      // Use the signal price as the limit price
      const signalPrice = params.limitPrice || (tradeValue / params.quantity);
      // Add 1% slippage buffer for BUY, subtract for SELL
      const limitPrice = params.side === "BUY"
        ? (signalPrice * 1.01).toFixed(2)
        : (signalPrice * 0.99).toFixed(2);
      orderBody.limit_price = limitPrice;
      orderBody.extended_hours = true;
    }

    // For crypto: use notional (dollar amount) — Alpaca calculates the exact qty
    if (isCrypto) {
      orderBody.notional = tradeValue.toFixed(2);
    } else {
      // Alpaca: fractional orders must be "simple" (no bracket/oto).
      // Round down to whole shares so we can use bracket orders with SL/TP.
      const wholeQty = Math.floor(params.quantity);
      if (wholeQty < 1) {
        orderBody.notional = tradeValue.toFixed(2);
      } else {
        orderBody.qty = wholeQty.toString();
      }
    }

    // Check if US stock market is currently open (9:30 AM–4:00 PM ET, Mon-Fri)
    const isMarketOpen = (() => {
      const now = new Date();
      const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const day = et.getDay();
      if (day === 0 || day === 6) return false; // Weekend
      const mins = et.getHours() * 60 + et.getMinutes();
      return mins >= 570 && mins < 960; // 9:30=570, 16:00=960
    })();

    // For stocks: use bracket orders with SL/TP only during market hours.
    // Extended hours require simple limit orders (no bracket).
    let useBracket = false;
    if (!isCrypto && isMarketOpen && orderBody.qty && params.stopLoss && params.takeProfit) {
      orderBody.order_class = "bracket";
      orderBody.stop_loss = { stop_price: params.stopLoss.toString() };
      orderBody.take_profit = { limit_price: params.takeProfit.toString() };
      delete orderBody.extended_hours; // bracket doesn't support extended hours
      useBracket = true;
      logger.info("[ALPACA] Market open — using bracket order", { symbol });
    } else if (!isCrypto && isMarketOpen && orderBody.qty && params.stopLoss) {
      orderBody.order_class = "oto";
      orderBody.stop_loss = { stop_price: params.stopLoss.toString() };
      delete orderBody.extended_hours;
      useBracket = true;
    } else if (!isCrypto && !isMarketOpen) {
      logger.info("[ALPACA] Market closed — using limit order with extended hours", { symbol });
    }

    try {
      // Only cancel stale open orders if there is NO existing position for this symbol
      const config = this.getConfig();
      // Alpaca positions API uses no-slash symbol format (ETHUSD not ETH/USD)
      const posSymbol = symbol.replace("/", "");
      const posResp = await fetch(
        `${config.baseUrl}/v2/positions/${encodeURIComponent(posSymbol)}`,
        { headers: this.getHeaders() }
      );
      if (!posResp.ok) {
        // No position — safe to cancel orphaned SL/TP orders
        await this.cancelOpenOrders(symbol);
      } else {
        logger.info("[ALPACA] Existing position found, keeping open orders", { symbol });
      }

      logger.info("[ALPACA] Placing order", { symbol, side: params.side, isCrypto, bracket: useBracket, extended: !!orderBody.extended_hours });

      let { ok, data } = await this.submitOrder(orderBody);

      // If bracket order failed, retry as simple limit order with extended hours
      if (!ok && useBracket) {
        const errMsg = String(data.message || "");
        logger.warn("[ALPACA] Bracket order failed, retrying as simple limit order", { symbol, error: errMsg });
        delete orderBody.order_class;
        delete orderBody.stop_loss;
        delete orderBody.take_profit;
        orderBody.extended_hours = true;
        const retry = await this.submitOrder(orderBody);
        ok = retry.ok;
        data = retry.data;
      }

      if (!ok) {
        logger.error("[ALPACA] Order failed", { data });
        return {
          success: false,
          orderId: "",
          status: "FAILED",
          message: `Alpaca error: ${data.message || "unknown"}`,
          raw: data,
        };
      }

      const entryOrderId = data.id as string;
      const exitSide = params.side === "BUY" ? "sell" : "buy";
      const db = getFirestore();

      // For crypto: wait for fill, then place SL order using actual position qty
      if (isCrypto && params.stopLoss) {
        let slQty: string | null = null;
        const maxAttempts = 15;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          await new Promise((r) => setTimeout(r, 2000));

          // Try position first — most reliable and accounts for fees
          try {
            // Alpaca positions API uses no-slash format (ETHUSD not ETH/USD)
            const posSymbol = symbol.replace("/", "");
            const posResp = await fetch(`${config.baseUrl}/v2/positions/${encodeURIComponent(posSymbol)}`, {
              headers: this.getHeaders(),
            });
            if (posResp.ok) {
              const posData = await posResp.json() as Record<string, unknown>;
              const qty = parseFloat(posData.qty as string || "0");
              logger.info("[ALPACA] Position check", { symbol, qty, attempt });
              if (qty > 0) {
                slQty = posData.qty as string;
                break;
              }
            } else {
              logger.info("[ALPACA] No position yet", { symbol, status: posResp.status, attempt });
            }
          } catch (err) {
            logger.warn("[ALPACA] Position fetch error", { attempt, err: String(err) });
          }
        }

        if (!slQty || parseFloat(slQty) <= 0) {
          logger.error("[ALPACA] Could not get position qty for SL after polling", { symbol });
          await db.collection("broker_errors").add({
            signalId: entryOrderId,
            broker: "alpaca",
            symbol: params.symbol,
            side: exitSide,
            orderType: "sl_skipped",
            error: "Could not determine position qty after waiting",
            timestamp: FieldValue.serverTimestamp(),
          });
        }

        if (slQty) {
          try {
            const slStop = parseFloat(params.stopLoss.toString());
            const slLimit = (slStop * 0.99).toFixed(2);
            const slResult = await this.submitOrder({
              symbol,
              qty: slQty,
              side: exitSide,
              type: "stop_limit",
              stop_price: params.stopLoss.toString(),
              limit_price: slLimit,
              time_in_force: "gtc",
            });
            if (slResult.ok) {
              logger.info("[ALPACA] Crypto SL order placed", { id: slResult.data.id, qty: slQty, stopPrice: params.stopLoss });
            } else {
              logger.error("[ALPACA] Crypto SL order failed", { data: slResult.data });
              await db.collection("broker_errors").add({
                signalId: entryOrderId,
                broker: "alpaca",
                symbol: params.symbol,
                side: exitSide,
                orderType: "stop_loss",
                error: slResult.data.message || "SL order failed",
                raw: slResult.data,
                timestamp: FieldValue.serverTimestamp(),
              });
            }
          } catch (err) {
            logger.error("[ALPACA] Crypto SL order error", err);
          }
        }
      }

      return {
        success: true,
        orderId: entryOrderId,
        status: data.status === "filled" ? "FILLED" : "PENDING",
        filledPrice: data.filled_avg_price
          ? parseFloat(data.filled_avg_price as string)
          : undefined,
        message: `Order ${data.status}`,
        raw: data,
      };
    } catch (err) {
      logger.error("[ALPACA] Request failed", err);
      return {
        success: false,
        orderId: "",
        status: "FAILED",
        message: `Alpaca request failed: ${String(err)}`,
      };
    }
  }

  private toAlpacaSymbol(symbol: string): { symbol: string; isCrypto: boolean } {
    const isCrypto = symbol.endsWith("USD") || symbol.endsWith("USDT") || symbol.includes("/");
    const alpacaSymbol = isCrypto && !symbol.includes("/")
      ? symbol.replace(/USDT?$/, "") + "/USD"
      : symbol;
    return { symbol: alpacaSymbol, isCrypto };
  }

  async getPosition(symbol: string): Promise<BrokerPosition | null> {
    const config = this.getConfig();
    const { symbol: alpacaSymbol } = this.toAlpacaSymbol(symbol);
    const posSymbol = alpacaSymbol.replace("/", "");

    try {
      const resp = await fetch(
        `${config.baseUrl}/v2/positions/${encodeURIComponent(posSymbol)}`,
        { headers: this.getHeaders() }
      );
      if (!resp.ok) return null;

      const data = await resp.json() as Record<string, unknown>;
      const qty = parseFloat(data.qty as string || "0");
      if (qty <= 0) return null;

      return {
        symbol: data.symbol as string,
        qty,
        currentPrice: parseFloat(data.current_price as string || "0"),
        costBasis: parseFloat(data.cost_basis as string || "0"),
        assetClass: data.asset_class as string,
      };
    } catch (err) {
      logger.warn("[ALPACA] getPosition error", { symbol, err: String(err) });
      return null;
    }
  }

  async liquidatePosition(symbol: string): Promise<Record<string, unknown>> {
    const config = this.getConfig();
    const headers = this.getHeaders();
    const { symbol: alpacaSymbol, isCrypto: _ } = this.toAlpacaSymbol(symbol);
    const cryptoSymbol = alpacaSymbol;

    // 1. Cancel all open orders for this symbol
    let cancelledCount = 0;
    try {
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
            if (cancelResp.ok || cancelResp.status === 204) cancelledCount++;
          }
        }
      }
      if (cancelledCount > 0) {
        logger.info("[ALPACA] Cancelled open orders", { symbol, cancelledCount });
      }
    } catch (cancelErr) {
      logger.warn("[ALPACA] Error cancelling orders", { symbol, error: String(cancelErr) });
    }

    // 2. Fetch current position
    const posSymbol = encodeURIComponent(symbol);
    const posResp = await fetch(`${config.baseUrl}/v2/positions/${posSymbol}`, { headers });
    if (!posResp.ok) {
      throw new Error(`No position found for ${symbol}`);
    }
    const position = (await posResp.json()) as Record<string, string>;
    const isCrypto = (position.asset_class || "").toLowerCase() === "crypto";

    const isMarketOpen = (() => {
      const now = new Date();
      const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const day = et.getDay();
      if (day === 0 || day === 6) return false;
      const mins = et.getHours() * 60 + et.getMinutes();
      return mins >= 570 && mins < 960;
    })();

    let closeData: Record<string, unknown>;

    if (!isCrypto && !isMarketOpen) {
      const currentPrice = parseFloat(position.current_price || "0");
      const limitPrice = (currentPrice * 0.98).toFixed(2);
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
        throw new Error(`Extended hours liquidation failed: ${errMsg}`);
      }
      closeData = (await orderResp.json()) as Record<string, unknown>;
      logger.info("[ALPACA] Extended hours limit sell placed", { symbol, qty: position.qty, limitPrice });
    } else {
      const closeResp = await fetch(`${config.baseUrl}/v2/positions/${posSymbol}`, {
        method: "DELETE",
        headers,
      });

      if (!closeResp.ok) {
        let errMsg = await closeResp.text();
        try { const j = JSON.parse(errMsg); if (j.message) errMsg = j.message; } catch {}
        throw new Error(`Liquidation failed: ${errMsg}`);
      }
      closeData = (await closeResp.json()) as Record<string, unknown>;
    }

    logger.info("[ALPACA] Position liquidated", { symbol, cancelledOrders: cancelledCount });
    return closeData;
  }

  async updateStopLoss(symbol: string, newStopPrice: number): Promise<{ success: boolean; orderId?: string; message: string }> {
    const config = this.getConfig();
    const headers = this.getHeaders();
    const { symbol: alpacaSymbol } = this.toAlpacaSymbol(symbol);
    const posSymbol = alpacaSymbol.replace("/", "");

    // 1. Get current position for qty
    const posResp = await fetch(`${config.baseUrl}/v2/positions/${encodeURIComponent(posSymbol)}`, { headers });
    if (!posResp.ok) {
      return { success: false, message: `No open position for ${symbol}` };
    }
    const position = await posResp.json() as Record<string, string>;
    const qty = position.qty;
    if (!qty || parseFloat(qty) <= 0) {
      return { success: false, message: `No open position for ${symbol}` };
    }

    // 2. Cancel any existing stop/stop_limit orders for this symbol
    try {
      const ordersResp = await fetch(
        `${config.baseUrl}/v2/orders?status=open&symbols=${encodeURIComponent(posSymbol)}&limit=100`,
        { headers }
      );
      if (ordersResp.ok) {
        const orders = await ordersResp.json() as Array<Record<string, string>>;
        const stopOrders = orders.filter((o) => o.type === "stop" || o.type === "stop_limit");
        for (const order of stopOrders) {
          await fetch(`${config.baseUrl}/v2/orders/${order.id}`, { method: "DELETE", headers });
        }
        if (stopOrders.length > 0) {
          logger.info("[ALPACA] updateStopLoss: cancelled existing stop orders", { symbol, count: stopOrders.length });
        }
      }
    } catch (cancelErr) {
      logger.warn("[ALPACA] updateStopLoss: cancel error (non-fatal)", { symbol, error: String(cancelErr) });
    }

    // 3. Place new stop order (stop_limit with 1% buffer below stop)
    const limitPrice = (newStopPrice * 0.99).toFixed(2);
    const stopPriceStr = newStopPrice.toFixed(2);
    const orderBody: Record<string, unknown> = {
      symbol: posSymbol,
      qty,
      side: "sell",
      type: "stop_limit",
      stop_price: stopPriceStr,
      limit_price: limitPrice,
      time_in_force: "gtc",
    };

    try {
      const orderResp = await fetch(`${config.baseUrl}/v2/orders`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(orderBody),
      });
      const data = await orderResp.json() as Record<string, unknown>;
      if (!orderResp.ok) {
        const msg = (data.message || data.code || "unknown error") as string;
        logger.error("[ALPACA] updateStopLoss: order failed", { symbol, data });
        await getFirestore().collection("broker_errors").add({
          broker: "alpaca",
          action: "updateStopLoss",
          symbol,
          stopPrice: newStopPrice,
          error: `Failed to place stop order: ${msg}`,
          raw: JSON.stringify(data).slice(0, 1000),
          timestamp: FieldValue.serverTimestamp(),
        });
        return { success: false, message: `Failed to place stop order: ${msg}` };
      }
      const orderId = data.id as string | undefined;
      logger.info("[ALPACA] updateStopLoss: stop order placed", { symbol, orderId, stopPrice: newStopPrice });
      return { success: true, orderId, message: `Stop loss updated to $${newStopPrice.toFixed(2)}` };
    } catch (err) {
      logger.error("[ALPACA] updateStopLoss error", { err: String(err) });
      await getFirestore().collection("broker_errors").add({
        broker: "alpaca",
        action: "updateStopLoss",
        symbol,
        stopPrice: newStopPrice,
        error: String(err),
        timestamp: FieldValue.serverTimestamp(),
      });
      return { success: false, message: `Error: ${String(err)}` };
    }
  }

  /**
   * Fetch all open positions with PnL + open stop-loss price (if any).
   * Symbol returned in Alpaca's canonical form (e.g. "BTC/USD", "AAPL").
   */
  async getDetailedPositions(): Promise<DetailedPosition[]> {
    const config = this.getConfig();
    const headers = this.getHeaders();

    let rawPositions: Array<Record<string, string>> = [];
    try {
      const resp = await fetch(`${config.baseUrl}/v2/positions`, { headers });
      if (!resp.ok) {
        logger.warn("[ALPACA] getDetailedPositions: positions fetch failed", { status: resp.status });
        return [];
      }
      rawPositions = (await resp.json()) as Array<Record<string, string>>;
    } catch (err) {
      logger.warn("[ALPACA] getDetailedPositions: positions error", { err: String(err) });
      return [];
    }

    if (rawPositions.length === 0) return [];

    // Index open stop / stop_limit SELL orders by symbol → stop_price.
    const stopPriceBySymbol = new Map<string, string>();
    try {
      const ordersResp = await fetch(
        `${config.baseUrl}/v2/orders?status=open&limit=500`,
        { headers },
      );
      if (ordersResp.ok) {
        const orders = (await ordersResp.json()) as Array<Record<string, string>>;
        for (const o of orders) {
          if (o.side !== "sell") continue;
          if (o.type !== "stop" && o.type !== "stop_limit") continue;
          if (o.stop_price && o.symbol) stopPriceBySymbol.set(o.symbol, o.stop_price);
        }
      }
    } catch (err) {
      logger.warn("[ALPACA] getDetailedPositions: orders fetch error (non-fatal)", { err: String(err) });
    }

    return rawPositions.map((p) => {
      const symbol = p.symbol || "";
      const stopLoss = stopPriceBySymbol.get(symbol);
      return {
        symbol,
        qty: p.qty || "0",
        avg_entry_price: p.avg_entry_price || "0",
        current_price: p.current_price || "0",
        market_value: p.market_value || "0",
        cost_basis: p.cost_basis || "0",
        unrealized_pl: p.unrealized_pl || "0",
        unrealized_plpc: p.unrealized_plpc || "0",
        unrealized_intraday_pl: p.unrealized_intraday_pl || "0",
        unrealized_intraday_plpc: p.unrealized_intraday_plpc || "0",
        change_today: p.change_today || "0",
        side: p.side || "long",
        asset_class: p.asset_class || "",
        ...(stopLoss !== undefined && { stop_loss: stopLoss }),
      } as DetailedPosition;
    });
  }

  /**
   * Per-tranche DCA buy breakdown for a single held equity — the individual BUY
   * fills that make up the current holding plus a position summary. Returns null
   * if nothing is held. Walks BUY fills newest-first only up to the current
   * quantity, so prior closed-out cycles are excluded.
   */
  async getPositionBuys(symbol: string): Promise<{
    symbol: string;
    qty: number;
    avgEntryPrice: number;
    currentPrice: number;
    costBasisUsd: number;
    marketValueUsd: number;
    unrealizedPlUsd: number;
    unrealizedPlPct: number;
    buys: Array<{ time: string; price: number; sizeBase: number; usdValue: number }>;
  } | null> {
    const config = this.getConfig();
    const headers = this.getHeaders();
    const sym = symbol.toUpperCase();

    // Current position summary.
    let pos: Record<string, string>;
    try {
      const resp = await fetch(`${config.baseUrl}/v2/positions/${encodeURIComponent(sym)}`, { headers });
      if (!resp.ok) return null; // 404 = no position
      pos = (await resp.json()) as Record<string, string>;
    } catch {
      return null;
    }
    const totalQty = parseFloat(pos.qty || "0");
    if (totalQty <= 0) return null;

    // Walk FILL activities (newest-first) accumulating BUY fills up to totalQty.
    const buys: Array<{ time: string; price: number; sizeBase: number; usdValue: number }> = [];
    let remainingQty = totalQty;
    try {
      const resp = await fetch(
        `${config.baseUrl}/v2/account/activities/FILL?symbols=${encodeURIComponent(sym)}&direction=desc&page_size=100`,
        { headers },
      );
      if (resp.ok) {
        const acts = (await resp.json()) as Array<Record<string, string>>;
        for (const a of acts) {
          if ((a.side || "").toLowerCase() !== "buy" || remainingQty <= 0) continue;
          const price = parseFloat(a.price || "0");
          const qty = parseFloat(a.qty || "0");
          if (qty <= 0) continue;
          const usedQty = Math.min(qty, remainingQty);
          remainingQty -= usedQty;
          buys.push({ time: a.transaction_time || "", price, sizeBase: usedQty, usdValue: usedQty * price });
        }
      }
    } catch {
      // non-fatal — summary still returns
    }
    buys.reverse(); // oldest-first for display

    return {
      symbol: sym,
      qty: totalQty,
      avgEntryPrice: parseFloat(pos.avg_entry_price || "0"),
      currentPrice: parseFloat(pos.current_price || "0"),
      costBasisUsd: parseFloat(pos.cost_basis || "0"),
      marketValueUsd: parseFloat(pos.market_value || "0"),
      unrealizedPlUsd: parseFloat(pos.unrealized_pl || "0"),
      unrealizedPlPct: parseFloat(pos.unrealized_plpc || "0") * 100,
      buys,
    };
  }

  /**
   * Fetch OHLCV bars for a symbol, oldest-first.
   * Routes to the crypto or equities data API based on the symbol form.
   */
  async getCandles(
    symbol: string,
    granularity: "ONE_MINUTE" | "FIVE_MINUTE" | "FIFTEEN_MINUTE" | "ONE_HOUR",
    count: number,
  ): Promise<Candle[]> {
    const headers = this.getHeaders();
    const tfMap: Record<string, string> = {
      ONE_MINUTE: "1Min",
      FIVE_MINUTE: "5Min",
      FIFTEEN_MINUTE: "15Min",
      ONE_HOUR: "1Hour",
    };
    const timeframe = tfMap[granularity] ?? "1Min";

    const { symbol: alpacaSymbol, isCrypto } = this.toAlpacaSymbol(symbol);
    // Pull a little extra to allow for missing bars.
    const limit = Math.min(Math.max(count + 5, 50), 10000);

    try {
      let url: string;
      if (isCrypto) {
        // Crypto data endpoint: v1beta3, symbol format "BTC/USD".
        url = `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(alpacaSymbol)}&timeframe=${timeframe}&limit=${limit}&sort=asc`;
      } else {
        // Stocks data endpoint: v2.
        url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(alpacaSymbol)}&timeframe=${timeframe}&limit=${limit}&sort=asc&feed=iex`;
      }

      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        logger.warn("[ALPACA] getCandles fetch failed", { symbol: alpacaSymbol, status: resp.status });
        return [];
      }
      const data = await resp.json() as { bars?: Record<string, Array<Record<string, string | number>>> };
      const barsBySymbol = data.bars || {};
      const rawBars = barsBySymbol[alpacaSymbol] || [];
      if (!Array.isArray(rawBars) || rawBars.length === 0) return [];

      const candles: Candle[] = rawBars.map((b) => ({
        start: Math.floor(new Date(String(b.t)).getTime() / 1000),
        open: Number(b.o) || 0,
        high: Number(b.h) || 0,
        low: Number(b.l) || 0,
        close: Number(b.c) || 0,
        volume: Number(b.v) || 0,
      })).filter((c) => Number.isFinite(c.start));

      candles.sort((a, b) => a.start - b.start);
      return candles.slice(-count);
    } catch (err) {
      logger.warn("[ALPACA] getCandles error", { symbol: alpacaSymbol, err: String(err) });
      return [];
    }
  }
}
