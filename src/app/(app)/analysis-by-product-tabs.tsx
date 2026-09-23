"use client";

import { Fragment, useState } from "react";
import { egyptToday, addDays } from "@/lib/dates";
import type { ModelRow, OpenMonthInfo, ProductOption, ProductDailyRow } from "@/lib/reports/per-product";

// Subtotal for any set of product rows - one definition shared by the
// sub-category, category and grand totals so the three can never drift.
function sumProducts(
  products: {
    ordersPlaced: number;
    expectedDelivered: number;
    revenue: number;
    cogs: number;
    grossProfit: number;
    adSpend: number;
    contributionProfit: number;
  }[]
) {
  return products.reduce(
    (t, p) => ({
      ordersPlaced: t.ordersPlaced + p.ordersPlaced,
      expectedDelivered: t.expectedDelivered + p.expectedDelivered,
      revenue: t.revenue + p.revenue,
      cogs: t.cogs + p.cogs,
      grossProfit: t.grossProfit + p.grossProfit,
      adSpend: t.adSpend + p.adSpend,
      contributionProfit: t.contributionProfit + p.contributionProfit,
    }),
    { ordersPlaced: 0, expectedDelivered: 0, revenue: 0, cogs: 0, grossProfit: 0, adSpend: 0, contributionProfit: 0 }
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function fmtMonth(d: string): string {
  const date = new Date(d + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function fmtMonthShort(d: string): string {
  const date = new Date(d + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

function fmtDay(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", timeZone: "UTC" });
}

const ROLLFORWARD_WINDOW = 7;

// A zeroed 7-day window ending at endDate - lets the Rollforward table render
// its structure before any product is picked (and while a fetch is in flight),
// so selecting a product just fills in the numbers.
function emptyWindow(endDate: string): ProductDailyRow[] {
  const rows: ProductDailyRow[] = [];
  for (let i = ROLLFORWARD_WINDOW - 1; i >= 0; i--) {
    rows.push({ date: addDays(endDate, -i), volume: 0, expectedVolume: 0, revenue: 0, cogs: 0, grossProfit: 0, adSpend: 0, contributionProfit: 0 });
  }
  return rows;
}

type KeyRatioRow = {
  id: string; // "<productId>:<variantId>" - a product can span several variant rows
  name: string;
  aRoas: number;
  aBeRoas: number;
  aCpa: number;
  mRoas: number;
  mBeRoas: number;
  mCpa: number;
  aCpaLimit: number;
  mCpaLimit: number;
  aFixedCost: number;
  mFixedCost: number;
};

export function AnalysisByProductTabs({
  performance,
  performanceOpenMonthInfo,
  productOptions,
  fixedCostPerItem,
  fixedCostTotal,
}: {
  performance: ModelRow[];
  performanceOpenMonthInfo: OpenMonthInfo | null;
  productOptions: ProductOption[];
  fixedCostPerItem: number;
  fixedCostTotal: number;
}) {
  const active = "performance" as const;
  // Two views: "all" (every model broken down by color) and "rollforward"
  // (a 7-day breakdown for one typed-in product).
  const [view, setView] = useState<"all" | "rollforward">("all");
  // Models start collapsed - the subtotal rows alone are the summary view, and
  // the products/variants under them are opened on demand. Shared by the
  // products table and the ratio tables so both stay in step.
  const [openModels, setOpenModels] = useState<Set<string>>(new Set());
  const isModelOpen = (modelName: string) => openModels.has(modelName);
  function toggleModel(modelName: string) {
    setOpenModels((prev) => {
      const next = new Set(prev);
      if (!next.delete(modelName)) next.add(modelName);
      return next;
    });
  }
  // The level above: Category > Sub-category > Products. Its own set, so
  // collapsing a category doesn't forget which sub-categories were open inside it.
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());
  const isCategoryOpen = (category: string) => openCategories.has(category);
  function toggleCategory(category: string) {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (!next.delete(category)) next.add(category);
      return next;
    });
  }
  const models = performance;
  const openMonthInfo = performanceOpenMonthInfo;
  const missingCostModels = models.filter((m) => m.costMissing);

  // One combined table: every product that SOLD items or carries marketing
  // spend. Ord. = expected delivered (all orders x delivery rate) / all orders,
  // like the daily Income Statement.
  const allProducts = models
    .flatMap((m) =>
      m.colors.map((c) => ({
        ...c,
        modelName: m.name,
        category: m.category?.trim() || "(uncategorised)",
        expectedDelivered: Math.round(c.ordersPlaced * c.deliveryRate),
        // Rounded to whole items so the fixed cost charged matches the item
        // count shown on the row. The per-item rate below divides by the sum of
        // these same rounded counts, so the allocation still ties back to the
        // fixed-cost pool.
        expectedItems: Math.round(c.itemsSold * c.deliveryRate),
      }))
    )
    // Sold OR carrying marketing. A product with spend and no sales is the most
    // important row on the page, and dropping it also dropped its share of the
    // model's spend - so the table's marketing total came out short of what was
    // actually spent.
    // Revenue too: a product whose only orders in range were cancelled still
    // carries their expected money (see migration 0079), and hiding the row
    // would drop it from the table's totals.
    .filter((p) => p.itemsSold > 0 || p.adSpend > 0 || p.revenue !== 0)
    .sort((a, b) => b.grossProfit - a.grossProfit);
  // A product broken into variants yields several rows sharing one productId,
  // so the row key has to carry the variant too.
  const rowKey = (p: (typeof allProducts)[number]) => `${p.productId}:${p.variantId ?? "-"}`;

  type Product = (typeof allProducts)[number];
  // Category > Sub-category > Products. Categories and sub-categories are each
  // ordered by contribution profit, like the products inside them.
  //
  // `flat` marks a category whose only sub-category is named after the category
  // itself - true for 7 of the 8 today (سبح, ماء زمزم, ...), where products
  // carry no real sub-category. Rendering the middle level there would just
  // repeat the heading and cost a second click for nothing, so those categories
  // open straight onto their products.
  const groupedByCategory = (() => {
    const byCategory = new Map<string, Map<string, Product[]>>();
    for (const p of allProducts) {
      const category = p.category?.trim() || "(uncategorised)";
      const group = p.modelName?.trim() || "(no sub-category)";
      const groups = byCategory.get(category) ?? new Map<string, Product[]>();
      groups.set(group, [...(groups.get(group) ?? []), p]);
      byCategory.set(category, groups);
    }
    return [...byCategory.entries()]
      .map(([category, groups]) => {
        const subGroups = [...groups.entries()]
          .map(([modelName, products]) => ({
            modelName,
            products: [...products].sort((a, b) => b.contributionProfit - a.contributionProfit),
            subtotal: sumProducts(products),
          }))
          .sort((a, b) => b.subtotal.contributionProfit - a.subtotal.contributionProfit);
        const products = subGroups.flatMap((g) => g.products);
        return {
          category,
          subGroups,
          flat: subGroups.length === 1 && subGroups[0].modelName === category,
          productCount: products.length,
          products: [...products].sort((a, b) => b.contributionProfit - a.contributionProfit),
          subtotal: sumProducts(products),
        };
      })
      .sort((a, b) => b.subtotal.contributionProfit - a.subtotal.contributionProfit);
  })();
  // Inside a model the model name is already the group heading, so the row
  // shows just the product (and variant) name.
  const productLabel = (p: Product) => p.name;
  const totals = allProducts.reduce(
    (t, p) => ({
      ordersPlaced: t.ordersPlaced + p.ordersPlaced,
      expectedDelivered: t.expectedDelivered + p.expectedDelivered,
      revenue: t.revenue + p.revenue,
      cogs: t.cogs + p.cogs,
      grossProfit: t.grossProfit + p.grossProfit,
      adSpend: t.adSpend + p.adSpend,
      contributionProfit: t.contributionProfit + p.contributionProfit,
    }),
    { ordersPlaced: 0, expectedDelivered: 0, revenue: 0, cogs: 0, grossProfit: 0, adSpend: 0, contributionProfit: 0 }
  );

  // Key Ratios: only products that carry marketing spend. Same formulas as the
  // Income Statement's Actual ratios, per product.
  const keyRatioProducts = allProducts.filter((p) => p.adSpend > 0);
  const safe = (num: number, den: number) => (den ? num / den : 0);

  // Fixed cost is allocated on each section's OWN item base, so each section
  // spreads the whole fixed-cost pool without over- or under-allocating:
  //   Actual  - pool / expected-delivered items, x this product's expected items
  //   Meta    - pool / all items sold,           x this product's items sold
  // The Meta rate is the P&L's fixed cost/item; the Actual rate is higher, since
  // the same pool is spread over the smaller delivered-item base.
  const totalExpectedItems = allProducts.reduce((s, p) => s + p.expectedItems, 0);
  const fixedCostPerExpectedItem = totalExpectedItems ? fixedCostTotal / totalExpectedItems : 0;

  // Compute each product's ratios once, shared by the desktop combined table and
  // the two stacked mobile tables. Actual uses expected-delivered
  // revenue/orders/items; Meta Dashboard uses all-orders (100% delivery) gross
  // revenue and placed orders/items.
  // Shared by the per-product rows AND the per-model subtotal rows. A model's
  // ratios are recomputed from its SUMMED figures - averaging its products'
  // ratios would be wrong (a ratio of sums is not the sum of ratios).
  type RatioInput = Pick<
    Product,
    "revenue" | "cogs" | "grossRevenue" | "grossCogs" | "adSpend" | "expectedDelivered" | "ordersPlaced" | "expectedItems" | "itemsSold"
  >;
  const makeRatioRow = (id: string, name: string, p: RatioInput): KeyRatioRow => {
    const mkt = p.adSpend;
    const aFixedCost = fixedCostPerExpectedItem * p.expectedItems;
    const mFixedCost = fixedCostPerItem * p.itemsSold;
    return {
      id,
      name,
      aRoas: safe(p.revenue, mkt),
      // Break-Even ROAS = (COGS + Marketing + Fixed) / Marketing - the ROAS at
      // which this product's revenue exactly covers its costs, so a ROAS above
      // the line is profitable. Actual takes the delivered-basis COGS, Meta
      // Dashboard takes grossCogs to match its 100%-delivered revenue; each
      // uses its own section's fixed-cost share.
      aBeRoas: safe(p.cogs + mkt + aFixedCost, mkt),
      aCpa: safe(mkt, p.expectedDelivered),
      mRoas: safe(p.grossRevenue, mkt),
      mBeRoas: safe(p.grossCogs + mkt + mFixedCost, mkt),
      mCpa: safe(mkt, p.ordersPlaced),
      // CPA Limit = the most payable per order at break-even, on each section's
      // own basis: (revenue - COGS - fixed) / orders.
      aCpaLimit: safe(p.revenue - p.cogs - aFixedCost, p.expectedDelivered),
      mCpaLimit: safe(p.grossRevenue - p.grossCogs - mFixedCost, p.ordersPlaced),
      aFixedCost,
      mFixedCost,
    };
  };

  // A group's ratios are recomputed from its SUMMED figures - averaging its
  // products' ratios would be wrong, since a ratio of sums is not the sum of
  // ratios. Same reduction at both the sub-category and the category level.
  const aggRatio = (products: RatioInput[]): RatioInput =>
    products.reduce<RatioInput>(
      (t, p) => ({
        revenue: t.revenue + p.revenue,
        cogs: t.cogs + p.cogs,
        grossRevenue: t.grossRevenue + p.grossRevenue,
        grossCogs: t.grossCogs + p.grossCogs,
        adSpend: t.adSpend + p.adSpend,
        expectedDelivered: t.expectedDelivered + p.expectedDelivered,
        ordersPlaced: t.ordersPlaced + p.ordersPlaced,
        expectedItems: t.expectedItems + p.expectedItems,
        itemsSold: t.itemsSold + p.itemsSold,
      }),
      { revenue: 0, cogs: 0, grossRevenue: 0, grossCogs: 0, adSpend: 0, expectedDelivered: 0, ordersPlaced: 0, expectedItems: 0, itemsSold: 0 }
    );

  // The same Category > Sub-category > Products tree as the products table,
  // restricted to products carrying marketing spend. A category or sub-category
  // with no such product drops out entirely rather than showing an empty row.
  const ratioCategories = groupedByCategory
    .map((cat) => {
      const subGroups = cat.subGroups
        .map((group) => {
          const products = group.products.filter((p) => p.adSpend > 0);
          if (products.length === 0) return null;
          return {
            modelName: group.modelName,
            subtotal: makeRatioRow(`model:${group.modelName}`, group.modelName, aggRatio(products)),
            rows: products.map((p) => makeRatioRow(rowKey(p), productLabel(p), p)),
          };
        })
        .filter((g): g is NonNullable<typeof g> => g !== null);
      const products = cat.products.filter((p) => p.adSpend > 0);
      if (products.length === 0) return null;
      return {
        category: cat.category,
        flat: cat.flat,
        subGroups,
        rows: products.map((p) => makeRatioRow(rowKey(p), productLabel(p), p)),
        rowCount: products.length,
        subtotal: makeRatioRow(`cat:${cat.category}`, cat.category, aggRatio(products)),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-400">Every Shopify order, whether or not it has shipped yet.</div>

      <div className="inline-flex rounded-md border border-gray-300 p-0.5">
        {([
          ["all", "All Products"],
          ["rollforward", "Rollforward"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={`rounded px-3 py-1 text-sm font-medium ${
              view === key ? "bg-gray-900 text-white" : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "rollforward" ? (
        <Rollforward key={active} productOptions={productOptions} mode={active} />
      ) : (
        <>
          {openMonthInfo && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {fmtMonth(openMonthInfo.month)} is still settling - revenue and COGS for that month are projected using each
              SKU&apos;s own last-mature-month delivery rate (see the Rate column below), not yet real per-order outcomes.
            </div>
          )}

          {missingCostModels.length > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              <strong>Missing unit cost — profit is overstated for these models:</strong>{" "}
              {missingCostModels.map((m) => m.name).join(", ")}
            </div>
          )}

          {/* One combined table for every product that sold items. Unreadable
              below sm (10 fixed-width columns), so mobile gets a card each. */}
          <div className="hidden rounded-lg border border-gray-200 bg-white sm:block">
            <table className="w-full table-fixed text-xs">
              <thead className="text-left text-[10px] font-medium uppercase text-gray-400">
                <tr>
                  <th className="w-[24%] py-2 pl-4">Product</th>
                  <th className="w-[8%] py-2">Ord.</th>
                  <th className="w-[10%] py-2">Rate</th>
                  <th className="w-[9%] py-2">Rev</th>
                  <th className="w-[9%] py-2">COGS</th>
                  <th className="w-[8%] py-2">GP</th>
                  <th className="w-[7%] py-2">GPM%</th>
                  <th className="w-[8%] py-2">Mark</th>
                  <th className="w-[8%] py-2">NP</th>
                  <th className="w-[9%] py-2">NPM%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {groupedByCategory.map((cat) => (
                  <Fragment key={cat.category}>
                    <GroupRow
                      label={cat.category}
                      count={cat.productCount}
                      open={isCategoryOpen(cat.category)}
                      onToggle={() => toggleCategory(cat.category)}
                      subtotal={cat.subtotal}
                      level="category"
                    />
                    {isCategoryOpen(cat.category) &&
                      (cat.flat
                        ? // Its only sub-category is the category itself, so the
                          // products hang straight off the category row.
                          cat.products.map((p) => (
                            <ProductRow key={rowKey(p)} label={productLabel(p)} product={p} indent="pl-8" />
                          ))
                        : cat.subGroups.map((group) => (
                            <Fragment key={group.modelName}>
                              <GroupRow
                                label={group.modelName}
                                count={group.products.length}
                                open={isModelOpen(group.modelName)}
                                onToggle={() => toggleModel(group.modelName)}
                                subtotal={group.subtotal}
                                level="sub"
                              />
                              {isModelOpen(group.modelName) &&
                                group.products.map((p) => (
                                  <ProductRow key={rowKey(p)} label={productLabel(p)} product={p} indent="pl-12" />
                                ))}
                            </Fragment>
                          )))}
                  </Fragment>
                ))}
                {allProducts.length === 0 && (
                  <tr>
                    <td colSpan={10} className="py-3 pl-4 text-gray-400">
                      No products with sales or marketing spend in this range.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-gray-900">
                  <td className="py-1.5 pl-4">Total</td>
                  <td className="py-1.5">
                    {totals.expectedDelivered}/{totals.ordersPlaced}
                  </td>
                  <td className="py-1.5 text-gray-400">—</td>
                  <td className="py-1.5">{fmt(totals.revenue)}</td>
                  <td className="py-1.5">{fmt(totals.cogs)}</td>
                  <td className={`py-1.5 ${totals.grossProfit >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(totals.grossProfit)}</td>
                  <td className="py-1.5">{pct(totals.grossProfit, totals.revenue)}</td>
                  <td className="py-1.5">{fmt(totals.adSpend)}</td>
                  <td className={`py-1.5 ${totals.contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                    {fmt(totals.contributionProfit)}
                  </td>
                  <td className="py-1.5">{pct(totals.contributionProfit, totals.revenue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white sm:hidden">
            {groupedByCategory.map((cat) => {
              const cards = (products: typeof cat.products) =>
                products.map((p) => (
                  <MobileProductCard
                    key={rowKey(p)}
                    name={productLabel(p)}
                    ordersResolved={p.expectedDelivered}
                    ordersPlaced={p.ordersPlaced}
                    rateLabel={
                      p.openMonthRate === null
                        ? null
                        : `${(p.openMonthRate * 100).toFixed(0)}%${
                            p.openMonthRateSourceMonth ? ` (${fmtMonthShort(p.openMonthRateSourceMonth)})` : ""
                          }`
                    }
                    revenue={p.revenue}
                    cogs={p.cogs}
                    grossProfit={p.grossProfit}
                    adSpend={p.adSpend}
                    contributionProfit={p.contributionProfit}
                  />
                ));
              return (
                <Fragment key={cat.category}>
                  <MobileGroupButton
                    label={cat.category}
                    count={cat.productCount}
                    open={isCategoryOpen(cat.category)}
                    onToggle={() => toggleCategory(cat.category)}
                    contributionProfit={cat.subtotal.contributionProfit}
                    level="category"
                  />
                  {isCategoryOpen(cat.category) &&
                    (cat.flat
                      ? cards(cat.products)
                      : cat.subGroups.map((group) => (
                          <Fragment key={group.modelName}>
                            <MobileGroupButton
                              label={group.modelName}
                              count={group.products.length}
                              open={isModelOpen(group.modelName)}
                              onToggle={() => toggleModel(group.modelName)}
                              contributionProfit={group.subtotal.contributionProfit}
                              level="sub"
                            />
                            {isModelOpen(group.modelName) && cards(group.products)}
                          </Fragment>
                        )))}
                </Fragment>
              );
            })}
            <MobileProductCard
              name="Total"
              bold
              ordersResolved={totals.expectedDelivered}
              ordersPlaced={totals.ordersPlaced}
              rateLabel={null}
              revenue={totals.revenue}
              cogs={totals.cogs}
              grossProfit={totals.grossProfit}
              adSpend={totals.adSpend}
              contributionProfit={totals.contributionProfit}
            />
          </div>

          {keyRatioProducts.length > 0 && (
            <div>
              <h3 className="mb-2 mt-2 text-sm font-semibold text-gray-900">Key Ratios</h3>
              <p className="mb-2 text-xs text-gray-400">
                Only products with marketing spend. Same calculation as the Income Statement&apos;s Actual ratios.
              </p>
              {/* Desktop: Actual + Meta Dashboard side by side. */}
              <div className="hidden overflow-hidden rounded-lg border border-gray-200 bg-white sm:block">
                <table className="w-full table-fixed text-[11px]">
                  <thead>
                    <tr className="border-b border-gray-100 text-[10px] font-semibold uppercase text-gray-500">
                      <th className="w-[20%] py-2 pl-3 text-left" />
                      <th className="border-l border-gray-200 py-2 text-center" colSpan={5}>
                        Actual Ratios
                      </th>
                      <th className="border-l border-gray-200 py-2 text-center" colSpan={5}>
                        Meta Dashboard Ratios
                      </th>
                    </tr>
                    <tr className="text-[10px] font-medium uppercase text-gray-400">
                      <th className="py-1.5 pl-3 text-left">Product</th>
                      <th className="border-l border-gray-200 py-1.5 text-right">ROAS</th>
                      <th className="py-1.5 text-right">BE ROAS</th>
                      <th className="py-1.5 text-right">CPA</th>
                      <th className="py-1.5 text-right">CPA Lim</th>
                      <th className="py-1.5 text-right">Fixed Cost</th>
                      <th className="border-l border-gray-200 py-1.5 text-right">ROAS</th>
                      <th className="py-1.5 text-right">BE ROAS</th>
                      <th className="py-1.5 text-right">CPA</th>
                      <th className="py-1.5 text-right">CPA Lim</th>
                      <th className="py-1.5 pr-3 text-right">Fixed Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {ratioCategories.map((cat) => (
                      <Fragment key={cat.category}>
                        <RatioGroupRow
                          label={cat.category}
                          count={cat.rowCount}
                          open={isCategoryOpen(cat.category)}
                          onToggle={() => toggleCategory(cat.category)}
                          subtotal={cat.subtotal}
                          level="category"
                        />
                        {isCategoryOpen(cat.category) &&
                          (cat.flat
                            ? cat.rows.map((r) => <RatioProductRow key={r.id} row={r} indent="pl-8" />)
                            : cat.subGroups.map((group) => (
                                <Fragment key={group.modelName}>
                                  <RatioGroupRow
                                    label={group.modelName}
                                    count={group.rows.length}
                                    open={isModelOpen(group.modelName)}
                                    onToggle={() => toggleModel(group.modelName)}
                                    subtotal={group.subtotal}
                                    level="sub"
                                  />
                                  {isModelOpen(group.modelName) &&
                                    group.rows.map((r) => <RatioProductRow key={r.id} row={r} indent="pl-12" />)}
                                </Fragment>
                              )))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: two stacked tables - Actual Ratios, then Meta Dashboard. */}
              <div className="space-y-3 sm:hidden">
                <MobileRatioTable
                  title="Actual Ratios"
                  categories={ratioCategories}
                  section="actual"
                  isModelOpen={isModelOpen}
                  toggleModel={toggleModel}
                  isCategoryOpen={isCategoryOpen}
                  toggleCategory={toggleCategory}
                />
                <MobileRatioTable
                  title="Meta Dashboard Ratios"
                  categories={ratioCategories}
                  section="meta"
                  isModelOpen={isModelOpen}
                  toggleModel={toggleModel}
                  isCategoryOpen={isCategoryOpen}
                  toggleCategory={toggleCategory}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// The ten ratio cells, shared by the heading rows and the product rows so the
// two can only differ in indent and weight.
function RatioCells({ row }: { row: KeyRatioRow }) {
  return (
    <>
      <td className="border-l border-gray-200 py-1.5 text-right">{row.aRoas.toFixed(2)}</td>
      <td className="py-1.5 text-right">{row.aBeRoas.toFixed(2)}</td>
      <td className="py-1.5 text-right">{fmt(row.aCpa)}</td>
      <td className="py-1.5 text-right">{fmt(row.aCpaLimit)}</td>
      <td className="py-1.5 text-right">{fmt(row.aFixedCost)}</td>
      <td className="border-l border-gray-200 py-1.5 text-right">{row.mRoas.toFixed(2)}</td>
      <td className="py-1.5 text-right">{row.mBeRoas.toFixed(2)}</td>
      <td className="py-1.5 text-right">{fmt(row.mCpa)}</td>
      <td className="py-1.5 text-right">{fmt(row.mCpaLimit)}</td>
      <td className="py-1.5 pr-3 text-right">{fmt(row.mFixedCost)}</td>
    </>
  );
}

// Key Ratios equivalent of GroupRow - a collapsible category or sub-category
// heading, carrying that group's ratios recomputed from its summed figures.
function RatioGroupRow({
  label,
  count,
  open,
  onToggle,
  subtotal,
  level,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  subtotal: KeyRatioRow;
  level: "category" | "sub";
}) {
  const isCategory = level === "category";
  return (
    <tr
      className={`cursor-pointer font-semibold text-gray-900 ${
        isCategory ? "bg-gray-100 hover:bg-gray-200" : "bg-gray-50 hover:bg-gray-100"
      }`}
      onClick={onToggle}
    >
      <td className={`py-1.5 ${isCategory ? "pl-3" : "pl-6"}`}>
        <span className="mr-1.5 text-[9px] text-gray-400">{open ? "▼" : "▶"}</span>
        <span dir="auto">{label}</span>
        <span className="ml-1.5 text-[10px] font-normal text-gray-400">({count})</span>
      </td>
      <RatioCells row={subtotal} />
    </tr>
  );
}

function RatioProductRow({ row, indent }: { row: KeyRatioRow; indent: string }) {
  return (
    <tr className="text-gray-700">
      <td className={`py-1.5 ${indent}`} dir="auto">
        {row.name}
      </td>
      <RatioCells row={row} />
    </tr>
  );
}

type Subtotal = ReturnType<typeof sumProducts>;

// Mobile equivalent of GroupRow: the collapsible heading above a set of product
// cards, at either level.
function MobileGroupButton({
  label,
  count,
  open,
  onToggle,
  contributionProfit,
  level,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  contributionProfit: number;
  level: "category" | "sub";
}) {
  const isCategory = level === "category";
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex w-full items-baseline justify-between px-3 py-1.5 text-left ${
        isCategory ? "bg-gray-100" : "bg-gray-50 pl-6"
      }`}
    >
      <span className="text-xs font-semibold text-gray-900">
        <span className="mr-1.5 text-[9px] text-gray-400">{open ? "▼" : "▶"}</span>
        <span dir="auto">{label}</span>
        <span className="ml-1.5 text-[10px] font-normal text-gray-400">({count})</span>
      </span>
      <span className={`text-xs font-semibold ${contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
        {fmt(contributionProfit)}
      </span>
    </button>
  );
}

// A collapsible heading row in the products table. Category and sub-category
// share one definition so the two levels can only ever differ by weight and
// indent, never by which figures they show or how they compute them.
function GroupRow({
  label,
  count,
  open,
  onToggle,
  subtotal,
  level,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  subtotal: Subtotal;
  level: "category" | "sub";
}) {
  const isCategory = level === "category";
  return (
    <tr
      className={`cursor-pointer text-gray-900 ${
        isCategory ? "bg-gray-100 hover:bg-gray-200" : "bg-gray-50 hover:bg-gray-100"
      }`}
      onClick={onToggle}
    >
      <td className={`py-1.5 font-semibold ${isCategory ? "pl-3" : "pl-6"}`}>
        <span className="mr-1.5 text-[9px] text-gray-400">{open ? "▼" : "▶"}</span>
        <span dir="auto">{label}</span>
        <span className="ml-1.5 text-[10px] font-normal text-gray-400">({count})</span>
      </td>
      <td className="py-1.5 font-semibold">
        {subtotal.expectedDelivered}/{subtotal.ordersPlaced}
      </td>
      <td className="py-1.5 text-gray-400">—</td>
      <td className="py-1.5 font-semibold">{fmt(subtotal.revenue)}</td>
      <td className="py-1.5 font-semibold">{fmt(subtotal.cogs)}</td>
      <td className={`py-1.5 font-semibold ${subtotal.grossProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
        {fmt(subtotal.grossProfit)}
      </td>
      <td className="py-1.5 font-semibold">{pct(subtotal.grossProfit, subtotal.revenue)}</td>
      <td className="py-1.5 font-semibold">{fmt(subtotal.adSpend)}</td>
      <td className={`py-1.5 font-semibold ${subtotal.contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
        {fmt(subtotal.contributionProfit)}
      </td>
      <td className="py-1.5 font-semibold">{pct(subtotal.contributionProfit, subtotal.revenue)}</td>
    </tr>
  );
}

// One product (or one variant of a multi-variant product). `indent` is the only
// thing that changes between a product under a category and one under a
// sub-category.
function ProductRow({
  label,
  product,
  indent,
}: {
  label: string;
  product: {
    expectedDelivered: number;
    ordersPlaced: number;
    openMonthRate: number | null;
    openMonthRateSourceMonth: string | null;
    revenue: number;
    cogs: number;
    grossProfit: number;
    adSpend: number;
    contributionProfit: number;
  };
  indent: string;
}) {
  return (
    <tr className="text-gray-700">
      <td className={`py-1.5 ${indent}`} dir="auto">
        {label}
      </td>
      <td className="py-1.5">
        {product.expectedDelivered}/{product.ordersPlaced}
      </td>
      <td className="py-1.5 text-gray-500">
        {product.openMonthRate === null
          ? "—"
          : `${(product.openMonthRate * 100).toFixed(0)}%${
              product.openMonthRateSourceMonth ? ` (${fmtMonthShort(product.openMonthRateSourceMonth)})` : ""
            }`}
      </td>
      <td className="py-1.5">{fmt(product.revenue)}</td>
      <td className="py-1.5">{fmt(product.cogs)}</td>
      <td className={`py-1.5 ${product.grossProfit >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(product.grossProfit)}</td>
      <td className="py-1.5">{pct(product.grossProfit, product.revenue)}</td>
      <td className="py-1.5">{fmt(product.adSpend)}</td>
      <td className={`py-1.5 ${product.contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
        {fmt(product.contributionProfit)}
      </td>
      <td className="py-1.5">{pct(product.contributionProfit, product.revenue)}</td>
    </tr>
  );
}

// Rollforward: type a product, pick it from the dropdown, and see a fixed
// 7-date-column breakdown (◀▶ shifts the window a day at a time, like the
// Income Statement). Data is fetched per product+window from
// /api/product-rollforward, in the active Performance/Actual mode.
function Rollforward({ productOptions, mode }: { productOptions: ProductOption[]; mode: "performance" | "actual" }) {
  const today = egyptToday();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ProductOption | null>(null);
  // Default to yesterday - today's data is still incomplete.
  const [endDate, setEndDate] = useState<string>(addDays(today, -1));
  const [rows, setRows] = useState<ProductDailyRow[] | null>(null);
  // The chosen product's own delivery rate (null until a product is picked), so
  // the Total Volume line can haircut by THIS product's rate, not a flat 50%.
  const [deliveryRate, setDeliveryRate] = useState<number | null>(null);
  const [rateSourceMonth, setRateSourceMonth] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Match on name or SKU, so you can find a product by its SKU when the name
  // doesn't ring a bell.
  const q = query.trim().toLowerCase();
  const matches = q
    ? productOptions
        .filter((o) => o.label.toLowerCase().includes(q) || (o.sku?.toLowerCase().includes(q) ?? false))
        .slice(0, 12)
    : [];

  async function fetchRows(productId: number, to: string, m: "performance" | "actual") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/product-rollforward?productId=${productId}&to=${to}&mode=${m}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to load");
      setRows(data.rows as ProductDailyRow[]);
      setDeliveryRate(typeof data.deliveryRate === "number" ? data.deliveryRate : null);
      setRateSourceMonth(typeof data.rateSourceMonth === "string" ? data.rateSourceMonth : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setRows(null);
    } finally {
      setBusy(false);
    }
  }

  function selectProduct(o: ProductOption) {
    setSelected(o);
    setQuery(o.label);
    setOpen(false);
    fetchRows(o.id, endDate, mode);
  }

  function shift(delta: number) {
    const next = addDays(endDate, delta);
    if (next > today) return; // don't page into the future
    setEndDate(next);
    if (selected) fetchRows(selected.id, next, mode);
  }

  // Keep whatever rows are already loaded on screen until the next fetch
  // returns (the "Updating…" hint covers the in-flight gap), so shifting the
  // window doesn't blank the table to zeros and back. Only before the first
  // product is picked do we fall back to the zeroed window.
  const displayRows = rows ?? emptyWindow(endDate);

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <label className="block text-xs font-medium text-gray-500">Product</label>
        <input
          type="text"
          value={query}
          placeholder="Type a product name or SKU…"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
        />
        {open && matches.length > 0 && (
          <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
            {matches.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectProduct(o);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
                >
                  <span className="truncate">{o.label}</span>
                  {o.sku && <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">SKU {o.sku}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-sm font-semibold ${selected ? "text-gray-900" : "text-gray-400"}`}>
          {selected ? selected.label : "No product selected"}
          {selected?.sku && <span className="ml-1.5 font-normal text-gray-400">(SKU {selected.sku})</span>}
        </span>
        <div className="flex items-center gap-2">
          {busy && <span className="text-xs text-gray-400">Updating…</span>}
          <span className="text-xs text-gray-500">
            {fmtDay(displayRows[0].date)} – {fmtDay(displayRows[displayRows.length - 1].date)}
          </span>
          <button
            type="button"
            onClick={() => shift(-1)}
            className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100"
            aria-label="Earlier day"
          >
            ◀
          </button>
          <button
            type="button"
            disabled={endDate >= today}
            onClick={() => shift(1)}
            className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Later day"
          >
            ▶
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <RollforwardTable rows={displayRows} deliveryRate={deliveryRate} rateSourceMonth={rateSourceMonth} />

      {!selected && <p className="text-xs text-gray-400">Type a product name above to fill in the numbers.</p>}
    </div>
  );
}

function RollforwardTable({
  rows,
  deliveryRate,
  rateSourceMonth,
}: {
  rows: ProductDailyRow[];
  deliveryRate: number | null;
  rateSourceMonth: string | null;
}) {
  const totalVolume = rows.reduce((a, r) => a + r.volume, 0);
  const totalExpectedVolume = rows.reduce((a, r) => a + r.expectedVolume, 0);
  const totalRev = rows.reduce((a, r) => a + r.revenue, 0);
  const totalCogs = rows.reduce((a, r) => a + r.cogs, 0);
  const totalGP = rows.reduce((a, r) => a + r.grossProfit, 0);
  const totalAd = rows.reduce((a, r) => a + r.adSpend, 0);
  const totalCP = rows.reduce((a, r) => a + r.contributionProfit, 0);

  // The chosen product's own delivery rate (its last-mature-month rate). Before
  // a product is picked there's no rate yet, so the haircut line shows a dash.
  const rateLabel =
    deliveryRate === null
      ? "Total Volume (rate)"
      : `Total Volume ${(deliveryRate * 100).toFixed(0)}%${rateSourceMonth ? ` (${fmtMonthShort(rateSourceMonth)})` : ""}`;

  const lines: { label: string; vals: number[]; total: number; pctLine: boolean; profit: boolean; bold?: boolean; small?: boolean }[] = [
    // Total items sold (units if every order delivered) and the same haircut by
    // THIS product's own delivery rate - shown smaller as a reference above Rev.
    // The haircut comes from the server, not `volume x rate`: chat-order items
    // are already 100% delivered and must not be scaled down again.
    { label: "Total Volume 100%", vals: rows.map((r) => r.volume), total: totalVolume, pctLine: false, profit: false, small: true },
    {
      label: rateLabel,
      vals: rows.map((r) => r.expectedVolume),
      total: totalExpectedVolume,
      pctLine: false,
      profit: false,
      small: true,
    },
    { label: "Rev", vals: rows.map((r) => r.revenue), total: totalRev, pctLine: false, profit: false },
    { label: "COGS", vals: rows.map((r) => r.cogs), total: totalCogs, pctLine: false, profit: false },
    { label: "Gross Profit", vals: rows.map((r) => r.grossProfit), total: totalGP, pctLine: false, profit: true, bold: true },
    {
      label: "Gross Margin",
      vals: rows.map((r) => (r.revenue ? (r.grossProfit / r.revenue) * 100 : NaN)),
      total: totalRev ? (totalGP / totalRev) * 100 : NaN,
      pctLine: true,
      profit: false,
    },
    { label: "Marketing Spend", vals: rows.map((r) => r.adSpend), total: totalAd, pctLine: false, profit: false },
    { label: "Contribution Profit", vals: rows.map((r) => r.contributionProfit), total: totalCP, pctLine: false, profit: true, bold: true },
    {
      label: "Contribution Margin",
      vals: rows.map((r) => (r.revenue ? (r.contributionProfit / r.revenue) * 100 : NaN)),
      total: totalRev ? (totalCP / totalRev) * 100 : NaN,
      pctLine: true,
      profit: false,
    },
  ];

  const cellText = (v: number, pctLine: boolean) => (pctLine ? (Number.isNaN(v) ? "—" : `${v.toFixed(1)}%`) : fmt(v));
  const colorCls = (v: number, profit: boolean) => (profit ? (v >= 0 ? "text-green-700" : "text-red-700") : "text-gray-900");

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b-2 border-gray-300 bg-gray-200">
            <th className="px-2 py-2 text-left text-xs font-medium uppercase text-gray-400">Line item</th>
            {rows.map((r) => (
              <th key={r.date} className="px-3 py-2 text-right text-sm font-semibold text-gray-900">
                {fmtDay(r.date)}
              </th>
            ))}
            <th className="border-l-2 border-l-gray-400 px-3 py-2 text-right text-sm font-semibold text-gray-900">Total</th>
            <th className="px-3 py-2 text-right text-sm font-semibold text-gray-900">Avg/day</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            // Money lines: mean per day across the window. Margin (%) lines:
            // averaging daily percentages is meaningless (idle days are blank),
            // so the per-period margin is the only sensible "average".
            const avg = line.pctLine ? line.total : line.total / (rows.length || 1);
            return (
              <tr key={line.label} className={`${line.bold ? "bg-gray-50" : ""}${line.small ? " text-xs" : ""}`}>
                <td className={`px-2 py-1.5 ${line.small ? "text-gray-500" : line.bold ? "font-bold text-gray-900" : "text-gray-700"}`}>
                  {line.label}
                </td>
                {line.vals.map((v, i) => (
                  <td key={i} className={`px-3 py-1.5 text-right ${line.bold ? "font-bold " : ""}${colorCls(v, line.profit)}`}>
                    {cellText(v, line.pctLine)}
                  </td>
                ))}
                <td
                  className={`border-l-2 border-l-gray-400 px-3 py-1.5 text-right ${line.bold ? "font-bold " : ""}${colorCls(
                    line.total,
                    line.profit
                  )}`}
                >
                  {cellText(line.total, line.pctLine)}
                </td>
                <td className={`px-3 py-1.5 text-right ${line.bold ? "font-bold " : ""}${colorCls(avg, line.profit)}`}>
                  {cellText(avg, line.pctLine)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Mobile-only stand-in for one table row - folds GPM%/NPM% into the
// Gross/Net Profit lines instead of giving them their own row, since the
// point is fewer, wider lines rather than the table's ten narrow columns.
function MobileProductCard({
  name,
  bold,
  ordersResolved,
  ordersPlaced,
  rateLabel,
  revenue,
  cogs,
  grossProfit,
  adSpend,
  contributionProfit,
}: {
  name: string;
  bold?: boolean;
  ordersResolved: number;
  ordersPlaced: number;
  rateLabel: string | null;
  revenue: number;
  cogs: number;
  grossProfit: number;
  adSpend: number;
  contributionProfit: number;
}) {
  return (
    <div className={`px-4 py-3 ${bold ? "bg-gray-50" : ""}`}>
      <div className="flex items-center justify-between">
        <span className={`text-sm ${bold ? "font-semibold text-gray-900" : "font-medium text-gray-800"}`}>{name}</span>
        <span className="text-xs text-gray-400">
          {ordersResolved}/{ordersPlaced} orders{rateLabel ? ` · ${rateLabel}` : ""}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-700">
        <MetricCell label="Revenue" value={fmt(revenue)} />
        <MetricCell label="COGS" value={fmt(cogs)} />
        <MetricCell
          label="Gross Profit"
          value={`${fmt(grossProfit)} (${pct(grossProfit, revenue)})`}
          valueClassName={grossProfit >= 0 ? "text-green-700" : "text-red-700"}
        />
        <MetricCell label="Marketing" value={fmt(adSpend)} />
        <div className="col-span-2 mt-0.5 flex items-baseline justify-between border-t border-gray-100 pt-1">
          <span className="text-gray-500">Net Profit</span>
          <span className={`font-semibold ${contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
            {fmt(contributionProfit)} ({pct(contributionProfit, revenue)})
          </span>
        </div>
      </div>
    </div>
  );
}

// One of the two stacked ratio tables shown on mobile (the desktop view keeps
// both sections side by side). Every column differs by section: Actual is on the
// expected-delivered basis, Meta Dashboard on the all-orders (100%) basis.
function MobileRatioTable({
  title,
  categories,
  section,
  isModelOpen,
  toggleModel,
  isCategoryOpen,
  toggleCategory,
}: {
  title: string;
  categories: {
    category: string;
    flat: boolean;
    subGroups: { modelName: string; subtotal: KeyRatioRow; rows: KeyRatioRow[] }[];
    rows: KeyRatioRow[];
    subtotal: KeyRatioRow;
  }[];
  section: "actual" | "meta";
  isModelOpen: (modelName: string) => boolean;
  toggleModel: (modelName: string) => void;
  isCategoryOpen: (category: string) => boolean;
  toggleCategory: (category: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-3 py-1.5 text-[10px] font-semibold uppercase text-gray-500">{title}</div>
      <table className="w-full table-fixed text-[11px]">
        <thead>
          <tr className="text-[10px] font-medium uppercase text-gray-400">
            <th className="w-[30%] py-1.5 pl-3 text-left">Product</th>
            <th className="py-1.5 text-right">ROAS</th>
            <th className="py-1.5 text-right">BE ROAS</th>
            <th className="py-1.5 text-right">CPA</th>
            <th className="py-1.5 text-right">CPA Lim</th>
            <th className="py-1.5 pr-3 text-right">Fixed Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {(() => {
            const cells = (r: KeyRatioRow) => (
              <>
                <td className="py-1.5 text-right">{(section === "actual" ? r.aRoas : r.mRoas).toFixed(2)}</td>
                <td className="py-1.5 text-right">{(section === "actual" ? r.aBeRoas : r.mBeRoas).toFixed(2)}</td>
                <td className="py-1.5 text-right">{fmt(section === "actual" ? r.aCpa : r.mCpa)}</td>
                <td className="py-1.5 text-right">{fmt(section === "actual" ? r.aCpaLimit : r.mCpaLimit)}</td>
                <td className="py-1.5 pr-3 text-right">{fmt(section === "actual" ? r.aFixedCost : r.mFixedCost)}</td>
              </>
            );
            const heading = (label: string, row: KeyRatioRow, open: boolean, onToggle: () => void, isCategory: boolean) => (
              <tr
                className={`cursor-pointer font-semibold text-gray-900 ${isCategory ? "bg-gray-100" : "bg-gray-50"}`}
                onClick={onToggle}
              >
                <td className={`py-1.5 ${isCategory ? "pl-3" : "pl-5"}`}>
                  <span className="mr-1 text-[9px] text-gray-400">{open ? "▼" : "▶"}</span>
                  <span dir="auto">{label}</span>
                </td>
                {cells(row)}
              </tr>
            );
            const productRows = (rows: KeyRatioRow[], indent: string) =>
              rows.map((r) => (
                <tr key={r.id} className="text-gray-700">
                  <td className={`py-1.5 ${indent}`} dir="auto">
                    {r.name}
                  </td>
                  {cells(r)}
                </tr>
              ));
            return categories.map((cat) => (
              <Fragment key={cat.category}>
                {heading(cat.category, cat.subtotal, isCategoryOpen(cat.category), () => toggleCategory(cat.category), true)}
                {isCategoryOpen(cat.category) &&
                  (cat.flat
                    ? productRows(cat.rows, "pl-6")
                    : cat.subGroups.map((group) => (
                        <Fragment key={group.modelName}>
                          {heading(
                            group.modelName,
                            group.subtotal,
                            isModelOpen(group.modelName),
                            () => toggleModel(group.modelName),
                            false
                          )}
                          {isModelOpen(group.modelName) && productRows(group.rows, "pl-8")}
                        </Fragment>
                      )))}
              </Fragment>
            ));
          })()}
        </tbody>
      </table>
    </div>
  );
}

function MetricCell({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-gray-400">{label}</span>
      <span className={valueClassName ?? "text-gray-900"}>{value}</span>
    </div>
  );
}
