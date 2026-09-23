// Client-safe shipping helpers and types - no server-only / supabase imports,
// so the Shipping Orders form (a client component) can use them. The actual
// data access lives in src/lib/shipping/orders.ts (server-only).

export type ShippingCourier = "movers" | "bosta";

export const COURIERS: { value: ShippingCourier; label: string }[] = [
  { value: "movers", label: "Movers" },
  { value: "bosta", label: "Bosta" },
];

const COURIER_LABELS: Record<ShippingCourier, string> = {
  movers: "Movers",
  bosta: "Bosta",
};

export function courierLabel(value: string | null): string {
  if (!value) return "—";
  return COURIER_LABELS[value as ShippingCourier] ?? value;
}

// Shopify order numbers carry a leading "#" (e.g. "#4756"). Normalize so the
// user can paste with or without it and lookups still match.
export function normalizeOrderNumber(input: string): string {
  const t = input.trim();
  return t.startsWith("#") ? t : `#${t}`;
}

// Splits a pasted blob on any whitespace/comma/semicolon, normalizes each, and
// dedupes - so the user can paste a column straight out of a sheet.
export function parseOrderNumbers(raw: string): string[] {
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,;]+/)) {
    const t = token.trim();
    if (t) seen.add(normalizeOrderNumber(t));
  }
  return [...seen];
}

export type BulkRecordSummary = {
  courier: ShippingCourier;
  date: string;
  requested: number;
  matched: number;
  alreadyRecorded: number;
  notFound: string[];
  cancelled: string[];
  handedToBosta: string[]; // Movers only: order already has a Bosta tracking number
};

export type ShipperSummary = {
  courier: ShippingCourier;
  orders: number; // recorded orders for this courier ("Shipped")
  delivered: number;
  returned: number;
  deliveryRate: number | null; // delivered / (delivered + returned), null if none resolved yet
};

export type RecentShipment = {
  orderNumber: string;
  date: string; // the recorded shipped-on date Actual mode buckets by
  courier: ShippingCourier;
  totalPrice: number | null;
};
