import "server-only";
import { supabase } from "@/lib/supabase";
import { getProductStructure } from "@/lib/products/final-products";
import { getUnitCostByProduct, getUnitCostByVariant } from "@/lib/products/catalog";
import { optionKey, type ChatOrder, type ChatOrderInput, type ChatOrderItem, type ChatOrderProduct } from "./shared";

export * from "./shared";

// Every finished good the owner can sell over chat, with its current cost for
// the live Est. COGS hint.
//
// A variant carries its own cost when one has been set on the Product List,
// falling back to the product's - the same precedence the margin engine uses.
export async function getChatOrderProducts(): Promise<ChatOrderProduct[]> {
  const [{ singles, bundles }, costByProduct, costByVariant] = await Promise.all([
    getProductStructure(),
    getUnitCostByProduct(),
    getUnitCostByVariant(),
  ]);
  const options: ChatOrderProduct[] = [];

  for (const s of singles) {
    const unitCost = costByProduct.get(s.id) ?? 0;
    if (s.variants.length > 0) {
      for (const v of s.variants) {
        options.push({
          productId: s.id,
          variantId: v.id,
          key: optionKey({ productId: s.id, variantId: v.id }),
          label: `${s.name} — ${v.title}`,
          sku: v.sku ?? s.sku,
          unitCost: costByVariant.get(v.id) ?? unitCost,
          isActive: s.isActive,
        });
      }
    } else {
      options.push({
        productId: s.id,
        variantId: null,
        key: optionKey({ productId: s.id, variantId: null }),
        label: s.name,
        sku: s.sku,
        unitCost,
        isActive: s.isActive,
      });
    }
  }

  for (const b of bundles) {
    options.push({
      productId: b.id,
      variantId: null,
      key: optionKey({ productId: b.id, variantId: null }),
      label: b.name,
      sku: null,
      unitCost: costByProduct.get(b.id) ?? 0,
      isActive: b.isActive,
    });
  }

  return options.sort((a, b) => a.label.localeCompare(b.label));
}

type OrderRow = { id: number; sale_date: string; revenue: number; order_count: number };
type ItemRow = {
  order_id: number;
  product_id: number;
  variant_id: number | null;
  quantity: number;
  cost_of_goods: number;
  products: { name: string } | null;
  product_variants: { title: string } | null;
};

export async function listChatOrders(): Promise<ChatOrder[]> {
  const { data: orderData, error: orderErr } = await supabase
    .from("chat_orders")
    .select("id, sale_date, revenue, order_count")
    .order("sale_date", { ascending: false })
    .order("id", { ascending: false });
  if (orderErr) return []; // table not created yet -> the tab renders empty rather than 500s
  const orders = (orderData ?? []) as OrderRow[];
  if (orders.length === 0) return [];

  const { data: itemData, error: itemErr } = await supabase
    .from("chat_order_items")
    .select("order_id, product_id, variant_id, quantity, cost_of_goods, products(name), product_variants(title)")
    .in(
      "order_id",
      orders.map((o) => o.id)
    );
  if (itemErr) throw new Error(`Failed to load chat order items: ${itemErr.message}`);

  const itemsByOrder = new Map<number, ChatOrderItem[]>();
  for (const row of (itemData ?? []) as unknown as ItemRow[]) {
    const list = itemsByOrder.get(row.order_id) ?? [];
    const base = row.products?.name ?? `Product #${row.product_id}`;
    list.push({
      productId: row.product_id,
      variantId: row.variant_id,
      key: optionKey({ productId: row.product_id, variantId: row.variant_id }),
      productName: row.product_variants?.title ? `${base} — ${row.product_variants.title}` : base,
      quantity: row.quantity,
      costOfGoods: Number(row.cost_of_goods),
    });
    itemsByOrder.set(row.order_id, list);
  }

  return orders.map((o) => {
    const items = (itemsByOrder.get(o.id) ?? []).sort((a, b) => a.productName.localeCompare(b.productName));
    return {
      id: o.id,
      saleDate: String(o.sale_date).slice(0, 10),
      // Older rows written before the column existed read back as null over
      // PostgREST until the migration runs; treat that as the one-order default.
      orderCount: o.order_count == null ? 1 : Number(o.order_count),
      revenue: Number(o.revenue),
      cogs: items.reduce((sum, i) => sum + i.costOfGoods, 0),
      items,
    };
  });
}

