// Client-safe Bosta delivery-rate types (no server-only / supabase imports).

// `received` is the denominator every rate on this tab divides by: EVERY order
// that came in that month, cancellations and orders never handed to a courier
// included - "of everything Shopify took, how much reached a customer". The
// per-product cells below count the same way, at order-line grain, so a model
// reads against the business total above it instead of flattering it.
//
// `inProgress` = placed that month but still without a final courier outcome
// (not delivered / failed_rto / exchange / pickup_return). Those orders sit in
// the denominator but can't be in the numerator yet, so a month with a high
// inProgress is not yet closed and its rate will still rise. Tracked for the
// whole business only - the per-product rows below stay a plain rate grid.
//
// `mix` breaks that denominator open, so the two kinds of order that drag a
// rate down without any courier ever failing can be seen and downloaded rather
// than taken on trust. Null only if the monthly_order_mix RPC isn't installed.
export type MonthlyRate = {
  month: string;
  received: number;
  delivered: number;
  inProgress: number;
  rate: number | null;
  mix: MonthlyOrderMix | null;
};

export type MonthlyOrderMix = {
  cancelled: number; // cancelled at any point, at any outcome
  neverHanded: number; // no tracking number, not self-delivered - no courier ever had it
  openAtCourier: number; // at Bosta, no final outcome yet - can still deliver
  // Never handed over AND still unresolved: the ones that will never resolve by
  // themselves. Someone has to say what happened in Bosta > Unresolved Orders.
  openNeverHanded: number;
};

export type RateCell = { received: number; delivered: number; rate: number | null };

export type ProductMonthlyRate = {
  productId: number;
  name: string;
  byMonth: Record<string, RateCell>;
};

// Products grouped under their model, with a per-month subtotal for the model.
export type ModelDeliveryGroup = {
  modelKey: string; // model name, or "(no model)" for unassigned products
  byMonth: Record<string, RateCell>; // model subtotal = Σ its products' received/delivered
  products: ProductMonthlyRate[];
};

// One row of the Unresolved Orders tab: an order with no final courier outcome.
export type UnresolvedOrder = {
  orderNumber: string;
  day: string;
  ageDays: number;
  atCourier: boolean; // has a Bosta tracking number or pickup stamp; false = never handed over
  // What Shopify says happened to it. A courier fulfilment reads IN_TRANSIT or
  // DELIVERED; one marked fulfilled by hand reads plain "FULFILLED"; null means
  // it was never fulfilled at all.
  shopifyStatus: string | null;
  // Fulfilled in Shopify with no courier anywhere near it - the signature of a
  // delivery someone made themselves. This is what the tab pre-selects.
  handFulfilled: boolean;
  governorate: string | null;
  totalPrice: number | null;
};

// What someone recorded actually happened to it.
export type ResolveAction = "delivered_private" | "returned" | "cancelled" | "undo";

export const RESOLVE_ACTIONS: ResolveAction[] = ["delivered_private", "returned", "cancelled", "undo"];

export type ProductRatesResult = {
  groups: ModelDeliveryGroup[];
  months: string[];
  rpcMissing: boolean;
};
