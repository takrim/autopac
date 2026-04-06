/**
 * API service — communicates with Cloud Functions backend.
 * All requests include the Firebase Auth token.
 */
import { auth, API_BASE_URL } from "../config/firebase";

const API_BASE = API_BASE_URL;

async function getAuthHeaders(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = await getAuthHeaders();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

// --- Signals ---

export interface Signal {
  id: string;
  strategy: string;
  symbol: string;
  action: "BUY" | "SELL";
  timeframe: string;
  price: number;
  stopLoss: number;
  takeProfit: number;
  signalTime: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED";
  statusMessage?: string;
  rsi?: number;
  rsiTrend?: string;
  rsiConfidence?: string;
  rsiPrice?: number;
  vwapTrend?: string;
  vwapPrice?: number;
  createdAt: any;
}

export async function fetchSignals(status?: string): Promise<Signal[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const data = await apiRequest<{ signals: Signal[] }>(`/signals${query}`);
  return data.signals;
}

export async function fetchSignal(id: string): Promise<Signal> {
  const data = await apiRequest<{ signal: Signal }>(`/signals/${encodeURIComponent(id)}`);
  return data.signal;
}

// --- Trade Actions ---

export interface TradeResult {
  status: string;
  signalId: string;
  order?: { orderId: string; status: string };
}

export async function approveSignal(signalId: string): Promise<TradeResult> {
  return apiRequest<TradeResult>("/trade/approve", {
    method: "POST",
    body: JSON.stringify({ signalId, action: "APPROVE" }),
  });
}

export async function rejectSignal(signalId: string): Promise<TradeResult> {
  return apiRequest<TradeResult>("/trade/approve", {
    method: "POST",
    body: JSON.stringify({ signalId, action: "REJECT" }),
  });
}

// --- Orders ---

export interface Order {
  id: string;
  signalId: string;
  broker: string;
  orderType: string;
  side: string;
  symbol: string;
  quantity: number;
  status: string;
  responsePayload: any;
  createdAt: any;
}

export async function fetchOrders(): Promise<Order[]> {
  const data = await apiRequest<{ orders: Order[] }>("/orders");
  return data.orders;
}

// --- Account ---

export interface AlpacaAccount {
  equity: string;
  cash: string;
  buying_power: string;
  portfolio_value: string;
  last_equity: string;
  long_market_value: string;
  short_market_value: string;
  initial_margin: string;
  maintenance_margin: string;
  daytrade_count: number;
  status: string;
  currency: string;
  non_marginable_buying_power: string;
}

export async function fetchAccount(): Promise<AlpacaAccount> {
  const data = await apiRequest<{ account: AlpacaAccount }>("/account");
  return data.account;
}

// --- Positions ---

export interface Position {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  unrealized_intraday_pl: string;
  unrealized_intraday_plpc: string;
  change_today: string;
  side: string;
  asset_class: string;
  simulated_fees?: string;
  fee_rate?: number;
}

export async function fetchPositions(): Promise<Position[]> {
  const data = await apiRequest<{ positions: Position[] }>("/positions");
  return data.positions;
}

export async function liquidatePosition(symbol: string): Promise<{ status: string; cancelledOrders: number }> {
  return apiRequest(`/positions/${encodeURIComponent(symbol)}`, {
    method: "DELETE",
  });
}

// --- Portfolio History ---

export interface PortfolioHistory {
  timestamp: number[];
  equity: number[];
  profit_loss: number[];
  profit_loss_pct: number[];
  base_value: number;
  timeframe: string;
}

export async function fetchPortfolioHistory(
  period = "1W",
  timeframe = "1D"
): Promise<PortfolioHistory> {
  const data = await apiRequest<{ history: PortfolioHistory }>(
    `/portfolio-history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}`
  );
  return data.history;
}

// --- Trading Config ---

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
}

export async function fetchConfig(): Promise<TradingConfig> {
  const data = await apiRequest<{ config: TradingConfig }>("/config");
  return data.config;
}

export async function updateConfig(updates: Partial<TradingConfig>): Promise<TradingConfig> {
  const data = await apiRequest<{ config: TradingConfig }>("/config", {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  return data.config;
}

// --- FCM Token ---

export async function registerFcmToken(token: string): Promise<void> {
  await apiRequest("/fcm-token", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}
