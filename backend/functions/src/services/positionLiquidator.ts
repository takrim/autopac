/**
 * Position Liquidator
 *
 * Runs every 1 minute on Coinbase positions.
 *
 * Per position (excluding IGNORED_SYMBOLS):
 *   • compute RSI(14) on 3-min closes (aggregated from 1-min candles)
 *   • if RSI ≥ 80 → trailing SL = current × (1 − TRAIL_BUFFER_PCT/100), ratchet-only
 *   • else if SL is missing/0 → set SL = current × (1 − DEFAULT_SL_PCT/100)
 *   • else → leave SL alone
 *
 * Sends a Telegram heartbeat every run with all relevant per-position info.
 * If all open positions are in IGNORED_SYMBOLS the heartbeat says "skipped".
 */

import { logger } from "firebase-functions/v2";
import { getBroker } from "../brokers";
import { CoinbaseBroker } from "../brokers/coinbase";
import { DetailedPosition } from "../brokers/interface";
import { sendTelegramMessage } from "./telegram";
import { sendTrailingStopNotification } from "./notification";
import { logDecision } from "./decisionLog";
import { computeRSI } from "./strategies/shared";
import { listRecentRsiDips } from "./rsiDip";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const RSI_PERIOD               = 14;
const RSI_TRAIL_TRIGGER        = 80;     // RSI ≥ 80 → arm/raise trailing stop
const TRAIL_BUFFER_PCT         = 1.0;    // trailing stop = current × (1 − 1%)
const DEFAULT_SL_PCT           = 2.0;    // initial stop = current × (1 − 2.0%) when SL missing
const PROFIT_LOCK_TRIGGER_PCT  = 2.0;    // PnL ≥ +2% → lock in profit
const PROFIT_LOCK_OFFSET_PCT   = 1.0;    // profit-lock SL = entry × (1 + 1%)
const RSI_FETCH_COUNT          = 300;    // 1-min candles aggregated to 3-min

const IGNORED_SYMBOLS = new Set<string>(["IO-USD", "GNO-USD"]);

const DIP_WINDOW_MS = 27 * 60 * 1000;   // mirror bulltrend RSI-dip gate window
const RECENT_STOPS_LIMIT = 5;           // recent stop-out summaries shown in heartbeat

// ---------------------------------------------------------------------------
// Helpers
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
    logger.warn("[LIQUIDATOR] RSI fetch failed", { productId, error: String(err) });
    return NaN;
  }
}

function toProductId(sym: string): string {
  const s = sym.toUpperCase();
  return s.includes("-") ? s : `${s}-USD`;
}

type Outcome =
  | { kind: "trailed";    oldSL: number; newSL: number }
  | { kind: "armed_trail"; newSL: number }
  | { kind: "trail_skipped_lower"; existingSL: number; proposedSL: number }
  | { kind: "profit_locked"; oldSL: number; newSL: number }
  | { kind: "profit_lock_armed"; newSL: number }
  | { kind: "profit_lock_skipped_lower"; existingSL: number; proposedSL: number }
  | { kind: "default_sl_set"; newSL: number }
  | { kind: "held";       existingSL: number }
  | { kind: "no_action";  reason: string }
  | { kind: "error";      message: string };

interface PerPosition {
  productId: string;
  entry: number;
  current: number;
  existingSL: number;
  pnlPct: number;
  rsi: number;          // NaN if unavailable
  ignored: boolean;
  outcome: Outcome;
}

interface StopFillSummary {
  symbol: string;
  exit: number;
  qty: number;
  entry: number | null;
  pnlUsd: number | null;
  filledAt: string;     // ISO string, "" if unknown
  ageMs: number;        // Number.POSITIVE_INFINITY if unknown
}

/**
 * Fetch the most recent stop-loss (SELL stop-limit) fills from Coinbase and
 * pair each with the most recent prior BUY fill on the same product to derive
 * entry price + realised USD P&L.
 */
