// One-shot PnL aggregator across Coinbase + Alpaca.
// Paginates full FILLED order history, FIFO-matches sells against buys per
// symbol, then buckets realized PnL by PST day windows: 1d / 1mo / 1y.
// Day boundary = 00:00 America/Los_Angeles.
//
// Run from backend/functions:
//   export COINBASE_API_KEY="$(firebase functions:secrets:access COINBASE_API_KEY 2>/dev/null)"
//   export COINBASE_API_SECRET="$(firebase functions:secrets:access COINBASE_API_SECRET 2>/dev/null)"
//   export ALPACA_API_KEY="$(firebase functions:secrets:access ALPACA_API_KEY 2>/dev/null)"
//   export ALPACA_API_SECRET="$(firebase functions:secrets:access ALPACA_API_SECRET 2>/dev/null)"
//   export ALPACA_BASE_URL="https://api.alpaca.markets"   # or paper
//   node scripts/pnl-windows.mjs

import crypto from "crypto";
import { SignJWT, importPKCS8 } from "jose";

// ---------- time windows (PST/PDT aware) ----------
const NOW = Date.now();

// Get the UTC timestamp of "today 00:00 in America/Los_Angeles"
function startOfPstDayUtc(date = new Date()) {
  // Format the moment in LA, parse Y-M-D, then build the equivalent UTC instant
  // for that LA midnight via Intl.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
  // Compute LA offset for that local midnight by going through Date math.
  // Easier path: build a guess "YYYY-MM-DDT00:00:00" interpreted as UTC, then
  // subtract LA's offset at that instant.
  const laMidnightAsIfUtc = Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  // Determine LA offset (minutes) at that instant by reformatting.
  const tzName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", timeZoneName: "shortOffset",
  }).formatToParts(new Date(laMidnightAsIfUtc)).find(p => p.type === "timeZoneName")?.value || "GMT-8";
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(tzName);
  const sign = m && m[1] === "-" ? -1 : 1;
  const hours = m ? Number(m[2]) : 8;
  const mins = m && m[3] ? Number(m[3]) : 0;
  const offsetMs = sign * (hours * 60 + mins) * 60_000;
  // LA midnight in true UTC = midnight-as-if-UTC - offset
  return laMidnightAsIfUtc - offsetMs;
}

const TODAY_PST_START = startOfPstDayUtc(new Date(NOW));
const ONE_WEEK_AGO = TODAY_PST_START - 7 * 86400_000;
const ONE_MONTH_AGO = TODAY_PST_START - 30 * 86400_000;

console.log("Window boundaries (UTC ISO):");
console.log("  today 00:00 PST :", new Date(TODAY_PST_START).toISOString());
console.log("  7 days ago      :", new Date(ONE_WEEK_AGO).toISOString());
console.log("  30 days ago     :", new Date(ONE_MONTH_AGO).toISOString());
console.log("  now             :", new Date(NOW).toISOString());
console.log();

// ---------- Coinbase ----------
const cbKey = process.env.COINBASE_API_KEY;
let cbSecret = (process.env.COINBASE_API_SECRET || "").replace(/\\n/g, "\n");

async function cbJwt(method, path) {
  const uri = `${method} api.coinbase.com${path.split("?")[0]}`;
  const now = Math.floor(Date.now() / 1000);
  let pem = cbSecret;
  if (pem.includes("BEGIN EC PRIVATE KEY")) {
    pem = crypto.createPrivateKey({ key: pem, format: "pem" })
      .export({ type: "pkcs8", format: "pem" });
  }
  const key = await importPKCS8(pem, "ES256");
  return new SignJWT({ sub: cbKey, iss: "cdp", nbf: now, exp: now + 120, uri })
    .setProtectedHeader({
      alg: "ES256", kid: cbKey,
      nonce: crypto.randomBytes(16).toString("hex"), typ: "JWT",
    }).sign(key);
}

