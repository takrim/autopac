/**
 * /cgbacktest — CoinGecko-driven crypto filter backtest.
 *
 * Pulls historical OHLC + hourly volume for a symbol from CoinGecko Pro,
 * evaluates a free-form filter expression per bar, simulates entries with a
 * positionLiquidator-style trailing-stop exit, and returns summary stats plus
 * the most recent simulated trades.
 *
 * Window:
 *   - Relative: `days` (1..30), default 14 → 1h OHLC bars (30m for days=1).
 *   - Absolute: `fromMs` + `toMs` (Pro `/range` endpoints), span clamped to 30d.
 *
 * Filter context (per bar):
 *   price, gainBar, gain24h, vol24h, rsi, ema200, aboveTrend, rank, marketCap
 *   plus literals: true, false
 * Operators: || && ! < <= > >= == != ( )  ; number suffixes k/m/b.
 */

import { logger } from "firebase-functions/v2";
import { computeEMA, computeRSI } from "./strategies/shared";

const CG_BASE = "https://pro-api.coingecko.com/api/v3";

// Trailing-stop defaults (mirror positionLiquidator semantics but local)
const DEFAULT_SL_PCT       = 1.0;    // initial hard stop %
const DEFAULT_TRAIL_PCT    = 1.5;    // trailing distance %
const DEFAULT_MAX_HOLD_BARS = 48;    // bar count cap
const RSI_CUT              = 30;     // RSI < → exit on close
const RSI_TRAIL_ACTIVATE   = 70;     // RSI ≥ → activate trailing
const FEE_PCT_PER_SIDE     = 0.6;
const ORDER_SIZE_USD       = 1000;
const MAX_SPAN_MS          = 30 * 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CgBacktestInput {
  symbol: string;                // user input — resolved to CoinGecko id
  expression: string;            // raw filter expression
  days?: number;                 // relative window (mutually exclusive with from/to)
  fromMs?: number;               // absolute window start
  toMs?: number;                 // absolute window end (defaults to now)
  slPct?: number;
  tpPct?: number;
  trailPct?: number;
  maxHoldBars?: number;
}

export interface CgBacktestTrade {
  entryTs: number;        // seconds
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;         // gross % move
  pnlUsd: number;         // net of fees, $1k notional
  exitReason: string;
}

export interface CgBacktestResult {
  symbol: string;
  cgId: string;
  windowLabel: string;
  barCount: number;
  barIntervalLabel: string;
  marketCapRank: number | null;
  marketCapUsd: number | null;
  filterMatches: number;
  trades: CgBacktestTrade[];
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    netPnl: number;
    grossPnl: number;
    avgWin: number;
    avgLoss: number;
    rr: number | null;
    maxDrawdown: number;
    exitReasons: Record<string, number>;
    bestHourUtc: number | null;
  };
  warnings: string[];
}

interface Bar {
  ts: number;             // seconds
  open: number;
  high: number;
  low: number;
  close: number;
  vol24h: number | null;  // rolling 24-bar sum in USD
}

// ─── CoinGecko fetch helper ─────────────────────────────────────────────────

async function cgGet<T>(path: string): Promise<T | null> {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    logger.error("[CG_BACKTEST] Missing COINGECKO_API_KEY secret");
    return null;
  }
  try {
    const resp = await fetch(`${CG_BASE}${path}`, {
      headers: { "x-cg-pro-api-key": apiKey },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      logger.warn("[CG_BACKTEST] CoinGecko request failed", {
        path, status: resp.status, body: body.slice(0, 200),
      });
      return null;
    }
    return (await resp.json()) as T;
  } catch (err) {
    logger.warn("[CG_BACKTEST] CoinGecko fetch error", { path, error: String(err) });
    return null;
  }
}

// ─── Symbol resolution ──────────────────────────────────────────────────────

function stripQuote(sym: string): string {
  const upper = sym.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const quote of ["USDT", "USDC", "USD", "BTC", "ETH"]) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return upper.slice(0, upper.length - quote.length);
    }
  }
  return upper;
}

async function resolveCgId(rawSymbol: string): Promise<string | null> {
  const sym = stripQuote(rawSymbol);
  if (!sym) return null;
  const data = await cgGet<{ coins: Array<{ id: string; symbol: string; market_cap_rank?: number }> }>(
    `/search?query=${encodeURIComponent(sym)}`
  );
  if (!data?.coins?.length) return null;
  // Prefer exact symbol match with best (lowest) market cap rank
  const exact = data.coins
    .filter(c => c.symbol.toLowerCase() === sym.toLowerCase())
    .sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))[0];
  return exact?.id ?? data.coins[0]?.id ?? null;
}

