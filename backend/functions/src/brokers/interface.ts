import { PlaceOrderParams, PlaceOrderResult } from "../types";

export interface BrokerPosition {
  symbol: string;
  qty: number;
  currentPrice: number;
  costBasis: number;
  assetClass?: string;
}

export interface DetailedPosition {
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
  actual_fees?: string;
  fee_rate?: number;
  stop_loss?: string;
}

/**
 * Abstract broker interface.
 * All broker implementations must conform to this contract.
 */
export interface IBroker {
  readonly name: string;
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult>;
  /** Return position for symbol, or null if none. */
  getPosition(symbol: string): Promise<BrokerPosition | null>;
  /** Liquidate full position for symbol. Throws if no position found. */
  liquidatePosition(symbol: string): Promise<Record<string, unknown>>;
  /** Return all positions with P&L and fee details for the portfolio view. */
  getDetailedPositions?(): Promise<DetailedPosition[]>;
}
