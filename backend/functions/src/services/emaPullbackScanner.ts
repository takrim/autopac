/**
 * EMA Pullback Scanner (trailing-stop only)
 *
 * Entry logic has been removed. This scanner now only manages trailing stops
 * for positions previously opened by the ema_pullback_scanner strategy:
 *
 *   • For each open position whose latest APPROVED BUY signal has
 *     strategy="ema_pullback_scanner":
 *       - compute RSI(14) on 3-minute closes (aggregated from 1-min candles)
 *       - if RSI ≥ 80 and current price > 0:
 *           propose newSL = current × (1 − 1%)
 *           apply only if it strictly raises the existing stop (ratchet-only)
 *
 * positionLiquidator still skips these symbols (see SELF_MANAGED_STRATEGIES)
 * so this scanner remains the sole exit-manager for its tagged positions.
 */

import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { getBroker } from "../brokers";
import { CoinbaseBroker } from "../brokers/coinbase";
import { DetailedPosition } from "../brokers/interface";
import { sendTelegramMessage } from "./telegram";
import { logDecision } from "./decisionLog";
import { computeRSI } from "./strategies/shared";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const STRATEGY_TAG          = "ema_pullback_scanner";

const RSI_PERIOD            = 14;
const RSI_TRAIL_TRIGGER     = 80;     // RSI ≥ 80 → arm/raise trailing stop
const TRAIL_BUFFER_PCT      = 1.0;    // stop = current × (1 − 1%), ratchet-only
const RSI_FETCH_COUNT       = 300;    // 1-min candles aggregated to 3-min

const db = getFirestore();

// ---------------------------------------------------------------------------
// 1-min → 3-min aggregation (for RSI)
// ---------------------------------------------------------------------------

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

async function fetchRsi3m(broker: CoinbaseBroker, productId: string): Promise<number> {
  try {
    const oneMin = await broker.getCandles(productId, "ONE_MINUTE", RSI_FETCH_COUNT);
    const threeMin = aggregateTo3MinCloses(oneMin);
    if (threeMin.length < RSI_PERIOD + 1) return NaN;
    const series = computeRSI(threeMin, RSI_PERIOD);
    const rsi = series[series.length - 1];
    return rsi != null && Number.isFinite(rsi) ? rsi : NaN;
  } catch (err) {
    logger.warn("[EMA_PB] RSI fetch failed", { productId, error: String(err) });
    return NaN;
  }
}

// ---------------------------------------------------------------------------
// Strategy-managed lookup
// ---------------------------------------------------------------------------

