import "server-only";
import { supabase } from "@/lib/supabase";
import { getShopifyAccessToken, shopifyGraphQL } from "@/lib/shopify";

const PAGE_SIZE = 50;
// Leaves headroom under Vercel's 60s function limit, including the worst-case
// retry backoff below (~2.8s).
const TIME_BUDGET_MS = 40_000;

// Supabase sits behind Cloudflare and intermittently answers with a 520/504
// that succeeds on an immediate retry. Without this a single blip throws out of
// the whole pass and - because the nightly cron breaks its loop on failure -
// strands the sync mid-day, silently leaving the dashboard hours stale.
const MAX_ATTEMPTS = 4;

function isTransient(message: string): boolean {
  return (
    /\b(408|429|50[0-4]|52[0-4])\b/.test(message) ||
    /timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|unknown error|try again/i.test(message)
  );
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_ATTEMPTS || !isTransient(message)) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

// Shopify exposes several "prices" per line item, and the gap between them is
// every discount the store gave away. Storing originalUnitPrice (the list
// price) booked discounts as revenue that was never collected.
// `discountAllocations` is the reliable net basis: it carries BOTH line-level
// discounts (EACH/ENTITLED) and order-level ones (ACROSS/ALL), which
// `discountedTotalSet` alone can miss.
type MoneyBag = { shopMoney?: { amount?: string | number | null } | null } | null;

type ShopifyLineItem = {
  id: string;
  quantity: number;
  title?: string | null;
  originalUnitPriceSet?: MoneyBag;
  originalTotalSet?: MoneyBag;
  discountAllocations?: Array<{ allocatedAmountSet?: MoneyBag }> | null;
  product?: { id: string } | null;
  variant?: { id: string } | null;
};

function money(bag: MoneyBag | undefined): number {
  return Number(bag?.shopMoney?.amount ?? 0);
}

function netLineTotal(line: ShopifyLineItem): number {
  const original = money(line.originalTotalSet);
  const allocated = (line.discountAllocations ?? []).reduce((sum, a) => sum + money(a?.allocatedAmountSet), 0);
  return Math.max(original - allocated, 0);
}

// Shopify's subtotalPrice is the authority on an order's goods value net of
// every discount (it excludes shipping, tracked separately as
// shipping_fee_charged). Per-line allocations can round a few piastres away
// from it, so nudge the lines to sum to it exactly. Only rounding-scale gaps
// are corrected: subtotalPrice is also reduced by RETURNS, and a refunded order
// legitimately diverges - that is modelled downstream as refund_adjustment.
const SUBTOTAL_RECONCILE_TOLERANCE = 0.02; // 2%

function reconcileToSubtotal(netTotals: number[], subtotal: number | null): number[] {
  if (subtotal === null || !Number.isFinite(subtotal) || subtotal <= 0) return netTotals;
  const sum = netTotals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return netTotals;
  const drift = Math.abs(sum - subtotal);
  if (drift <= 0.01) return netTotals;
  if (drift / subtotal > SUBTOTAL_RECONCILE_TOLERANCE) return netTotals;
  const scale = subtotal / sum;
  return netTotals.map((t) => t * scale);
}

type SyncResult = {
  ok: boolean;
  ordersProcessed: number;
  reachedEnd: boolean;
  error?: string;
};

