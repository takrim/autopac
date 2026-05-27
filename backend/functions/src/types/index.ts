import { Timestamp, FieldValue } from "firebase-admin/firestore";

// --- Signal ---

export type SignalAction = "BUY" | "SELL";
export type SignalStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTED"
  | "FAILED";

export interface Signal {
  id?: string;
  strategy: string;
  symbol: string;
  action: SignalAction;
  timeframe: string;
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  signalTime: string;
  status: SignalStatus;
  statusMessage?: string;
  idempotencyKey: string;
  rsi?: number;
  rsiTrend?: string;
  rsiConfidence?: string;
  vwapTrend?: string;
  vwapPrice?: number;
  strongBuy?: boolean;
  bullishTrend?: boolean;
  bulltrendPrice?: number;
  bulltrendVolume?: number;
  bulltrendTime?: string;
  broker?: string;
  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}

// --- Webhook Error ---

export interface WebhookError {
  id?: string;
  error: string;
  receivedBody: Record<string, unknown>;
  ip: string;
  timestamp: Timestamp | FieldValue;
}

export interface WebhookPayload {
  strategy: string;
  symbol: string;
  action: string;
  timeframe: string;
  price: number;
  stopLoss: number;
  takeProfit: number;
  signalTime: string;
  secret: string;
}

// --- Decision ---

export type DecisionAction = "APPROVE" | "REJECT";

export interface Decision {
  id?: string;
  signalId: string;
  userId: string;
  decision: DecisionAction;
  decisionTime: Timestamp | FieldValue;
}

// --- Order ---

export type OrderStatus =
  | "PENDING"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "CANCELLED"
  | "FAILED";

export interface Order {
  id?: string;
  signalId: string;
  broker: string;
  orderType: "market" | "limit";
  side: SignalAction;
  symbol: string;
  quantity: number;
  status: OrderStatus;
  responsePayload: Record<string, unknown> | null;
  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}

// --- Broker ---

export interface PlaceOrderParams {
  symbol: string;
  side: SignalAction;
  quantity: number;
  orderType: "market" | "limit";
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  tradeValueUsd?: number;
  /**
   * When true, the broker attempts a post-only (maker) limit fill first and
   * falls back to a market (taker) order if it doesn't fill within the broker's
   * internal timeout. Currently honoured by Coinbase BUYs only.
   */
  makerFirst?: boolean;
}

export interface PlaceOrderResult {
  success: boolean;
  orderId: string;
  status: OrderStatus;
  filledPrice?: number;
  message?: string;
  raw?: Record<string, unknown>;
}

// --- Audit ---

export type AuditAction =
  | "SIGNAL_RECEIVED"
  | "SIGNAL_VALIDATED"
  | "SIGNAL_DUPLICATE"
  | "NOTIFICATION_SENT"
  | "NOTIFICATION_FAILED"
  | "DECISION_APPROVE"
  | "DECISION_REJECT"
  | "ORDER_PLACED"
  | "ORDER_FILLED"
  | "ORDER_FAILED"
  | "RISK_CHECK_PASSED"
  | "RISK_CHECK_FAILED"
  | "MANUAL_ORDER";

export interface AuditEntry {
  action: AuditAction;
  signalId?: string;
  userId?: string;
  details?: Record<string, unknown>;
  timestamp: Timestamp | FieldValue;
}

// --- API ---

export interface TradeApprovalRequest {
  signalId: string;
  action: DecisionAction;
}

// --- Backtest ---

export type BacktestGrade = "A+" | "B" | "WEAK";

export interface BacktestCandle {
  ts: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestIndicatorPoint {
  ts: number;
  close: number;
  rsi14: number | null;
  vwap20: number | null;
  rvol20: number | null;
  bbMid20: number | null;
  bbUpper20: number | null;
  bbLower20: number | null;
  ema50: number | null;
  grade: BacktestGrade;
  // ScalpX indicators
  almaClose?: number | null;
  almaOpen?: number | null;
  ema144?: number | null;
  rsi28?: number | null;
}

export interface BacktestTrade {
  symbol: string;
  grade: BacktestGrade;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  grossPnl: number;
  netPnl: number;
  fees: number;
  slippageCost: number;
  exitReason: "stop" | "target" | "time";
}

export interface BacktestRunSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  grossPnl: number;
  totalFees: number;
  totalSlippage: number;
  maxDrawdown: number;
  stopCount: number;
  targetCount: number;
  timeCount: number;
  avgHoldHours: number;
  totalVolumeUsd: number;
  totalVolumeBtc: number;
  orderSizeUsd: number;
  avgWin: number;
  avgLoss: number;
  bestHourUtc: number;
  bestGrade: BacktestGrade;
}

export interface BacktestRunDoc {
  symbol: string;
  granularity: "FIVE_MINUTE";
  lookbackDays: number;
  engineVersion: string;
  strategyId?: string;
  trigger: "scheduled" | "manual";
  runStartedAtMs: number;
  runCompletedAtMs: number;
  durationMs: number;
  candleCount: number;
  summary: BacktestRunSummary;
  sampleTrades: BacktestTrade[];
  createdAt: Timestamp | FieldValue;
}
