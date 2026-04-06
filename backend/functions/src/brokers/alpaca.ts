import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { IBroker } from "./interface";
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

    if (!isCrypto) {
      // Use the signal price as the limit price
      const signalPrice = params.limitPrice || (CONFIG.TRADE_VALUE_USD / params.quantity);
      // Add 1% slippage buffer for BUY, subtract for SELL
      const limitPrice = params.side === "BUY"
        ? (signalPrice * 1.01).toFixed(2)
        : (signalPrice * 0.99).toFixed(2);
      orderBody.limit_price = limitPrice;
      orderBody.extended_hours = true;
    }

    // For crypto: use notional (dollar amount) — Alpaca calculates the exact qty
    if (isCrypto) {
      orderBody.notional = CONFIG.TRADE_VALUE_USD.toFixed(2);
    } else {
      // Alpaca: fractional orders must be "simple" (no bracket/oto).
      // Round down to whole shares so we can use bracket orders with SL/TP.
      const wholeQty = Math.floor(params.quantity);
      if (wholeQty < 1) {
        orderBody.notional = CONFIG.TRADE_VALUE_USD.toFixed(2);
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
}
