import "server-only";
import { unstable_cache } from "next/cache";
import { REPORT_CACHE_SECONDS, REPORT_CACHE_TAG } from "./cache";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { inBatches } from "@/lib/in-batches";
import { addDays, egyptToday } from "@/lib/dates";
import { getSkuProjectionRates } from "@/lib/engine/monthly-rate";
import { REPORTED_AD_SEGMENT } from "@/lib/ad-segment";
import { ADSET_LEVEL_CAMPAIGNS } from "@/lib/ad-split";

// Campaigns P&L: one row per Meta campaign over a date range.
//
// Orders are credited to the Meta campaign of the customer's LAST ad click
// within 7 days (orders.meta_campaign_id, see src/lib/sync/shopify-attribution.ts).
// Meta's own "Results" count more than this (view-through, cross-device and
// modelled purchases), but those never leave a trace on the order, so they
// can't be turned into real orders and products.
//
// Money follows Analysis by Product (./per-product.ts):
//   - revenue = quantity x unit_price, the net line price, never shipping;
//   - COGS = the margin engine's stored line cost (the cost in force on the
//     order's day);
//   - Revenue, COGS and Contribution are shown at full value (every order
//     delivered, cancelled ones included); "Contribution after returns"
//     applies each product's own delivery rate to its revenue and COGS, and
//     counts a cancelled order as delivering nothing;
//   - marketing = the campaign's own retail Meta spend over the same days. A
//     campaign split by ad set (src/lib/ad-split.ts) is one row per ad set,
//     the same as its spend.

export type CampaignProduct = { name: string; units: number; orders: number };

export type CampaignRow = {
  // null for spend that couldn't be tied to a campaign.
  campaignId: string | null;
  name: string;
  orders: number;
  items: number;
  grossRevenue: number; // every order delivered
  grossCogs: number;
  revenue: number; // expected delivered
  cogs: number;
  grossProfit: number; // expected
  adSpend: number;
  grossContribution: number; // grossRevenue - grossCogs - adSpend
  contributionProfit: number; // after returns: revenue - cogs - adSpend
  products: CampaignProduct[];
  // Cancelled orders. They count in orders, items, gross revenue / COGS and
  // Contribution like any order, but as delivering nothing in "after returns";
  // Products Sold lists them with a Cancelled tag.
  cancelledOrders: number;
  cancelledProducts: CampaignProduct[];
};

export type CampaignPnlResult = {
  from: string;
  // `to` capped at yesterday - the open day shows as zero everywhere else in the
  // app, and its spend and attribution are still filling in.
  to: string;
  campaigns: CampaignRow[];
  // Every order in the range (cancelled ones included, as in the table), how
  // many of them a Meta campaign is credited with, and how many haven't had
  // their visit data read yet.
  placedOrders: number;
  attributedOrders: number;
  uncheckedOrders: number;
};

// A Meta ad click whose campaign isn't known: tagged with labels only, or its ad set
// is one the token can't read.
const UNKNOWN_CAMPAIGN = "unknown";

export const getCampaignPnl = unstable_cache(computeCampaignPnl, ["campaign-pnl"], {
  revalidate: REPORT_CACHE_SECONDS,
  tags: [REPORT_CACHE_TAG],
});

