// One-shot: set coinbase.tradeValueUsd in config/trading.
// Usage: node set_coinbase_trade_value.mjs 10
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const value = Number(process.argv[2]);
if (!Number.isFinite(value) || value <= 0) {
  console.error("Usage: node set_coinbase_trade_value.mjs <usd>");
  process.exit(1);
}

initializeApp({ projectId: "autopac-40a4e" });
const db = getFirestore();
const ref = db.collection("config").doc("trading");

const before = (await ref.get()).data()?.brokerSettings?.coinbase?.tradeValueUsd;
await ref.set({ brokerSettings: { coinbase: { tradeValueUsd: value } } }, { merge: true });
console.log(`coinbase.tradeValueUsd: ${before ?? "(unset)"} -> ${value}`);
process.exit(0);