interface CoinDetail {
  market_cap_rank: number | null;
  market_data: { market_cap: { usd: number | null } };
}

async function fetchCoinDetail(cgId: string): Promise<CoinDetail | null> {
  return cgGet<CoinDetail>(
    `/coins/${encodeURIComponent(cgId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`
  );
}

// ─── Historical data fetch ──────────────────────────────────────────────────

type OhlcTuple = [number, number, number, number, number]; // [ts_ms, o, h, l, c]
type ChartPoint = [number, number];                         // [ts_ms, value]

async function fetchOhlc(
  cgId: string,
  mode: "relative" | "absolute",
  days: number,
  fromSec: number,
  toSec: number,
): Promise<OhlcTuple[] | null> {
  if (mode === "relative") {
    return cgGet<OhlcTuple[]>(
      `/coins/${encodeURIComponent(cgId)}/ohlc?vs_currency=usd&days=${days}`
    );
  }
  return cgGet<OhlcTuple[]>(
    `/coins/${encodeURIComponent(cgId)}/ohlc/range?vs_currency=usd&from=${fromSec}&to=${toSec}&interval=hourly`
  );
}

async function fetchHourlyVolume(
  cgId: string,
  mode: "relative" | "absolute",
  days: number,
  fromSec: number,
  toSec: number,
): Promise<ChartPoint[]> {
  if (mode === "relative") {
    const data = await cgGet<{ total_volumes: ChartPoint[] }>(
      `/coins/${encodeURIComponent(cgId)}/market_chart?vs_currency=usd&days=${days}&interval=hourly`
    );
    return data?.total_volumes ?? [];
  }
  const data = await cgGet<{ total_volumes: ChartPoint[] }>(
    `/coins/${encodeURIComponent(cgId)}/market_chart/range?vs_currency=usd&from=${fromSec}&to=${toSec}`
  );
  return data?.total_volumes ?? [];
}

// ─── Expression parser (recursive descent) ──────────────────────────────────
// Grammar:
//   expr   := or
//   or     := and ( '||' and )*
//   and    := not ( '&&' not )*
//   not    := '!' not | cmp
//   cmp    := atom ( ('<'|'<='|'>'|'>='|'=='|'!=') atom )?
//   atom   := number | ident | '(' expr ')'
// Identifiers whitelisted; unknown identifier → ParseError.

class ParseError extends Error {}

const ALLOWED_IDENTS = new Set([
  "price", "gainBar", "gain24h", "vol24h",
  "rsi", "ema200", "aboveTrend", "rank", "marketCap",
  "true", "false",
]);

type Node =
  | { type: "num"; value: number }
  | { type: "id"; name: string }
  | { type: "not"; arg: Node }
  | { type: "bin"; op: string; left: Node; right: Node };

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  const re = /\s+|(&&|\|\||<=|>=|==|!=|[<>!()])|([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?[kmb]?)/g;
  let lastIdx = 0;
  for (const m of src.matchAll(re)) {
    if (m.index !== lastIdx) {
      throw new ParseError(`Unexpected character near '${src.slice(lastIdx, m.index + 1)}'`);
    }
    lastIdx = m.index + m[0].length;
    if (/^\s+$/.test(m[0])) continue;
    tokens.push(m[0]);
  }
  if (lastIdx !== src.length) {
    throw new ParseError(`Unexpected trailing '${src.slice(lastIdx)}'`);
  }
  return tokens;
}

function parseNumber(tok: string): number {
  const m = tok.match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) throw new ParseError(`Bad number '${tok}'`);
  const n = parseFloat(m[1]);
  switch ((m[2] ?? "").toLowerCase()) {
    case "k": return n * 1_000;
    case "m": return n * 1_000_000;
    case "b": return n * 1_000_000_000;
    default: return n;
  }
}