async function cbReq(path) {
  const full = "/api/v3/brokerage" + path;
  const t = await cbJwt("GET", full);
  const r = await fetch("https://api.coinbase.com" + full, {
    headers: { Authorization: "Bearer " + t },
  });
  if (!r.ok) throw new Error(`Coinbase ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchAllCoinbaseFills(sinceMs) {
  const all = [];
  let cursor = "";
  let pages = 0;
  const startIso = new Date(sinceMs).toISOString();
  while (true) {
    pages++;
    const qs = new URLSearchParams({
      order_status: "FILLED",
      limit: "250",
      start_date: startIso,
    });
    if (cursor) qs.set("cursor", cursor);
    const data = await cbReq(`/orders/historical/batch?${qs.toString()}`);
    const orders = data.orders || [];
    all.push(...orders);
    if (!data.has_next || !data.cursor) break;
    cursor = data.cursor;
    if (pages > 200) { console.warn("cb pagination capped at 200 pages"); break; }
  }
  console.log(`[coinbase] fetched ${all.length} FILLED orders across ${pages} pages`);
  return all;
}

// ---------- Alpaca ----------
const alpacaKey = process.env.ALPACA_API_KEY;
const alpacaSecret = process.env.ALPACA_API_SECRET;
const alpacaBase = process.env.ALPACA_BASE_URL || "https://api.alpaca.markets";

async function alpacaReq(path) {
  const r = await fetch(alpacaBase + path, {
    headers: {
      "APCA-API-KEY-ID": alpacaKey,
      "APCA-API-SECRET-KEY": alpacaSecret,
    },
  });
  if (!r.ok) throw new Error(`Alpaca ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchAllAlpacaFills(sinceMs) {
  if (!alpacaKey || !alpacaSecret) {
    console.warn("[alpaca] credentials missing; skipping");
    return [];
  }
  const all = [];
  let pages = 0;
  let until = new Date().toISOString();
  const sinceIso = new Date(sinceMs).toISOString();
  while (true) {
    pages++;
    const qs = new URLSearchParams({
      status: "closed",
      limit: "500",
      direction: "desc",
      after: sinceIso,
      until,
      nested: "false",
    });
    const orders = await alpacaReq(`/v2/orders?${qs.toString()}`);
    if (!orders.length) break;
    const filled = orders.filter(o => o.status === "filled" && o.filled_qty && Number(o.filled_qty) > 0);
    all.push(...filled);
    if (orders.length < 500) break;
    // Page back via "until"
    const oldest = orders[orders.length - 1];
    const ts = oldest.submitted_at || oldest.created_at;
    if (!ts) break;
    until = new Date(Date.parse(ts) - 1).toISOString();
    if (pages > 200) { console.warn("alpaca pagination capped"); break; }
  }
  console.log(`[alpaca] fetched ${all.length} filled orders across ${pages} pages`);
  return all;
}

// ---------- Normalize to a unified fill shape ----------
// { broker, symbol, side: 'BUY'|'SELL', qty, price, ts }
function normalizeCoinbase(orders) {
  const fills = [];
  for (const o of orders) {
    const qty = Number(o.filled_size || 0);
    const price = Number(o.average_filled_price || 0);
    const fee = Number(o.total_fees || 0);
    const tsIso = o.last_fill_time || o.created_time;
    if (!qty || !price || !tsIso) continue;
    fills.push({
      broker: "coinbase",
      symbol: o.product_id,
      side: String(o.side).toUpperCase(),
      qty,
      price,
      fee,
      ts: Date.parse(tsIso),
    });
  }
  return fills;
}

function normalizeAlpaca(orders) {
  const fills = [];
  for (const o of orders) {
    const qty = Number(o.filled_qty || 0);
    const price = Number(o.filled_avg_price || 0);
    const tsIso = o.filled_at || o.updated_at;
    if (!qty || !price || !tsIso) continue;
    fills.push({
      broker: "alpaca",
      symbol: o.symbol,
      side: String(o.side).toUpperCase(),
      qty,
      price,
      fee: 0, // Alpaca equities are commission-free
      ts: Date.parse(tsIso),
    });
  }
  return fills;
}

// ---------- FIFO realized-PnL engine ----------
// Per (broker,symbol) we keep a queue of open BUY lots: { qty, price }.
// On SELL we consume lots oldest-first; realized PnL = (sellPx - lotPx) * qty.
// Each SELL emits a {ts, pnl} event used for bucketing.

function computePnlEvents(fills) {
  fills.sort((a, b) => a.ts - b.ts);
  const lots = new Map(); // key = `${broker}|${symbol}` -> [{qty, price, feePerUnit}]
  const events = []; // {ts, pnl, broker, symbol}
  for (const f of fills) {
    const key = `${f.broker}|${f.symbol}`;
    let queue = lots.get(key);
    if (!queue) { queue = []; lots.set(key, queue); }
    if (f.side === "BUY") {
      // Apportion the buy fee per unit so partial sells consume it proportionally.
      const feePerUnit = f.qty > 0 ? f.fee / f.qty : 0;
      queue.push({ qty: f.qty, price: f.price, feePerUnit });
    } else if (f.side === "SELL") {
      let remaining = f.qty;
      let pnl = 0;
      while (remaining > 1e-12 && queue.length) {
        const lot = queue[0];
        const take = Math.min(lot.qty, remaining);
        // Realized = (sellPx - buyPx) * qty - buyFeeAllocated
        pnl += (f.price - lot.price) * take - lot.feePerUnit * take;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-12) queue.shift();
      }
      // Subtract the sell-side fee (apportioned only to the matched qty so an
      // unmatched tail from missing pre-window buys doesn't get charged twice).
      const matched = f.qty - remaining;
      const sellFeeAllocated = f.qty > 0 ? f.fee * (matched / f.qty) : 0;
      pnl -= sellFeeAllocated;
      events.push({ ts: f.ts, pnl, broker: f.broker, symbol: f.symbol, qty: matched });
    }
  }
  return events;
}

function bucket(events) {
  const sums = {
    day:   { all: 0, coinbase: 0, alpaca: 0, sells: 0 },
    week:  { all: 0, coinbase: 0, alpaca: 0, sells: 0 },
    month: { all: 0, coinbase: 0, alpaca: 0, sells: 0 },
  };
  for (const e of events) {
    const add = (b) => { sums[b].all += e.pnl; sums[b][e.broker] += e.pnl; sums[b].sells += 1; };
    if (e.ts >= ONE_MONTH_AGO) add("month");
    if (e.ts >= ONE_WEEK_AGO) add("week");
    if (e.ts >= TODAY_PST_START) add("day");
  }
  return sums;
}

// ---------- main ----------
const [cbOrders, alpacaOrders] = await Promise.all([
  fetchAllCoinbaseFills(ONE_MONTH_AGO),
  fetchAllAlpacaFills(ONE_MONTH_AGO),
]);

const cbFills = normalizeCoinbase(cbOrders);
const alFills = normalizeAlpaca(alpacaOrders);
console.log(`[normalize] coinbase fills=${cbFills.length}  alpaca fills=${alFills.length}`);

const events = computePnlEvents([...cbFills, ...alFills]);
console.log(`[engine] sell events generated: ${events.length}`);

const sums = bucket(events);

function fmt(n) { return (n >= 0 ? "+" : "") + n.toFixed(2); }

console.log("\n=== Realized PnL (USD) ===");
console.log("Today (PST 00:00 → now):");
console.log(`  total    ${fmt(sums.day.all)}   sells=${sums.day.sells}`);
console.log(`    coinbase ${fmt(sums.day.coinbase)}`);
console.log(`    alpaca   ${fmt(sums.day.alpaca)}`);
console.log("Last 7 days:");
console.log(`  total    ${fmt(sums.week.all)}   sells=${sums.week.sells}`);
console.log(`    coinbase ${fmt(sums.week.coinbase)}`);
console.log(`    alpaca   ${fmt(sums.week.alpaca)}`);
console.log("Last 30 days:");
console.log(`  total    ${fmt(sums.month.all)}   sells=${sums.month.sells}`);
console.log(`    coinbase ${fmt(sums.month.coinbase)}`);
console.log(`    alpaca   ${fmt(sums.month.alpaca)}`);

// Top winners/losers in 30d window for sanity
const last30 = events.filter(e => e.ts >= ONE_MONTH_AGO)
  .sort((a, b) => b.pnl - a.pnl);
console.log("\nTop 5 wins (30d):");
last30.slice(0, 5).forEach(e =>
  console.log(`  +${e.pnl.toFixed(2)}  [${e.broker}] ${e.symbol}  ${new Date(e.ts).toISOString()}`));
console.log("Top 5 losses (30d):");
last30.slice(-5).reverse().forEach(e =>
  console.log(`  ${e.pnl.toFixed(2)}  [${e.broker}] ${e.symbol}  ${new Date(e.ts).toISOString()}`));
