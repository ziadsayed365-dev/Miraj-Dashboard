import "server-only";
import { unstable_cache } from "next/cache";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { REPORTED_AD_SEGMENT } from "@/lib/ad-segment";
import { firstOfMonth, addDays, egyptToday } from "@/lib/dates";
import { isMonthMature, getSkuProjectionRates, type SkuProjectionRate } from "@/lib/engine/monthly-rate";
import { getChatOrderProductStats, getChatOrderProductDailyTotals } from "@/lib/chat-orders/reporting";
import { compareLabels } from "@/lib/products/labels";
import { isActiveStatus } from "@/lib/products/status";
import { REPORT_CACHE_SECONDS, REPORT_CACHE_TAG } from "./cache";

const RESOLVED_OUTCOMES = ["delivered", "failed_rto", "exchange", "pickup_return"];

// The group a product's numbers are reported under, and the same key ad spend
// is allocated to: its sub-category, falling back to its category when it has
// none (49 products carry a category only).
const groupOfProduct = (p: { category: string | null; sub_category: string | null }): string | null =>
  p.sub_category?.trim() || p.category?.trim() || null;

// category -> every group inside it, built from the products themselves so a
// category-wide allocation always covers whatever the category holds TODAY.
// That is the whole point of storing the category rather than a frozen list of
// its sub-categories (see migration 0067).
function groupsByCategory(products: { category: string | null; sub_category: string | null }[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const p of products) {
    const category = p.category?.trim();
    const group = groupOfProduct(p);
    if (!category || !group) continue;
    const set = out.get(category) ?? new Set<string>();
    set.add(group);
    out.set(category, set);
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}

// Every group one ad_spend row's money lands on: the sub-categories it names,
// plus every group inside any category it was pinned to. De-duplicated, so a
// campaign pinned to both a category and one of its own sub-categories gives
// that sub-category ONE share rather than two.
function allocationGroups(
  row: { sub_categories: string[] | null; categories: string[] | null },
  byCategory: Map<string, string[]>
): string[] {
  const out = new Set<string>();
  for (const s of row.sub_categories ?? []) out.add(s);
  for (const c of row.categories ?? []) for (const g of byCategory.get(c) ?? []) out.add(g);
  return [...out];
}

export type ColorRow = {
  productId: number;
  // Set when this row is ONE VARIANT of a multi-variant product. Null for a
  // whole product, and for the catch-all row holding sales whose variant was
  // deleted in Shopify.
  variantId: number | null;
  name: string;
  ordersPlaced: number;
  ordersResolved: number;
  itemsSold: number;
  revenue: number; // EXPECTED delivered = gross x this product's delivery rate
  cogs: number; // EXPECTED delivered = gross x rate
  grossRevenue: number; // all-orders revenue (100% delivery) - for Meta ratios
  grossCogs: number;
  deliveryRate: number; // this product's own delivery rate applied above
  grossProfit: number;
  adSpend: number; // the model's total ad spend split equally across its SKUs - ad campaigns target a model, not one color
  contributionProfit: number;
  openMonthRate: number | null; // this SKU's own delivery rate used to project the open month, if any
  openMonthRateSourceMonth: string | null;
};

export type ModelRow = {
  // The sub-category (or category, for products without one) this group covers -
  // the same key ad spend is allocated to.
  modelId: string;
  name: string;
  // The category this group sits under, so the table can nest
  // Category > Sub-category > Products. Null only for products with no category
  // at all, which fall into the "(uncategorised)" bucket.
  category: string | null;
  ordersPlaced: number;
  ordersResolved: number;
  itemsSold: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  adSpend: number;
  contributionProfit: number;
  costMissing: boolean;
  colors: ColorRow[];
};

export type PerProductMode = "performance" | "actual";

// Typeahead option for the per-product Rollforward picker. `sku` lets the
// picker be searched by SKU as well as name (for when the name isn't memorable).
export type ProductOption = { id: number; label: string; sku: string | null };

// One day in the per-product Rollforward (the same metrics as the per-product
// table, but per calendar day for a single product).
export type ProductDailyRow = {
  date: string;
  // Total items sold (sum of order line quantities) before the delivery-rate
  // haircut - i.e. units if every order delivered.
  volume: number;
  // The same items after the haircut. Courier items are scaled by this
  // product's delivery rate; chat items are added whole, since a chat order is
  // delivered on the spot - so this can't be derived client-side as
  // volume x rate without understating the chat share.
  expectedVolume: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  adSpend: number;
  contributionProfit: number;
};

// The per-product Rollforward result: the daily rows plus the single delivery
// rate that belongs to the chosen product (its own last-mature-month rate, the
// same figure the All Products "Rate" column shows), so the table can apply
// THAT rate to volume instead of a flat guess.
export type ProductRollforwardResult = {
  rows: ProductDailyRow[];
  deliveryRate: number;
  rateSourceMonth: string | null;
};

export type OpenMonthInfo = { month: string };

export type PerProductResult = {
  models: ModelRow[];
  openMonthInfo: OpenMonthInfo | null;
};

// Finds the earliest immature month touching [from, to] - same rule the
// Income Statement uses (src/lib/reports/daily-pnl.ts), so a SKU's
// revenue/COGS switch over to the delivery-rate projection on exactly the
// same boundary the P&L does.
function findOpenMonthBoundary(from: string, to: string): string | null {
  const floor = firstOfMonth(from);
  let month = firstOfMonth(to);
  let boundary: string | null = null;
  while (!isMonthMature(month)) {
    boundary = month;
    if (month <= floor) break;
    month = firstOfMonth(addDays(month, -1));
  }
  return boundary;
}

// Cached for the same reason as the Income Statement report - see ./cache.ts.
export const getPerProductReport = unstable_cache(computePerProductReport, ["per-product"], {
  revalidate: REPORT_CACHE_SECONDS,
  tags: [REPORT_CACHE_TAG],
});

async function computePerProductReport(
  from: string,
  to: string,
  mode: PerProductMode = "performance"
): Promise<PerProductResult> {
  const { data: products, error: productsErr } = await supabase
    .from("products")
    .select("id, name, category, sub_category, unit_cost_override, status");
  if (productsErr) throw new Error(`Failed to load products: ${productsErr.message}`);

  const productById = new Map((products ?? []).map((p) => [p.id, p]));

  // The grouping the report reports on, matching where ad spend is allocated:
  // a product's sub-category, falling back to its category when it has none
  // (49 products carry a category only), and finally to an explicit bucket so
  // nothing silently vanishes from the totals.
  const UNGROUPED = "(uncategorised)";
  const groupOf = (p: { category: string | null; sub_category: string | null }) =>
    p.sub_category?.trim() || p.category?.trim() || UNGROUPED;

  // Variant titles, for naming the per-variant rows below.
  const { data: variantRows, error: variantErr } = await supabase
    .from("product_variants")
    .select("id, product_id, title, position");
  if (variantErr) throw new Error(`Failed to load product_variants: ${variantErr.message}`);
  const variantById = new Map((variantRows ?? []).map((v) => [v.id, v]));
  // Only a product with SEVERAL variants is worth breaking apart. A
  // single-variant product's variant is Shopify's placeholder ("Default Title"),
  // which is noise - those rows stay merged as one product row.
  const variantCountByProduct = new Map<number, number>();
  for (const v of variantRows ?? []) {
    variantCountByProduct.set(v.product_id, (variantCountByProduct.get(v.product_id) ?? 0) + 1);
  }
  const isMultiVariant = (productId: number) => (variantCountByProduct.get(productId) ?? 0) > 1;

  const boundary = findOpenMonthBoundary(from, to);
  // The current (open) day is shown as zero, exactly like the Income Statement
  // (src/lib/reports/daily-pnl.ts). This page is a range aggregate, so "today
  // contributes zero" = end the aggregation at yesterday. Closed days are
  // unchanged; it rolls over automatically each day.
  const yesterday = addDays(egyptToday(), -1);
  const effTo = to > yesterday ? yesterday : to;
  // Each product's own delivery rate - revenue/COGS below are the EXPECTED
  // delivered figures (gross x this rate), for every month in range.
  const skuRates = await getSkuProjectionRates();
  const rateFor = (productId: number): SkuProjectionRate => skuRates.ratesByProduct.get(productId) ?? skuRates.fallback;

  // Date-filtered in the query rather than in JS below - this used to pull the
  // whole ad_spend table over the wire and discard most of it.
  // Retail only: wholesale runs its own P&L (see src/lib/ad-segment.ts).
  const allAdSpendRows = await fetchAllRows<{
    sub_categories: string[] | null;
    categories: string[] | null;
    spend: number;
    date: string;
    is_general: boolean;
  }>(
    supabase,
    "ad_spend",
    "id, sub_categories, categories, spend, date, is_general",
    (query) => query.gte("date", from).lte("date", effTo).eq("segment", REPORTED_AD_SEGMENT)
  );
  const adCategoryGroups = groupsByCategory(products ?? []);
  const adSpendBySubCategory = new Map<string, number>();
  // Brand / general campaigns promote no single sub-category, so their spend is
  // spread across the ones that actually sold in this range (see below). Spend
  // that is neither allocated nor general is still excluded - it's an
  // outstanding decision in the allocation popup, not a real cost signal yet.
  let generalAdSpend = 0;
  for (const row of allAdSpendRows) {
    if (row.date < from || row.date > effTo) continue;
    if (row.is_general) {
      generalAdSpend += Number(row.spend);
      continue;
    }
    // A category pin expands to every sub-category it currently holds, so this
    // is the full target list either way.
    const labels = allocationGroups(row, adCategoryGroups);
    if (labels.length === 0) continue;
    // A campaign promoting several sub-categories splits its spend EQUALLY
    // between them - there is no signal saying which got more of the budget.
    const share = Number(row.spend) / labels.length;
    for (const label of labels) {
      adSpendBySubCategory.set(label, (adSpendBySubCategory.get(label) ?? 0) + share);
    }
  }

  type Stats = {
    ordersPlaced: number;
    ordersResolved: number;
    itemsSold: number;
    grossRevenue: number; // all-orders (100% delivery); scaled to expected per product below
    grossCogs: number;
  };
  // Keyed by product AND variant: "<productId>:<variantId ?? '-'>". A product
  // with variants contributes one entry per variant it actually sold.
  const statsByKey = new Map<string, Stats>();
  const variantKeysByProduct = new Map<number, (number | null)[]>();
  const statsKey = (productId: number, variantId: number | null) => `${productId}:${variantId ?? "-"}`;
  function getStats(productId: number, variantId: number | null): Stats {
    const key = statsKey(productId, variantId);
    if (!statsByKey.has(key)) {
      statsByKey.set(key, { ordersPlaced: 0, ordersResolved: 0, itemsSold: 0, grossRevenue: 0, grossCogs: 0 });
      const seen = variantKeysByProduct.get(productId) ?? [];
      seen.push(variantId);
      variantKeysByProduct.set(productId, seen);
    }
    return statsByKey.get(key)!;
  }

  // The whole range aggregated in the DATABASE (gross = all outcomes). No need
  // to split out the open month anymore since every month is scaled to expected
  // by the product's rate, so the mature/open handling is identical. Gross money
  // includes cancelled orders, because the rate it is scaled by already counts
  // them; the order and item counts do not (migration 0079).
  const { data: statRows, error: rpcErr } = await supabase.rpc("per_product_stats", { p_mode: mode, p_from: from, p_to: effTo });
  if (rpcErr) throw new Error(`per_product_stats failed: ${rpcErr.message}`);
  for (const r of (statRows ?? []) as {
    product_id: number;
    variant_id: number | null;
    orders_placed: number;
    orders_resolved: number;
    items_sold: number;
    revenue: number;
    cogs: number;
  }[]) {
    const s = getStats(Number(r.product_id), r.variant_id == null ? null : Number(r.variant_id));
    s.ordersPlaced += Number(r.orders_placed);
    s.ordersResolved += Number(r.orders_resolved);
    s.itemsSold += Number(r.items_sold);
    s.grossRevenue += Number(r.revenue);
    s.grossCogs += Number(r.cogs);
  }

  // Chat orders for the same range, per product/variant. Kept SEPARATE from the
  // courier stats above because those are gross (all-outcomes) figures that get
  // scaled by the product's delivery rate below - a chat order has no courier and
  // is 100% delivered, so scaling it would understate it. Added after the scaling.
  const chatStats = await getChatOrderProductStats(from, effTo);
  // Make sure a product that ONLY ever sold over chat still gets a row.
  for (const key of chatStats.keys()) {
    const [p, v] = key.split(":");
    getStats(Number(p), v === "-" ? null : Number(v));
  }

  const productsByGroup = new Map<string, typeof products>();
  for (const p of products ?? []) {
    const key = groupOf(p);
    if (!productsByGroup.has(key)) productsByGroup.set(key, []);
    productsByGroup.get(key)!.push(p);
  }
  const groupKeys = [...productsByGroup.keys()].sort((a, b) => compareLabels(a, b));

  const emptyStats: Stats = { ordersPlaced: 0, ordersResolved: 0, itemsSold: 0, grossRevenue: 0, grossCogs: 0 };

  // The rows the table renders for one product: one per variant it sold when the
  // product has several, otherwise a single collapsed row. Ad spend is divided
  // by these, so it has to be the same list the row builder below walks.
  const rowKeysOf = (p: { id: number }): (number | null)[] =>
    isMultiVariant(p.id) ? variantKeysByProduct.get(p.id) ?? [null] : [null];
  // Did this row move anything in range? Courier and chat both count - a row
  // that sold only over chat is still a live row.
  const rowItemsSold = (p: { id: number }, variantId: number | null): number => {
    const keys = isMultiVariant(p.id) ? [variantId] : variantKeysByProduct.get(p.id) ?? [null];
    return keys.reduce<number>(
      (n, k) => n + (statsByKey.get(statsKey(p.id, k))?.itemsSold ?? 0) + (chatStats.get(statsKey(p.id, k))?.items ?? 0),
      0
    );
  };

  // General spend is split EQUALLY across the sub-categories that actually sold
  // in this range. Ones with no sales are excluded - charging a dormant group
  // would bury spend in a row the report doesn't even show, so the split would
  // stop adding up to the real total.
  const sellingGroups = groupKeys.filter((key) =>
    (productsByGroup.get(key) ?? []).some((p) =>
      (variantKeysByProduct.get(p.id) ?? []).some((v) => (statsByKey.get(statsKey(p.id, v))?.itemsSold ?? 0) > 0)
    )
  );
  const generalPerGroup = sellingGroups.length > 0 ? generalAdSpend / sellingGroups.length : 0;
  const sellingGroupSet = new Set(sellingGroups);

  const result: ModelRow[] = [];
  for (const groupKey of groupKeys) {
    const modelProducts = productsByGroup.get(groupKey) ?? [];
    const adSpend = (adSpendBySubCategory.get(groupKey) ?? 0) + (sellingGroupSet.has(groupKey) ? generalPerGroup : 0);
    // The group's spend is divided EQUALLY ACROSS ITS ROWS - every line the
    // table shows carries the same figure, whether it is one weight of a
    // four-variant product or a product that has only one.
    //
    // It used to divide per PRODUCT and then again per variant, which charged a
    // single-variant product several times what each variant of its neighbour
    // carried (5,059 against 1,686 in ملابس الإحرام) purely because of how the
    // listing happens to be built in Shopify. Nothing about the ads justifies
    // that - a campaign promotes the group, not a listing structure.
    //
    // A row earns a share by being LIVE: it sold in range, and its product is
    // not archived / draft / unlisted (the Product List's own "active" rule).
    // Dead rows - a retired listing, a stale "Default Title", a variant deleted
    // in Shopify - take nothing, so their history stops absorbing today's spend.
    const activeCount = modelProducts.filter((p) => isActiveStatus(p.status)).length;
    const allRows = modelProducts.flatMap((p) => rowKeysOf(p).map((variantId) => ({ p, variantId })));
    const liveRows = allRows.filter(
      ({ p, variantId }) => rowItemsSold(p, variantId) > 0 && (activeCount === 0 || isActiveStatus(p.status))
    );
    // A group where nothing is live still has to absorb its spend, or the money
    // divides by zero and disappears from the report - so it falls back to
    // spreading across every row it holds.
    const splitRows = liveRows.length > 0 ? liveRows : allRows;
    const perRowAdSpend = splitRows.length > 0 ? adSpend / splitRows.length : 0;
    const splitRowSet = new Set(splitRows.map(({ p, variantId }) => statsKey(p.id, variantId)));

    const colors: ColorRow[] = modelProducts.flatMap((p) => {
      // One row per variant the product actually sold in this range (null = the
      // product itself / sales whose variant was deleted). A product that sold
      // nothing still gets its single zero row, as before. Single-variant
      // products collapse to ONE row - their variant carries no real meaning.
      const keys = rowKeysOf(p);
      // Delivery rates are calibrated per PRODUCT, so every variant of a
      // product shares its parent's rate.
      const { rate, sourceMonth } = rateFor(p.id);

      return keys
        .map((variantId) => {
          // A collapsed product sums every key it sold under (its placeholder
          // variant, and any line whose variant was deleted); a broken-out
          // variant reads only its own.
          const s = isMultiVariant(p.id)
            ? statsByKey.get(statsKey(p.id, variantId)) ?? emptyStats
            : (variantKeysByProduct.get(p.id) ?? []).reduce<Stats>((acc, k) => {
                const part = statsByKey.get(statsKey(p.id, k));
                if (!part) return acc;
                return {
                  ordersPlaced: acc.ordersPlaced + part.ordersPlaced,
                  ordersResolved: acc.ordersResolved + part.ordersResolved,
                  itemsSold: acc.itemsSold + part.itemsSold,
                  grossRevenue: acc.grossRevenue + part.grossRevenue,
                  grossCogs: acc.grossCogs + part.grossCogs,
                };
              }, { ...emptyStats });
          const variant = variantId == null ? null : variantById.get(variantId);
          // Chat orders for this row: a collapsed product sums every key it sold
          // under, a broken-out variant reads only its own - mirroring `s` above.
          const chat = (isMultiVariant(p.id) ? [variantId] : variantKeysByProduct.get(p.id) ?? [null]).reduce(
            (acc, k) => {
              const part = chatStats.get(statsKey(p.id, k));
              if (!part) return acc;
              return {
                orders: acc.orders + part.orders,
                items: acc.items + part.items,
                revenue: acc.revenue + part.revenue,
                cogs: acc.cogs + part.cogs,
              };
            },
            { orders: 0, items: 0, revenue: 0, cogs: 0 }
          );
          // Every live row in the group carries the same share; a dead one
          // carries nothing.
          const adSpendPerRow = splitRowSet.has(statsKey(p.id, variantId)) ? perRowAdSpend : 0;
          // Courier sales are scaled to expected-delivered; chat sales are added
          // at full value on top, since they are already delivered.
          const revenue = s.grossRevenue * rate + chat.revenue;
          const cogs = s.grossCogs * rate + chat.cogs;
          const grossProfit = revenue - cogs;
          return {
            productId: p.id,
            variantId,
            // "Default Title" is Shopify's placeholder for a product with no
            // real variants - never worth showing next to the product name.
            name: variant && variant.title !== "Default Title" ? `${p.name} — ${variant.title}` : p.name,
            // Chat orders are real orders and real items, so they count here;
            // they are always resolved (delivered on the spot).
            ordersPlaced: s.ordersPlaced + chat.orders,
            ordersResolved: s.ordersResolved + chat.orders,
            itemsSold: s.itemsSold + chat.items,
            revenue,
            cogs,
            // Gross = the all-orders (100%-delivered) basis the Meta ratios use.
            // A chat order IS 100% delivered, so it contributes its full value.
            grossRevenue: s.grossRevenue + chat.revenue,
            grossCogs: s.grossCogs + chat.cogs,
            deliveryRate: rate,
            grossProfit,
            adSpend: adSpendPerRow,
            contributionProfit: grossProfit - adSpendPerRow,
            openMonthRate: rate,
            openMonthRateSourceMonth: sourceMonth,
            sortPosition: variant?.position ?? 0,
          };
        })
        .sort((a, b) => a.sortPosition - b.sortPosition)
        .map(({ sortPosition: _sortPosition, ...row }) => row);
    });

    const ordersPlaced = colors.reduce((sum, c) => sum + c.ordersPlaced, 0);
    const ordersResolved = colors.reduce((sum, c) => sum + c.ordersResolved, 0);
    const itemsSold = colors.reduce((sum, c) => sum + c.itemsSold, 0);
    const revenue = colors.reduce((sum, c) => sum + c.revenue, 0);
    const cogs = colors.reduce((sum, c) => sum + c.cogs, 0);
    const grossProfit = revenue - cogs;

    result.push({
      modelId: groupKey,
      name: groupKey,
      // Every product in a group shares its category by construction (the group
      // key is derived from the category), so the first one settles it.
      category: modelProducts[0]?.category?.trim() || null,
      ordersPlaced,
      ordersResolved,
      itemsSold,
      revenue,
      cogs,
      grossProfit,
      adSpend,
      contributionProfit: grossProfit - adSpend,
      // The real signal: something sold but booked no COGS. Reading a cost
      // column here instead would flag whole groups that are in fact fully
      // costed, since a cost can sit on the product or on the variant.
      costMissing: colors.some((c) => c.itemsSold > 0 && c.grossCogs === 0),
      colors: colors.sort((a, b) => b.grossProfit - a.grossProfit),
    });
  }

  return {
    models: result.sort((a, b) => b.grossProfit - a.grossProfit),
    openMonthInfo: boundary ? { month: boundary } : null,
  };
}

// Flat list of every product for the Rollforward typeahead, labelled
// "Model — Color" so models with similarly-named colors stay distinguishable
// (collapsed to just the name when the color matches the model, which is the
// common case here).
export const getProductOptions = unstable_cache(computeProductOptions, ["product-options"], {
  revalidate: REPORT_CACHE_SECONDS,
  tags: [REPORT_CACHE_TAG],
});

async function computeProductOptions(): Promise<ProductOption[]> {
  const { data: products, error } = await supabase.from("products").select("id, name, sku, category, sub_category");
  if (error) throw new Error(`Failed to load products: ${error.message}`);

  return (products ?? [])
    .map((p) => {
      const group = p.sub_category?.trim() || p.category?.trim() || null;
      // Some products are named identically to their sub-category, so
      // "Group — Name" would just repeat the same text - only prefix when it differs.
      const label = group && group !== p.name.trim() ? `${group} — ${p.name}` : p.name;
      const sku = p.sku && String(p.sku).trim() ? String(p.sku).trim() : null;
      return { id: p.id, label, sku };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Daily Volume/Rev/COGS/Gross/Marketing/Contribution for a single product
// across [from, to]. Every figure here is computed on exactly the same basis as
// getPerProductReport above, so summing this window ties back to that product's
// rows in the All Products table:
//   - revenue/COGS come from the stored per-line figures, scaled by the
//     product's own delivery rate on EVERY day (no separate open-month branch -
//     the projection is the rate, in both mature and open months alike);
//   - chat orders are added on top at full value, never scaled, since they carry
//     no courier and are delivered on the spot;
//   - marketing is the product's share of its model's spend that day, plus the
//     model's share of general/brand spend, bucketed by the ad's own date.
// Returns one row per calendar day in range (zeros where idle).
// How many LIVE rows each product of a group renders - the unit the All
// Products table divides a group's ad spend by. A product with several variants
// shows one row per variant it sold; a single-variant one collapses to a single
// row. A row that sold nothing is not live and takes no share.
async function countGroupRows(
  groupProducts: { id: number }[],
  from: string,
  to: string,
  mode: PerProductMode
): Promise<Map<number, number>> {
  const ids = new Set(groupProducts.map((p) => p.id));
  const { data: variantRows } = await supabase.from("product_variants").select("id, product_id");
  const variantCount = new Map<number, number>();
  for (const v of variantRows ?? []) variantCount.set(v.product_id, (variantCount.get(v.product_id) ?? 0) + 1);

  const soldKeys = new Map<number, Set<string>>();
  // A single-variant product collapses to one row, so every key it sold under
  // folds into the same bucket.
  const add = (productId: number, variantId: number | null) => {
    if (!ids.has(productId)) return;
    const key = (variantCount.get(productId) ?? 0) > 1 ? String(variantId ?? "-") : "-";
    const set = soldKeys.get(productId) ?? new Set<string>();
    set.add(key);
    soldKeys.set(productId, set);
  };

  const { data: statRows, error } = await supabase.rpc("per_product_stats", { p_mode: mode, p_from: from, p_to: to });
  if (error) throw new Error(`per_product_stats failed: ${error.message}`);
  for (const r of (statRows ?? []) as { product_id: number; variant_id: number | null; items_sold: number }[]) {
    if (Number(r.items_sold) <= 0) continue;
    add(Number(r.product_id), r.variant_id == null ? null : Number(r.variant_id));
  }
  // Chat orders make a row live just as courier orders do.
  for (const [key, stats] of await getChatOrderProductStats(from, to)) {
    if (stats.items <= 0) continue;
    const [p, v] = key.split(":");
    add(Number(p), v === "-" ? null : Number(v));
  }

  return new Map([...soldKeys].map(([id, set]) => [id, set.size]));
}

export async function getProductDailyRollforward(
  productId: number,
  from: string,
  to: string,
  mode: PerProductMode = "performance"
): Promise<ProductRollforwardResult> {
  const { data: product, error: prodErr } = await supabase
    .from("products")
    .select("id, name, category, sub_category, status")
    .eq("id", productId)
    .maybeSingle();
  if (prodErr) throw new Error(`Failed to load product: ${prodErr.message}`);

  // This product's own delivery rate (its last finalized month, or the
  // store-wide fallback) - the same figure the All Products "Rate" column shows,
  // and what scales revenue/COGS/volume to their expected-delivered basis.
  const skuRates = await getSkuProjectionRates();
  const { rate: deliveryRate, sourceMonth: rateSourceMonth } =
    skuRates.ratesByProduct.get(productId) ?? skuRates.fallback;

  if (!product) return { rows: [], deliveryRate, rateSourceMonth };

  // Costs are NOT read here. They are already baked into
  // order_line_items.cost_of_goods by computeMargins (src/lib/engine/margin.ts),
  // which resolves them as variant cost -> product cost -> the model group's
  // cost as of the order's day. Re-multiplying a cost column here would restate
  // margins that the engine has already settled.
  //
  // This product's share of its group's ad spend, on exactly the basis the All
  // Products table uses: the group's spend is split equally across its LIVE
  // ROWS, so a product holding three selling variants takes three shares and a
  // single-variant neighbour takes one. The whole catalogue is read once here
  // and reused for the category expansion below.
  //
  // Grouping goes through groupOfProduct, NOT a column match: a group is
  // "sub-category, falling back to category", so a category-only product
  // belongs to the same group as its sub-categorised siblings. Matching on one
  // column alone counted a different set than the All Products table and the
  // two views disagreed on the denominator.
  const { data: allProducts } = await supabase.from("products").select("id, category, sub_category, status");
  const catalogue = allProducts ?? [];
  const productGroup = product.sub_category?.trim() || product.category?.trim() || null;
  // Numerator / denominator of this product's slice: its own live rows over
  // every live row in the group.
  let myRows = 1;
  let groupRows = 1;
  if (productGroup) {
    const groupProducts = catalogue.filter((p) => groupOfProduct(p) === productGroup);
    const counts = await countGroupRows(groupProducts, from, to, mode);
    const activeCount = groupProducts.filter((p) => isActiveStatus(p.status)).length;
    const live = groupProducts.filter((p) => activeCount === 0 || isActiveStatus(p.status));
    const liveTotal = live.reduce((n, p) => n + (counts.get(p.id) ?? 0), 0);
    if (liveTotal > 0) {
      groupRows = liveTotal;
      myRows = activeCount === 0 || isActiveStatus(product.status) ? counts.get(productId) ?? 0 : 0;
    } else {
      // Nothing live in the group: fall back to one row each, so the spend is
      // still spread rather than lost - the same fallback the table applies.
      groupRows = groupProducts.length > 0 ? groupProducts.length : 1;
      myRows = 1;
    }
  }

  // Per day in the database, on exactly per_product_stats' basis: gross money
  // includes cancelled orders (the delivery rate already counts them - see
  // migration 0079), while volume counts only orders still standing.
  const { data: dailyRows, error: dailyErr } = await supabase.rpc("per_product_daily_stats", {
    p_product_id: productId,
    p_mode: mode,
    p_from: from,
    p_to: to,
  });
  if (dailyErr) throw new Error(`per_product_daily_stats failed: ${dailyErr.message}`);

  // Gross = the all-orders (100%-delivered) basis, scaled to expected below.
  const byDate = new Map<string, { volume: number; grossRevenue: number; grossCogs: number }>();
  for (const r of (dailyRows ?? []) as { day: string; items_sold: number; revenue: number; cogs: number }[]) {
    byDate.set(r.day, { volume: Number(r.items_sold), grossRevenue: Number(r.revenue), grossCogs: Number(r.cogs) });
  }

  const chatByDate = await getChatOrderProductDailyTotals(productId, from, to);

  // Ad spend, split exactly as the All Products table splits it: the
  // sub-category's own spend goes to its SKUs, and general/brand spend - which
  // promotes no single one - is spread across those that actually sold here.
  const adByDate = new Map<string, number>();
  if (productGroup) {
    // Retail only, matching the All Products table above.
    const adRows = await fetchAllRows<{
      sub_categories: string[] | null;
      categories: string[] | null;
      spend: number;
      date: string;
      is_general: boolean;
    }>(
      supabase,
      "ad_spend",
      "id, sub_categories, categories, spend, date, is_general",
      (query) => query.gte("date", from).lte("date", to).eq("segment", REPORTED_AD_SEGMENT)
    );
    // Same category expansion the All Products table uses, so a campaign pinned
    // to a whole category reaches this product's daily row too.
    const dailyCategoryGroups = groupsByCategory(catalogue);
    const generalByDate = new Map<string, number>();
    for (const r of adRows) {
      if (r.is_general) {
        generalByDate.set(r.date, (generalByDate.get(r.date) ?? 0) + Number(r.spend));
        continue;
      }
      const labels = allocationGroups(r, dailyCategoryGroups);
      if (!labels.includes(productGroup)) continue;
      // Shared equally with the campaign's other sub-categories, same as above.
      adByDate.set(r.date, (adByDate.get(r.date) ?? 0) + Number(r.spend) / labels.length);
    }

    if (generalByDate.size > 0) {
      const { sellingGroupCount, thisGroupSold } = await getSellingGroupSplit(productGroup, from, to, mode);
      if (thisGroupSold && sellingGroupCount > 0) {
        for (const [date, spend] of generalByDate) {
          adByDate.set(date, (adByDate.get(date) ?? 0) + spend / sellingGroupCount);
        }
      }
    }
  }

  const today = egyptToday();
  const rows: ProductDailyRow[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    // Open day shown as zero (same rule as the Income Statement).
    if (d === today) {
      rows.push({ date: d, volume: 0, expectedVolume: 0, revenue: 0, cogs: 0, grossProfit: 0, adSpend: 0, contributionProfit: 0 });
      continue;
    }
    const rc = byDate.get(d) ?? { volume: 0, grossRevenue: 0, grossCogs: 0 };
    const chat = chatByDate.get(d) ?? { orders: 0, items: 0, revenue: 0, cogs: 0 };
    const revenue = rc.grossRevenue * deliveryRate + chat.revenue;
    const cogs = rc.grossCogs * deliveryRate + chat.cogs;
    const grossProfit = revenue - cogs;
    const adSpend = (adByDate.get(d) ?? 0) * (myRows / groupRows);
    rows.push({
      date: d,
      volume: rc.volume + chat.items,
      expectedVolume: rc.volume * deliveryRate + chat.items,
      revenue,
      cogs,
      grossProfit,
      adSpend,
      contributionProfit: grossProfit - adSpend,
    });
  }
  return { rows, deliveryRate, rateSourceMonth };
}

// How many sub-categories actually sold in [from, to], and whether `group` is
// one of them - the denominator the All Products table uses to spread
// general/brand ad spend. Groups with no sales are excluded there, so charging
// one here would leave the Rollforward's marketing line short of that table's.
async function getSellingGroupSplit(
  group: string,
  from: string,
  to: string,
  mode: PerProductMode
): Promise<{ sellingGroupCount: number; thisGroupSold: boolean }> {
  const { data: statRows, error } = await supabase.rpc("per_product_stats", { p_mode: mode, p_from: from, p_to: to });
  if (error) throw new Error(`per_product_stats failed: ${error.message}`);

  const soldProductIds = new Set<number>();
  for (const r of (statRows ?? []) as { product_id: number; items_sold: number }[]) {
    if (Number(r.items_sold) > 0) soldProductIds.add(Number(r.product_id));
  }
  if (soldProductIds.size === 0) return { sellingGroupCount: 0, thisGroupSold: false };

  const { data: products, error: prodErr } = await supabase.from("products").select("id, category, sub_category");
  if (prodErr) throw new Error(`Failed to load products: ${prodErr.message}`);

  const sellingGroups = new Set<string>();
  for (const p of products ?? []) {
    if (!soldProductIds.has(p.id)) continue;
    const key = p.sub_category?.trim() || p.category?.trim();
    if (key) sellingGroups.add(key);
  }
  return { sellingGroupCount: sellingGroups.size, thisGroupSold: sellingGroups.has(group) };
}