async function getRecentStopFillSummaries(cb: CoinbaseBroker, limit = RECENT_STOPS_LIMIT): Promise<StopFillSummary[]> {
  try {
    const { ok, data } = await (cb as unknown as { request: (m: string, p: string) => Promise<{ ok: boolean; data: Record<string, unknown> }> })
      .request("GET", "/orders/historical/batch?order_status=FILLED&limit=100");
    if (!ok) return [];
    const orders = (data.orders as Array<Record<string, unknown>> | undefined) || [];

    // Index BUY fills by symbol for entry-price lookup.
    const buysBySymbol = new Map<string, Array<{ time: number; price: number }>>();
    for (const o of orders) {
      if (o.side !== "BUY") continue;
      const sym = String(o.product_id || "");
      const price = parseFloat(String(o.average_filled_price || "0"));
      const t = Date.parse(String(o.last_fill_time || ""));
      if (!sym || !(price > 0) || !Number.isFinite(t)) continue;
      const arr = buysBySymbol.get(sym) || [];
      arr.push({ time: t, price });
      buysBySymbol.set(sym, arr);
    }

    const stops = orders.filter((o) => {
      if (o.side !== "SELL") return false;
      const cfg = o.order_configuration as Record<string, unknown> | undefined;
      return !!(cfg?.stop_limit_stop_limit_gtc || cfg?.stop_limit_stop_limit_gtd);
    }).slice(0, limit);

    const now = Date.now();
    return stops.map((o) => {
      const symbol = String(o.product_id || "");
      const exit = parseFloat(String(o.average_filled_price || "0"));
      const qty = parseFloat(String(o.filled_size || "0"));
      const filledAt = String(o.last_fill_time || "");
      const filledTs = Date.parse(filledAt);
      const ageMs = Number.isFinite(filledTs) ? now - filledTs : Number.POSITIVE_INFINITY;

      const buys = buysBySymbol.get(symbol) || [];
      const eligible = Number.isFinite(filledTs) ? buys.filter((b) => b.time <= filledTs) : buys;
      const chosen = (eligible.length > 0 ? eligible : buys).sort((a, b) => b.time - a.time)[0];
      const entry = chosen ? chosen.price : null;
      const pnlUsd = entry !== null && exit > 0 && qty > 0 ? (exit - entry) * qty : null;

      return { symbol, exit, qty, entry, pnlUsd, filledAt, ageMs };
    });
  } catch (err) {
    logger.warn("[LIQUIDATOR] getRecentStopFillSummaries failed", { error: String(err) });
    return [];
  }
}