function parseExpression(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t?: string) => {
    if (t !== undefined && tokens[pos] !== t) throw new ParseError(`Expected '${t}', got '${tokens[pos] ?? "EOF"}'`);
    return tokens[pos++];
  };

  function parseOr(): Node {
    let left = parseAnd();
    while (peek() === "||") { eat(); left = { type: "bin", op: "||", left, right: parseAnd() }; }
    return left;
  }
  function parseAnd(): Node {
    let left = parseNot();
    while (peek() === "&&") { eat(); left = { type: "bin", op: "&&", left, right: parseNot() }; }
    return left;
  }
  function parseNot(): Node {
    if (peek() === "!") { eat(); return { type: "not", arg: parseNot() }; }
    return parseCmp();
  }
  function parseCmp(): Node {
    const left = parseAtom();
    const op = peek();
    if (op === "<" || op === "<=" || op === ">" || op === ">=" || op === "==" || op === "!=") {
      eat();
      const right = parseAtom();
      return { type: "bin", op, left, right };
    }
    return left;
  }
  function parseAtom(): Node {
    const t = peek();
    if (t === undefined) throw new ParseError("Unexpected end of expression");
    if (t === "(") { eat("("); const e = parseOr(); eat(")"); return e; }
    if (/^[A-Za-z_]/.test(t)) {
      eat();
      if (!ALLOWED_IDENTS.has(t)) throw new ParseError(`Unknown identifier '${t}' (allowed: ${Array.from(ALLOWED_IDENTS).join(", ")})`);
      return { type: "id", name: t };
    }
    if (/^\d/.test(t)) { eat(); return { type: "num", value: parseNumber(t) }; }
    throw new ParseError(`Unexpected token '${t}'`);
  }

  const ast = parseOr();
  if (pos !== tokens.length) throw new ParseError(`Unexpected token '${tokens[pos]}'`);
  return ast;
}

type Ctx = Record<string, number | boolean>;

function evalNode(node: Node, ctx: Ctx): number | boolean {
  switch (node.type) {
    case "num": return node.value;
    case "id":
      if (node.name === "true")  return true;
      if (node.name === "false") return false;
      return ctx[node.name] ?? NaN;
    case "not": return !evalNode(node.arg, ctx);
    case "bin": {
      if (node.op === "&&") return Boolean(evalNode(node.left, ctx)) && Boolean(evalNode(node.right, ctx));
      if (node.op === "||") return Boolean(evalNode(node.left, ctx)) || Boolean(evalNode(node.right, ctx));
      const l = evalNode(node.left, ctx) as number;
      const r = evalNode(node.right, ctx) as number;
      switch (node.op) {
        case "<":  return l <  r;
        case "<=": return l <= r;
        case ">":  return l >  r;
        case ">=": return l >= r;
        case "==": return l === r;
        case "!=": return l !== r;
      }
    }
  }
  return false;
}

// ─── Volume alignment ───────────────────────────────────────────────────────

function buildVolume24h(bars: OhlcTuple[], volSeries: ChartPoint[]): Array<number | null> {
  // Sort volume series by ts; for each bar, find the volume buckets falling in
  // the trailing 24h window. Series is hourly so 24 buckets per window.
  const sorted = [...volSeries].sort((a, b) => a[0] - b[0]);
  const vols = sorted.map(p => p[1]);
  const tsMs = sorted.map(p => p[0]);
  const out: Array<number | null> = new Array(bars.length).fill(null);
  if (sorted.length === 0) return out;
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  let lo = 0, hi = 0;
  for (let i = 0; i < bars.length; i++) {
    const barMs = bars[i][0];
    const fromMs = barMs - WINDOW_MS;
    while (hi < tsMs.length && tsMs[hi] <= barMs) hi++;
    while (lo < hi && tsMs[lo] < fromMs) lo++;
    if (hi === lo) { out[i] = null; continue; }
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += vols[k];
    out[i] = sum;
  }
  return out;
}

// ─── Simulator ──────────────────────────────────────────────────────────────

interface PerBar {
  rsi: number | null;
  ema200: number | null;
  aboveTrend: boolean;
  gainBar: number | null;
  gain24h: number | null;
  vol24h: number | null;
}

function buildContext(bars: Bar[], i: number, per: PerBar, rank: number | null, marketCap: number | null): Ctx {
  return {
    price: bars[i].close,
    gainBar: per.gainBar ?? NaN,
    gain24h: per.gain24h ?? NaN,
    vol24h: per.vol24h ?? NaN,
    rsi: per.rsi ?? NaN,
    ema200: per.ema200 ?? NaN,
    aboveTrend: per.aboveTrend,
    rank: rank ?? NaN,
    marketCap: marketCap ?? NaN,
  };
}

