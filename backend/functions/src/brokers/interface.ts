import { PlaceOrderParams, PlaceOrderResult } from "../types";

/**
 * Abstract broker interface.
 * All broker implementations must conform to this contract.
 */
export interface IBroker {
  readonly name: string;
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult>;
}
