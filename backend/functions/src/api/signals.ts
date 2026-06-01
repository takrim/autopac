import { Request, Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { getTradingConfig, getActiveBrokerSettings } from "./config";
import { normalizeBookSymbol, fetchOrderBook, scoreBook } from "../services/orderbook";

const db = getFirestore();

/**
 * GET /book/:symbol — fetch and score the order book for any symbol.
 * Returns spread, imbalance, score, signal, and a human-readable summary.
 */
export async function handleGetBook(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) { res.status(401).json({ error: "Unauthorized" }); return; }

  const raw = req.params.symbol;
  if (!raw) { res.status(400).json({ error: "Missing symbol" }); return; }

  const cbSymbol = normalizeBookSymbol(raw.toUpperCase());

  try {
    const book = await fetchOrderBook(cbSymbol, 50);
    if (!book || book.bids.length === 0 || book.asks.length === 0) {
      res.status(404).json({ error: `No order book data for ${cbSymbol}` });
      return;
    }

    const { bids, asks } = book;
    const scored = scoreBook(bids, asks);

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPct = (spread / mid) * 100;

    const totalBidUsd = bids.reduce((s, l) => s + l.size * l.price, 0);
    const totalAskUsd = asks.reduce((s, l) => s + l.size * l.price, 0);
    const totalBidSize = bids.reduce((s, l) => s + l.size, 0);
    const totalAskSize = asks.reduce((s, l) => s + l.size, 0);
    const totalSize = totalBidSize + totalAskSize;
    const bidPct = (totalBidSize / totalSize) * 100;

    const within1pctBidUsd = bids.filter(l => l.price >= mid * 0.99).reduce((s, l) => s + l.size * l.price, 0);
    const within1pctAskUsd = asks.filter(l => l.price <= mid * 1.01).reduce((s, l) => s + l.size * l.price, 0);

    const topBidWall = [...bids].sort((a, b) => b.size - a.size)[0];
    const topAskWall = [...asks].sort((a, b) => b.size - a.size)[0];

    const recommendation =
      scored.score >= 3 ? "Strong Buy" :
      scored.score >= 1 ? "Buy" :
      scored.score <= -3 ? "Strong Sell" :
      scored.score <= -1 ? "Sell" : "Neutral";

    res.json({
      symbol: cbSymbol,
      midPrice: mid,
      spread: spreadPct,
      score: scored.score,
      signal: scored.signal,
      recommendation,
      imbalanceRatio: scored.imbalanceRatio,
      bidPct,
      askPct: 100 - bidPct,
      totalBidUsd,
      totalAskUsd,
      depth1pctBidUsd: within1pctBidUsd,
      depth1pctAskUsd: within1pctAskUsd,
      topBidWall: topBidWall ? { price: topBidWall.price, sizeUsd: topBidWall.size * topBidWall.price } : null,
      topAskWall: topAskWall ? { price: topAskWall.price, sizeUsd: topAskWall.size * topAskWall.price } : null,
      reasons: scored.reasons,
    });
  } catch (err) {
    logger.error("[API] Get book error", { error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /signals — list signals for the authenticated user.
 * Optional query params: ?status=PENDING&limit=50
 */
export async function handleListSignals(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const status = req.query.status as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  try {
    let query = db.collection("signals")
      .orderBy("createdAt", "desc")
      .limit(limit);

    if (status) {
      const validStatuses = ["PENDING", "APPROVED", "REJECTED", "EXECUTED", "FAILED"];
      if (!validStatuses.includes(status.toUpperCase())) {
        res.status(400).json({ error: "Invalid status filter" });
        return;
      }
      query = query.where("status", "==", status.toUpperCase());
    }

    const snapshot = await query.get();
    const signals = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.json({ signals });
  } catch (err) {
    logger.error("[API] List signals error", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
}

/**
 * GET /signals/:id — get a single signal by ID.
 */
export async function handleGetSignal(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: "Missing signal ID" });
    return;
  }

  const doc = await db.collection("signals").doc(id).get();
  if (!doc.exists) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }

  res.json({ signal: { id: doc.id, ...doc.data() } });
}

/**
 * GET /orders — list orders for the authenticated user.
 */
export async function handleListOrders(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  const snapshot = await db
    .collection("orders")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  const orders = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  res.json({ orders });
}

/**
 * GET /webhook-errors — list recent webhook errors.
 * Optional query params: ?limit=50
 */
export async function handleListWebhookErrors(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  const snapshot = await db
    .collection("webhook_errors")
    .orderBy("timestamp", "desc")
    .limit(limit)
    .get();

  const errors = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  res.json({ errors });
}

/**
 * GET /broker-errors — list recent broker/order execution errors.
 * Optional query params: ?limit=50
 */
export async function handleListBrokerErrors(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  const snapshot = await db
    .collection("broker_errors")
    .orderBy("timestamp", "desc")
    .limit(limit)
    .get();

  const errors = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  res.json({ errors });
}

/**
 * POST /fcm-token — register/update FCM token for push notifications.
 */
export async function handleRegisterToken(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { token } = req.body;
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Missing or invalid FCM token" });
    return;
  }

  await db.collection("userTokens").doc(user.uid).set(
    {
      token,
      userId: user.uid,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );

  res.json({ status: "registered" });
}

/**
 * GET /decisions — list signal decision audit trail.
 * Optional query params: ?symbol=ETHUSD&decision=rejected&handler=bulltrend&limit=50
 */
export async function handleListDecisions(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const symbol = req.query.symbol as string | undefined;
  const decision = req.query.decision as string | undefined;
  const handler = req.query.handler as string | undefined;

  let query: any = db.collection("signal_decisions")
    .orderBy("createdAt", "desc")
    .limit(limit);

  if (symbol) {
    query = query.where("symbol", "==", symbol.toUpperCase());
  }
  if (decision) {
    query = query.where("decision", "==", decision.toLowerCase());
  }
  if (handler) {
    query = query.where("handler", "==", handler.toLowerCase());
  }

  const snapshot = await query.get();
  const decisions = snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));

  res.json({ decisions });
}