// Egypt day = fixed UTC+3 offset, matching the same rule used in the database.
function toEgyptDay(isoDate: string): string {
  const shifted = new Date(new Date(isoDate).getTime() + 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// The courier writes delivery status back into Shopify fulfillments,
// so we read the delivery outcome straight from the order's fulfillments here
// instead of calling a separate courier API. Maps Shopify's FulfillmentDisplay-
// Status to this app's outcome enum.
const FAILED_STATUSES = new Set(["FAILURE", "NOT_DELIVERED", "CANCELED"]);

type DeliveryInfo = {
  outcome: "delivered" | "in_transit" | "failed_rto" | null;
  resolvedAt: string | null;
  trackingNumber: string | null;
  // The fulfilments' own displayStatus, kept verbatim. A courier fulfilment
  // moves IN_TRANSIT -> DELIVERED; one marked fulfilled by hand stays at plain
  // 'FULFILLED' with no tracking, which is how the Unresolved Orders tab spots
  // a private delivery. Null when nothing was ever fulfilled.
  fulfillmentStatus: string | null;
};

function classifyDelivery(fulfillments: any[]): DeliveryInfo {
  const tracking =
    fulfillments.flatMap((f) => f.trackingInfo ?? []).map((t) => t?.number).find(Boolean) ?? null;
  const fulfillmentStatus =
    [...new Set((fulfillments ?? []).map((f) => f.displayStatus).filter(Boolean))].join(",") || null;

  if (!fulfillments || fulfillments.length === 0) {
    return { outcome: null, resolvedAt: null, trackingNumber: null, fulfillmentStatus: null };
  }
  const delivered = fulfillments.find((f) => f.displayStatus === "DELIVERED");
  if (delivered) {
    return { outcome: "delivered", resolvedAt: delivered.deliveredAt ?? null, trackingNumber: tracking, fulfillmentStatus };
  }
  if (fulfillments.some((f) => FAILED_STATUSES.has(f.displayStatus))) {
    return { outcome: "failed_rto", resolvedAt: null, trackingNumber: tracking, fulfillmentStatus };
  }
  return { outcome: "in_transit", resolvedAt: null, trackingNumber: tracking, fulfillmentStatus };
}

const ORDERS_QUERY = `
  query Orders($cursor: String, $searchQuery: String) {
    orders(first: ${PAGE_SIZE}, after: $cursor, query: $searchQuery, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          name
          createdAt
          cancelledAt
          displayFinancialStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          subtotalPriceSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          shippingAddress { province }
          displayFulfillmentStatus
          fulfillments(first: 5) {
            status
            displayStatus
            deliveredAt
            trackingInfo { number }
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                quantity
                title
                originalUnitPriceSet { shopMoney { amount } }
                originalTotalSet { shopMoney { amount } }
                discountAllocations { allocatedAmountSet { shopMoney { amount } } }
                product { id }
                variant { id }
              }
            }
          }
        }
      }
    }
  }
`;

export async function syncShopifyOrders(): Promise<SyncResult> {
  const startedAt = Date.now();

  try {
    const accessToken = await getShopifyAccessToken();

    const { data: state, error: stateErr } = await supabase
      .from("sync_state")
      .select("*")
      .eq("source", "shopify")
      .single();
    if (stateErr) throw new Error(`Failed to read sync_state: ${stateErr.message}`);

    let cursor: string | null = null;
    let since: string | null = state?.last_synced_at ?? null;
    if (state?.cursor) {
      try {
        const parsed = JSON.parse(state.cursor);
        cursor = parsed.after ?? null;
        since = parsed.since ?? since;
      } catch {
        // malformed cursor from a previous bug, just restart the pass
      }
    }

    // Optional lower bound on ORDER CREATION date (e.g. only sync Jan 2026
    // onward). Combined with the incremental updated_at filter so ongoing syncs
    // still catch status changes on orders created after the floor.
    const createdFloor = process.env.SHOPIFY_ORDERS_SINCE || null;
    const parts: string[] = [];
    if (createdFloor) parts.push(`created_at:>='${createdFloor}'`);
    if (since) parts.push(`updated_at:>='${since}'`);
    const searchQuery = parts.length > 0 ? parts.join(" ") : null;
    const passStartedAt = new Date().toISOString();
    const productCache = new Map<string, number | null>();
    const variantCache = new Map<string, number | null>();

    let ordersProcessed = 0;
    let reachedEnd = false;
    // Cursor of the last page that finished cleanly. Persisted even when the
    // pass ends in an error, so a failure costs one page of re-work rather than
    // replaying from wherever it last succeeded.
    let lastGoodCursor: string | null = cursor;

    try {
      while (true) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) break;

        const data = await withRetry(() => shopifyGraphQL<any>(accessToken, ORDERS_QUERY, { cursor, searchQuery }));
        const edges = data.orders.edges;
        if (edges.length === 0) {
          reachedEnd = true;
          break;
        }

        for (const edge of edges) {
          await withRetry(() => upsertOrder(edge.node, productCache, variantCache));
          ordersProcessed++;
        }

        cursor = edges[edges.length - 1].cursor;
        lastGoodCursor = cursor;
        if (!data.orders.pageInfo.hasNextPage) {
          reachedEnd = true;
          break;
        }
      }
    } catch (err) {
      // Checkpoint the pages that did land before giving up.
      await saveSyncState({ reachedEnd: false, since, cursor: lastGoodCursor, passStartedAt });
      return {
        ok: false,
        ordersProcessed,
        reachedEnd: false,
        error: err instanceof Error ? err.message : "unknown error",
      };
    }

    await saveSyncState({ reachedEnd, since, cursor, passStartedAt });

    return { ok: true, ordersProcessed, reachedEnd };
  } catch (err) {
    return {
      ok: false,
      ordersProcessed: 0,
      reachedEnd: false,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

// A completed pass clears the cursor and advances the incremental watermark; an
// incomplete one only records where to resume, leaving the watermark alone so
// nothing updated mid-pass is skipped next time.
async function saveSyncState(opts: {
  reachedEnd: boolean;
  since: string | null;
  cursor: string | null;
  passStartedAt: string;
}) {
  const update = opts.reachedEnd
    ? { last_synced_at: opts.passStartedAt, cursor: null, updated_at: new Date().toISOString() }
    : { cursor: JSON.stringify({ since: opts.since, after: opts.cursor }), updated_at: new Date().toISOString() };
  await supabase.from("sync_state").update(update).eq("source", "shopify");
}

async function upsertOrder(
  node: any,
  productCache: Map<string, number | null>,
  variantCache: Map<string, number | null>
) {
  const shopifyOrderId = node.id.split("/").pop();
  const orderCreatedAt = node.createdAt;

  const totalPrice = node.totalPriceSet?.shopMoney?.amount ?? null;
  const governorate = node.shippingAddress?.province ?? null;
  const delivery = classifyDelivery(node.fulfillments ?? []);

  const { data: orderRow, error: orderErr } = await supabase
    .from("orders")
    .upsert(
      {
        shopify_order_id: shopifyOrderId,
        order_number: node.name,
        order_created_at: orderCreatedAt,
        egypt_day: toEgyptDay(orderCreatedAt),
        total_price: totalPrice,
        currency: node.totalPriceSet?.shopMoney?.currencyCode ?? "EGP",
        shipping_fee_charged: node.totalShippingPriceSet?.shopMoney?.amount ?? null,
        governorate_shopify: governorate,
        cancelled_at: node.cancelledAt ?? null,
        financial_status: node.displayFinancialStatus ?? null,
        // Delivery outcome via Shopify fulfillments.
        outcome: delivery.outcome,
        outcome_governorate: delivery.outcome ? governorate : null,
        resolved_at: delivery.resolvedAt,
        // COD is collected on delivery, so a delivered order collected its total.
        cod_amount_collected: delivery.outcome === "delivered" ? totalPrice : null,
        bosta_tracking_number: delivery.trackingNumber,
        shopify_fulfillment_status: delivery.fulfillmentStatus,
        last_bosta_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "shopify_order_id" }
    )
    .select("id")
    .single();

  if (orderErr || !orderRow) {
    throw new Error(`Failed to upsert order ${node.name}: ${orderErr?.message}`);
  }

  // Net-of-discount line totals, nudged to sum to Shopify's own subtotal.
  const lines: ShopifyLineItem[] = (node.lineItems?.edges ?? []).map((e: { node: ShopifyLineItem }) => e.node);
  const netTotals = reconcileToSubtotal(
    lines.map(netLineTotal),
    node.subtotalPriceSet?.shopMoney?.amount != null ? Number(node.subtotalPriceSet.shopMoney.amount) : null
  );

  for (const [lineIndex, line] of lines.entries()) {
    const shopifyLineItemId = line.id.split("/").pop();
    const shopifyProductId: string | null = line.product?.id ? (line.product.id.split("/").pop() ?? null) : null;

    const shopifyVariantId: string | null = line.variant?.id ? (line.variant.id.split("/").pop() ?? null) : null;

    let productId: number | null = null;
    if (shopifyProductId) {
      if (productCache.has(shopifyProductId)) {
        productId = productCache.get(shopifyProductId) ?? null;
      } else {
        const { data: product } = await supabase
          .from("products")
          .select("id")
          .eq("shopify_product_id", shopifyProductId)
          .maybeSingle();
        productId = product?.id ?? null;
        productCache.set(shopifyProductId, productId);
      }
    }

    // Resolve the variant the same way as the product: if the catalog sync
    // hasn't created it yet, the raw shopify_variant_id is still stored so
    // syncVariants can relink this line later.
    let variantId: number | null = null;
    if (shopifyVariantId) {
      if (variantCache.has(shopifyVariantId)) {
        variantId = variantCache.get(shopifyVariantId) ?? null;
      } else {
        const { data: variant } = await supabase
          .from("product_variants")
          .select("id")
          .eq("shopify_variant_id", shopifyVariantId)
          .maybeSingle();
        variantId = variant?.id ?? null;
        variantCache.set(shopifyVariantId, variantId);
      }
    }

    const { error: lineErr } = await supabase.from("order_line_items").upsert(
      {
        order_id: orderRow.id,
        product_id: productId,
        variant_id: variantId,
        shopify_product_id: shopifyProductId,
        shopify_variant_id: shopifyVariantId,
        shopify_line_item_id: shopifyLineItemId,
        quantity: line.quantity,
        // NET (post-discount) price: margin.ts derives revenue as
        // quantity * unit_price, so storing the list price here overstated
        // revenue by every discount ever given.
        unit_price:
          line.quantity > 0 ? netTotals[lineIndex] / line.quantity : money(line.originalUnitPriceSet),
        product_title_raw: productId ? null : line.title,
      },
      { onConflict: "shopify_line_item_id" }
    );
    if (lineErr) {
      throw new Error(`Failed to upsert line item ${shopifyLineItemId}: ${lineErr.message}`);
    }
  }
}
