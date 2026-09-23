// Client-safe Chat Orders types - no server-only / supabase imports, so the Chat
// Orders tab (a client component) can use them. The data access lives in
// src/lib/chat-orders/orders.ts (server-only).
//
// Ported from Laurel, with variants threaded through: in Miraj a product with
// more than one variant is costed BY VARIANT ONLY, so an order line has to name
// the variant, not just the product.

// Identifies one pickable option. A product with a single variant (or a bundle)
// has variantId null and is identified by its product id alone; a multi-variant
// product yields one option per variant.
export type ChatOrderRef = { productId: number; variantId: number | null };

// The <select> value, and the key the parser/aliases match on. Composite because
// several options can share a productId.
export function optionKey(ref: ChatOrderRef): string {
  return `${ref.productId}:${ref.variantId ?? ""}`;
}

export function parseOptionKey(key: string): ChatOrderRef | null {
  const [p, v] = key.split(":");
  const productId = Number(p);
  if (!Number.isFinite(productId)) return null;
  return { productId, variantId: v === "" || v === undefined ? null : Number(v) };
}

// A finished good the owner can put on a chat order, with the built cost used for
// the form's live "Est. COGS" hint. The figure actually saved is priced on the
// server from the product's current built cost - see createChatOrder.
export type ChatOrderProduct = {
  productId: number;
  variantId: number | null;
  key: string; // optionKey(...), the select's value
  label: string; // "Product" or "Product — Variant"
  sku: string | null;
  unitCost: number; // current cost per unit (0 when nothing is costed yet)
  isActive: boolean;
};

export type ChatOrderItem = {
  productId: number;
  variantId: number | null;
  key: string;
  productName: string;
  quantity: number;
  costOfGoods: number; // snapshotted at write time
};

export type ChatOrder = {
  id: number;
  saleDate: string; // YYYY-MM-DD
  orderCount: number; // how many real orders this one record stands for (>=1); >1 when several chats were bundled
  revenue: number; // one owner-typed figure for the whole record (all its orders)
  cogs: number; // sum of the items' snapshotted cost
  items: ChatOrderItem[];
};

export type ChatOrderInput = {
  saleDate: string;
  orderCount: number;
  revenue: number;
  items: { productId: number; variantId: number | null; quantity: number }[];
};
