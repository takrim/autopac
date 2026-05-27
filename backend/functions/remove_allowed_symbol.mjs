// One-shot: remove a symbol from coinbase.allowedSymbols in config/trading
// Usage: node remove_allowed_symbol.mjs TRACUSD
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const SYMBOL = (process.argv[2] || "").toUpperCase();
if (!SYMBOL) {
  console.error("Usage: node remove_allowed_symbol.mjs <SYMBOL>");
  process.exit(1);
}

initializeApp({ projectId: "autopac-40a4e" });
const db = getFirestore();

const ref = db.collection("config").doc("trading");
const snap = await ref.get();
if (!snap.exists) {
  console.error("config/trading does not exist");
  process.exit(1);
}
const data = snap.data();
const list = data?.brokerSettings?.coinbase?.allowedSymbols || [];

const normalized = s => s.toUpperCase().replace("-", "");
const filtered = list.filter(s => normalized(s) !== normalized(SYMBOL));

if (filtered.length === list.length) {
  console.log(`${SYMBOL} not found in allowedSymbols (size=${list.length}). No change.`);
  process.exit(0);
}

await ref.set(
  { brokerSettings: { coinbase: { allowedSymbols: filtered } } },
  { merge: true }
);
console.log(`Removed ${SYMBOL}. Size ${list.length} -> ${filtered.length}.`);