// Coerces an untrusted JSON body into a ChatOrderInput. Shape only - the business
// rules are validate()'s job, and both run before any write.
export function parseChatOrderBody(body: unknown): ChatOrderInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(b.items) ? b.items : [];
  return {
    saleDate: String(b.saleDate ?? "").slice(0, 10),
    // Absent (an older client, or the API called without it) means one order.
    orderCount: b.orderCount === undefined || b.orderCount === null ? 1 : Number(b.orderCount),
    revenue: Number(b.revenue),
    items: rawItems.map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      return {
        productId: Number(item.productId),
        variantId: item.variantId === null || item.variantId === undefined ? null : Number(item.variantId),
        quantity: Number(item.quantity),
      };
    }),
  };
}

function validate(input: ChatOrderInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.saleDate)) throw new Error("Pick a date.");
  if (!Number.isInteger(input.orderCount) || input.orderCount < 1) throw new Error("Order count must be a whole number of 1 or more.");
  if (!Number.isFinite(input.revenue) || input.revenue < 0) throw new Error("Enter the total revenue.");
  if (input.items.length === 0) throw new Error("Add at least one product.");
  for (const item of input.items) {
    if (!Number.isFinite(item.productId)) throw new Error("Pick a product on every row.");
    if (item.variantId !== null && !Number.isFinite(item.variantId)) throw new Error("Pick a product on every row.");
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("Every quantity must be a whole number above zero.");
  }
  // Keyed on product+variant: two different variants of one product are two
  // legitimate rows, but the same variant twice is not.
  const keys = input.items.map((i) => optionKey(i));
  if (new Set(keys).size !== keys.length) throw new Error("The same product is listed twice - combine the rows.");
}

// Prices each line at its current cost and writes the items.
//
// A backdated order is priced at TODAY's cost: the model cost timeline is
// effective-dated for the margin engine, but a chat order snapshots what it was
// worth when recorded, which is the property that matters here - later cost
// edits can't restate an order already written down.
async function writeItems(orderId: number, input: ChatOrderInput): Promise<void> {
  const [costByProduct, costByVariant] = await Promise.all([getUnitCostByProduct(), getUnitCostByVariant()]);
  const rows = input.items.map((item) => {
    // The variant sold is costed at its own price when it has one, else at the
    // product's - matching the margin engine.
    const unit =
      (item.variantId !== null ? costByVariant.get(item.variantId) : undefined) ?? costByProduct.get(item.productId);
    return {
      order_id: orderId,
      product_id: item.productId,
      variant_id: item.variantId,
      quantity: item.quantity,
      // Nothing costed -> 0 rather than throwing, the same way the margin engine
      // reports it as "cost missing" instead of failing.
      cost_of_goods: (unit ?? 0) * item.quantity,
    };
  });
  const { error } = await supabase.from("chat_order_items").insert(rows);
  if (error) throw new Error(`Failed to save chat order items: ${error.message}`);
}

export async function createChatOrder(input: ChatOrderInput): Promise<number> {
  validate(input);

  const { data, error } = await supabase
    .from("chat_orders")
    .insert({ sale_date: input.saleDate, revenue: input.revenue, order_count: input.orderCount })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to save chat order: ${error?.message}`);

  try {
    await writeItems(data.id, input);
  } catch (err) {
    // No transactions over PostgREST - an order with no items would report
    // revenue at zero COGS, so drop it rather than leave it half-written.
    await supabase.from("chat_orders").delete().eq("id", data.id);
    throw err;
  }
  return data.id;
}

// Full replace: quantities or the product mix may have moved, so every item is
// re-priced rather than keeping its old snapshot.
export async function updateChatOrder(id: number, input: ChatOrderInput): Promise<void> {
  validate(input);

  const { error: updateErr } = await supabase
    .from("chat_orders")
    .update({ sale_date: input.saleDate, revenue: input.revenue, order_count: input.orderCount, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (updateErr) throw new Error(`Failed to update chat order: ${updateErr.message}`);

  const { error: deleteErr } = await supabase.from("chat_order_items").delete().eq("order_id", id);
  if (deleteErr) throw new Error(`Failed to replace chat order items: ${deleteErr.message}`);

  await writeItems(id, input);
}

export async function deleteChatOrder(id: number): Promise<void> {
  // Items go with it via the on-delete-cascade foreign key.
  const { error } = await supabase.from("chat_orders").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete chat order: ${error.message}`);
}
