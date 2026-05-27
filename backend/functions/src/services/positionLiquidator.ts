/**
 * Position Liquidator
 *
 * Runs every 1 minute. For each open Coinbase position, computes RSI(14) on
 * 3-minute bars (aggregated from 1-minute candles) and acts as follows:
 *   - RSI < 30  → cut loss (immediate market exit)
 *   - RSI ≥ 70  → arm/trail a stop-loss 0.5% below the current price; the stop
 *                 only ever ratchets up. Actual exit happens when the broker
 *                 stop fires (detected via snapshot diff next run).
 *   - 30 ≤ RSI < 70 → hold, no action.
 *
 * Snapshot-diff detection reports positions that disappear between runs
 * (e.g. stop fills or manual closes) for visibility.
 */

import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getBroker } from "../brokers";
import { CoinbaseBroker } from "../brokers/coinbase";
import { DetailedPosition } from "../brokers/interface";
import { sendTelegramMessage } from "./telegram";
import { sendExitNotification } from "./notification";
import { logDecision } from "./decisionLog";

// RSI-based exits
const RSI_PERIOD         = 14;
const RSI_EXIT_LOSS      = 30;   // RSI(14) on 3m < 30 → cut loss immediately
const RSI_TRAIL_TRIGGER  = 70;   // RSI(14) on 3m ≥ 70 → arm/trail stop-loss
const TRAIL_BUFFER_PCT   = 0.5;  // stop-loss = current price × (1 − 0.5%)

// Telegram heartbeat cadence (minutes) — proves the 1-min job is alive
const HEARTBEAT_INTERVAL_MIN = 3;
const HEARTBEAT_DOC = "_heartbeats/positionLiquidator";

// Firestore snapshot of last-seen positions — used to detect external/manual exits
const POSITIONS_SNAPSHOT_DOC = "_liquidator_state/positions";

// Source of truth for symbols the burst scanner has marked forbidden (e.g. defi/meme).
// Same doc that burstScanner writes via addToForbiddenCache.
const FORBIDDEN_CACHE_DOC = "_burst_cache/forbidden";
// Trading config doc — holds brokerSettings.coinbase.allowedSymbols
const TRADING_CONFIG_DOC = "config/trading";

type PositionSnapshot = Record<string, { entry: number; lastPrice: number; stopLoss: number }>;

const db = getFirestore();

/**
 * Sends a heartbeat to Telegram if it has been HEARTBEAT_INTERVAL_MIN since the last one.
 * Uses Firestore to track the last beat across stateless function invocations.
 *
 * `rsis` is an array of per-position snapshots (productId, RSI, P/L%) used to
 * enrich the heartbeat message with current RSI for every open position.
 */