function simulate(
  bars: Bar[],
  perBars: PerBar[],
  ast: Node,
  rank: number | null,
  marketCap: number | null,
  slPct: number,
  tpPct: number | null,
  trailPct: number,
  maxHoldBars: number,
): { trades: CgBacktestTrade[]; matches: number } {
  const trades: CgBacktestTrade[] = [];
  let matches = 0;
  let i = 0;
  // Warmup: need EMA200, 24-bar gain, and RSI to all be valid
  while (i < bars.length && (perBars[i].ema200 === null || perBars[i].rsi === null || perBars[i].gain24h === null)) i++;

  while (i < bars.length - 1) {
    const ctx = buildContext(bars, i, perBars[i], rank, marketCap);
    const matched = Boolean(evalNode(ast, ctx));
    if (!matched) { i++; continue; }
    matches++;

    // Enter at next bar's open to avoid lookahead bias
    const entryIdx = i + 1;
    const entry = bars[entryIdx].open;
    let stop = entry * (1 - slPct / 100);
    const tp = tpPct !== null ? entry * (1 + tpPct / 100) : null;
    let peakHigh = entry;
    let trailing = false;
    let exitIdx = -1;
    let exitPrice = entry;
    let reason = "max_hold";

    for (let j = entryIdx; j < Math.min(bars.length, entryIdx + maxHoldBars); j++) {
      const b = bars[j];
      const p = perBars[j];
      if (b.high > peakHigh) peakHigh = b.high;

      // Stop-loss / trailing stop (use intrabar low)
      if (b.low <= stop) {
        exitIdx = j; exitPrice = stop; reason = trailing ? "trail_stop" : "stop_loss"; break;
      }
      // Take-profit
      if (tp !== null && b.high >= tp) {
        exitIdx = j; exitPrice = tp; reason = "take_profit"; break;
      }
      // RSI cut
      if (p.rsi !== null && p.rsi < RSI_CUT) {
        exitIdx = j; exitPrice = b.close; reason = "rsi_cut"; break;
      }
      // Activate trailing once RSI ≥ 70, then raise the stop
      if (p.rsi !== null && p.rsi >= RSI_TRAIL_ACTIVATE) {
        trailing = true;
      }
      if (trailing) {
        const newStop = peakHigh * (1 - trailPct / 100);
        if (newStop > stop) stop = newStop;
      }
    }
    if (exitIdx === -1) {
      const j = Math.min(bars.length - 1, entryIdx + maxHoldBars - 1);
      exitIdx = j;
      exitPrice = bars[j].close;
      reason = "max_hold";
    }

    const pnlPct = (exitPrice / entry - 1) * 100;
    const qty = ORDER_SIZE_USD / entry;
    const fees = (entry * qty + exitPrice * qty) * (FEE_PCT_PER_SIDE / 100);
    const pnlUsd = (exitPrice - entry) * qty - fees;

    trades.push({
      entryTs: bars[entryIdx].ts,
      exitTs: bars[exitIdx].ts,
      entryPrice: entry,
      exitPrice,
      pnlPct,
      pnlUsd,
      exitReason: reason,
    });
    // Move past exit + 1-bar cooldown
    i = exitIdx + 2;
  }
  return { trades, matches };
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function buildStats(trades: CgBacktestTrade[]): CgBacktestResult["stats"] {
  const wins = trades.filter(t => t.pnlUsd > 0);
  const losses = trades.filter(t => t.pnlUsd <= 0);
  const grossPnl = trades.reduce((s, t) => s + (t.exitPrice - t.entryPrice) * (ORDER_SIZE_USD / t.entryPrice), 0);
  const netPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlUsd, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlUsd, 0) / losses.length : 0;
  // Max drawdown from running net-PnL equity curve
  let peak = 0, eq = 0, maxDd = 0;
  for (const t of trades) {
    eq += t.pnlUsd;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDd) maxDd = dd;
  }
  const exitReasons: Record<string, number> = {};
  for (const t of trades) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  // Best hour by total PnL
  const hourPnl = new Map<number, number>();
  for (const t of trades) {
    const h = new Date(t.entryTs * 1000).getUTCHours();
    hourPnl.set(h, (hourPnl.get(h) ?? 0) + t.pnlUsd);
  }
  let bestHourUtc: number | null = null;
  let bestVal = -Infinity;
  for (const [h, v] of hourPnl) {
    if (v > bestVal) { bestVal = v; bestHourUtc = h; }
  }
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netPnl,
    grossPnl,
    avgWin,
    avgLoss,
    rr: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null,
    maxDrawdown: maxDd,
    exitReasons,
    bestHourUtc,
  };
}

// ─── Window parsing ─────────────────────────────────────────────────────────

interface ResolvedWindow {
  mode: "relative" | "absolute";
  days: number;
  fromSec: number;
  toSec: number;
  label: string;
  warnings: string[];
}