function formatStopFillLines(stops: StopFillSummary[]): string {
  if (stops.length === 0) return `📭 *Recent stop-outs*: none`;
  const lines = [`💸 *Recent stop-outs* (last ${stops.length}):`];
  for (const s of stops) {
    const entryStr = s.entry !== null ? `$${s.entry.toPrecision(5)}` : "n/a";
    const exitStr = s.exit > 0 ? `$${s.exit.toPrecision(5)}` : "n/a";
    const qtyStr = s.qty > 0 ? s.qty.toPrecision(4) : "n/a";
    const pnlStr = s.pnlUsd !== null
      ? `${s.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(s.pnlUsd).toFixed(2)}`
      : "n/a";
    const ageStr = Number.isFinite(s.ageMs)
      ? (s.ageMs < 60_000
          ? `${Math.round(s.ageMs / 1000)}s ago`
          : s.ageMs < 3_600_000
            ? `${Math.round(s.ageMs / 60_000)}m ago`
            : `${Math.round(s.ageMs / 3_600_000)}h ago`)
      : "";
    lines.push(`  • ${s.symbol} entry=${entryStr} → exit=${exitStr} qty=${qtyStr} pnl=${pnlStr}${ageStr ? ` (${ageStr})` : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

export async function runPositionLiquidator(): Promise<void> {
  const tStart = Date.now();
  logger.info("[LIQUIDATOR] Starting run");

  const broker = getBroker("coinbase") as CoinbaseBroker;

  let positions: DetailedPosition[] = [];
  try {
    if (broker.getDetailedPositions) {
      positions = await broker.getDetailedPositions();
    }
  } catch (err) {
    logger.error("[LIQUIDATOR] Failed to fetch positions", { error: String(err) });
    await sendTelegramMessage(`⚠️ *Liquidator* — failed to fetch positions\n${String(err).slice(0, 250)}`).catch(() => {});
    return;
  }

  if (positions.length === 0) {
    logger.info("[LIQUIDATOR] No open positions");
    const [dips, recentStops] = await Promise.all([
      listRecentRsiDips(DIP_WINDOW_MS),
      getRecentStopFillSummaries(broker),
    ]);
    const windowMin = Math.round(DIP_WINDOW_MS / 60000);
    const dipLines = dips.length === 0
      ? `📭 *RSI dips* (last ${windowMin} min): none`
      : `📉 *RSI dips* (last ${windowMin} min, ${dips.length}):\n` +
        dips.map(d => {
          const ageSec = Math.round(d.ageMs / 1000);
          const priceStr = d.price !== null ? d.price.toPrecision(5) : "n/a";
          const rsiStr = d.rsi !== null ? d.rsi.toFixed(1) : "n/a";
          return `  • ${d.symbol} @${priceStr} RSI=${rsiStr} (${ageSec}s ago)`;
        }).join("\n");
    const stopsBlock = formatStopFillLines(recentStops);
    await sendTelegramMessage(`🫥 *Liquidator heartbeat* — no open positions\n\n${dipLines}\n\n${stopsBlock}`).catch(() => {});
    return;
  }

  const results: PerPosition[] = [];

  for (const position of positions) {
    const productId  = toProductId(position.symbol);
    const entry      = parseFloat(position.avg_entry_price) || 0;
    const current    = parseFloat(position.current_price)   || 0;
    const existingSL = position.stop_loss ? parseFloat(position.stop_loss) || 0 : 0;
    const pnlPct     = entry > 0 ? ((current - entry) / entry) * 100 : 0;
    const ignored    = IGNORED_SYMBOLS.has(productId);

    const base = { productId, entry, current, existingSL, pnlPct, ignored };

    if (ignored) {
      results.push({ ...base, rsi: NaN, outcome: { kind: "no_action", reason: "ignored symbol" } });
      continue;
    }

    if (current <= 0) {
      results.push({ ...base, rsi: NaN, outcome: { kind: "no_action", reason: "no current price" } });
      continue;
    }

    const rsi = await fetchRsi3m(broker, productId);

    // Profit-lock candidate (entry × 1.01) when PnL ≥ +2%; 0 if not applicable.
    const profitLockSL = (entry > 0 && pnlPct >= PROFIT_LOCK_TRIGGER_PCT)
      ? entry * (1 + PROFIT_LOCK_OFFSET_PCT / 100)
      : 0;

    // ── Trailing-stop branch (RSI ≥ 80) ─────────────────────────────────
    if (Number.isFinite(rsi) && rsi >= RSI_TRAIL_TRIGGER) {
      const trailSL = current * (1 - TRAIL_BUFFER_PCT / 100);
      const newSL = Math.max(trailSL, profitLockSL);
      if (existingSL > 0 && newSL <= existingSL) {
        results.push({ ...base, rsi, outcome: { kind: "trail_skipped_lower", existingSL, proposedSL: newSL } });
        continue;
      }
      try {
        const result = await broker.updateStopLoss(productId, newSL);
        if (!result.success) {
          logger.warn("[LIQUIDATOR] updateStopLoss rejected (trail)", { productId, message: result.message });
          results.push({ ...base, rsi, outcome: { kind: "error", message: `trail rejected: ${result.message ?? "broker"}` } });
          await logDecision({
            source: "liquidator", outcome: "REJECTED", action: "OTHER",
            symbol: productId, price: current,
            reason: `trailing SL update failed: ${result.message ?? "broker rejected"}`,
            expression: `RSI=${rsi.toFixed(1)} ≥ ${RSI_TRAIL_TRIGGER} → propose SL=${newSL.toPrecision(6)} → broker rejected`,
            params: { entry, current, rsi: +rsi.toFixed(1), existing_sl: existingSL, proposed_sl: +newSL.toPrecision(6) },
          });
          continue;
        }
        const wasRaised = existingSL > 0;
        results.push({
          ...base, rsi,
          outcome: wasRaised
            ? { kind: "trailed", oldSL: existingSL, newSL }
            : { kind: "armed_trail", newSL },
        });
        await sendTrailingStopNotification(productId, newSL, pnlPct, wasRaised).catch((notifErr) => {
          logger.warn("[LIQUIDATOR] Push notification failed (non-fatal)", { productId, error: String(notifErr) });
        });
        await logDecision({
          source: "liquidator", outcome: "ACCEPTED", action: "OTHER",
          symbol: productId, price: current,
          reason: `trailing SL ${wasRaised ? "raised" : "armed"} (RSI ≥ ${RSI_TRAIL_TRIGGER})`,
          expression: `RSI=${rsi.toFixed(1)} ≥ ${RSI_TRAIL_TRIGGER} → SL ${wasRaised ? existingSL.toPrecision(6) : "none"} → ${newSL.toPrecision(6)}`,
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
        logger.error("[LIQUIDATOR] updateStopLoss threw (trail)", { productId, error: String(err) });
        results.push({ ...base, rsi, outcome: { kind: "error", message: String(err).slice(0, 200) } });
      }
      continue;
    }

    // ── Profit-lock branch (PnL ≥ +2%, RSI < 80) ────────────────────────
    if (profitLockSL > 0) {
      if (existingSL > 0 && profitLockSL <= existingSL) {
        results.push({ ...base, rsi, outcome: { kind: "profit_lock_skipped_lower", existingSL, proposedSL: profitLockSL } });
        continue;
      }
      try {
        const result = await broker.updateStopLoss(productId, profitLockSL);
        if (!result.success) {
          logger.warn("[LIQUIDATOR] updateStopLoss rejected (profit-lock)", { productId, message: result.message });
          results.push({ ...base, rsi, outcome: { kind: "error", message: `profit-lock rejected: ${result.message ?? "broker"}` } });
          await logDecision({
            source: "liquidator", outcome: "REJECTED", action: "OTHER",
            symbol: productId, price: current,
            reason: `profit-lock SL update failed: ${result.message ?? "broker rejected"}`,
            expression: `PnL=${pnlPct.toFixed(2)}% ≥ ${PROFIT_LOCK_TRIGGER_PCT}% → propose SL=entry×(1+${PROFIT_LOCK_OFFSET_PCT}%)=${profitLockSL.toPrecision(6)} → broker rejected`,
            params: { entry, current, pnl_pct: +pnlPct.toFixed(2), existing_sl: existingSL, proposed_sl: +profitLockSL.toPrecision(6) },
          });
          continue;
        }
        const wasRaised = existingSL > 0;
        results.push({
          ...base, rsi,
          outcome: wasRaised
            ? { kind: "profit_locked", oldSL: existingSL, newSL: profitLockSL }
            : { kind: "profit_lock_armed", newSL: profitLockSL },
        });
        await logDecision({
          source: "liquidator", outcome: "ACCEPTED", action: "OTHER",
          symbol: productId, price: current,
          reason: `profit-lock SL ${wasRaised ? "raised" : "armed"} (PnL ≥ ${PROFIT_LOCK_TRIGGER_PCT}%)`,
          expression: `PnL=${pnlPct.toFixed(2)}% ≥ ${PROFIT_LOCK_TRIGGER_PCT}% → SL ${wasRaised ? existingSL.toPrecision(6) : "none"} → ${profitLockSL.toPrecision(6)} (entry×(1+${PROFIT_LOCK_OFFSET_PCT}%))`,
          params: {
            entry, current,
            rsi: Number.isFinite(rsi) ? +rsi.toFixed(1) : null,
            pnl_pct: +pnlPct.toFixed(2),
            old_sl: existingSL,
            new_sl: +profitLockSL.toPrecision(6),
            offset_pct: PROFIT_LOCK_OFFSET_PCT,
          },
        });
      } catch (err) {
        logger.error("[LIQUIDATOR] updateStopLoss threw (profit-lock)", { productId, error: String(err) });
        results.push({ ...base, rsi, outcome: { kind: "error", message: String(err).slice(0, 200) } });
      }
      continue;
    }

    // ── Default-SL branch (RSI < 80 or unavailable, no SL set) ──────────
    if (existingSL <= 0) {
      const newSL = current * (1 - DEFAULT_SL_PCT / 100);
      try {
        const result = await broker.updateStopLoss(productId, newSL);
        if (!result.success) {
          logger.warn("[LIQUIDATOR] updateStopLoss rejected (default)", { productId, message: result.message });
          results.push({ ...base, rsi, outcome: { kind: "error", message: `default SL rejected: ${result.message ?? "broker"}` } });
          await logDecision({
            source: "liquidator", outcome: "REJECTED", action: "OTHER",
            symbol: productId, price: current,
            reason: `default SL set failed: ${result.message ?? "broker rejected"}`,
            expression: `no SL → propose ${DEFAULT_SL_PCT}% below current=${newSL.toPrecision(6)} → broker rejected`,
            params: { entry, current, rsi: Number.isFinite(rsi) ? +rsi.toFixed(1) : null, proposed_sl: +newSL.toPrecision(6) },
          });
          continue;
        }
        results.push({ ...base, rsi, outcome: { kind: "default_sl_set", newSL } });
        await logDecision({
          source: "liquidator", outcome: "ACCEPTED", action: "OTHER",
          symbol: productId, price: current,
          reason: `default SL set (${DEFAULT_SL_PCT}% below current)`,
          expression: `no existing SL → SL = current × (1 − ${DEFAULT_SL_PCT}%) = ${newSL.toPrecision(6)}`,
          params: {
            entry, current,
            rsi: Number.isFinite(rsi) ? +rsi.toFixed(1) : null,
            gain_pct: +pnlPct.toFixed(2),
            new_sl: +newSL.toPrecision(6),
            default_pct: DEFAULT_SL_PCT,
          },
        });
      } catch (err) {
        logger.error("[LIQUIDATOR] updateStopLoss threw (default)", { productId, error: String(err) });
        results.push({ ...base, rsi, outcome: { kind: "error", message: String(err).slice(0, 200) } });
      }
      continue;
    }

    // ── Hold branch (SL already set, RSI < 80) ──────────────────────────
    results.push({ ...base, rsi, outcome: { kind: "held", existingSL } });
  }

  // ── Heartbeat ────────────────────────────────────────────────────────
  const ignoredCount  = results.filter(r => r.ignored).length;
  const actionable    = results.filter(r => !r.ignored);
  const allIgnored    = positions.length > 0 && actionable.length === 0;

  const lines: string[] = [];
  if (allIgnored) {
    lines.push(`🫥 *Liquidator heartbeat* — skipped (all ${positions.length} open positions are ignored: ${[...IGNORED_SYMBOLS].join(", ")})`);
  } else {
    lines.push(`💓 *Liquidator heartbeat* (${positions.length} pos, ${ignoredCount} ignored)`);
  }

  for (const r of results) {
    const rsiStr = Number.isFinite(r.rsi) ? r.rsi.toFixed(1) : "n/a";
    const slStr  = r.existingSL > 0 ? r.existingSL.toPrecision(5) : "none";
    const pnlSign = r.pnlPct >= 0 ? "+" : "";
    let tail: string;
    switch (r.outcome.kind) {
      case "trailed":
        tail = `🔼 SL ${r.outcome.oldSL.toPrecision(5)} → ${r.outcome.newSL.toPrecision(5)}`;
        break;
      case "armed_trail":
        tail = `🛡️ SL armed → ${r.outcome.newSL.toPrecision(5)}`;
        break;
      case "trail_skipped_lower":
        tail = `↔︎ trail skipped (would lower ${r.outcome.existingSL.toPrecision(5)} → ${r.outcome.proposedSL.toPrecision(5)})`;
        break;
      case "profit_locked":
        tail = `🔒 profit-lock SL ${r.outcome.oldSL.toPrecision(5)} → ${r.outcome.newSL.toPrecision(5)} (entry+${PROFIT_LOCK_OFFSET_PCT}%)`;
        break;
      case "profit_lock_armed":
        tail = `🔒 profit-lock SL armed → ${r.outcome.newSL.toPrecision(5)} (entry+${PROFIT_LOCK_OFFSET_PCT}%)`;
        break;
      case "profit_lock_skipped_lower":
        tail = `↔︎ profit-lock skipped (would lower ${r.outcome.existingSL.toPrecision(5)} → ${r.outcome.proposedSL.toPrecision(5)})`;
        break;
      case "default_sl_set":
        tail = `🆕 default SL set → ${r.outcome.newSL.toPrecision(5)} (${DEFAULT_SL_PCT}% below)`;
        break;
      case "held":
        tail = `hold (SL ${r.outcome.existingSL.toPrecision(5)})`;
        break;
      case "no_action":
        tail = r.ignored ? "ignored" : `no action (${r.outcome.reason})`;
        break;
      case "error":
        tail = `⚠️ ${r.outcome.message}`;
        break;
    }
    lines.push(
      `  • ${r.productId} ${pnlSign}${r.pnlPct.toFixed(2)}% px=${r.current.toPrecision(5)} RSI=${rsiStr} SL=${slStr} — ${tail}`,
    );
  }

  // ── Active RSI-dip collection (buy candidates within bulltrend window) ──
  const dips = await listRecentRsiDips(DIP_WINDOW_MS);
  const windowMin = Math.round(DIP_WINDOW_MS / 60000);
  if (dips.length === 0) {
    lines.push(`\n📭 *RSI dips* (last ${windowMin} min): none`);
  } else {
    lines.push(`\n📉 *RSI dips* (last ${windowMin} min, ${dips.length}):`);
    for (const d of dips) {
      const ageSec = Math.round(d.ageMs / 1000);
      const priceStr = d.price !== null ? d.price.toPrecision(5) : "n/a";
      const rsiStr = d.rsi !== null ? d.rsi.toFixed(1) : "n/a";
      lines.push(`  • ${d.symbol} @${priceStr} RSI=${rsiStr} (${ageSec}s ago)`);
    }
  }

  // ── Recent stop-loss executions (entry, exit, USD P&L) ──
  const recentStops = await getRecentStopFillSummaries(broker);
  lines.push("\n" + formatStopFillLines(recentStops));

  await sendTelegramMessage(lines.join("\n")).catch(() => {});

  logger.info("[LIQUIDATOR] Run complete", {
    durationMs: Date.now() - tStart,
    positions: positions.length,
    ignored: ignoredCount,
    trailed: results.filter(r => r.outcome.kind === "trailed" || r.outcome.kind === "armed_trail").length,
    defaultSet: results.filter(r => r.outcome.kind === "default_sl_set").length,
    errors: results.filter(r => r.outcome.kind === "error").length,
  });
}
