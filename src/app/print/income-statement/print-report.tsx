"use client";

import { Fragment, useEffect } from "react";
import type { DailyPnlRow, ExpectedDeliveryRate } from "@/lib/reports/daily-pnl";
import { fixedCostPool } from "@/lib/reports/fixed-cost-pool";
import type { ModelRow } from "@/lib/reports/per-product";
import { buildLines, LineRow } from "@/app/(app)/weekly-table";
import { egyptToday } from "@/lib/dates";

const BRAND_NAVY = "#050a30";

// How far down the Category > Sub-category > Products tree the Analysis by
// Product section prints. Chosen in the Export PDF dialog.
export type ProductDepth = "category" | "sub" | "item";

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", timeZone: "UTC" });
}
function fmtLongDate(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}
function fmtMonthShort(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

// CSS printed into the standalone page: portrait A4, keep the on-screen
// colours/backgrounds (browsers strip them from print by default), and hide the
// on-screen-only toolbar.
const PRINT_CSS = `
  @page { size: A4 portrait; margin: 10mm; }
  @media print {
    .no-print { display: none !important; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`;

export function PrintReport({
  window: cols,
  rate,
  expectedDeliveryRate,
  showIncome,
  showProduct,
  productDepth,
  models,
  from,
  to,
}: {
  window: DailyPnlRow[];
  rate: number | null;
  expectedDeliveryRate: ExpectedDeliveryRate;
  showIncome: boolean;
  showProduct: boolean;
  productDepth: ProductDepth;
  models: ModelRow[] | null;
  from: string;
  to: string;
}) {
  // Auto-open the print dialog once the page has painted. A short delay lets
  // fonts/layout settle so the PDF isn't captured mid-render.
  useEffect(() => {
    const t = setTimeout(() => window.print(), 500);
    return () => clearTimeout(t);
  }, []);

  if (cols.length === 0) {
    return <div className="p-8 text-sm text-gray-600">No data in the selected range.</div>;
  }

  const lines = buildLines(cols, {
    collapseFixed: true,
    rate: rate ?? expectedDeliveryRate.rate ?? undefined,
    expected: expectedDeliveryRate,
  });
  const title =
    showIncome && showProduct ? "Income Statement & Product Analysis" : showProduct ? "Analysis by Product" : "Income Statement";

  return (
    <div className="mx-auto max-w-none bg-white p-6 text-gray-900">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="no-print mb-4 flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2">
        <span className="text-xs text-gray-500">Use your browser&apos;s dialog to save as PDF. It should open automatically.</span>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
        >
          Print / Save as PDF
        </button>
      </div>

      {/* Each data-pdf-page block is scaled to fit one A4 page by AI MIRAJ's
          nightly PDF (scripts/ai-miraj/miraj.mjs): Income Statement first,
          Analysis by Product second. */}
      <div data-pdf-page="income">
      <header className="mb-4 flex items-end justify-between border-b-2 pb-2" style={{ borderColor: BRAND_NAVY }}>
        <div>
          <div className="text-lg font-bold" style={{ color: BRAND_NAVY }}>
            Miraj — {title}
          </div>
          <div className="text-xs text-gray-500">
            {fmtLongDate(from)} – {fmtLongDate(to)} · {cols.length} {cols.length === 1 ? "day" : "days"}
          </div>
        </div>
        <div className="text-right text-[10px] text-gray-400">Generated {fmtLongDate(egyptToday())}</div>
      </header>

      {/* Income Statement — same lines/rendering as the on-screen daily view. */}
      {showIncome && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200">
              <th className="px-2 py-2 text-left text-xs font-medium uppercase text-gray-400">Line item</th>
              {cols.map((r) => (
                <th key={r.date} className="px-3 py-2 text-right text-sm font-semibold text-gray-900">
                  {fmtDate(r.date)}
                </th>
              ))}
              <th className="border-l-2 border-l-gray-400 px-3 py-2 text-right text-sm font-semibold text-gray-900">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <LineRow key={i} line={line} />
            ))}
          </tbody>
        </table>
      )}
      </div>

      {showProduct && models && <ProductAnalysis models={models} cols={cols} newPage={showIncome} depth={productDepth} />}
    </div>
  );
}

type PrintSubtotal = {
  ordersPlaced: number;
  expectedDelivered: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  adSpend: number;
  contributionProfit: number;
};

