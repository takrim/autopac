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
  stopLoss: number;
  takeProfit: number;
  signalTime: string;
  status: SignalStatus;
  statusMessage?: string;
  idempotencyKey: string;
  rsiTrend?: string;
  rsiConfidence?: string;
  rsiPrice?: number;
  rsiUpdatedAt?: Timestamp | FieldValue;
  vwapTrend?: string;
  vwapPrice?: number;
  vwapUpdatedAt?: Timestamp | FieldValue;
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
  | "RISK_CHECK_FAILED";

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
