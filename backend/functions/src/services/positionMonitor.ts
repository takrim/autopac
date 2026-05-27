/**
 * Position Monitor
 *
 * Runs on a schedule (every 10 minutes). For each open position, fetches the
 * Coinbase order book and scores it. If the score is <= -3 (strong sell signal —
 * at least 3 out of 4 bearish sub-signals aligned), the position is liquidated
 * and a Telegram alert is sent.
 *
 * A cooldown is stored in Firestore (_position_monitor_cooldowns/{symbol}) so we
 * don't fire multiple liquidations for the same symbol within 30 minutes.
 */

import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getBroker } from "../brokers";
import { CoinbaseBroker } from "../brokers/coinbase";
import { getTradingConfig } from "../api/config";
import { normalizeBookSymbol, fetchOrderBook, scoreBook } from "./orderbook";
import { sendTelegramMessage } from "./telegram";

const STRONG_SELL_THRESHOLD = -4;        // score <= this triggers liquidation (-4 requires strong imbalance + both depth/CVD bearish)
const COOLDOWN_MINUTES = 30;             // ignore same symbol within this window
const COOLDOWN_COLLECTION = "_position_monitor_cooldowns";

// RSI-based exits (burst-scanner positions have no static SL/TP)
const RSI_PERIOD          = 14;
const RSI_EXIT_LOSS       = 30;   // RSI < 30 → liquidate (cut loss)
const RSI_EXIT_PROFIT     = 70;   // RSI ≥ 70 → liquidate (take profit)

// Trailing stop thresholds
const TRAIL_BREAKEVEN_PCT  = 3;   // price >= entry + 3% → move SL to entry (0 PnL)
const TRAIL_PROFIT_PCT     = 5;   // price >= entry + 5% → move SL to entry + 2.5%
const TRAIL_LOCK_IN_PCT    = 2.5; // the profit level locked in when price is >= +5%
const TRAIL_SL_COLLECTION  = "_position_monitor_sl_updates";

const db = getFirestore();

/**
 * Check and set cooldown for a symbol.
 * Returns true if the symbol is currently in cooldown (skip liquidation).
 */
async function isInCooldown(symbol: string): Promise<boolean> {
  const ref = db.collection(COOLDOWN_COLLECTION).doc(symbol);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data()!;
  const triggeredAt: FirebaseFirestore.Timestamp = data.triggeredAt;
  const ageMinutes = (Date.now() - triggeredAt.toMillis()) / 60_000;
  return ageMinutes < COOLDOWN_MINUTES;
}

