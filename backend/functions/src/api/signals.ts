import { Request, Response } from "express";
import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();

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

  let query = db.collection("signals").orderBy("createdAt", "desc").limit(limit);

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

  let query: any = db.collection("signal_decisions").orderBy("createdAt", "desc").limit(limit);

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
