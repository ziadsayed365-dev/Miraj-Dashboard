import "server-only";
import { addDays } from "@/lib/dates";
import { getDailyPnl } from "./daily-pnl";
import { getPerProductReport, type ModelRow } from "./per-product";

// How the reported day did against an ordinary day, for the short analysis at
// the top of AI MIRAJ's nightly message. Performance mode (every order on the
// day it was placed) since that is what marketing decisions are made on. The
// average is the plain daily mean of the BASELINE_DAYS before the day.

const BASELINE_DAYS = 28;

// Only the products that matter make the message: the biggest by revenue or
// ad spend, on the day or on an average day.
const MAX_PRODUCTS = 8;

export type DayMetrics = {
  ordersPlaced: number;
  itemsSold: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  adSpend: number;
  tiktokSpend: number;
  contributionProfit: number;
  roas: number | null; // revenue / ad spend
  cpa: number | null; // ad spend per order
  grossMarginPct: number | null;
};

export type ProductMetrics = {
  itemsSold: number;
  revenue: number;
  adSpend: number;
  contributionProfit: number;
  roas: number | null;
};

export type ProductComparison = { name: string; day: ProductMetrics; average: ProductMetrics };

export type DayComparison = {
  baselineFrom: string;
  baselineTo: string;
  baselineDays: number;
  day: DayMetrics;
  average: DayMetrics;
  products: ProductComparison[];
};

const ratio = (num: number, den: number) => (den ? num / den : null);

function dayMetrics(m: Omit<DayMetrics, "roas" | "cpa" | "grossMarginPct">): DayMetrics {
  return {
    ...m,
    roas: ratio(m.revenue, m.adSpend),
    cpa: ratio(m.adSpend, m.ordersPlaced),
    grossMarginPct: m.revenue ? (m.grossProfit / m.revenue) * 100 : null,
  };
}

function productMetrics(m: ModelRow | undefined, divideBy: number): ProductMetrics {
  const revenue = (m?.revenue ?? 0) / divideBy;
  const adSpend = (m?.adSpend ?? 0) / divideBy;
  return {
    itemsSold: (m?.itemsSold ?? 0) / divideBy,
    revenue,
    adSpend,
    contributionProfit: (m?.contributionProfit ?? 0) / divideBy,
    roas: ratio(revenue, adSpend),
  };
}

export async function getDayComparison(day: string): Promise<DayComparison> {
  const baselineFrom = addDays(day, -BASELINE_DAYS);
  const baselineTo = addDays(day, -1);

  const [pnl, dayProducts, baselineProducts] = await Promise.all([
    getDailyPnl(baselineFrom, day, "performance"),
    getPerProductReport(day, day, "performance"),
    getPerProductReport(baselineFrom, baselineTo, "performance"),
  ]);

  const pick = (rows: typeof pnl.rows, divideBy: number) =>
    dayMetrics({
      ordersPlaced: rows.reduce((s, r) => s + r.ordersPlaced, 0) / divideBy,
      itemsSold: rows.reduce((s, r) => s + r.itemsSold, 0) / divideBy,
      revenue: rows.reduce((s, r) => s + r.revenue, 0) / divideBy,
      cogs: rows.reduce((s, r) => s + r.cogs, 0) / divideBy,
      grossProfit: rows.reduce((s, r) => s + r.grossProfit, 0) / divideBy,
      adSpend: rows.reduce((s, r) => s + r.adSpend, 0) / divideBy,
      tiktokSpend: rows.reduce((s, r) => s + r.tiktokSpend, 0) / divideBy,
      contributionProfit: rows.reduce((s, r) => s + r.contributionProfit, 0) / divideBy,
    });

  const baselineRows = pnl.rows.filter((r) => r.date >= baselineFrom && r.date <= baselineTo);
  const dayRows = pnl.rows.filter((r) => r.date === day);

  const dayByName = new Map(dayProducts.models.map((m) => [m.name, m]));
  const baselineByName = new Map(baselineProducts.models.map((m) => [m.name, m]));
  const names = [...new Set([...dayByName.keys(), ...baselineByName.keys()])];
  const products = names
    .map((name) => ({
      name,
      day: productMetrics(dayByName.get(name), 1),
      average: productMetrics(baselineByName.get(name), BASELINE_DAYS),
    }))
    .map((p) => ({ ...p, weight: Math.max(p.day.revenue, p.average.revenue, p.day.adSpend, p.average.adSpend) }))
    .filter((p) => p.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_PRODUCTS)
    .map(({ weight: _weight, ...p }) => p); // eslint-disable-line @typescript-eslint/no-unused-vars

  return {
    baselineFrom,
    baselineTo,
    baselineDays: BASELINE_DAYS,
    day: pick(dayRows, 1),
    average: pick(baselineRows, BASELINE_DAYS),
    products,
  };
}
