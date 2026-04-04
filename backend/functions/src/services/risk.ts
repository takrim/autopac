import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { CONFIG } from "../config";
import { Signal } from "../types";
import { logAudit } from "./audit";

const db = getFirestore();

export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
}

/**
 * Run all risk checks before executing a trade.
 * Returns { passed: true } if all checks pass, otherwise { passed: false, reason }.
 */
export async function runRiskChecks(signal: Signal): Promise<RiskCheckResult> {
  // 1. Check daily trade limit
  const dailyCheck = await checkDailyTradeLimit();
  if (!dailyCheck.passed) return dailyCheck;

  // 2. Check max position value
  const valueCheck = checkPositionValue(signal);
  if (!valueCheck.passed) return valueCheck;

  // 3. Check market hours (basic US market check)
  const hoursCheck = checkMarketHours(signal);
  if (!hoursCheck.passed) return hoursCheck;

  await logAudit("RISK_CHECK_PASSED", { signalId: signal.id });
  return { passed: true };
}

async function checkDailyTradeLimit(): Promise<RiskCheckResult> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const ordersToday = await db
    .collection("orders")
    .where("createdAt", ">=", Timestamp.fromDate(todayStart))
    .count()
    .get();

  const count = ordersToday.data().count;

  if (count >= CONFIG.MAX_DAILY_TRADES) {
    logger.warn(`[RISK] Daily trade limit reached: ${count}/${CONFIG.MAX_DAILY_TRADES}`);
    return {
      passed: false,
      reason: `Daily trade limit reached (${CONFIG.MAX_DAILY_TRADES})`,
    };
  }

  return { passed: true };
}

function checkPositionValue(signal: Signal): RiskCheckResult {
  const value = CONFIG.TRADE_VALUE_USD;

  if (value > CONFIG.MAX_POSITION_VALUE) {
    return {
      passed: false,
      reason: `Position value $${value} exceeds max $${CONFIG.MAX_POSITION_VALUE}`,
    };
  }

  return { passed: true };
}

function isCryptoSymbol(symbol: string): boolean {
  return symbol.endsWith("USD") || symbol.endsWith("USDT") || symbol.includes("/");
}

function checkMarketHours(signal: Signal): RiskCheckResult {
  if (isCryptoSymbol(signal.symbol)) {
    return { passed: true };
  }

  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const etOffset = -4; // EDT; use -5 for EST
  const etHour = (utcHour + etOffset + 24) % 24;

  const isPreMarket = etHour < 9 || (etHour === 9 && utcMin < 30);
  const isPostMarket = etHour >= 16;
  const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;

  if (isWeekend) {
    logger.warn("[RISK] Market closed: weekend");
    return { passed: false, reason: "Market closed: weekend" };
  }

  if (isPreMarket || isPostMarket) {
    logger.warn("[RISK] Outside regular market hours — proceeding with caution");
  }

  return { passed: true };
}
