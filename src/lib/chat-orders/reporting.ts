import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";

// Chat orders folded into the normal reporting flow: the Income Statement's
// daily rows and Analysis by Product's per-product stats.
//
// Two rules govern everything here, both settled with the owner:
//
//  1. Chat orders are fulfilled directly - no courier is ever involved - so they
//     are 100% delivered by definition. They are NEVER scaled by a delivery rate
//     and never projected, in the open month or any other.
//  2. They are deliberately kept OUT of the delivery-rate counts. The Bosta tab's
//     rate and the P&L's Delivery Rate line measure COURIER performance, and that
//     rate also drives the open-month revenue projection - so letting a run of
//     always-delivered chat orders drag it toward 100% would quietly inflate
//     forecast revenue. They are carried in their own fields instead.
//
// Revenue attribution: a chat order carries ONE agreed price for the whole order,
// not a price per line, so per-product revenue has to be apportioned. Split is
// pro-rata by each line's catalog price (quantity x current price), which shares
// any discount proportionally. Falls back to a COGS split when no line has a
// price, then to an equal split - so an order's parts always re-sum to exactly
// the agreed total, whatever the catalog knows.

export type ChatDayTotals = { orders: number; items: number; revenue: number; cogs: number };
// Keyed "<productId>:<variantId ?? '-'>" - the same key per-product.ts uses.
export type ChatProductStats = { orders: number; items: number; revenue: number; cogs: number };

type OrderRow = { id: number; sale_date: string; revenue: number; order_count: number };
type ItemRow = { order_id: number; product_id: number; variant_id: number | null; quantity: number; cost_of_goods: number };

export function chatStatsKey(productId: number, variantId: number | null): string {
  return `${productId}:${variantId ?? "-"}`;
}

type LoadedOrder = {
  date: string;
  orderCount: number; // real orders this record stands for (>=1)
  revenue: number;
  items: { productId: number; variantId: number | null; quantity: number; cogs: number; price: number | null }[];
};

// Every chat order in [from, to] with its lines, each line carrying the catalog
// price used for the revenue split. Returns [] when the tables aren't there yet,
// so a deployment that precedes the migration degrades to "no chat orders"
// rather than 500ing every report on the site.
async function loadOrders(from: string, to: string): Promise<LoadedOrder[]> {
  const { data: orderData, error: orderErr } = await supabase
    .from("chat_orders")
    .select("id, sale_date, revenue, order_count")
    .gte("sale_date", from)
    .lte("sale_date", to);
  if (orderErr) return [];
  const orders = (orderData ?? []) as OrderRow[];
  if (orders.length === 0) return [];

  const { data: itemData, error: itemErr } = await supabase
    .from("chat_order_items")
    .select("order_id, product_id, variant_id, quantity, cost_of_goods")
    .in(
      "order_id",
      orders.map((o) => o.id)
    );
  if (itemErr) return [];
  const items = (itemData ?? []) as ItemRow[];

  // Catalog prices for the pro-rata split. A variant's own price wins; a product
  // with no variants uses its product-level price.
  const [productRows, variantRows] = await Promise.all([
    fetchAllRows<{ id: number; current_price: number | null }>(supabase, "products", "id, current_price"),
    fetchAllRows<{ id: number; current_price: number | null }>(supabase, "product_variants", "id, current_price"),
  ]);
  const productPrice = new Map(productRows.map((p) => [p.id, p.current_price === null ? null : Number(p.current_price)]));
  const variantPrice = new Map(variantRows.map((v) => [v.id, v.current_price === null ? null : Number(v.current_price)]));

  const itemsByOrder = new Map<number, ItemRow[]>();
  for (const i of items) {
    const list = itemsByOrder.get(i.order_id) ?? [];
    list.push(i);
    itemsByOrder.set(i.order_id, list);
  }

  return orders.map((o) => ({
    date: String(o.sale_date).slice(0, 10),
    orderCount: o.order_count == null ? 1 : Number(o.order_count),
    revenue: Number(o.revenue),
    items: (itemsByOrder.get(o.id) ?? []).map((i) => ({
      productId: i.product_id,
      variantId: i.variant_id,
      quantity: i.quantity,
      cogs: Number(i.cost_of_goods),
      price: i.variant_id !== null ? variantPrice.get(i.variant_id) ?? null : productPrice.get(i.product_id) ?? null,
    })),
  }));
}

