import { Request, Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

const db = getFirestore();
const CONFIG_DOC = db.collection("config").doc("trading");

export interface TradingConfig {
  AUTO_APPROVE: boolean;
  PAPER_TRADING: boolean;
  ACTIVE_BROKER: "mock" | "alpaca";
  TRADE_VALUE_USD: number;
  STOP_LOSS_PCT: number;
  TAKE_PROFIT_PCT: number;
  SIMULATED_FEE_RATE: number;
  ALLOWED_DIRECTIONS: "BOTH" | "LONG" | "SHORT";
  ORDER_PYRAMID: boolean;
  MAX_DAILY_TRADES: number;
  ORDER_MODE: "STRATEGY" | "RSI" | "BOTH";
}

const DEFAULTS: TradingConfig = {
  AUTO_APPROVE: false,
  PAPER_TRADING: true,
  ACTIVE_BROKER: "alpaca",
  TRADE_VALUE_USD: 1000,
  STOP_LOSS_PCT: 0.5,
  TAKE_PROFIT_PCT: 2.0,
  SIMULATED_FEE_RATE: 0.006,
  ALLOWED_DIRECTIONS: "LONG",
  ORDER_PYRAMID: false,
  MAX_DAILY_TRADES: 50,
  ORDER_MODE: "BOTH",
};

/**
 * Read the trading config from Firestore, merging with defaults.
 */
export async function getTradingConfig(): Promise<TradingConfig> {
  const snap = await CONFIG_DOC.get();
  if (!snap.exists) return { ...DEFAULTS };
  return { ...DEFAULTS, ...(snap.data() as Partial<TradingConfig>) };
}

/**
 * GET /config — return current trading configuration.
 */
export async function handleGetConfig(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const config = await getTradingConfig();
    res.json({ config });
  } catch (err) {
    logger.error("[CONFIG] Failed to fetch config", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

const ALLOWED_KEYS: (keyof TradingConfig)[] = [
  "AUTO_APPROVE",
  "PAPER_TRADING",
  "ACTIVE_BROKER",
  "TRADE_VALUE_USD",
  "STOP_LOSS_PCT",
  "TAKE_PROFIT_PCT",
  "SIMULATED_FEE_RATE",
  "ALLOWED_DIRECTIONS",
  "ORDER_PYRAMID",
  "MAX_DAILY_TRADES",
  "ORDER_MODE",
];

/**
 * PATCH /config — update one or more trading config fields.
 */
export async function handleUpdateConfig(req: Request, res: Response): Promise<void> {
  const user = (req as any).user;
  if (!user?.uid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body as Partial<TradingConfig>;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  // Only allow whitelisted keys
  const update: Partial<TradingConfig> = {};
  for (const key of ALLOWED_KEYS) {
    if (key in body) {
      (update as any)[key] = (body as any)[key];
    }
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "No valid config fields provided" });
    return;
  }

  // Basic validation
  if (update.TRADE_VALUE_USD !== undefined && (update.TRADE_VALUE_USD < 1 || update.TRADE_VALUE_USD > 100000)) {
    res.status(400).json({ error: "TRADE_VALUE_USD must be between 1 and 100000" });
    return;
  }
  if (update.STOP_LOSS_PCT !== undefined && (update.STOP_LOSS_PCT < 0.1 || update.STOP_LOSS_PCT > 50)) {
    res.status(400).json({ error: "STOP_LOSS_PCT must be between 0.1 and 50" });
    return;
  }
  if (update.TAKE_PROFIT_PCT !== undefined && (update.TAKE_PROFIT_PCT < 0.1 || update.TAKE_PROFIT_PCT > 100)) {
    res.status(400).json({ error: "TAKE_PROFIT_PCT must be between 0.1 and 100" });
    return;
  }
  if (update.SIMULATED_FEE_RATE !== undefined && (update.SIMULATED_FEE_RATE < 0 || update.SIMULATED_FEE_RATE > 0.1)) {
    res.status(400).json({ error: "SIMULATED_FEE_RATE must be between 0 and 0.1 (10%)" });
    return;
  }
  if (update.MAX_DAILY_TRADES !== undefined && (update.MAX_DAILY_TRADES < 1 || update.MAX_DAILY_TRADES > 500)) {
    res.status(400).json({ error: "MAX_DAILY_TRADES must be between 1 and 500" });
    return;
  }

  try {
    await CONFIG_DOC.set(update, { merge: true });
    const config = await getTradingConfig();
    logger.info("[CONFIG] Trading config updated", { uid: user.uid, update });
    res.json({ config });
  } catch (err) {
    logger.error("[CONFIG] Failed to update config", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