async function computeCampaignPnl(from: string, to: string): Promise<CampaignPnlResult> {
  const yesterday = addDays(egyptToday(), -1);
  const effTo = to > yesterday ? yesterday : to;
  const empty: CampaignPnlResult = { from, to: effTo, campaigns: [], placedOrders: 0, attributedOrders: 0, uncheckedOrders: 0 };
  if (effTo < from) return empty;

  const [orders, spendRows, products, variants, skuRates, placed, unchecked] = await Promise.all([
    fetchAllRows<{
      order_number: string;
      cancelled_at: string | null;
      meta_campaign_id: string | null;
      meta_adset_id: string | null;
      order_line_items: {
        product_id: number | null;
        variant_id: number | null;
        quantity: number;
        unit_price: number | null;
        cost_of_goods: number | null;
        product_title_raw: string | null;
      }[];
    }>(
      supabase,
      "orders",
      "id, order_number, cancelled_at, meta_campaign_id, meta_adset_id, order_line_items(product_id, variant_id, quantity, unit_price, cost_of_goods, product_title_raw)",
      (query) =>
        query
          .gte("egypt_day", from)
          .lte("egypt_day", effTo)
          .or("meta_campaign_id.not.is.null,meta_adset_id.not.is.null")
    ),
    fetchAllRows<{ campaign_id: string | null; campaign_name: string | null; spend: number; date: string }>(
      supabase,
      "ad_spend",
      "id, campaign_id, campaign_name, spend, date",
      (query) => query.eq("source", "meta").eq("segment", REPORTED_AD_SEGMENT).gte("date", from).lte("date", effTo)
    ),
    fetchAllRows<{ id: number; name: string }>(supabase, "products", "id, name"),
    fetchAllRows<{ id: number; title: string | null }>(supabase, "product_variants", "id, title"),
    getSkuProjectionRates(),
    supabase.from("orders").select("id", { count: "exact", head: true }).gte("egypt_day", from).lte("egypt_day", effTo),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .gte("egypt_day", from)
      .lte("egypt_day", effTo)
      .is("attribution_synced_at", null),
  ]);
  if (placed.error) throw new Error(`Failed to count orders: ${placed.error.message}`);
  if (unchecked.error) throw new Error(`Failed to count unattributed orders: ${unchecked.error.message}`);

  // "Product — Variant" as on Analysis by Product; Shopify's "Default Title"
  // placeholder is never shown.
  const productName = new Map(products.map((p) => [p.id, p.name]));
  const variantTitle = new Map(variants.map((v) => [v.id, v.title]));
  const labelFor = (li: { product_id: number | null; variant_id: number | null; product_title_raw: string | null }) => {
    if (li.product_id === null) return li.product_title_raw ?? "Unknown product";
    const name = productName.get(li.product_id) ?? li.product_title_raw ?? `Product ${li.product_id}`;
    const title = li.variant_id !== null ? variantTitle.get(li.variant_id) : null;
    return title && title !== "Default Title" ? `${name} — ${title}` : name;
  };
  const rateFor = (productId: number | null) =>
    (productId !== null ? skuRates.ratesByProduct.get(productId) : undefined)?.rate ?? skuRates.fallback.rate;

  type Acc = Omit<CampaignRow, "grossProfit" | "grossContribution" | "contributionProfit" | "products" | "cancelledProducts"> & {
    products: ProductAcc;
    cancelledProducts: ProductAcc;
    nameDate: string;
  };
  const byCampaign = new Map<string | null, Acc>();
  const acc = (id: string | null): Acc => {
    let a = byCampaign.get(id);
    if (!a) {
      a = {
        campaignId: id,
        name:
          id === null ? "Spend not matched to a campaign" : id === UNKNOWN_CAMPAIGN ? "Meta ad, campaign unknown" : `Campaign ${id}`,
        nameDate: "",
        orders: 0,
        items: 0,
        grossRevenue: 0,
        grossCogs: 0,
        revenue: 0,
        cogs: 0,
        adSpend: 0,
        products: new Map(),
        cancelledProducts: new Map(),
        cancelledOrders: 0,
      };
      byCampaign.set(id, a);
    }
    return a;
  };

  // Spend first, so the campaign's name is the latest one it ran under in range.
  for (const r of spendRows) {
    const a = acc(r.campaign_id);
    a.adSpend += Number(r.spend);
    if (r.campaign_id !== null && r.campaign_name && r.date >= a.nameDate) {
      a.name = r.campaign_name;
      a.nameDate = r.date;
    }
  }

  // The engine stores zero cost on a cancelled order's lines, so those (and any
  // line it hasn't costed yet) are priced from the most recent unit cost the
  // engine booked for the product.
  const unitCostFor = await recentUnitCosts(
    orders.flatMap((o) =>
      (o.order_line_items ?? [])
        .filter((li) => o.cancelled_at !== null || !(Number(li.cost_of_goods ?? 0) > 0))
        .map((li) => li.product_id)
    )
  );

  let attributedOrders = 0;
  for (const order of orders) {
    // A campaign split by ad set is reported per ad set, like its spend.
    const key =
      order.meta_campaign_id === null
        ? UNKNOWN_CAMPAIGN
        : ADSET_LEVEL_CAMPAIGNS.has(order.meta_campaign_id) && order.meta_adset_id
          ? order.meta_adset_id
          : order.meta_campaign_id;
    attributedOrders++;
    const a = acc(key);
    a.orders++;
    // Full value like any order, but a cancelled one will never deliver.
    const cancelled = order.cancelled_at !== null;
    if (cancelled) a.cancelledOrders++;
    for (const li of order.order_line_items ?? []) {
      const qty = li.quantity ?? 0;
      const rate = cancelled ? 0 : rateFor(li.product_id);
      const gross = qty * Number(li.unit_price ?? 0);
      // A line the engine hasn't costed yet (synced since the last margins run)
      // borrows the product's latest cost too.
      const cost =
        !cancelled && li.cost_of_goods !== null && Number(li.cost_of_goods) > 0
          ? Number(li.cost_of_goods)
          : (li.product_id !== null ? unitCostFor.get(li.product_id) ?? 0 : 0) * qty;
      a.items += qty;
      a.grossRevenue += gross;
      a.grossCogs += cost;
      a.revenue += gross * rate;
      a.cogs += cost * rate;
      addProduct(cancelled ? a.cancelledProducts : a.products, labelFor(li), qty, order.order_number);
    }
  }

  // A campaign with orders but no spend in range (its spend fell on the day
  // before, say) still needs its real name rather than its id.
  const unnamed = [...byCampaign.values()]
    .filter((a) => a.campaignId !== null && a.campaignId !== UNKNOWN_CAMPAIGN && a.nameDate === "")
    .map((a) => a.campaignId!);
  for (const batch of inBatches(unnamed)) {
    const { data, error } = await supabase
      .from("ad_spend")
      .select("campaign_id, campaign_name, date")
      .in("campaign_id", batch)
      .not("campaign_name", "is", null)
      .order("date", { ascending: true });
    if (error) throw new Error(`Failed to look up campaign names: ${error.message}`);
    for (const row of data ?? []) {
      const a = byCampaign.get(row.campaign_id);
      if (a) a.name = row.campaign_name; // ascending, so the latest name wins
    }
  }

  const campaigns: CampaignRow[] = [...byCampaign.values()]
    .filter((a) => a.orders > 0 || a.adSpend > 0)
    .map((a) => {
      const grossProfit = a.revenue - a.cogs;
      return {
        campaignId: a.campaignId,
        name: a.name,
        orders: a.orders,
        items: a.items,
        grossRevenue: a.grossRevenue,
        grossCogs: a.grossCogs,
        revenue: a.revenue,
        cogs: a.cogs,
        grossProfit,
        adSpend: a.adSpend,
        grossContribution: a.grossRevenue - a.grossCogs - a.adSpend,
        contributionProfit: grossProfit - a.adSpend,
        products: productList(a.products),
        cancelledOrders: a.cancelledOrders,
        cancelledProducts: productList(a.cancelledProducts),
      };
    })
    // Unmatched spend last; otherwise the biggest earners first.
    .sort((x, y) => (x.campaignId === null ? 1 : 0) - (y.campaignId === null ? 1 : 0) || y.contributionProfit - x.contributionProfit);

  return {
    from,
    to: effTo,
    campaigns,
    placedOrders: placed.count ?? 0,
    attributedOrders,
    uncheckedOrders: unchecked.count ?? 0,
  };
}