function resolveWindow(input: CgBacktestInput): ResolvedWindow {
  const warnings: string[] = [];
  const nowMs = Date.now();
  if (input.fromMs !== undefined) {
    let from = input.fromMs;
    let to = input.toMs ?? nowMs;
    if (to <= from) throw new Error(`Invalid window: to (${new Date(to).toISOString()}) must be after from (${new Date(from).toISOString()})`);
    if (to > nowMs) { to = nowMs; warnings.push(`to= clamped to now`); }
    if (to - from > MAX_SPAN_MS) {
      from = to - MAX_SPAN_MS;
      warnings.push(`Span clamped to 30 days (from=${new Date(from).toISOString().slice(0,10)})`);
    }
    return {
      mode: "absolute",
      days: Math.ceil((to - from) / (24 * 60 * 60 * 1000)),
      fromSec: Math.floor(from / 1000),
      toSec: Math.floor(to / 1000),
      label: `${new Date(from).toISOString().slice(0,10)} → ${new Date(to).toISOString().slice(0,10)}`,
      warnings,
    };
  }
  const days = Math.max(1, Math.min(30, input.days ?? 14));
  if (input.days !== undefined && (input.days < 1 || input.days > 30)) {
    warnings.push(`days clamped to ${days}`);
  }
  return {
    mode: "relative",
    days,
    fromSec: Math.floor((nowMs - days * 24 * 60 * 60 * 1000) / 1000),
    toSec: Math.floor(nowMs / 1000),
    label: `last ${days}d`,
    warnings,
  };
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function runCgBacktest(input: CgBacktestInput): Promise<CgBacktestResult> {
  // 1. Parse expression first — fail fast on syntax errors
  let ast: Node;
  try {
    ast = parseExpression(input.expression);
  } catch (err) {
    if (err instanceof ParseError) throw new Error(`Filter expression: ${err.message}`);
    throw err;
  }

  // 2. Resolve window + symbol
  const win = resolveWindow(input);
  const cgId = await resolveCgId(input.symbol);
  if (!cgId) throw new Error(`Could not resolve symbol "${input.symbol}" on CoinGecko`);

  // 3. Fetch metadata + history in parallel
  const [detail, ohlc, vol] = await Promise.all([
    fetchCoinDetail(cgId),
    fetchOhlc(cgId, win.mode, win.days, win.fromSec, win.toSec),
    fetchHourlyVolume(cgId, win.mode, win.days, win.fromSec, win.toSec),
  ]);
  if (!ohlc || ohlc.length === 0) {
    throw new Error(`No OHLC data returned for ${cgId} (window=${win.label})`);
  }

  const rank = detail?.market_cap_rank ?? null;
  const marketCap = detail?.market_data?.market_cap?.usd ?? null;

  // 4. Build per-bar series
  const vol24hArr = buildVolume24h(ohlc, vol);
  const closes = ohlc.map(b => b[4]);
  const rsi = computeRSI(closes, 14);
  const ema = computeEMA(closes, 200);

  const bars: Bar[] = ohlc.map((b, i) => ({
    ts: Math.floor(b[0] / 1000),
    open: b[1], high: b[2], low: b[3], close: b[4],
    vol24h: vol24hArr[i],
  }));
  const perBars: PerBar[] = ohlc.map((b, i) => {
    const prev = i > 0 ? ohlc[i - 1][4] : null;
    const prev24 = i >= 24 ? ohlc[i - 24][4] : null;
    const emaVal = ema[i];
    return {
      rsi: rsi[i],
      ema200: emaVal,
      aboveTrend: emaVal !== null && b[4] > emaVal,
      gainBar: prev !== null ? (b[4] / prev - 1) * 100 : null,
      gain24h: prev24 !== null ? (b[4] / prev24 - 1) * 100 : null,
      vol24h: vol24hArr[i],
    };
  });

  // 5. Bar interval label (CoinGecko OHLC granularity per docs)
  const intervalLabel = win.mode === "relative"
    ? (win.days === 1 ? "30m" : "1h")
    : "1h";

  // 6. Simulate
  const slPct = input.slPct ?? DEFAULT_SL_PCT;
  const trailPct = input.trailPct ?? DEFAULT_TRAIL_PCT;
  const maxHoldBars = input.maxHoldBars ?? DEFAULT_MAX_HOLD_BARS;
  const tpPct = input.tpPct ?? null;
  const { trades, matches } = simulate(bars, perBars, ast, rank, marketCap, slPct, tpPct, trailPct, maxHoldBars);

  return {
    symbol: stripQuote(input.symbol),
    cgId,
    windowLabel: win.label,
    barCount: bars.length,
    barIntervalLabel: intervalLabel,
    marketCapRank: rank,
    marketCapUsd: marketCap,
    filterMatches: matches,
    trades,
    stats: buildStats(trades),
    warnings: win.warnings,
  };
}
