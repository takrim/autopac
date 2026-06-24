import { Request, Response } from "express";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();

/**
 * GET /stock-monitor/last-run — the most recent stock-monitor run snapshot:
 * the scored tickers (sorted best-first) each with friendly + full analysis.
 */
export async function handleGetStockLastRun(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) { res.status(401).json({ error: "Unauthorized" }); return; }

  try {
    const snap = await db.collection("stock_monitor_runs").orderBy("runAt", "desc").limit(1).get();
    if (snap.empty) { res.json({ run: null }); return; }
    const doc = snap.docs[0];
    res.json({ run: { id: doc.id, ...doc.data() } });
  } catch (err) {
    logger.error("[API] Stock last run error", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
}

/**
 * GET /stock-alerts — recent stock-monitor buy alerts (newest first), each with
 * the full score breakdown (`checks`). Optional `?limit=`.
 */
export async function handleListStockAlerts(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) { res.status(401).json({ error: "Unauthorized" }); return; }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  try {
    const snapshot = await db.collection("stock_alerts").orderBy("createdAt", "desc").limit(limit).get();
    res.json({ alerts: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    logger.error("[API] List stock alerts error", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
}
