import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as crypto from "crypto";
import { SignJWT, importPKCS8 } from "jose";
import { IBroker, BrokerPosition, DetailedPosition } from "./interface";
import { PlaceOrderParams, PlaceOrderResult } from "../types";
import { getCoinbaseConfig, CONFIG } from "../config";

const API_BASE = "https://api.coinbase.com";
const API_HOST = "api.coinbase.com";
const API_PREFIX = "/api/v3/brokerage";

/**
 * Coinbase Advanced Trade broker implementation.
 * Uses CDP API keys with ES256 JWT authentication.
 */
export class CoinbaseBroker implements IBroker {
  readonly name = "coinbase";

  private getConfig() {
    return getCoinbaseConfig();
  }

  /**
   * Generate a JWT for Coinbase CDP API authentication.
   * Each request needs a fresh JWT (expires in 120s).
   */
  private async generateJWT(method: string, path: string): Promise<string> {
    const config = this.getConfig();
    // Strip query params from URI claim — Coinbase CDP JWT must not include them
    const pathWithoutQuery = path.split("?")[0];
    const uri = `${method} ${API_HOST}${pathWithoutQuery}`;
    const now = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");

    // The CDP key may be SEC1 (BEGIN EC PRIVATE KEY) — convert to PKCS#8 for jose
    let pem = config.apiSecret;
    if (pem.includes("BEGIN EC PRIVATE KEY")) {
      const keyObj = crypto.createPrivateKey({ key: pem, format: "pem" });
      pem = keyObj.export({ type: "pkcs8", format: "pem" }) as string;
    }
    const privateKey = await importPKCS8(pem, "ES256");

    const jwt = await new SignJWT({
      sub: config.apiKey,
      iss: "cdp",
      nbf: now,
      exp: now + 120,
      uri,
    })
      .setProtectedHeader({
        alg: "ES256",
        kid: config.apiKey,
        nonce,
        typ: "JWT",
      })
      .sign(privateKey);

    return jwt;
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const fullPath = `${API_PREFIX}${path}`;
    const jwt = await this.generateJWT(method, fullPath);

    const response = await fetch(`${API_BASE}${fullPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { rawBody: text, httpStatus: response.status };
    }
    return { ok: response.ok, data };
  }

  /**
   * Convert symbol from BTCUSD format to BTC-USD (Coinbase product_id format).
   */
  private toProductId(symbol: string): string {
    // If already hyphenated, return as-is
    if (symbol.includes("-")) return symbol;
    // Strip trailing USD/USDT and add hyphen
    const base = symbol.replace(/USDT?$/, "");
    return `${base}-USD`;
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    const config = this.getConfig();

    if (!config.apiKey || !config.apiSecret) {
      return {
        success: false,
        orderId: "",
        status: "FAILED",
        message: "Coinbase CDP API credentials not configured",
      };
    }

    const productId = this.toProductId(params.symbol);
    const clientOrderId = crypto.randomUUID();
    const side = params.side; // "BUY" or "SELL"

    // Build order_configuration based on order type
    const tradeValue = params.tradeValueUsd || CONFIG.TRADE_VALUE_USD;
    let orderConfiguration: Record<string, unknown>;

    if (params.orderType === "market") {
      if (side === "BUY") {
        // Market buy: use quote_size (dollar amount)
        orderConfiguration = {
          market_market_ioc: {
            quote_size: tradeValue.toFixed(4),
          },
        };
      } else {
        // Market sell: use base_size (asset quantity)
        orderConfiguration = {
          market_market_ioc: {
            base_size: params.quantity.toString(),
          },
        };
      }
    } else {
      // Limit order: use limit_limit_gtc
      const limitPrice = params.limitPrice || tradeValue / params.quantity;
      if (side === "BUY") {
        orderConfiguration = {
          limit_limit_gtc: {
            quote_size: tradeValue.toFixed(4),
            limit_price: limitPrice.toFixed(4),
            post_only: false,
          },
        };
      } else {
        orderConfiguration = {
          limit_limit_gtc: {
            base_size: params.quantity.toString(),
            limit_price: limitPrice.toFixed(4),
            post_only: false,
          },
        };
      }
    }

    const orderBody: Record<string, unknown> = {
      client_order_id: clientOrderId,
      product_id: productId,
      side,
      order_configuration: orderConfiguration,
    };

    try {
      logger.info("[COINBASE] Placing order", {
        productId,
        side,
        orderType: params.orderType,
      });

      const { ok, data } = await this.request("POST", "/orders", orderBody);

      if (!ok || data.success === false) {
        const errorResponse = data.error_response as Record<string, unknown> | undefined;
        const errorMsg = errorResponse?.message || errorResponse?.error_details || data.message || "unknown error";
        logger.error("[COINBASE] Order failed", { data });
        return {
          success: false,
          orderId: "",
          status: "FAILED",
          message: `Coinbase error: ${errorMsg}`,
          raw: data,
        };
      }

      const successResponse = data.success_response as Record<string, unknown> | undefined;
      const orderId = (successResponse?.order_id || clientOrderId) as string;

      logger.info("[COINBASE] Order placed", { orderId, productId, side });

      // If stop loss is requested, place a stop-limit order
      if (params.stopLoss && side === "BUY") {
        await this.placeStopLoss(productId, params.stopLoss, params.quantity, orderId);
      }

      const db = getFirestore();
      await db.collection("orders").add({
        signalId: orderId,
        broker: "coinbase",
        orderType: params.orderType,
        side: params.side,
        symbol: params.symbol,
        quantity: params.quantity,
        status: "FILLED",
        responsePayload: data,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        success: true,
        orderId,
        status: "FILLED",
        message: "Order placed on Coinbase",
        raw: data,
      };
    } catch (err) {
      logger.error("[COINBASE] Order error", { err: String(err) });
      return {
        success: false,
        orderId: "",
        status: "FAILED",
        message: `Coinbase error: ${String(err)}`,
      };
    }
  }

  /**
   * Place a stop-limit sell order as a protective stop loss.
   * Uses stop_limit_stop_limit_gtc with STOP_DIRECTION_STOP_DOWN.
   */
  private async placeStopLoss(
    productId: string,
    stopPrice: number,
    quantity: number,
    parentOrderId: string
  ): Promise<void> {
    // Wait for the entry order to fill before placing SL
    // Poll for up to 30 seconds
    let baseSize: string | null = null;
    const maxAttempts = 15;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const { ok, data } = await this.request("GET", `/orders/historical/${parentOrderId}`);
        if (ok) {
          const order = data.order as Record<string, unknown> | undefined;
          if (order && order.status === "FILLED") {
            const filledSize = order.filled_size as string;
            if (filledSize && parseFloat(filledSize) > 0) {
              baseSize = filledSize;
              break;
            }
          }
        }
      } catch (err) {
        logger.warn("[COINBASE] SL poll error", { attempt, err: String(err) });
      }
    }

    if (!baseSize || parseFloat(baseSize) <= 0) {
      logger.error("[COINBASE] Could not get filled size for SL", { productId });
      const db = getFirestore();
      await db.collection("broker_errors").add({
        signalId: parentOrderId,
        broker: "coinbase",
        symbol: productId,
        side: "SELL",
        orderType: "sl_skipped",
        error: "Could not determine filled size after waiting",
        timestamp: FieldValue.serverTimestamp(),
      });
      return;
    }

    // Stop-limit: trigger at stopPrice, limit slightly below (1% buffer)
    const limitPrice = (stopPrice * 0.99).toFixed(4);
    const slBody: Record<string, unknown> = {
      client_order_id: crypto.randomUUID(),
      product_id: productId,
      side: "SELL",
      order_configuration: {
        stop_limit_stop_limit_gtc: {
          base_size: baseSize,
          limit_price: limitPrice,
          stop_price: stopPrice.toFixed(4),
          stop_direction: "STOP_DIRECTION_STOP_DOWN",
        },
      },
    };

    try {
      const { ok, data } = await this.request("POST", "/orders", slBody);
      if (!ok || data.success === false) {
        logger.error("[COINBASE] SL order failed", { data });
      } else {
        const slResponse = data.success_response as Record<string, unknown> | undefined;
        logger.info("[COINBASE] SL order placed", { orderId: slResponse?.order_id, stopPrice });
      }
    } catch (err) {
      logger.error("[COINBASE] SL order error", { err: String(err) });
    }
  }

  /**
   * Cancel any existing stop-loss orders for a product and place a new one.
   * Used for "move to break-even" or "trail stop" actions from the app.
   */
  async updateStopLoss(symbol: string, newStopPrice: number): Promise<{ success: boolean; orderId?: string; message: string }> {
    const productId = this.toProductId(symbol);

    // 1. Query position directly via accounts API
    logger.info("[COINBASE] updateStopLoss: querying position", { symbol, productId, newStopPrice });
    const { ok: acctOk, data: acctData } = await this.request("GET", "/accounts?limit=250");
    logger.info("[COINBASE] updateStopLoss: accounts response", { ok: acctOk, keys: Object.keys(acctData) });
    if (!acctOk) {
      return { success: false, message: `Coinbase accounts API failed for ${symbol}` };
    }
    const accounts = acctData.accounts as Array<Record<string, unknown>> | undefined;
    const baseCurrency = productId.split("-")[0];
    const acct = (accounts || []).find((a) => (a.currency as string) === baseCurrency);
    if (!acct) {
      logger.warn("[COINBASE] updateStopLoss: no account for currency", { baseCurrency, total: (accounts || []).length });
      return { success: false, message: `No open position for ${symbol}` };
    }
    const available = parseFloat(((acct.available_balance as Record<string, string>) || {}).value || "0");
    const held = parseFloat(((acct.hold as Record<string, string>) || {}).value || "0");
    const posQty = available + held;
    logger.info("[COINBASE] updateStopLoss: found account", { baseCurrency, available, held, posQty });
    if (posQty <= 0) {
      return { success: false, message: `No open position for ${symbol}` };
    }

    // 2. Cancel all existing SELL stop-limit orders for this product
    try {
      const { ok, data } = await this.request("GET", `/orders/historical/batch?product_id=${productId}&order_status=OPEN&limit=100`);
      if (ok) {
        const orders = data.orders as Array<Record<string, unknown>> | undefined;
        const slOrders = (orders || []).filter((o) => {
          const cfg = o.order_configuration as Record<string, unknown> | undefined;
          return o.side === "SELL" && (cfg?.stop_limit_stop_limit_gtc || cfg?.stop_limit_stop_limit_gtd);
        });
        if (slOrders.length > 0) {
          const ids = slOrders.map((o) => o.order_id as string);
          await this.request("POST", "/orders/batch_cancel", { order_ids: ids });
          logger.info("[COINBASE] Cancelled existing SL orders", { productId, count: ids.length });
          // Brief pause to let balance release
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
    } catch (cancelErr) {
      logger.warn("[COINBASE] updateStopLoss: cancel error (non-fatal)", { productId, error: String(cancelErr) });
    }

    // 3. Place new stop-limit order using product's quote_increment for correct precision
    const extractError = (data: Record<string, unknown>): string => {
      const errResp = data.error_response as Record<string, unknown> | undefined;
      return (
        (errResp?.message as string) ||
        (errResp?.error_details as string) ||
        (errResp?.preview_failure_reason as string) ||
        (errResp?.new_order_failure_reason as string) ||
        (data.message as string) ||
        (data.failure_reason as string) ||
        (data.error as string) ||
        "unknown error"
      );
    };

    const isDecimalError = (msg: string) =>
      /decimal|precision|invalid.*number|too many|increment/i.test(msg);

    // Format base_size: trim float noise, max 8 decimal places then strip trailing zeros
    const formatQty = (qty: number): string => {
      const s = qty.toFixed(8);
      return s.replace(/\.?0+$/, "") || "0";
    };

    // Round a number to match a quote_increment string like "0.01" or "0.001"
    const roundToIncrement = (value: number, increment: string): string => {
      const parts = increment.split(".");
      const decimals = parts.length > 1 ? parts[1].length : 0;
      // Round to nearest increment
      const factor = Math.pow(10, decimals);
      const rounded = Math.round(value * factor) / factor;
      return rounded.toFixed(decimals);
    };

    // Fetch product info to get quote_increment (price tick size)
    let quoteIncrement = "0.01"; // fallback
    try {
      const { ok: prodOk, data: prodData } = await this.request("GET", `/products/${productId}`);
      if (prodOk && prodData.quote_increment) {
        quoteIncrement = prodData.quote_increment as string;
        logger.info("[COINBASE] updateStopLoss: product info", { productId, quoteIncrement });
      }
    } catch {
      logger.warn("[COINBASE] updateStopLoss: could not fetch product info, using default increment", { productId });
    }

    const stopStr = roundToIncrement(newStopPrice, quoteIncrement);
    // Limit price: 1% below stop, also rounded to quote increment
    const limitStr = roundToIncrement(newStopPrice * 0.99, quoteIncrement);
    logger.info("[COINBASE] updateStopLoss: placing order", { productId, qty: formatQty(posQty), stopStr, limitStr, quoteIncrement });

    const slBody: Record<string, unknown> = {
      client_order_id: crypto.randomUUID(),
      product_id: productId,
      side: "SELL",
      order_configuration: {
        stop_limit_stop_limit_gtc: {
          base_size: formatQty(posQty),
          limit_price: limitStr,
          stop_price: stopStr,
          stop_direction: "STOP_DIRECTION_STOP_DOWN",
        },
      },
    };

    try {
      let lastMsg = "unknown error";
      let lastRaw = "";
      // Try with computed precision, then fall back through decreasing precision
      const decimals = quoteIncrement.includes(".") ? quoteIncrement.split(".")[1].length : 0;
      const decimalSequence = [...new Set([decimals, Math.max(0, decimals - 1), 2, 1, 0])];
      for (const d of decimalSequence) {
        const sStr = newStopPrice.toFixed(d);
        const lStr = (newStopPrice * 0.99).toFixed(d);
        const body = {
          ...slBody,
          client_order_id: crypto.randomUUID(),
          order_configuration: {
            stop_limit_stop_limit_gtc: {
              base_size: formatQty(posQty),
              limit_price: lStr,
              stop_price: sStr,
              stop_direction: "STOP_DIRECTION_STOP_DOWN",
            },
          },
        };
        const { ok, data } = await this.request("POST", "/orders", body);
        if (ok && data.success !== false) {
          const slResp = data.success_response as Record<string, unknown> | undefined;
          const orderId = slResp?.order_id as string | undefined;
          logger.info("[COINBASE] updateStopLoss: SL order placed", { productId, orderId, stopPrice: newStopPrice, d, sStr });
          return { success: true, orderId, message: `Stop loss updated to $${sStr}` };
        }
        lastMsg = extractError(data);
        lastRaw = JSON.stringify(data).slice(0, 500);
        logger.warn("[COINBASE] updateStopLoss: order attempt failed", { productId, d, sStr, lStr, lastMsg });
        if (!isDecimalError(lastMsg)) {
          // Non-precision error — no point retrying with different decimals
          logger.error("[COINBASE] updateStopLoss: non-recoverable order error", { productId, lastMsg });
          await getFirestore().collection("broker_errors").add({
            broker: "coinbase",
            action: "updateStopLoss",
            symbol,
            stopPrice: newStopPrice,
            error: `Failed: ${lastMsg}`,
            raw: lastRaw,
            timestamp: FieldValue.serverTimestamp(),
          });
          return { success: false, message: `Failed to place new stop loss: ${lastMsg}` };
        }
      }
      // All decimal attempts exhausted
      logger.error("[COINBASE] updateStopLoss: failed after all decimal retries", { productId, lastMsg });
      await getFirestore().collection("broker_errors").add({
        broker: "coinbase",
        action: "updateStopLoss",
        symbol,
        stopPrice: newStopPrice,
        error: `Failed after decimal retries: ${lastMsg}`,
        raw: lastRaw,
        timestamp: FieldValue.serverTimestamp(),
      });
      return { success: false, message: `Failed to place new stop loss: ${lastMsg}` };
    } catch (err) {
      logger.error("[COINBASE] updateStopLoss error", { err: String(err) });
      await getFirestore().collection("broker_errors").add({
        broker: "coinbase",
        action: "updateStopLoss",
        symbol,
        stopPrice: newStopPrice,
        error: String(err),
        timestamp: FieldValue.serverTimestamp(),
      });
      return { success: false, message: `Error: ${String(err)}` };
    }
  }

  async getPosition(symbol: string): Promise<BrokerPosition | null> {
    const productId = this.toProductId(symbol);

    try {
      // List accounts and find the one matching the base currency
      const { ok, data } = await this.request("GET", "/accounts?limit=250");
      if (!ok) {
        logger.warn("[COINBASE] getPosition accounts query failed", { data });
        return null;
      }

      const accounts = data.accounts as Array<Record<string, unknown>> | undefined;
      if (!accounts) {
        logger.warn("[COINBASE] getPosition no accounts array", { keys: Object.keys(data) });
        return null;
      }

      // Extract base currency from product_id (e.g. BTC from BTC-USD)
      const baseCurrency = productId.split("-")[0];

      for (const acct of accounts) {
        const currency = acct.currency as string;
        if (currency === baseCurrency) {
          const balanceObj = acct.available_balance as Record<string, string> | undefined;
          const holdObj = acct.hold as Record<string, string> | undefined;
          const available = parseFloat(balanceObj?.value || "0");
          const held = parseFloat(holdObj?.value || "0");
          const total = available + held;
          logger.info("[COINBASE] Found account balance", { currency, available, held, total });
          if (total <= 0) return null;

          return {
            symbol: productId,
            qty: total,
            currentPrice: 0,
            costBasis: 0,
            assetClass: "crypto",
          };
        }
      }

      logger.info("[COINBASE] No account found for currency", { baseCurrency, accountCount: accounts.length });
      return null;
    } catch (err) {
      logger.warn("[COINBASE] getPosition error", { symbol, err: String(err) });
      return null;
    }
  }

  async liquidatePosition(symbol: string): Promise<Record<string, unknown>> {
    const productId = this.toProductId(symbol);

    // Cancel all open orders for this product first (releases held balances)
    try {
      const { ok, data } = await this.request("GET", `/orders/historical/batch?product_id=${productId}&order_status=OPEN&limit=100`);
      if (ok) {
        const orders = data.orders as Array<Record<string, unknown>> | undefined;
        if (orders && orders.length > 0) {
          const orderIds = orders.map((o) => o.order_id as string);
          await this.request("POST", "/orders/batch_cancel", { order_ids: orderIds });
          logger.info("[COINBASE] Cancelled open orders before liquidation", { symbol: productId, count: orderIds.length });
          // Brief pause to let balance release
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    } catch (cancelErr) {
      logger.warn("[COINBASE] Error cancelling orders", { symbol, error: String(cancelErr) });
    }

    // Get position (balance) after cancelling orders
    const position = await this.getPosition(symbol);
    if (!position || position.qty <= 0) {
      throw new Error(`No position found for ${symbol}`);
    }

    // Place market sell for entire balance
    const sellBody: Record<string, unknown> = {
      client_order_id: crypto.randomUUID(),
      product_id: productId,
      side: "SELL",
      order_configuration: {
        market_market_ioc: {
          base_size: position.qty.toString(),
        },
      },
    };

    const { ok, data } = await this.request("POST", "/orders", sellBody);

    if (!ok || data.success === false) {
      const errorResponse = data.error_response as Record<string, unknown> | undefined;
      const errorMsg = errorResponse?.message || errorResponse?.error_details || "unknown error";
      throw new Error(`Coinbase liquidation failed: ${errorMsg}`);
    }

    logger.info("[COINBASE] Position liquidated", { symbol: productId, qty: position.qty });
    return data;
  }

  /**
   * Build detailed positions from Coinbase accounts, fills, and product prices.
   * Returns actual fees from fill data instead of simulated ones.
   */
  async getDetailedPositions(): Promise<DetailedPosition[]> {
    // 1. Get all accounts with non-zero balances
    const { ok: acctOk, data: acctData } = await this.request("GET", "/accounts?limit=250");
    if (!acctOk) {
      logger.error("[COINBASE] Failed to fetch accounts for positions", { data: acctData });
      return [];
    }

    const accounts = acctData.accounts as Array<Record<string, unknown>> | undefined;
    if (!accounts) return [];

    // Filter to accounts with non-zero balance, excluding USD/USDC
    const stablecoins = new Set(["USD", "USDC", "USDT"]);
    const holdingAccounts = accounts.filter((a) => {
      const currency = a.currency as string;
      if (stablecoins.has(currency)) return false;
      const available = parseFloat((a.available_balance as Record<string, string>)?.value || "0");
      const held = parseFloat((a.hold as Record<string, string>)?.value || "0");
      return (available + held) > 0;
    });

    if (holdingAccounts.length === 0) return [];

    // 2. Fetch all open stop-loss orders once (stop_limit_stop_limit_gtc SELL)
    const openSlOrders = new Map<string, string>(); // productId -> stop_price
    try {
      const { ok: slOk, data: slData } = await this.request("GET", "/orders/historical/batch?order_status=OPEN&limit=250");
      if (slOk) {
        const openOrders = slData.orders as Array<Record<string, unknown>> | undefined;
        if (openOrders) {
          for (const o of openOrders) {
            if (o.side !== "SELL") continue;
            const cfg = o.order_configuration as Record<string, unknown> | undefined;
            const slGtc = cfg?.stop_limit_stop_limit_gtc as Record<string, string> | undefined;
            if (slGtc?.stop_price) {
              openSlOrders.set(o.product_id as string, slGtc.stop_price);
            }
          }
        }
      }
    } catch {
      // non-fatal — positions still show without stop loss
    }

    // 3. For each holding, get fills and current price
    const positions: DetailedPosition[] = [];

    for (const acct of holdingAccounts) {
      const currency = acct.currency as string;
      const productId = `${currency}-USD`;
      const available = parseFloat((acct.available_balance as Record<string, string>)?.value || "0");
      const held = parseFloat((acct.hold as Record<string, string>)?.value || "0");
      const totalQty = available + held;

      // Get current price
      let currentPrice = 0;
      try {
        const { ok, data } = await this.request("GET", `/products/${productId}`);
        if (ok) {
          currentPrice = parseFloat((data.price as string) || "0");
        }
      } catch {
        // non-fatal
      }

      // Get recent fills for this product to compute avg entry price and actual fees
      let totalFees = 0;
      let totalBuyQty = 0;
      let totalBuyCost = 0;
      try {
        const { ok, data } = await this.request(
          "GET",
          `/orders/historical/fills?product_id=${productId}&limit=100`
        );
        if (ok) {
          const fills = data.fills as Array<Record<string, unknown>> | undefined;
          if (fills) {
            // Fills are returned newest-first. Walk backwards through BUY fills
            // and only accumulate until we've covered the current holding qty.
            // This ensures we only count fees for the buys that built THIS position.
            let remainingQty = totalQty;
            for (const fill of fills) {
              const side = fill.side as string;
              let fillQty = parseFloat((fill.size as string) || "0");
              const fillPrice = parseFloat((fill.price as string) || "0");
              const commission = parseFloat((fill.commission as string) || "0");
              const sizeInQuote = fill.size_in_quote as boolean | undefined;

              // Market buy fills placed with quote_size have size in quote currency (USD).
              // Convert to base currency for correct cost basis calculation.
              if (sizeInQuote && fillPrice > 0) {
                fillQty = fillQty / fillPrice;
              }

              if (side === "BUY" && remainingQty > 0) {
                const usedQty = Math.min(fillQty, remainingQty);
                totalBuyQty += usedQty;
                totalBuyCost += usedQty * fillPrice;
                totalFees += commission * (usedQty / fillQty); // prorate fee if partial
                remainingQty -= usedQty;
              }
              // Skip SELL fills — they belong to previous closed positions
            }
          }
        }
      } catch {
        // non-fatal
      }

      const avgEntryPrice = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;
      const marketValue = totalQty * currentPrice;
      const costBasis = totalQty * avgEntryPrice;
      // Estimate sell-side fee if position were closed now
      const estimatedSellFee = marketValue * CONFIG.SIMULATED_FEE_RATE;
      // Subtract actual fees (buy-side) and estimated sell fee from PnL
      const unrealizedPl = marketValue - costBasis - totalFees - estimatedSellFee;
      const unrealizedPlPct = costBasis > 0 ? unrealizedPl / costBasis : 0;

      const stopLoss = openSlOrders.get(productId);

      positions.push({
        symbol: productId,
        qty: totalQty.toString(),
        avg_entry_price: avgEntryPrice.toFixed(6),
        current_price: currentPrice.toFixed(6),
        market_value: marketValue.toFixed(6),
        cost_basis: costBasis.toFixed(6),
        unrealized_pl: unrealizedPl.toFixed(6),
        unrealized_plpc: unrealizedPlPct.toFixed(6),
        unrealized_intraday_pl: "0",
        unrealized_intraday_plpc: "0",
        change_today: "0",
        side: "long",
        asset_class: "crypto",
        actual_fees: (totalFees + estimatedSellFee).toFixed(6),
        ...(stopLoss !== undefined && { stop_loss: stopLoss }),
      });
    }

    return positions;
  }

  /**
   * Get USD cash balance from Coinbase accounts.
   */
  async getCashBalance(): Promise<number> {
    const { ok, data } = await this.request("GET", "/accounts?limit=250");
    if (!ok) return 0;

    const accounts = data.accounts as Array<Record<string, unknown>> | undefined;
    if (!accounts) return 0;

    let cash = 0;
    for (const acct of accounts) {
      const currency = acct.currency as string;
      if (currency === "USD" || currency === "USDC") {
        const available = parseFloat((acct.available_balance as Record<string, string>)?.value || "0");
        const held = parseFloat((acct.hold as Record<string, string>)?.value || "0");
        cash += available + held;
      }
    }
    return cash;
  }

  /**
   * Compute realized P&L performance metrics from Coinbase fill history.
   * Returns realized P&L for 1d, 1w, 1m, 1y windows.
   */
  async getPerformanceMetrics(): Promise<Record<string, unknown>> {
    // Rolling windows: last 24h, 7d, 30d, 365d from now
    const nowMs = Date.now();
    const windows = {
      "1d": nowMs - 24 * 60 * 60 * 1000,
      "1w": nowMs - 7 * 24 * 60 * 60 * 1000,
      "1m": nowMs - 30 * 24 * 60 * 60 * 1000,
      "1y": nowMs - 365 * 24 * 60 * 60 * 1000,
    };

    // PNL_RESET_DATE: ignore any fills before May 2, 2026 00:00:00 UTC
    const pnlResetDate = 1777680000000;

    // Fetch all fills (up to 1000 via pagination)
    const allFills: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const path = `/orders/historical/fills?limit=100${cursor ? `&cursor=${cursor}` : ""}`;
      const { ok, data } = await this.request("GET", path);
      if (!ok) break;
      const fills = data.fills as Array<Record<string, unknown>> | undefined;
      if (!fills || fills.length === 0) break;
      allFills.push(...fills);
      cursor = data.cursor as string | undefined;
      if (!cursor) break;
    }

    // Group fills by product into buy/sell pairs per window
    // Track realized P&L: for each SELL, find corresponding BUY cost
    const result: Record<string, { realizedPl: number; trades: number; tradeDetails: Array<{ symbol: string; time: number; qty: number; sellPrice: number; realizedPl: number }> }> = {
      "1d": { realizedPl: 0, trades: 0, tradeDetails: [] },
      "1w": { realizedPl: 0, trades: 0, tradeDetails: [] },
      "1m": { realizedPl: 0, trades: 0, tradeDetails: [] },
      "1y": { realizedPl: 0, trades: 0, tradeDetails: [] },
    };

    // Exclusive window cutoffs (for debugging: what each period contributed independently)
    const exclusiveCutoffs = {
      "1d_only": { from: nowMs - 24 * 60 * 60 * 1000, to: nowMs },
      "1d_to_1w": { from: nowMs - 7 * 24 * 60 * 60 * 1000, to: nowMs - 24 * 60 * 60 * 1000 },
      "1w_to_1m": { from: nowMs - 30 * 24 * 60 * 60 * 1000, to: nowMs - 7 * 24 * 60 * 60 * 1000 },
      "1m_to_1y": { from: nowMs - 365 * 24 * 60 * 60 * 1000, to: nowMs - 30 * 24 * 60 * 60 * 1000 },
    };
    const exclusive: Record<string, { realizedPl: number; trades: number }> = {
      "1d_only": { realizedPl: 0, trades: 0 },
      "1d_to_1w": { realizedPl: 0, trades: 0 },
      "1w_to_1m": { realizedPl: 0, trades: 0 },
      "1m_to_1y": { realizedPl: 0, trades: 0 },
    };

    // Group sells by product within each window
    const sellsByProduct: Record<string, Array<{ qty: number; price: number; fee: number; time: number }>> = {};
    const buysByProduct: Record<string, Array<{ qty: number; price: number; fee: number; time: number }>> = {};

    for (const fill of allFills) {
      const side = fill.side as string;
      const productId = fill.product_id as string;
      let qty = parseFloat((fill.size as string) || "0");
      const price = parseFloat((fill.price as string) || "0");
      const fee = parseFloat((fill.commission as string) || "0");
      const timeStr = fill.trade_time as string;
      const time = new Date(timeStr).getTime();
      const sizeInQuote = fill.size_in_quote as boolean | undefined;

      // Skip fills before the reset date
      if (time < pnlResetDate) continue;

      if (sizeInQuote && price > 0) {
        qty = qty / price;
      }

      if (side === "SELL") {
        if (!sellsByProduct[productId]) sellsByProduct[productId] = [];
        sellsByProduct[productId].push({ qty, price, fee, time });
      } else if (side === "BUY") {
        if (!buysByProduct[productId]) buysByProduct[productId] = [];
        buysByProduct[productId].push({ qty, price, fee, time });
      }
    }

    // Also collect pre-reset buys (for FIFO cost basis) — but mark them so
    // their cost is treated as the sell price (P&L contribution = 0)
    const preBuys: Record<string, Array<{ qty: number; price: number; fee: number; time: number; preReset: boolean }>> = {};
    const postBuys: Record<string, Array<{ qty: number; price: number; fee: number; time: number; preReset: boolean }>> = {};
    for (const [productId, buys] of Object.entries(buysByProduct)) {
      postBuys[productId] = buys.map(b => ({ ...b, preReset: false }));
    }
    // Re-scan fills for pre-reset buys
    for (const fill of allFills) {
      const side = fill.side as string;
      if (side !== "BUY") continue;
      const productId = fill.product_id as string;
      let qty = parseFloat((fill.size as string) || "0");
      const price = parseFloat((fill.price as string) || "0");
      const fee = parseFloat((fill.commission as string) || "0");
      const timeStr = fill.trade_time as string;
      const time = new Date(timeStr).getTime();
      const sizeInQuote = fill.size_in_quote as boolean | undefined;
      if (time >= pnlResetDate) continue; // skip post-reset (already in postBuys)
      if (sizeInQuote && price > 0) qty = qty / price;
      if (!preBuys[productId]) preBuys[productId] = [];
      preBuys[productId].push({ qty, price, fee, time, preReset: true });
    }

    // FIFO-match all sells against buys once, then assign each sell's realized P&L
    // to every time window the sell falls within.
    for (const productId of Object.keys(sellsByProduct)) {
      const sells = sellsByProduct[productId].sort((a, b) => a.time - b.time);
      // Pre-reset buys come first in FIFO order (cost = sell price, so P&L = 0)
      // followed by post-reset buys at actual cost
      const allBuys = [
        ...(preBuys[productId] || []).sort((a, b) => a.time - b.time),
        ...(postBuys[productId] || []).sort((a, b) => a.time - b.time),
      ];
      let buyIdx = 0;
      let buyRemaining = allBuys.length > 0 ? allBuys[0].qty : 0;

      for (const sell of sells) {
        let sellRemaining = sell.qty;
        const sellRevenue = sell.qty * sell.price - sell.fee;
        let buyCost = 0;

        while (sellRemaining > 1e-10 && buyIdx < allBuys.length) {
          const matchQty = Math.min(sellRemaining, buyRemaining);
          const buy = allBuys[buyIdx];
          // Pre-reset buys: use sell price as cost so P&L contribution = 0
          const effectivePrice = buy.preReset ? sell.price : buy.price;
          const effectiveFee = buy.preReset ? 0 : buy.fee;
          buyCost += matchQty * effectivePrice + effectiveFee * (matchQty / buy.qty);
          sellRemaining -= matchQty;
          buyRemaining -= matchQty;
          if (buyRemaining <= 1e-10) {
            buyIdx++;
            buyRemaining = buyIdx < allBuys.length ? allBuys[buyIdx].qty : 0;
          }
        }

        const realizedPl = sellRevenue - buyCost;

        for (const [period, cutoff] of Object.entries(windows)) {
          if (sell.time >= cutoff) {
            result[period].realizedPl += realizedPl;
            result[period].trades += 1;
            result[period].tradeDetails.push({ symbol: productId, time: sell.time, qty: sell.qty, sellPrice: sell.price, realizedPl });
          }
        }

        for (const [period, range] of Object.entries(exclusiveCutoffs)) {
          if (sell.time >= range.from && sell.time < range.to) {
            exclusive[period].realizedPl += realizedPl;
            exclusive[period].trades += 1;
          }
        }
      }
    }

    return { ...result, exclusive };
  }
}