async function isManagedByThisStrategy(productId: string): Promise<boolean> {
  try {
    const snap = await db.collection("signals")
      .where("symbol", "==", productId)
      .where("action", "==", "BUY")
      .where("strategy", "==", STRATEGY_TAG)
      .limit(1)
      .get();
    return !snap.empty;
  } catch (err) {
    logger.warn("[EMA_PB] strategy lookup failed — skipping (fail-closed)", { productId, error: String(err) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

export async function runEmaPullbackScanner(): Promise<void> {
  const tStart = Date.now();
  logger.info("[EMA_PB] Starting trailing-stop run");

  const broker = getBroker("coinbase") as CoinbaseBroker;

  let positions: DetailedPosition[] = [];
  try {
    if (broker.getDetailedPositions) {
      positions = await broker.getDetailedPositions();
    }
  } catch (err) {
    logger.error("[EMA_PB] Failed to fetch positions", { error: String(err) });
    return;
  }

  if (positions.length === 0) {
    logger.info("[EMA_PB] No open positions");
    return;
  }

  const trailed: Array<{ productId: string; rsi: number; oldSL: number; newSL: number; gainPct: number }> = [];
  const skipped: Array<{ productId: string; reason: string }> = [];

  for (const position of positions) {
    const sym = position.symbol.toUpperCase();
    const productId = sym.includes("-") ? sym : `${sym}-USD`;

    const managed = await isManagedByThisStrategy(productId);
    if (!managed) continue;

    const entry      = parseFloat(position.avg_entry_price) || 0;
    const current    = parseFloat(position.current_price)   || 0;
    const existingSL = position.stop_loss ? parseFloat(position.stop_loss) || 0 : 0;
    const pnlPct     = entry > 0 ? ((current - entry) / entry) * 100 : 0;

    if (current <= 0) {
      skipped.push({ productId, reason: "invalid current price" });
      continue;
    }

    const rsi = await fetchRsi3m(broker, productId);
    if (!Number.isFinite(rsi)) {
      skipped.push({ productId, reason: "RSI unavailable" });
      continue;
    }

    if (rsi < RSI_TRAIL_TRIGGER) {
      skipped.push({ productId, reason: `RSI=${rsi.toFixed(1)} < ${RSI_TRAIL_TRIGGER}` });
      continue;
    }

    const newSL = current * (1 - TRAIL_BUFFER_PCT / 100);
    if (existingSL > 0 && newSL <= existingSL) {
      skipped.push({ productId, reason: `would lower SL (${existingSL.toPrecision(6)} → ${newSL.toPrecision(6)})` });
      continue;
    }

    try {
      const result = await broker.updateStopLoss(productId, newSL);
      if (!result.success) {
        logger.warn("[EMA_PB] updateStopLoss rejected", { productId, message: result.message });
        skipped.push({ productId, reason: `broker rejected: ${result.message ?? "unknown"}` });
        await logDecision({
          source: "ema_pullback_scanner",
          outcome: "REJECTED",
          action: "OTHER",
          symbol: productId,
          price: current,
          reason: `trailing SL update failed: ${result.message ?? "broker rejected"}`,
          expression: `RSI=${rsi.toFixed(1)} ≥ ${RSI_TRAIL_TRIGGER} → propose SL=${newSL.toPrecision(6)} → broker rejected`,
          params: { entry, current, rsi: +rsi.toFixed(1), existing_sl: existingSL, proposed_sl: +newSL.toPrecision(6) },
        });
        continue;
      }
      trailed.push({ productId, rsi, oldSL: existingSL, newSL, gainPct: pnlPct });
      await logDecision({
        source: "ema_pullback_scanner",
        outcome: "ACCEPTED",
        action: "OTHER",
        symbol: productId,
        price: current,
        reason: `trailing SL ${existingSL > 0 ? "raised" : "armed"} (RSI ≥ ${RSI_TRAIL_TRIGGER})`,
        expression: `RSI=${rsi.toFixed(1)} ≥ ${RSI_TRAIL_TRIGGER} → SL ${existingSL > 0 ? existingSL.toPrecision(6) : "none"} → ${newSL.toPrecision(6)}`,
        params: {
          entry, current,
          rsi: +rsi.toFixed(1),
          gain_pct: +pnlPct.toFixed(2),
          old_sl: existingSL,
          new_sl: +newSL.toPrecision(6),
          buffer_pct: TRAIL_BUFFER_PCT,
        },
      });
    } catch (err) {
      logger.error("[EMA_PB] updateStopLoss threw", { productId, error: String(err) });
      skipped.push({ productId, reason: `threw: ${String(err).slice(0, 80)}` });
    }
  }

  if (trailed.length > 0) {
    const lines: string[] = [
      `🔼 *EMA Pullback — Trailed SL* (RSI ≥ ${RSI_TRAIL_TRIGGER}, ${TRAIL_BUFFER_PCT}% buffer)`,
    ];
    for (const t of trailed) {
      lines.push(
        `  • ${t.productId} +${t.gainPct.toFixed(2)}% RSI=${t.rsi.toFixed(1)} — SL ${t.oldSL > 0 ? t.oldSL.toPrecision(5) : "none"} → ${t.newSL.toPrecision(5)}`,
      );
    }
    await sendTelegramMessage(lines.join("\n")).catch(() => {});
  }

  logger.info("[EMA_PB] Run complete", {
    durationMs: Date.now() - tStart,
    positions: positions.length,
    trailed: trailed.length,
    skipped: skipped.length,
  });
}
