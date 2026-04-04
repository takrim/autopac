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
  createdAt: any;
}

export async function fetchSignals(status?: string): Promise<Signal[]> {
  const query = status ? `?status=${status}` : "";
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

// --- FCM Token ---

export async function registerFcmToken(token: string): Promise<void> {
  await apiRequest("/fcm-token", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}