// A category or sub-category heading row in the printed products table. One
// definition for both, so the two levels differ only by shading and indent.
function PrintGroupRow({
  label,
  count,
  subtotal,
  level,
}: {
  label: string;
  count: number;
  subtotal: PrintSubtotal;
  level: "category" | "sub";
}) {
  const isCategory = level === "category";
  return (
    <tr className={`font-semibold text-gray-900 ${isCategory ? "bg-gray-200" : "bg-gray-50"}`}>
      <td className={`py-1.5 ${isCategory ? "pl-2" : "pl-5"}`}>
        <span dir="auto">{label}</span>
        <span className="ml-1.5 text-[10px] font-normal text-gray-400">({count})</span>
      </td>
      <td className="py-1.5 text-right">
        {subtotal.expectedDelivered}/{subtotal.ordersPlaced}
      </td>
      <td className="py-1.5 text-right text-gray-400">—</td>
      <td className="py-1.5 text-right">{fmt(subtotal.revenue)}</td>
      <td className="py-1.5 text-right">{fmt(subtotal.cogs)}</td>
      <td className={`py-1.5 text-right ${subtotal.grossProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
        {fmt(subtotal.grossProfit)}
      </td>
      <td className="py-1.5 text-right">{pct(subtotal.grossProfit, subtotal.revenue)}</td>
      <td className="py-1.5 text-right">{fmt(subtotal.adSpend)}</td>
      <td className={`py-1.5 text-right ${subtotal.contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
        {fmt(subtotal.contributionProfit)}
      </td>
      <td className="py-1.5 pr-2 text-right">{pct(subtotal.contributionProfit, subtotal.revenue)}</td>
    </tr>
  );
}

function PrintProductRow({
  label,
  p,
  indent,
}: {
  label: string;
  p: {
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
      <td className={`py-1 ${indent}`} dir="auto">
        {label}
      </td>
      <td className="py-1 text-right">
        {p.expectedDelivered}/{p.ordersPlaced}
      </td>
      <td className="py-1 text-right text-gray-500">
        {p.openMonthRate === null
          ? "—"
          : `${(p.openMonthRate * 100).toFixed(0)}%${p.openMonthRateSourceMonth ? ` (${fmtMonthShort(p.openMonthRateSourceMonth)})` : ""}`}
      </td>
      <td className="py-1 text-right">{fmt(p.revenue)}</td>
      <td className="py-1 text-right">{fmt(p.cogs)}</td>
      <td className={`py-1 text-right ${p.grossProfit >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(p.grossProfit)}</td>
      <td className="py-1 text-right">{pct(p.grossProfit, p.revenue)}</td>
      <td className="py-1 text-right">{fmt(p.adSpend)}</td>
      <td className={`py-1 text-right ${p.contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
        {fmt(p.contributionProfit)}
      </td>
      <td className="py-1 pr-2 text-right">{pct(p.contributionProfit, p.revenue)}</td>
    </tr>
  );
}

type PrintRatio = {
  aRoas: number;
  aBeRoas: number;
  aCpa: number;
  aCpaLimit: number;
  aFixedCost: number;
  mRoas: number;
  mBeRoas: number;
  mCpa: number;
  mCpaLimit: number;
  mFixedCost: number;
};

// One Key Ratios row at any of the three levels. `count` is only meaningful on
// a heading row; an item row omits it.
function PrintRatioRow({
  label,
  count,
  row,
  level,
  indent,
}: {
  label: string;
  count?: number;
  row: PrintRatio;
  level: "category" | "sub" | "item";
  indent?: string;
}) {
  const shade = level === "category" ? "bg-gray-200 font-semibold text-gray-900" : level === "sub" ? "bg-gray-50 font-semibold text-gray-900" : "text-gray-700";
  const pad = indent ?? (level === "category" ? "pl-2" : level === "sub" ? "pl-5" : "pl-10");
  const cell = level === "item" ? "py-1" : "py-1.5";
  return (
    <tr className={shade}>
      <td className={`${cell} ${pad}`} dir="auto">
        {label}
        {count !== undefined && <span className="ml-1.5 text-[10px] font-normal text-gray-400">({count})</span>}
      </td>
      <td className={`border-l border-gray-200 ${cell} text-right`}>{row.aRoas.toFixed(2)}</td>
      <td className={`${cell} text-right`}>{row.aBeRoas.toFixed(2)}</td>
      <td className={`${cell} text-right`}>{fmt(row.aCpa)}</td>
      <td className={`${cell} text-right`}>{fmt(row.aCpaLimit)}</td>
      <td className={`${cell} text-right`}>{fmt(row.aFixedCost)}</td>
      <td className={`border-l border-gray-200 ${cell} text-right`}>{row.mRoas.toFixed(2)}</td>
      <td className={`${cell} text-right`}>{row.mBeRoas.toFixed(2)}</td>
      <td className={`${cell} text-right`}>{fmt(row.mCpa)}</td>
      <td className={`${cell} text-right`}>{fmt(row.mCpaLimit)}</td>
      <td className={`${cell} pr-2 text-right`}>{fmt(row.mFixedCost)}</td>
    </tr>
  );
}

// Static reproduction of the Analysis by Product "All Products" table + Key
// Ratios, matching analysis-by-product-tabs.tsx's Category > Sub-category >
// Products nesting. `depth` stands in for the screen's disclosure triangles and
// decides how far down the print goes:
//   "category" - one row per category
//   "sub"      - categories, each followed by its sub-categories
//   "item"     - all of the above plus every product/variant
// Rendered on a fresh page.
function ProductAnalysis({
  models,
  cols,
  newPage,
  depth,
}: {
  models: ModelRow[];
  cols: DailyPnlRow[];
  newPage: boolean;
  depth: ProductDepth;
}) {
  // Same pool as the Analysis by Product screen: the Income Statement's
  // contribution-to-net gap, not the stale monthly overhead constant.
  const today = egyptToday();
  const fixedCostTotal = fixedCostPool(cols, { skipDate: today });
  const totalItems = cols.reduce((s, r) => s + r.itemsSold, 0);
  const fixedCostPerItem = totalItems ? fixedCostTotal / totalItems : 0;

  const allProducts = models
    .flatMap((m) =>
      m.colors.map((c) => ({
        ...c,
        modelName: m.name,
        category: m.category?.trim() || "(uncategorised)",
        expectedDelivered: Math.round(c.ordersPlaced * c.deliveryRate),
        // Rounded to whole items, matching the Analysis by Product screen.
        expectedItems: Math.round(c.itemsSold * c.deliveryRate),
      }))
    )
    // Sold OR carrying marketing, same as the screen: a product with spend and
    // no sales is the most important row, and dropping it also drops its share
    // of the model's marketing total.
    .filter((p) => p.itemsSold > 0 || p.adSpend > 0)
    .sort((a, b) => b.grossProfit - a.grossProfit);

  // A product broken into variants yields several rows sharing one productId,
  // so the row key has to carry the variant too.
  type Product = (typeof allProducts)[number];
  const rowKey = (p: Product) => `${p.productId}:${p.variantId ?? "-"}`;
  // Inside a model the model name is already the group heading, so the row
  // shows just the product (and variant) name.
  const productLabel = (p: Product) => p.name;

  const sumProducts = (products: Product[]) =>
    products.reduce(
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

  // Category > Sub-category > Products, ordered by contribution profit at every
  // level - identical to the on-screen grouping. `flat` marks a category whose
  // only sub-category repeats its own name, where the middle row would print
  // the same label twice for nothing.
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
          products: [...products].sort((a, b) => b.contributionProfit - a.contributionProfit),
          subtotal: sumProducts(products),
        };
      })
      .sort((a, b) => b.subtotal.contributionProfit - a.subtotal.contributionProfit);
  })();

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

  const safe = (num: number, den: number) => (den ? num / den : 0);
  // Fixed cost is spread on each section's own item base, so both allocate the
  // whole pool: Actual over expected-delivered items, Meta over all items sold.
  const totalExpectedItems = allProducts.reduce((s, p) => s + p.expectedItems, 0);
  const fixedCostPerExpectedItem = totalExpectedItems ? fixedCostTotal / totalExpectedItems : 0;
  // Shared by the per-product rows AND the per-model subtotal rows. A model's
  // ratios are recomputed from its SUMMED figures - averaging its products'
  // ratios would be wrong (a ratio of sums is not the sum of ratios).
  type RatioInput = Pick<
    Product,
    "revenue" | "cogs" | "grossRevenue" | "grossCogs" | "adSpend" | "expectedDelivered" | "ordersPlaced" | "expectedItems" | "itemsSold"
  >;
  const makeRatioRow = (id: string, name: string, p: RatioInput) => {
    const aFixedCost = fixedCostPerExpectedItem * p.expectedItems;
    const mFixedCost = fixedCostPerItem * p.itemsSold;
    return {
      id,
      name,
      aRoas: safe(p.revenue, p.adSpend),
      // Break-Even ROAS = (COGS + Marketing + Fixed) / Marketing, per product,
      // each section on its own basis. Mirrors the Income Statement.
      aBeRoas: safe(p.cogs + p.adSpend + aFixedCost, p.adSpend),
      aCpa: safe(p.adSpend, p.expectedDelivered),
      mRoas: safe(p.grossRevenue, p.adSpend),
      mBeRoas: safe(p.grossCogs + p.adSpend + mFixedCost, p.adSpend),
      mCpa: safe(p.adSpend, p.ordersPlaced),
      aCpaLimit: safe(p.revenue - p.cogs - aFixedCost, p.expectedDelivered),
      mCpaLimit: safe(p.grossRevenue - p.grossCogs - mFixedCost, p.ordersPlaced),
      aFixedCost,
      mFixedCost,
    };
  };

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

  // Same Category > Sub-category > Products tree as the products table,
  // restricted to products carrying spend, and printed to the same depth.
  const ratioCategories = groupedByCategory
    .map((cat) => {
      const products = cat.products.filter((p) => p.adSpend > 0);
      if (products.length === 0) return null;
      const subGroups = cat.subGroups
        .map((group) => {
          const spending = group.products.filter((p) => p.adSpend > 0);
          if (spending.length === 0) return null;
          return {
            modelName: group.modelName,
            subtotal: makeRatioRow(`model:${group.modelName}`, group.modelName, aggRatio(spending)),
            rows: spending.map((p) => makeRatioRow(rowKey(p), productLabel(p), p)),
          };
        })
        .filter((g): g is NonNullable<typeof g> => g !== null);
      return {
        category: cat.category,
        flat: cat.flat,
        subGroups,
        rows: products.map((p) => makeRatioRow(rowKey(p), productLabel(p), p)),
        subtotal: makeRatioRow(`cat:${cat.category}`, cat.category, aggRatio(products)),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  return (
    <div data-pdf-page="product" style={newPage ? { breakBefore: "page" } : undefined} className={newPage ? "mt-8" : ""}>
      <h2 className="mb-2 text-base font-bold" style={{ color: BRAND_NAVY }}>
        Analysis by Product
      </h2>
      <table className="w-full table-fixed text-xs">
        <thead className="text-left text-[10px] font-medium uppercase text-gray-500">
          <tr className="border-b-2 border-gray-300 bg-gray-200">
            <th className="w-[24%] py-1.5 pl-2">Product</th>
            <th className="w-[8%] py-1.5 text-right">Ord.</th>
            <th className="w-[10%] py-1.5 text-right">Rate</th>
            <th className="w-[9%] py-1.5 text-right">Rev</th>
            <th className="w-[9%] py-1.5 text-right">COGS</th>
            <th className="w-[8%] py-1.5 text-right">GP</th>
            <th className="w-[7%] py-1.5 text-right">GPM%</th>
            <th className="w-[8%] py-1.5 text-right">Mark</th>
            <th className="w-[8%] py-1.5 text-right">NP</th>
            <th className="w-[9%] py-1.5 pr-2 text-right">NPM%</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {groupedByCategory.map((cat) => (
            <Fragment key={cat.category}>
              <PrintGroupRow label={cat.category} count={cat.products.length} subtotal={cat.subtotal} level="category" />
              {depth !== "category" &&
                !cat.flat &&
                cat.subGroups.map((group) => (
                  <Fragment key={group.modelName}>
                    <PrintGroupRow
                      label={group.modelName}
                      count={group.products.length}
                      subtotal={group.subtotal}
                      level="sub"
                    />
                    {depth === "item" && group.products.map((p) => <PrintProductRow key={rowKey(p)} label={productLabel(p)} p={p} indent="pl-10" />)}
                  </Fragment>
                ))}
              {/* A flat category's single sub-category just repeats the category
                  name, so printing it would be the same label and the same
                  numbers twice. Its products ARE the next level down, so they
                  are what "Sub Category" opens - matching the screen, where
                  expanding such a category hangs its products straight off it.
                  Without this the level printed nothing at all for these, and on
                  this store 7 of 8 categories are flat: only سجاد صلاة has real
                  sub-categories, so only that one appeared to open. */}
              {depth !== "category" &&
                cat.flat &&
                cat.products.map((p) => <PrintProductRow key={rowKey(p)} label={productLabel(p)} p={p} indent="pl-6" />)}
            </Fragment>
          ))}
          {allProducts.length === 0 && (
            <tr>
              <td colSpan={10} className="py-3 pl-2 text-gray-400">
                No products with sales or marketing spend in this range.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-300 bg-gray-100 font-semibold text-gray-900">
            <td className="py-1.5 pl-2">Total</td>
            <td className="py-1.5 text-right">
              {totals.expectedDelivered}/{totals.ordersPlaced}
            </td>
            <td className="py-1.5 text-right text-gray-400">—</td>
            <td className="py-1.5 text-right">{fmt(totals.revenue)}</td>
            <td className="py-1.5 text-right">{fmt(totals.cogs)}</td>
            <td className={`py-1.5 text-right ${totals.grossProfit >= 0 ? "text-green-700" : "text-red-700"}`}>{fmt(totals.grossProfit)}</td>
            <td className="py-1.5 text-right">{pct(totals.grossProfit, totals.revenue)}</td>
            <td className="py-1.5 text-right">{fmt(totals.adSpend)}</td>
            <td className={`py-1.5 text-right ${totals.contributionProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
              {fmt(totals.contributionProfit)}
            </td>
            <td className="py-1.5 pr-2 text-right">{pct(totals.contributionProfit, totals.revenue)}</td>
          </tr>
        </tfoot>
      </table>

      {ratioCategories.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">Key Ratios</h3>
          <p className="mb-2 text-[10px] text-gray-400">
            Only products with marketing spend. Same calculation as the Income Statement&apos;s Actual ratios.
          </p>
          <table className="w-full table-fixed text-[11px]">
            <thead>
              <tr className="border-b border-gray-200 text-[10px] font-semibold uppercase text-gray-500">
                <th className="w-[20%] py-1.5 pl-2 text-left" />
                <th className="border-l border-gray-200 py-1.5 text-center" colSpan={5}>
                  Actual Ratios
                </th>
                <th className="border-l border-gray-200 py-1.5 text-center" colSpan={5}>
                  Meta Dashboard Ratios
                </th>
              </tr>
              <tr className="text-[10px] font-medium uppercase text-gray-400">
                <th className="py-1.5 pl-2 text-left">Product</th>
                <th className="border-l border-gray-200 py-1.5 text-right">ROAS</th>
                <th className="py-1.5 text-right">BE ROAS</th>
                <th className="py-1.5 text-right">CPA</th>
                <th className="py-1.5 text-right">CPA Lim</th>
                <th className="py-1.5 text-right">Fixed Cost</th>
                <th className="border-l border-gray-200 py-1.5 text-right">ROAS</th>
                <th className="py-1.5 text-right">BE ROAS</th>
                <th className="py-1.5 text-right">CPA</th>
                <th className="py-1.5 text-right">CPA Lim</th>
                <th className="py-1.5 pr-2 text-right">Fixed Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {ratioCategories.map((cat) => (
                <Fragment key={cat.category}>
                  <PrintRatioRow label={cat.category} count={cat.rows.length} row={cat.subtotal} level="category" />
                  {depth !== "category" &&
                    !cat.flat &&
                    cat.subGroups.map((group) => (
                      <Fragment key={group.modelName}>
                        <PrintRatioRow label={group.modelName} count={group.rows.length} row={group.subtotal} level="sub" />
                        {depth === "item" && group.rows.map((r) => <PrintRatioRow key={r.id} label={r.name} row={r} level="item" />)}
                      </Fragment>
                    ))}
                  {/* Same rule as the products table above: a flat category's
                      next level down is its products, so that is what the Sub
                      Category level opens. */}
                  {depth !== "category" &&
                    cat.flat &&
                    cat.rows.map((r) => <PrintRatioRow key={r.id} label={r.name} row={r} level="item" indent="pl-6" />)}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