/**
 * GET /trend — return trend analysis from the last N news monitor runs.
 * Optional query params: ?runs=10&limit=50
 */
export async function handleGetTrend(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const runsToFetch = Math.min(parseInt(req.query.runs as string) || 10, 30);
  const symbolLimit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  try {
    const runsSnap = await db.collection("_news_monitor_runs")
      .orderBy("runAt", "desc")
      .limit(runsToFetch)
      .get();

    if (runsSnap.empty) {
      res.json({ trend: [], runsAnalysed: 0 });
      return;
    }

    const symbolHistory: Record<string, number[]> = {};
    const symbolRSI: Record<string, number[]> = {};
    const symbolChange: Record<string, number[]> = {};

    for (const doc of runsSnap.docs) {
      const run = doc.data() as {
        symbols: Array<{
          symbol: string;
          combinedScore: number | null;
          rsi: number | null;
          priceChange24h: number | null;
        }>;
      };
      for (const s of run.symbols ?? []) {
        if (s.combinedScore !== null && s.combinedScore !== undefined) {
          (symbolHistory[s.symbol] ||= []).push(s.combinedScore);
        }
        if (s.rsi !== null && s.rsi !== undefined) {
          (symbolRSI[s.symbol] ||= []).push(s.rsi);
        }
        if (s.priceChange24h !== null && s.priceChange24h !== undefined) {
          (symbolChange[s.symbol] ||= []).push(s.priceChange24h);
        }
      }
    }

    const trend = Object.entries(symbolHistory)
      .filter(([, scores]) => scores.length >= 2)
      .map(([symbol, scores]) => {
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        const trendDelta = scores[0] - scores[scores.length - 1]; // recent minus oldest
        const rsiArr = symbolRSI[symbol] ?? [];
        const chgArr = symbolChange[symbol] ?? [];
        return {
          symbol,
          avgScore: Math.round(avgScore * 10) / 10,
          trendDelta: Math.round(trendDelta * 10) / 10,
          trendDirection: trendDelta > 0.5 ? "up" : trendDelta < -0.5 ? "down" : "flat",
          avgRSI: rsiArr.length ? Math.round(rsiArr.reduce((a, b) => a + b, 0) / rsiArr.length) : null,
          avgChange24h: chgArr.length
            ? Math.round((chgArr.reduce((a, b) => a + b, 0) / chgArr.length) * 10) / 10
            : null,
          appearances: scores.length,
        };
      })
      .sort((a, b) => b.avgScore - a.avgScore)
      .slice(0, symbolLimit);

    res.json({ trend, runsAnalysed: runsSnap.size });
  } catch (err) {
    logger.error("[API] Get trend error", { error: String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}