// Splits one order's agreed revenue across its lines. Weights are the line's
// catalog value (price x qty); if no line has a price, COGS; if neither, an equal
// share. The last line takes the rounding remainder so the parts always re-sum to
// the agreed total exactly.
function splitRevenue(order: LoadedOrder): number[] {
  const n = order.items.length;
  if (n === 0) return [];

  let weights = order.items.map((i) => (i.price ?? 0) * i.quantity);
  let total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) {
    weights = order.items.map((i) => i.cogs);
    total = weights.reduce((s, w) => s + w, 0);
  }
  if (total <= 0) {
    weights = order.items.map(() => 1);
    total = n;
  }

  const out = weights.map((w) => (order.revenue * w) / total);
  const allocated = out.slice(0, -1).reduce((s, v) => s + v, 0);
  out[n - 1] = order.revenue - allocated;
  return out;
}

// Chat orders rolled up per calendar day, for the Income Statement.
export async function getChatOrderDailyTotals(from: string, to: string): Promise<Map<string, ChatDayTotals>> {
  const orders = await loadOrders(from, to);
  const byDate = new Map<string, ChatDayTotals>();
  for (const order of orders) {
    const cur = byDate.get(order.date) ?? { orders: 0, items: 0, revenue: 0, cogs: 0 };
    // A record may stand for several bundled orders - count the real orders it
    // represents, not the single row. This drives both the "Chat Orders" memo
    // count and the per-order Shipping Difference estimate in daily-pnl.ts.
    cur.orders += order.orderCount;
    cur.items += order.items.reduce((s, i) => s + i.quantity, 0);
    cur.revenue += order.revenue;
    cur.cogs += order.items.reduce((s, i) => s + i.cogs, 0);
    byDate.set(order.date, cur);
  }
  return byDate;
}

// One product's chat orders rolled up per calendar day, for the per-product
// Rollforward. Same revenue split as getChatOrderProductStats below, just
// bucketed by day and narrowed to one product - every variant of it included,
// since the Rollforward reports at product level.
export async function getChatOrderProductDailyTotals(
  productId: number,
  from: string,
  to: string
): Promise<Map<string, ChatDayTotals>> {
  const orders = await loadOrders(from, to);
  const byDate = new Map<string, ChatDayTotals>();
  for (const order of orders) {
    const revenues = splitRevenue(order);
    order.items.forEach((item, idx) => {
      if (item.productId !== productId) return;
      const cur = byDate.get(order.date) ?? { orders: 0, items: 0, revenue: 0, cogs: 0 };
      cur.orders += 1;
      cur.items += item.quantity;
      cur.revenue += revenues[idx];
      cur.cogs += item.cogs;
      byDate.set(order.date, cur);
    });
  }
  return byDate;
}

// Chat orders rolled up per product/variant, for Analysis by Product. An order
// counts as one order against EVERY product on it (the same convention the
// per-product report uses for multi-product Shopify orders).
export async function getChatOrderProductStats(from: string, to: string): Promise<Map<string, ChatProductStats>> {
  const orders = await loadOrders(from, to);
  const byKey = new Map<string, ChatProductStats>();
  for (const order of orders) {
    const revenues = splitRevenue(order);
    order.items.forEach((item, idx) => {
      const key = chatStatsKey(item.productId, item.variantId);
      const cur = byKey.get(key) ?? { orders: 0, items: 0, revenue: 0, cogs: 0 };
      cur.orders += 1;
      cur.items += item.quantity;
      cur.revenue += revenues[idx];
      cur.cogs += item.cogs;
      byKey.set(key, cur);
    });
  }
  return byKey;
}
