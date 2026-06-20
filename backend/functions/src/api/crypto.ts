import { Request, Response } from "express";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();

/**
 * GET /crypto-alerts — recent crypto-monitor buy alerts (newest first), each
 * including the full score breakdown (`checks`). Optional `?category=STRONG_BUY`.
 */
export async function handleListCryptoAlerts(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const category = (req.query.category as string | undefined)?.toUpperCase();

  try {
    let query = db.collection("crypto_alerts").orderBy("createdAt", "desc").limit(limit);
    if (category) {
      if (!["STRONG_BUY", "WATCHLIST"].includes(category)) {
        res.status(400).json({ error: "Invalid category filter" });
        return;
      }
      query = query.where("category", "==", category);
    }

    const snapshot = await query.get();
    const alerts = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ alerts });
  } catch (err) {
    logger.error("[API] List crypto alerts error", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
}

/**
 * GET /monitor/last-run — the most recent crypto-monitor run snapshot: the
 * scored coins (sorted best-first) each with friendly + full analysis text.
 */
export async function handleGetLastRun(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const snap = await db.collection("monitor_runs").orderBy("runAt", "desc").limit(1).get();
    if (snap.empty) {
      res.json({ run: null });
      return;
    }
    const doc = snap.docs[0];
    res.json({ run: { id: doc.id, ...doc.data() } });
  } catch (err) {
    logger.error("[API] Last run error", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
}