async function maybeSendHeartbeat(
  positionCount: number,
  rsis: Array<{ productId: string; rsi: number; pnlPct: number }> = [],
): Promise<void> {
  try {
    const ref = db.doc(HEARTBEAT_DOC);
    const snap = await ref.get();
    const lastAt: FirebaseFirestore.Timestamp | undefined = snap.exists ? snap.data()?.lastAt : undefined;
    const ageMin = lastAt ? (Date.now() - lastAt.toMillis()) / 60_000 : Infinity;
    if (ageMin < HEARTBEAT_INTERVAL_MIN) return;

    await ref.set({ lastAt: FieldValue.serverTimestamp() });

    const header = `\u{1F493} *Liquidator heartbeat* — alive, watching ${positionCount} position${positionCount === 1 ? "" : "s"}`;
    let body = "";
    if (rsis.length > 0) {
      const lines = rsis.map(r => {
        const rsiStr = Number.isFinite(r.rsi) ? r.rsi.toFixed(1) : "N/A";
        const pnlStr = `${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(2)}%`;
        return `  • ${r.productId} — RSI=${rsiStr} | P/L ${pnlStr}`;
      });
      body = `\n${lines.join("\n")}`;
    }
    await sendTelegramMessage(header + body).catch(() => {});
  } catch (err) {
    logger.warn("[LIQUIDATOR] Heartbeat failed (non-fatal)", { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// RSI helpers (Wilder RSI-14 on 3-min bars aggregated from 1-min candles)
// ---------------------------------------------------------------------------

function calcRsi(closes: number[], period = RSI_PERIOD): number {
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

async function fetchRsi3m(broker: CoinbaseBroker, productId: string): Promise<number> {
  // Up to 3 attempts with small backoff — Coinbase occasionally rate-limits or
  // returns an empty payload when many candle requests fire in parallel.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const oneMin = await broker.getCandles(productId, "ONE_MINUTE", 300);
      const closes = aggregateTo3MinCloses(oneMin);
      if (closes.length >= RSI_PERIOD + 1) return calcRsi(closes);
      logger.warn("[LIQUIDATOR] RSI insufficient candles", {
        symbol: productId,
        attempt,
        oneMinCount: oneMin.length,
        bucketCount: closes.length,
      });
    } catch (err) {
      logger.warn("[LIQUIDATOR] RSI fetch error", { symbol: productId, attempt, error: String(err) });
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt));
  }
  // Fallback chain for illiquid markets (Coinbase only returns candles for
  // minutes with trades). Walk up granularities until we have enough bars.
  for (const gran of ["FIVE_MINUTE", "FIFTEEN_MINUTE", "ONE_HOUR"] as const) {
    try {
      const bars = await broker.getCandles(productId, gran, 100);
      const closes = bars.map(c => c.close);
      if (closes.length >= RSI_PERIOD + 1) {
        logger.info("[LIQUIDATOR] RSI fallback granularity", { symbol: productId, gran, bars: closes.length });
        return calcRsi(closes);
      }
      logger.warn("[LIQUIDATOR] RSI fallback insufficient", { symbol: productId, gran, bars: closes.length });
    } catch (err) {
      logger.warn("[LIQUIDATOR] RSI fallback error", { symbol: productId, gran, error: String(err) });
    }
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// Strategy-managed positions (skip from global RSI rules)
// ---------------------------------------------------------------------------

// Strategies whose scanners manage their own entry & exit logic on their own
// schedule — positionLiquidator must leave their positions alone.
const SELF_MANAGED_STRATEGIES = new Set<string>(["ema_pullback_scanner"]);

/**
 * Return the set of symbols that have any APPROVED BUY signal from a
 * self-managed strategy. We query specifically for action=BUY + strategy
 * so that a subsequent SELL signal (or a signal from a different strategy)
 * never accidentally un-guards the position.
 */
async function loadStrategyManagedSymbols(
  positions: DetailedPosition[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const productIds = positions.map(p => {
    const sym = p.symbol.toUpperCase();
    return sym.includes("-") ? sym : `${sym}-USD`;
  });
  const strategies = Array.from(SELF_MANAGED_STRATEGIES);

  const results = await Promise.allSettled(productIds.map(async (productId) => {
    const snap = await db.collection("signals")
      .where("symbol", "==", productId)
      .where("action", "==", "BUY")
      .where("strategy", "in", strategies)
      .limit(1)
      .get();
    return { productId, found: !snap.empty };
  }));

  for (const result of results) {
    if (result.status === "rejected") {
      // Firestore index missing or unavailable — fail-closed: protect ALL positions
      // to prevent liquidating strategy-managed positions during index build.
      const errMsg = String(result.reason).slice(0, 200);
      logger.error("[LIQUIDATOR] strategy lookup failed — protecting ALL positions (fail-closed)", {
        error: errMsg,
      });
      await sendTelegramMessage(
        `🚨 *LIQUIDATOR ALERT*\n⚠️ Strategy lookup failed — ALL positions protected (fail-closed)\n\`${errMsg}\``
      ).catch(() => {});
      return new Set(productIds);
    }
    if (result.value.found) out.add(result.value.productId);
  }

  return out;
}

export async function runPositionLiquidator(): Promise<void> {
  logger.info("[LIQUIDATOR] Starting position liquidator run");

  const broker = getBroker("coinbase") as CoinbaseBroker;

  // Load previous snapshot to diff against — disappearances = stop-loss exits
  const snapshotRef = db.doc(POSITIONS_SNAPSHOT_DOC);
  let prevSnapshot: PositionSnapshot = {};
  try {
    const snap = await snapshotRef.get();
    if (snap.exists) prevSnapshot = (snap.data()?.symbols as PositionSnapshot) || {};
  } catch (err) {
    logger.warn("[LIQUIDATOR] Failed to read prev snapshot (non-fatal)", { error: String(err) });
  }

  // Fetch all open positions
  let positions: DetailedPosition[] = [];
  try {
    if (broker.getDetailedPositions) {
      positions = await broker.getDetailedPositions();
    }
  } catch (err) {
    logger.error("[LIQUIDATOR] Failed to fetch positions", { error: String(err) });
    return;
  }

  const currentSymbols = new Set(
    positions.map(p => (p.symbol.includes("-") ? p.symbol : `${p.symbol}-USD`).toUpperCase())
  );

  // Stop-loss exits = symbols in previous snapshot but no longer present
  const stoppedOut: Array<{ productId: string; entry: number; lastPrice: number; stopLoss: number }> = [];
  for (const [productId, info] of Object.entries(prevSnapshot)) {
    if (!currentSymbols.has(productId)) {
      stoppedOut.push({ productId, ...info });
    }
  }

  if (positions.length === 0) {
    logger.info("[LIQUIDATOR] No open positions — nothing to check");
    await maybeSendHeartbeat(0);
    if (stoppedOut.length > 0) {
      await notifyStoppedOut(stoppedOut);
      await snapshotRef.set({ symbols: {}, updatedAt: FieldValue.serverTimestamp() });
    }
    await pruneForbiddenFromAllowlist().catch(err => {
      logger.warn("[LIQUIDATOR] Forbidden allowlist prune failed (non-fatal)", { error: String(err) });
    });
    return;
  }

  logger.info("[LIQUIDATOR] Checking positions", { count: positions.length });

  // Pre-compute RSI for every position in parallel so the heartbeat can report
  // current RSI even when no action is taken this run.
  const rsiByProductId = new Map<string, number>();
  const heartbeatRows: Array<{ productId: string; rsi: number; pnlPct: number }> = [];
  const rsiResults = await Promise.all(
    positions.map(async (p) => {
      const sym = p.symbol.toUpperCase();
      const pid = sym.includes("-") ? sym : `${sym}-USD`;
      const rsi = await fetchRsi3m(broker, pid);
      return { pid, rsi, p };
    })
  );
  for (const { pid, rsi, p } of rsiResults) {
    rsiByProductId.set(pid, rsi);
    const entry   = parseFloat(p.avg_entry_price) || 0;
    const current = parseFloat(p.current_price)   || 0;
    const pnlPct  = entry > 0 ? ((current - entry) / entry) * 100 : 0;
    heartbeatRows.push({ productId: pid, rsi, pnlPct });
  }

  await maybeSendHeartbeat(positions.length, heartbeatRows);

  // Build set of symbols owned by strategies that manage their own exits.
  // The EMA-pullback scanner trails on RSI≥80 and liquidates on EMA200
  // flat/down across 3 ticks, which conflicts with the global RSI<30 / RSI≥70
  // rules below — skip those positions here.
  const strategyManagedSymbols = await loadStrategyManagedSymbols(positions);
  if (strategyManagedSymbols.size > 0) {
    logger.info("[LIQUIDATOR] Skipping strategy-managed positions", {
      symbols: Array.from(strategyManagedSymbols),
    });
  }

  const liquidated: string[] = [];
  const errors: string[] = [];
  const rsiExits: Array<{ productId: string; rsi: number; entry: number; current: number; pnlPct: number; kind: "CUT" }> = [];
  const trailed: Array<{ productId: string; rsi: number; entry: number; current: number; oldSL: number; newSL: number; gainPct: number }> = [];

  for (const position of positions) {
    const symbol = position.symbol.toUpperCase();
    // symbol from getDetailedPositions is already in "BTC-USD" format
    const productId = symbol.includes("-") ? symbol : `${symbol}-USD`;

    if (strategyManagedSymbols.has(productId)) {
      continue; // owned by a strategy that handles its own exits
    }

    const rsi = rsiByProductId.get(productId) ?? NaN;
    const entryPrice   = parseFloat(position.avg_entry_price) || 0;
    const currentPrice = parseFloat(position.current_price) || 0;
    const existingSL   = position.stop_loss ? parseFloat(position.stop_loss) || 0 : 0;
    const pnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

    if (!Number.isFinite(rsi)) {
      logger.info("[LIQUIDATOR] RSI unavailable — skipping", { symbol: productId });
      continue;
    }

    // --- RSI < 30 → cut loss immediately ---
    if (rsi < RSI_EXIT_LOSS) {
      logger.warn("[LIQUIDATOR] RSI cut-loss triggered", {
        symbol: productId, rsi: rsi.toFixed(1), pnlPct: pnlPct.toFixed(2),
      });
      try {
        await broker.liquidatePosition(productId);
        liquidated.push(productId);
        rsiExits.push({ productId, rsi, entry: entryPrice, current: currentPrice, pnlPct, kind: "CUT" });
        await logDecision({
          source: "liquidator",
          outcome: "ACCEPTED",
          action: "SELL",
          symbol: productId,
          price: currentPrice,
          reason: `cut loss — RSI(3m,14)=${rsi.toFixed(1)} < ${RSI_EXIT_LOSS}`,
          expression: `RSI=${rsi.toFixed(1)} < ${RSI_EXIT_LOSS} → SELL @ $${currentPrice.toPrecision(6)} (P/L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
          params: {
            entry: entryPrice,
            current: currentPrice,
            pnl_pct: +pnlPct.toFixed(2),
            rsi: +rsi.toFixed(1),
            exit_kind: "CUT",
          },
        });
      } catch (err) {
        const errMsg = String(err);
        logger.error("[LIQUIDATOR] RSI liquidation failed", { symbol: productId, error: errMsg });
        errors.push(`${productId}(${errMsg.slice(0, 60)})`);
        await logDecision({
          source: "liquidator",
          outcome: "REJECTED",
          action: "SELL",
          symbol: productId,
          price: currentPrice,
          reason: `RSI liquidation failed: ${errMsg.slice(0, 120)}`,
          expression: `RSI=${rsi.toFixed(1)} < ${RSI_EXIT_LOSS} → SELL attempt threw`,
          params: {
            entry: entryPrice,
            current: currentPrice,
            pnl_pct: +pnlPct.toFixed(2),
            rsi: +rsi.toFixed(1),
            exit_kind: "CUT",
            error: errMsg.slice(0, 200),
          },
        });
      }
      continue;
    }

    // --- RSI ≥ 70 → arm/trail stop-loss 0.5% below current price (ratchet only) ---
    if (rsi >= RSI_TRAIL_TRIGGER) {
      if (currentPrice <= 0) {
        logger.warn("[LIQUIDATOR] Cannot trail SL — invalid current price", { symbol: productId, currentPrice });
        continue;
      }
      const newSL = currentPrice * (1 - TRAIL_BUFFER_PCT / 100);

      if (existingSL > 0 && newSL <= existingSL) {
        logger.info("[LIQUIDATOR] Trail skipped (would lower SL)", {
          symbol: productId, rsi: rsi.toFixed(1), existingSL, proposedSL: newSL.toPrecision(6),
        });
        continue;
      }

      try {
        const result = await broker.updateStopLoss(productId, newSL);
        if (!result.success) {
          logger.warn("[LIQUIDATOR] updateStopLoss returned failure", { symbol: productId, message: result.message });
          errors.push(`${productId}(SL: ${(result.message || "rejected").slice(0, 50)})`);
          await logDecision({
            source: "liquidator",
            outcome: "REJECTED",
            action: "OTHER",
            symbol: productId,
            price: currentPrice,
            reason: `trailing SL update failed: ${result.message ?? "broker rejected"}`,
            expression: `RSI=${rsi.toFixed(1)} ≥ ${RSI_TRAIL_TRIGGER} → propose SL=${newSL.toPrecision(6)} → broker rejected`,
            params: { entry: entryPrice, current: currentPrice, rsi: +rsi.toFixed(1), existing_sl: existingSL, proposed_sl: +newSL.toPrecision(6) },
          });
          continue;
        }
        trailed.push({ productId, rsi, entry: entryPrice, current: currentPrice, oldSL: existingSL, newSL, gainPct: pnlPct });
        logger.info("[LIQUIDATOR] Trailing SL set/raised", {
          symbol: productId, rsi: rsi.toFixed(1), oldSL: existingSL, newSL: newSL.toPrecision(6), gainPct: pnlPct.toFixed(2),
        });
        await logDecision({
          source: "liquidator",
          outcome: "ACCEPTED",
          action: "OTHER",
          symbol: productId,
          price: currentPrice,
          reason: `trailing SL ${existingSL > 0 ? "raised" : "armed"} (RSI≥${RSI_TRAIL_TRIGGER}, ${TRAIL_BUFFER_PCT}% below current)`,
          expression: `RSI=${rsi.toFixed(1)} ≥ ${RSI_TRAIL_TRIGGER} → SL ${existingSL > 0 ? existingSL.toPrecision(6) : "none"} → ${newSL.toPrecision(6)} (current $${currentPrice.toPrecision(6)}, gain ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
          params: {
            entry: entryPrice,
            current: currentPrice,
            rsi: +rsi.toFixed(1),
            gain_pct: +pnlPct.toFixed(2),
            old_sl: existingSL,
            new_sl: +newSL.toPrecision(6),
            buffer_pct: TRAIL_BUFFER_PCT,
          },
        });
      } catch (err) {
        const errMsg = String(err);
        logger.error("[LIQUIDATOR] updateStopLoss threw", { symbol: productId, error: errMsg });
        errors.push(`${productId}(SL ex: ${errMsg.slice(0, 50)})`);
      }
      continue;
    }

    // 30 ≤ RSI < 70 → hold
    logger.info("[LIQUIDATOR] No action", { symbol: productId, rsi: rsi.toFixed(1) });
  }

  // Only send Telegram notification if something happened
  if (liquidated.length > 0 || errors.length > 0 || stoppedOut.length > 0 || rsiExits.length > 0 || trailed.length > 0) {
    const lines: string[] = ["\u{1F6A8} *Position Liquidator*"];
    if (rsiExits.length > 0) {
      const rLines = rsiExits.map(r =>
        `  \u{1F4C9} ${r.productId} — CUT LOSS (RSI < ${RSI_EXIT_LOSS}) | RSI=${r.rsi.toFixed(1)} | entry ${r.entry.toPrecision(5)} → ${r.current.toPrecision(5)} (${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(2)}%)`
      );
      lines.push(`\u{1F50C} *RSI exits:*\n${rLines.join("\n")}`);
    }
    if (trailed.length > 0) {
      const tLines = trailed.map(t =>
        `  • ${t.productId} +${t.gainPct.toFixed(2)}% RSI=${t.rsi.toFixed(1)} — SL ${t.oldSL > 0 ? t.oldSL.toPrecision(5) : "none"} → ${t.newSL.toPrecision(5)} (current ${t.current.toPrecision(5)})`
      );
      lines.push(`\u{1F53C} *Trailed SL* (RSI ≥ ${RSI_TRAIL_TRIGGER}, ${TRAIL_BUFFER_PCT}% buffer):\n${tLines.join("\n")}`);
    }
    if (stoppedOut.length > 0) {
      const sLines = stoppedOut.map(s => {
        const pl = s.entry > 0 ? (((s.lastPrice - s.entry) / s.entry) * 100).toFixed(2) : "?";
        return `  • ${s.productId} — entry ${s.entry.toPrecision(5)} → last ${s.lastPrice.toPrecision(5)} (${pl}%) SL@${s.stopLoss > 0 ? s.stopLoss.toPrecision(5) : "n/a"}`;
      });
      lines.push(`🛑 *Stop-loss exits:*\n${sLines.join("\n")}`);
    }
    if (errors.length > 0) {
      lines.push(`⚠️ *Errors:* ${errors.join(", ")}`);
    }
    await sendTelegramMessage(lines.join("\n")).catch(() => {});

    // Push notifications: only positive-P/L exits (per user spec)
    for (const r of rsiExits) {
      if (r.pnlPct > 0) {
        try {
          await sendExitNotification(r.productId, r.pnlPct, "RSI cut");
        } catch (err) {
          logger.warn("[LIQUIDATOR] Exit push failed (non-fatal)", { symbol: r.productId, error: String(err) });
        }
      }
    }
    for (const s of stoppedOut) {
      if (s.entry <= 0) continue;
      const pnlPct = ((s.lastPrice - s.entry) / s.entry) * 100;
      if (pnlPct <= 0) continue;
      // Heuristic: if a stopLoss was armed and lastPrice is at/near it, label as trailing stop; otherwise external close.
      const nearStop = s.stopLoss > 0 && s.lastPrice <= s.stopLoss * 1.002;
      const reason = nearStop ? "trailing stop" : "external close";
      try {
        await sendExitNotification(s.productId, pnlPct, reason);
      } catch (err) {
        logger.warn("[LIQUIDATOR] Exit push failed (non-fatal)", { symbol: s.productId, error: String(err) });
      }
    }
  }

  // Record stop-loss exits to decision_logs (Telegram already covered above)
  if (stoppedOut.length > 0) {
    await logStoppedOutDecisions(stoppedOut);
  }

  // Save current snapshot (excluding symbols we liquidated this run —
  // they'll be gone next fetch but were NOT stop-loss exits)
  const liquidatedSet = new Set(liquidated);
  const newSnapshot: PositionSnapshot = {};
  for (const p of positions) {
    const productId = (p.symbol.includes("-") ? p.symbol : `${p.symbol}-USD`).toUpperCase();
    if (liquidatedSet.has(productId)) continue;
    newSnapshot[productId] = {
      entry: parseFloat(p.avg_entry_price) || 0,
      lastPrice: parseFloat(p.current_price) || 0,
      stopLoss: p.stop_loss ? parseFloat(p.stop_loss) || 0 : 0,
    };
  }
  try {
    await snapshotRef.set({ symbols: newSnapshot, updatedAt: FieldValue.serverTimestamp() });
  } catch (err) {
    logger.warn("[LIQUIDATOR] Failed to write snapshot (non-fatal)", { error: String(err) });
  }

  await pruneForbiddenFromAllowlist().catch(err => {
    logger.warn("[LIQUIDATOR] Forbidden allowlist prune failed (non-fatal)", { error: String(err) });
  });
}

async function notifyStoppedOut(
  stoppedOut: Array<{ productId: string; entry: number; lastPrice: number; stopLoss: number }>
): Promise<void> {
  const sLines = stoppedOut.map(s => {
    const pl = s.entry > 0 ? (((s.lastPrice - s.entry) / s.entry) * 100).toFixed(2) : "?";
    return `  • ${s.productId} — entry ${s.entry.toPrecision(5)} → last ${s.lastPrice.toPrecision(5)} (${pl}%) SL@${s.stopLoss > 0 ? s.stopLoss.toPrecision(5) : "n/a"}`;
  });
  await sendTelegramMessage(`🚨 *Position Liquidator*\n🛑 *Stop-loss exits:*\n${sLines.join("\n")}`).catch(() => {});
  await logStoppedOutDecisions(stoppedOut);
}

/**
 * Prune any symbols from the Coinbase allowlist that are present in the burst
 * scanner's forbidden cache (defi/meme/etc.). Runs at the end of every
 * liquidator tick. Non-fatal: any failure is logged and swallowed.
 */
async function pruneForbiddenFromAllowlist(): Promise<void> {
  // 1. Load forbidden cache (keys of the `symbols` map are productIds like TROLL-USD)
  const forbiddenSnap = await db.doc(FORBIDDEN_CACHE_DOC).get();
  if (!forbiddenSnap.exists) return;
  const forbiddenMap = (forbiddenSnap.data()?.symbols ?? {}) as Record<string, number>;
  const forbidden = new Set(Object.keys(forbiddenMap).map(s => s.toUpperCase()));
  if (forbidden.size === 0) return;

  // 2. Load trading config
  const configRef = db.doc(TRADING_CONFIG_DOC);
  const configSnap = await configRef.get();
  if (!configSnap.exists) return;
  const data = configSnap.data() ?? {};
  const allowed = (data.brokerSettings?.coinbase?.allowedSymbols ?? []) as string[];
  if (!Array.isArray(allowed) || allowed.length === 0) return;

  // 3. Diff
  const removed: string[] = [];
  const kept: string[] = [];
  for (const sym of allowed) {
    if (forbidden.has(String(sym).toUpperCase())) removed.push(sym);
    else kept.push(sym);
  }
  if (removed.length === 0) {
    logger.info("[LIQUIDATOR] Allowlist prune: no overlap with forbidden cache", {
      allowlistSize: allowed.length, forbiddenSize: forbidden.size,
    });
    return;
  }

  // 4. Persist trimmed allowlist (merge keeps other fields intact)
  await configRef.set(
    { brokerSettings: { coinbase: { allowedSymbols: kept } } },
    { merge: true },
  );
  logger.info("[LIQUIDATOR] Pruned forbidden symbols from Coinbase allowlist", {
    removed, keptCount: kept.length,
  });

  // 5. Telegram notice (cap list length)
  const MAX_SHOWN = 15;
  const shown = removed.slice(0, MAX_SHOWN);
  const suffix = removed.length > MAX_SHOWN ? `\n  …and ${removed.length - MAX_SHOWN} more` : "";
  const lines = shown.map(s => `  • ${s}`).join("\n");
  await sendTelegramMessage(
    `🧹 *Liquidator* — pruned ${removed.length} forbidden symbol${removed.length === 1 ? "" : "s"} from Coinbase allowlist:\n${lines}${suffix}`
  ).catch(() => {});

  // 6. Decision log entries (one per removed symbol) for queryability
  await Promise.all(removed.map(productId =>
    logDecision({
      source: "liquidator",
      outcome: "ACCEPTED",
      action: "OTHER",
      symbol: productId,
      price: 0,
      reason: "pruned from Coinbase allowlist (forbidden category)",
      expression: `${productId} ∈ forbidden cache → removed from brokerSettings.coinbase.allowedSymbols`,
      params: { allowlist_size_after: kept.length },
    }).catch(() => {})
  ));
}

async function logStoppedOutDecisions(
  stoppedOut: Array<{ productId: string; entry: number; lastPrice: number; stopLoss: number }>
): Promise<void> {
  await Promise.all(stoppedOut.map(s => {
    const pnlPct = s.entry > 0 ? ((s.lastPrice - s.entry) / s.entry) * 100 : 0;
    return logDecision({
      source: "liquidator",
      outcome: "ACCEPTED",
      action: "SELL",
      symbol: s.productId,
      price: s.lastPrice,
      reason: "stop-loss exit (position disappeared between runs)",
      expression: `position closed: entry=${s.entry.toPrecision(6)} → last=${s.lastPrice.toPrecision(6)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%) SL=${s.stopLoss > 0 ? s.stopLoss.toPrecision(6) : "n/a"}`,
      params: {
        entry: s.entry,
        last_price: s.lastPrice,
        stop_loss: s.stopLoss,
        pnl_pct: +pnlPct.toFixed(2),
      },
    });
  })).catch(() => {});
}
