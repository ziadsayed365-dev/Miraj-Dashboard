import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { getPerProductReport, getProductOptions } from "@/lib/reports/per-product";
import { getUnmappedAds } from "@/lib/reports/ad-allocation";
import { listAllocationCategories } from "@/lib/products/catalog";
import { getDailyPnl } from "@/lib/reports/daily-pnl";
import { fixedCostPool } from "@/lib/reports/fixed-cost-pool";
import { egyptToday, addDays } from "@/lib/dates";
import { AnalysisByProductTabs } from "../analysis-by-product-tabs";
import { AdAllocationModal } from "../ad-allocation-modal";

export const dynamic = "force-dynamic";

const ALL_TIME_START = "2000-01-01";

export default async function AnalysisByProductPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  // Default to yesterday only - today's data is still incomplete, and
  // yesterday is the most recently fully-settled day to review.
  const yesterday = addDays(egyptToday(), -1);
  const from = params.from && params.from.length > 0 ? params.from : yesterday;
  const to = params.to && params.to.length > 0 ? params.to : yesterday;

  const cookieStore = await cookies();
  const role = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);

  const [performance, unmappedAds, categoryTree, productOptions, pnl] = await Promise.all([
    getPerProductReport(from, to, "performance"),
    role === "owner" ? getUnmappedAds() : Promise.resolve([]),
    role === "owner" ? listAllocationCategories() : Promise.resolve([]),
    getProductOptions(),
    getDailyPnl(from, to, "performance"),
  ]);

  // Fixed cost to allocate across products = the Income Statement's own
  // contribution-to-net gap, so both screens charge products the same pool:
  // the six overheads PLUS the below-contribution courier costs (bosta penalty,
  // next-day fee, and shipping differences - the last is charged/paid, so a
  // negative value is a net cost and subtracts here). Mirrors weekly-table's
  // `contributionProfit - netProfit`. Each row already carries its own day's
  // share of the overheads (recorded actuals for ended months, the Settings
  // assumption for the open one), so no monthly figure is spread here.
  // Skip the open day - it's shown as zero everywhere, so it carries no fixed
  // cost (and no items) until it closes.
  const today = egyptToday();
  const fixedCostTotal = fixedCostPool(pnl.rows, { skipDate: today });
  // Per-item fixed cost on the SAME item base the Income Statement uses (its
  // total items sold), so each product's fixed cost/item matches the P&L.
  const totalItems = pnl.rows.reduce((s, r) => s + r.itemsSold, 0);
  const fixedCostPerItem = totalItems ? fixedCostTotal / totalItems : 0;

  return (
    <div className="space-y-6">
      {role === "owner" && <AdAllocationModal ads={unmappedAds} categoryTree={categoryTree} />}
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Analysis by Product</h1>
        <p className="text-xs text-gray-400">All amounts in EGP.</p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <label className="block text-xs font-medium text-gray-500">From</label>
          <input type="date" name="from" defaultValue={from === ALL_TIME_START ? "" : from} className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">To</label>
          <input type="date" name="to" defaultValue={to} className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm" />
        </div>
        <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700">
          Apply
        </button>
        <a
          href={`/products?from=${ALL_TIME_START}&to=${egyptToday()}`}
          className="px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
        >
          Show all time
        </a>
        <a href="/products" className="px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700">
          Reset to yesterday
        </a>
        <span className="text-xs text-gray-400">
          Showing: {from === ALL_TIME_START ? "all time" : from} → {to}
        </span>
      </form>

      <AnalysisByProductTabs
        performance={performance.models}
        performanceOpenMonthInfo={performance.openMonthInfo}
        productOptions={productOptions}
        fixedCostPerItem={fixedCostPerItem}
        fixedCostTotal={fixedCostTotal}
      />
    </div>
  );
}
