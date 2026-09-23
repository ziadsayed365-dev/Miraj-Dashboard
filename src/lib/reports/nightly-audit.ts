import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { addDays } from "@/lib/dates";
import { listAllocationCategories, type AllocationCategory } from "@/lib/products/catalog";
import { getUnmappedAds, type UnmappedAd } from "./ad-allocation";
import { getDailyPnl } from "./daily-pnl";
import { getPerProductReport } from "./per-product";
import { getDayComparison, type DayComparison } from "./day-comparison";

// The nightly audit AI MIRAJ reads after its sync (GET /api/agent/audit). It
// answers the owner's questions - was TikTok spend entered for the day, is there
// retail Meta spend nobody has allocated, and was anything sold whose cost is
// missing - checks that the Income Statement and Analysis by Product agree for
// the day being reported, and compares the day with an average one.

// The day AI MIRAJ started. The owner wants it to police new numbers only, so
// sales, ad spend and TikTok days before this are never flagged.
const AUDIT_SINCE = "2026-09-23";

// The owner only wants to hear about a big gap between the two reports: 5,000
// EGP or more on a line. Anything smaller is ignored.
const TIE_FLAG_AT_EGP = 5000;

// A product that sold with no cost at all, found the way Analysis by Product
// flags "cost missing": items sold, zero cost of goods.
export type MissingCostProduct = {
  productId: number;
  name: string;
  group: string; // the sub-category (or category) it is reported under
  unitsSold: number;
};

export type TieLine = { incomeStatement: number; byProduct: number; difference: number; ok: boolean };

export type TieCheck = {
  mode: "performance" | "actual";
  revenue: TieLine;
  cogs: TieLine;
  adSpend: TieLine;
};

export type NightlyAudit = {
  ok: boolean;
  day: string;
  // Days (up to and including `day`) with no TikTok entry yet - the same days
  // the dashboard's TikTok popup would ask for.
  tiktokMissingDays: string[];
  tiktokSpend: number; // what was entered for `day` (0 when missing)
  unallocatedCampaigns: UnmappedAd[];
  missingCostProducts: MissingCostProduct[];
  ties: TieCheck[];
  // The day against an average day, for the short analysis in the nightly message.
  comparison: DayComparison;
  // Everything a campaign can be allocated to, so a reply can be matched
  // exactly rather than guessed.
  allocationCategories: AllocationCategory[];
};

function tieLine(incomeStatement: number, byProduct: number): TieLine {
  const difference = incomeStatement - byProduct;
  return { incomeStatement, byProduct, difference, ok: Math.abs(difference) < TIE_FLAG_AT_EGP };
}

async function getTikTok(day: string): Promise<{ missingDays: string[]; spend: number }> {
  const rows = await fetchAllRows<{ date: string; spend: number }>(supabase, "ad_spend", "id, date, spend", (q) =>
    q.eq("source", "tiktok").gte("date", AUDIT_SINCE).lte("date", day)
  );
  const have = new Set(rows.map((r) => r.date));
  const missingDays: string[] = [];
  for (let d = AUDIT_SINCE; d <= day; d = addDays(d, 1)) {
    if (!have.has(d)) missingDays.push(d);
  }
  const spend = rows.filter((r) => r.date === day).reduce((sum, r) => sum + Number(r.spend), 0);
  return { missingDays, spend };
}

// Same rule as Analysis by Product's "cost missing" warning (per-product.ts):
// items sold with no cost of goods behind them. Read from the report itself so
// every cost source the margin engine knows (purchases, components, bundles,
// variant and product costs) counts, not just the ones this file could list.
async function getMissingCostProducts(day: string): Promise<MissingCostProduct[]> {
  if (day < AUDIT_SINCE) return [];
  const { models } = await getPerProductReport(AUDIT_SINCE, day, "performance");
  const byProduct = new Map<number, MissingCostProduct>();
  for (const m of models) {
    for (const c of m.colors) {
      if (c.itemsSold <= 0 || c.grossCogs !== 0) continue;
      const existing = byProduct.get(c.productId);
      if (existing) existing.unitsSold += c.itemsSold;
      else byProduct.set(c.productId, { productId: c.productId, name: c.name, group: m.name, unitsSold: c.itemsSold });
    }
  }
  return [...byProduct.values()].sort((a, b) => b.unitsSold - a.unitsSold);
}

// Revenue and COGS are compared at full value (every order as if delivered),
// not as expected-delivered: Analysis by Product scales each product by its own
// delivery rate while the Income Statement scales by the store-wide one, so
// their expected figures differ by design. What must agree is that both count
// the same sales. Only in Actual mode, though: in Performance the Income
// Statement's all-orders figure keeps cancelled orders at full value while
// Analysis by Product zeroes them, so the two differ by exactly the day's
// cancelled orders (checked on 15 and 21 Sep 2026). Ad spend is the same in
// both modes, so Actual covers it too.
async function tieCheck(day: string, mode: "performance" | "actual"): Promise<TieCheck> {
  const pnl = await getDailyPnl(day, day, mode);
  const row = pnl.rows.find((r) => r.date === day);
  const { models } = await getPerProductReport(day, day, mode);

  const colors = models.flatMap((m) => m.colors);
  const sum = <T,>(list: T[], pick: (x: T) => number) => list.reduce((acc, x) => acc + pick(x), 0);
  return {
    mode,
    revenue: tieLine(row?.grossRevenue ?? 0, sum(colors, (c) => c.grossRevenue)),
    cogs: tieLine(row?.grossCogs ?? 0, sum(colors, (c) => c.grossCogs)),
    adSpend: tieLine(row?.adSpend ?? 0, sum(models, (m) => m.adSpend)),
  };
}

export async function runNightlyAudit(day: string): Promise<NightlyAudit> {
  const [tiktok, allUnallocated, missingCostProducts, actual, comparison, allocationCategories] =
    await Promise.all([
      getTikTok(day),
      getUnmappedAds(),
      getMissingCostProducts(day),
      tieCheck(day, "actual"),
      getDayComparison(day),
      listAllocationCategories(),
    ]);

  // Hand-typed TikTok rows are entered as General or per group, never allocated
  // afterwards, so they are not "unallocated campaigns".
  const unallocatedCampaigns = allUnallocated.filter(
    (ad) => ad.date >= AUDIT_SINCE && !ad.campaignId.startsWith("tiktok:")
  );
  const ties = [actual];
  const tiesOk = ties.every((t) => t.revenue.ok && t.cogs.ok && t.adSpend.ok);

  return {
    ok: tiktok.missingDays.length === 0 && unallocatedCampaigns.length === 0 && missingCostProducts.length === 0 && tiesOk,
    day,
    tiktokMissingDays: tiktok.missingDays,
    tiktokSpend: tiktok.spend,
    unallocatedCampaigns,
    missingCostProducts,
    ties,
    comparison,
    allocationCategories,
  };
}