type ProductAcc = Map<string, { units: number; orders: Set<string> }>;

function addProduct(into: ProductAcc, name: string, units: number, orderNumber: string): void {
  const p = into.get(name) ?? { units: 0, orders: new Set<string>() };
  p.units += units;
  p.orders.add(orderNumber);
  into.set(name, p);
}

function productList(from: ProductAcc): CampaignProduct[] {
  return [...from.entries()]
    .map(([name, p]) => ({ name, units: p.units, orders: p.orders.size }))
    .sort((x, y) => y.units - x.units || x.name.localeCompare(y.name));
}

// The latest per-unit cost the margin engine booked for each product, from its
// most recent costed line - what a cancelled line of the same product would
// have cost.
async function recentUnitCosts(productIds: (number | null)[]): Promise<Map<number, number>> {
  const ids = [...new Set(productIds.filter((id): id is number => id !== null))];
  const out = new Map<number, number>();
  await Promise.all(
    ids.map(async (id) => {
      const { data, error } = await supabase
        .from("order_line_items")
        .select("quantity, cost_of_goods")
        .eq("product_id", id)
        .gt("cost_of_goods", 0)
        .order("id", { ascending: false })
        .limit(1);
      if (error) throw new Error(`Failed to look up the cost of product ${id}: ${error.message}`);
      const row = data?.[0];
      if (row && Number(row.quantity) > 0) out.set(id, Number(row.cost_of_goods) / Number(row.quantity));
    })
  );
  return out;
}