async function setCooldown(symbol: string): Promise<void> {
  await db.collection(COOLDOWN_COLLECTION).doc(symbol).set({
    triggeredAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Returns the stop-loss target price if a trailing-stop adjustment is warranted,
 * or null if no update is needed.
 *
 * Rules (only ever moves SL up):
 *   price >= entry + 5% → SL = entry × 1.025  (lock in 2.5% profit)
 *   price >= entry + 3% → SL = entry           (break-even)
 */
function trailingStopTarget(
  entryPrice: number,
  currentPrice: number,
  currentStopLoss: number | null,
): number | null {
  const pctAbove = (currentPrice - entryPrice) / entryPrice * 100;

  let target: number | null = null;
  if (pctAbove >= TRAIL_PROFIT_PCT) {
    target = entryPrice * (1 + TRAIL_LOCK_IN_PCT / 100);
  } else if (pctAbove >= TRAIL_BREAKEVEN_PCT) {
    target = entryPrice; // break-even
  }

  if (target === null) return null;

  // Never move SL downward
  if (currentStopLoss !== null && !isNaN(currentStopLoss) && currentStopLoss >= target) return null;

  return target;
}

/**
 * Returns true if we already updated the SL to this level recently (within 10 min)
 * to avoid hammering the broker on every run.
 */
async function slAlreadyUpdatedTo(symbol: string, targetPrice: number): Promise<boolean> {
  const ref = db.collection(TRAIL_SL_COLLECTION).doc(symbol);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const data = snap.data()!;
  const lastPrice: number = data.stopPrice ?? 0;
  const updatedAt: FirebaseFirestore.Timestamp = data.updatedAt;
  const ageMinutes = (Date.now() - updatedAt.toMillis()) / 60_000;
  // Already set to same level and updated within last 20 minutes — skip
  return Math.abs(lastPrice - targetPrice) / targetPrice < 0.001 && ageMinutes < 20;
}

async function recordSlUpdate(symbol: string, stopPrice: number): Promise<void> {
  await db.collection(TRAIL_SL_COLLECTION).doc(symbol).set({
    stopPrice,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// RSI helpers (3-min aggregated from 1-min Coinbase candles)
// ---------------------------------------------------------------------------

function calculateRSI(closes: number[], period = RSI_PERIOD): number {
  if (closes.length < period + 1) return NaN;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function aggregateTo3MinCloses(candles: { start: number; close: number }[]): number[] {
  const buckets = new Map<number, { close: number; count: number; start: number }>();
  for (const c of candles) {
    const bucketStart = c.start - (c.start % 180);
    const ex = buckets.get(bucketStart);
    if (!ex) buckets.set(bucketStart, { close: c.close, count: 1, start: bucketStart });
    else { ex.close = c.close; ex.count++; }
  }
  const out = Array.from(buckets.values()).sort((a, b) => a.start - b.start);
  while (out.length > 0 && out[out.length - 1].count < 3) out.pop();
  return out.map(b => b.close);
}

/** Returns RSI(14) on 3-min closed bars, or NaN if data is insufficient. */
async function fetchRsi3m(symbol: string): Promise<number> {
  try {
    const tradingConfig = await getTradingConfig();
    const broker = getBroker(tradingConfig.ACTIVE_BROKER) as CoinbaseBroker;
    if (typeof broker.getCandles !== "function") return NaN;
    const productId = symbol.includes("-") ? symbol : normalizeBookSymbol(symbol);
    const oneMin = await broker.getCandles(productId, "ONE_MINUTE", 100);
    const closes = aggregateTo3MinCloses(oneMin);
    if (closes.length < RSI_PERIOD + 1) return NaN;
    return calculateRSI(closes);
  } catch (err) {
    logger.warn("[POSITION_MONITOR] RSI fetch failed", { symbol, error: String(err) });
    return NaN;
  }
}

export async function runPositionMonitor(): Promise<void> {
  logger.info("[POSITION_MONITOR] Starting position monitor run");

  const tradingConfig = await getTradingConfig();
  const broker = getBroker(tradingConfig.ACTIVE_BROKER);

  if (!broker.getDetailedPositions) {
    logger.warn("[POSITION_MONITOR] Active broker does not support getDetailedPositions; skipping");
    return;
  }

  let positions;
  try {
    positions = await broker.getDetailedPositions!();
  } catch (err) {
    logger.error("[POSITION_MONITOR] Failed to fetch positions", { error: String(err) });
    return;
  }

  if (!positions || positions.length === 0) {
    logger.info("[POSITION_MONITOR] No open positions");
    return;
  }

  logger.info("[POSITION_MONITOR] Checking positions", { count: positions.length });

  for (const pos of positions) {
    const rawSymbol = pos.symbol;
    const cbSymbol = normalizeBookSymbol(rawSymbol);

    logger.info("[POSITION_MONITOR] Checking book for position", { symbol: rawSymbol, cbSymbol });

    // Fetch order book
    const book = await fetchOrderBook(cbSymbol);
    if (!book) {
      logger.warn("[POSITION_MONITOR] Could not fetch order book, skipping", { symbol: rawSymbol });
      continue;
    }

    const bookScore = scoreBook(book.bids, book.asks);

    logger.info("[POSITION_MONITOR] Book scored", {
      symbol: rawSymbol,
      score: bookScore.score,
      signal: bookScore.signal,
      reasons: bookScore.reasons,
    });

    const entryPrice = parseFloat(pos.avg_entry_price);
    const currentPrice = parseFloat(pos.current_price);
    const stopLossPrice = pos.stop_loss ? parseFloat(pos.stop_loss) : null;

    // --- RSI-based exit (highest priority) ---
    // Burst-scanner positions have no static SL/TP; we exit on RSI<30 (cut) or RSI≥70 (take profit)
    const rsi = await fetchRsi3m(rawSymbol);
    if (Number.isFinite(rsi) && (rsi < RSI_EXIT_LOSS || rsi >= RSI_EXIT_PROFIT)) {
      const cooledDown = await isInCooldown(rawSymbol);
      if (cooledDown) {
        logger.info("[POSITION_MONITOR] RSI exit suppressed by cooldown", { symbol: rawSymbol, rsi });
      } else {
        const isTakeProfit = rsi >= RSI_EXIT_PROFIT;
        const label = isTakeProfit ? "TAKE PROFIT" : "CUT LOSS";
        logger.warn("[POSITION_MONITOR] RSI exit triggered", {
          symbol: rawSymbol, rsi: rsi.toFixed(1), label,
        });

        let liqResult: Record<string, unknown> | null = null;
        let liqError: string | null = null;
        try {
          liqResult = await broker.liquidatePosition(rawSymbol);
          await setCooldown(rawSymbol);
        } catch (err) {
          liqError = String(err);
        }

        const unrealizedPl = parseFloat(pos.unrealized_pl);
        const plSign = unrealizedPl >= 0 ? "+" : "";
        const emoji  = isTakeProfit ? "\u{1F4B0}" : "\u{1F6A8}";
        const lines = liqError
          ? [
              `⚠️ *Position Monitor* — RSI ${label} liquidation FAILED`,
              `Symbol: \`${rawSymbol}\``,
              `RSI(3m,14): ${rsi.toFixed(1)} (threshold ${isTakeProfit ? `≥ ${RSI_EXIT_PROFIT}` : `< ${RSI_EXIT_LOSS}`})`,
              `Qty: ${pos.qty} @ $${currentPrice.toFixed(4)}`,
              `Unrealized P&L: ${plSign}$${unrealizedPl.toFixed(2)}`,
              ``,
              `❌ Error: ${liqError}`,
            ].join("\n")
          : [
              `${emoji} *Position Monitor* — RSI ${label}`,
              `Symbol: \`${rawSymbol}\``,
              `RSI(3m,14): ${rsi.toFixed(1)} (threshold ${isTakeProfit ? `≥ ${RSI_EXIT_PROFIT}` : `< ${RSI_EXIT_LOSS}`})`,
              `Qty: ${pos.qty} @ $${currentPrice.toFixed(4)}`,
              `Unrealized P&L: ${plSign}$${unrealizedPl.toFixed(2)}`,
              ``,
              `✅ Liquidation order submitted`,
            ].join("\n");
        await sendTelegramMessage(lines).catch(tgErr => {
          logger.warn("[POSITION_MONITOR] Telegram notify failed", { error: String(tgErr) });
        });
        void liqResult;
      }
      // Skip other checks once an RSI exit has been processed for this symbol
      continue;
    }

    // --- Trailing stop adjustment (runs for ALL positions, regardless of book score) ---
    if (!isNaN(entryPrice) && !isNaN(currentPrice)) {
      const slTarget = trailingStopTarget(entryPrice, currentPrice, stopLossPrice);
      if (slTarget !== null) {
        const alreadySet = await slAlreadyUpdatedTo(rawSymbol, slTarget).catch(() => false);
        if (!alreadySet) {
          const isBreakEven = Math.abs(slTarget - entryPrice) / entryPrice < 0.001;
          const label = isBreakEven ? "break-even" : `+${TRAIL_LOCK_IN_PCT}% profit lock`;
          logger.info("[POSITION_MONITOR] Moving trailing stop", { symbol: rawSymbol, slTarget, label });

          try {
            const slResult = await (broker as any).updateStopLoss(rawSymbol, slTarget);
            await recordSlUpdate(rawSymbol, slTarget);
            logger.info("[POSITION_MONITOR] Trailing stop updated", { symbol: rawSymbol, slTarget, success: slResult.success });

            const pctAbove = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1);
            await sendTelegramMessage([
              `🛡 *Trailing Stop Updated* — \`${rawSymbol}\``,
              `Price: $${currentPrice.toPrecision(6)} (+${pctAbove}% above entry)`,
              `New Stop Loss: $${slTarget.toPrecision(6)} _(${label})_`,
            ].join("\n")).catch(() => {});
          } catch (slErr) {
            logger.warn("[POSITION_MONITOR] Trailing stop update failed", { symbol: rawSymbol, error: String(slErr) });
          }
        }
      }
    }

    // --- Liquidation check (order-book score) ---
    if (bookScore.score > STRONG_SELL_THRESHOLD) {
      // Not a strong sell — skip liquidation
      continue;
    }

    // Skip if a break-even (or better) stop loss is already in place — position is protected
    if (stopLossPrice !== null && !isNaN(stopLossPrice) && stopLossPrice >= entryPrice) {
      logger.info("[POSITION_MONITOR] Break-even stop in place — skipping liquidation", {
        symbol: rawSymbol, entryPrice, stopLossPrice, score: bookScore.score,
      });
      continue;
    }

    // Strong sell detected — check cooldown before liquidating
    const cooledDown = await isInCooldown(rawSymbol);
    if (cooledDown) {
      logger.info("[POSITION_MONITOR] In cooldown, skipping liquidation", { symbol: rawSymbol });
      continue;
    }

    // Liquidate
    logger.warn("[POSITION_MONITOR] STRONG SELL detected — liquidating", {
      symbol: rawSymbol,
      score: bookScore.score,
      reasons: bookScore.reasons,
    });

    let liquidationResult: Record<string, unknown> | null = null;
    let liquidationError: string | null = null;
    try {
      liquidationResult = await broker.liquidatePosition(rawSymbol);
      await setCooldown(rawSymbol);
      logger.info("[POSITION_MONITOR] Liquidation submitted", { symbol: rawSymbol, result: liquidationResult });
    } catch (err) {
      liquidationError = String(err);
      logger.error("[POSITION_MONITOR] Liquidation failed", { symbol: rawSymbol, error: liquidationError });
    }

    // Build Telegram message
    const qty = pos.qty;
    const unrealizedPl = parseFloat(pos.unrealized_pl);
    const plSign = unrealizedPl >= 0 ? "+" : "";
    const scoreBar = "🔴🔴🔴🔴";

    const reasonLines = bookScore.reasons.map(r => `  • ${r}`).join("\n");

    let msg: string;
    if (liquidationError) {
      msg = [
        `⚠️ *Position Monitor* — Liquidation FAILED`,
        `Symbol: \`${rawSymbol}\``,
        `Book Score: ${bookScore.score}/4 ${scoreBar}`,
        `Qty: ${qty} @ $${currentPrice.toFixed(4)}`,
        `Unrealized P&L: ${plSign}$${unrealizedPl.toFixed(2)}`,
        ``,
        `📉 Reasons:`,
        reasonLines,
        ``,
        `❌ Error: ${liquidationError}`,
      ].join("\n");
    } else {
      msg = [
        `🚨 *Position Monitor* — Auto-Liquidated`,
        `Symbol: \`${rawSymbol}\``,
        `Book Score: ${bookScore.score}/4 ${scoreBar}`,
        `Qty: ${qty} @ $${currentPrice.toFixed(4)}`,
        `Unrealized P&L: ${plSign}$${unrealizedPl.toFixed(2)}`,
        ``,
        `📉 Book Reasons:`,
        reasonLines,
        ``,
        `✅ Liquidation order submitted`,
      ].join("\n");
    }

    await sendTelegramMessage(msg).catch(tgErr => {
      logger.warn("[POSITION_MONITOR] Telegram notify failed", { error: String(tgErr) });
    });
  }

  logger.info("[POSITION_MONITOR] Run complete");
}
