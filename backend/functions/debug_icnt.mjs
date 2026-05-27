// Diagnostic: why wasn't ICNT-USD rebought?
// Usage: GOOGLE_APPLICATION_CREDENTIALS=... node debug_icnt.mjs
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

initializeApp({ projectId: "autopac-40a4e" });
const db = getFirestore();

const SYMBOL = (process.argv[2] || "ICNT-USD").toUpperCase();

async function main() {
  console.log(`\n=== Diagnosing rebuy state for ${SYMBOL} ===\n`);

  // 1. Rebuy watchlist
  const watchSnap = await db.doc("_liquidator_state/rebuy_watch").get();
  if (!watchSnap.exists) {
    console.log("[watch] No rebuy_watch doc exists yet.");
  } else {
    const data = watchSnap.data() || {};
    const symbols = data.symbols || {};
    const entry = symbols[SYMBOL];
    console.log(`[watch] rebuy_watch updatedAt: ${data.updatedAt?.toDate?.()?.toISOString() ?? "n/a"}`);
    console.log(`[watch] tracked symbols (${Object.keys(symbols).length}):`, Object.keys(symbols));
    if (entry) {
      const ageMin = (Date.now() - entry.exitedAt) / 60_000;
      console.log(`[watch] ${SYMBOL} ENTRY:`, JSON.stringify(entry, null, 2));
      console.log(`[watch]   age: ${ageMin.toFixed(1)} min (TTL = 60 min)`);
    } else {
      console.log(`[watch] ${SYMBOL} is NOT in the rebuy watchlist.`);
    }
  }

  // 2. Forbidden cache
  const fSnap = await db.doc("_burst_cache/forbidden").get();
  const forbidden = fSnap.exists ? (fSnap.data()?.symbols ?? {}) : {};
  console.log(`\n[forbidden] in cache?`, !!forbidden[SYMBOL], `(total ${Object.keys(forbidden).length})`);

  // 3. Trading config allowlist
  const cSnap = await db.doc("config/trading").get();
  const allowed = cSnap.exists ? (cSnap.data()?.brokerSettings?.coinbase?.allowedSymbols ?? []) : [];
  const inAllow = allowed.map(s => String(s).toUpperCase()).includes(SYMBOL);
  console.log(`[allowlist] in coinbase allowedSymbols?`, inAllow, `(total ${allowed.length})`);

  // 4. Recent decision logs for this symbol
  console.log(`\n[decisions] last 15 decisions for ${SYMBOL}:`);
  const dSnap = await db.collection("decisions")
    .where("symbol", "==", SYMBOL)
    .orderBy("timestamp", "desc")
    .limit(15)
    .get();
  if (dSnap.empty) {
    console.log("  (none — check that the collection is 'decisions' vs 'decision_logs')");
    // Fallback to alternate naming
    const alt = await db.collection("decision_logs")
      .where("symbol", "==", SYMBOL)
      .orderBy("timestamp", "desc")
      .limit(15)
      .get();
    if (!alt.empty) {
      console.log(`  (found ${alt.size} in 'decision_logs')`);
      alt.forEach(d => {
        const v = d.data();
        const ts = v.timestamp?.toDate?.()?.toISOString() ?? "n/a";
        console.log(`  • ${ts} ${v.source}/${v.outcome}/${v.action} — ${v.reason}`);
      });
    }
  } else {
    dSnap.forEach(d => {
      const v = d.data();
      const ts = v.timestamp?.toDate?.()?.toISOString() ?? "n/a";
      console.log(`  • ${ts} ${v.source}/${v.outcome}/${v.action} — ${v.reason}`);
    });
  }

  // 5. Recent signals for this symbol
  console.log(`\n[signals] last 10 signals for ${SYMBOL}:`);
  const sSnap = await db.collection("signals")
    .where("symbol", "==", SYMBOL)
    .orderBy("createdAt", "desc")
    .limit(10)
    .get();
  sSnap.forEach(d => {
    const v = d.data();
    const ts = v.createdAt?.toDate?.()?.toISOString() ?? "n/a";
    console.log(`  • ${ts} ${v.strategy} ${v.action} status=${v.status} ${v.statusMessage ? "msg=" + v.statusMessage : ""}`);
  });

  console.log("\n=== Done ===\n");
}

main().catch(e => { console.error(e); process.exit(1); });
