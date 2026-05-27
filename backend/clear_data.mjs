// One-shot script to clear all trading data from Firestore
// Usage: GOOGLE_APPLICATION_CREDENTIALS=... node clear_data.mjs
import { initializeApp, cert, getApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const COLLECTIONS_TO_DELETE = [
  "signals",
  "signal_decisions",
  "bulltrends",
  "beartrends",
  "orders",
  "audit",
  "decisions",
  "broker_errors",
  "webhook_errors",
];

// Use application default credentials (gcloud auth or GOOGLE_APPLICATION_CREDENTIALS)
initializeApp({ projectId: "autopac-40a4e" });
const db = getFirestore();

async function deleteCollection(colName) {
  let deleted = 0;
  while (true) {
    const snap = await db.collection(colName).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    deleted += snap.docs.length;
    process.stdout.write(`\r  ${colName}: deleted ${deleted} docs...`);
  }
  console.log(`\r  ✓ ${colName}: ${deleted} docs deleted`);
}

console.log("Clearing Firestore trading data...\n");
for (const col of COLLECTIONS_TO_DELETE) {
  await deleteCollection(col);
}
console.log("\nDone.");
