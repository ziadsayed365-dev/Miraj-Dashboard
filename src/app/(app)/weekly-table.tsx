"use client";

import { useEffect, useState } from "react";
import type { DailyPnlRow, ExpectedDeliveryRate, OpenMonthInfo } from "@/lib/reports/daily-pnl";
import { egyptToday } from "@/lib/dates";

// Daily and monthly views share the same below-Contribution lines (Salary, Post
// Production, Subscription, Rent, Transportation, Other, Shipping Differences,
// Bosta Penalty, Next Day fees → Net Income). Each overhead's per-day share is
// resolved server-side onto the row (daily-pnl); the monthly view sums them, the
// daily view reads them per day (the still-open day shows zero).
//
// Owner-added accounts flagged into the Income Statement arrive as `customLines`
// on each row and are rendered as extra named lines in the same section - an
// expense below "Other - Expense", an income below "Other - Income".

const WINDOW_DESKTOP = 7;
const WINDOW_MOBILE = 3;
const BRAND_NAVY = "#050a30";

// Matches the app's sm: breakpoint (640px) used for the mobile nav - below
// it, the full 7-day table is too cramped/horizontally-scrolly to be
// useful, so it shows fewer day columns at once instead.
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    setIsMobile(query.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

function fmtMoney(n: number): string {
  const rounded = Math.round(n);
  const abs = Math.abs(rounded).toLocaleString("en-US");
  return rounded < 0 ? `(${abs})` : abs;
}

function fmtDate(d: string): string {
  const date = new Date(d + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function fmtMonth(d: string): string {
  const date = new Date(d + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// Compact header for month columns in the monthly view, e.g. "Jan 26".
export function fmtMonthShort(d: string): string {
  const date = new Date(d + "T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

// The open-month banner names the rate new days are projected at. Days reported
// before that rate took over keep the one they were first shown at (see
// getOpenMonthRows), so they are spelled out rather than silently mislabelled.
export function earlierProjectionNote(rows: DailyPnlRow[], openMonthInfo: OpenMonthInfo): string | null {
  const bySource = new Map<string, { label: string; rate: number; first: string; last: string }>();
  for (const r of rows) {
    const p = r.projectionRate;
    if (!p || p.sourceMonth === openMonthInfo.sourceMonth) continue;
    const key = p.sourceMonth ?? "default";
    const cur = bySource.get(key);
    if (!cur) {
      bySource.set(key, { label: p.sourceMonth ? fmtMonth(p.sourceMonth) : "the default", rate: p.rate, first: r.date, last: r.date });
      continue;
    }
    if (r.date < cur.first) cur.first = r.date;
    if (r.date > cur.last) cur.last = r.date;
  }
  if (bySource.size === 0) return null;
  const parts = [...bySource.values()].map(
    (s) => `${fmtDate(s.first)} – ${fmtDate(s.last)} at ${s.label}'s ${(s.rate * 100).toFixed(1)}%`
  );
  return `Days already reported keep the rate they were first shown at: ${parts.join("; ")}.`;
}

function emptyRow(date: string): DailyPnlRow {
  return {
    date,
    ordersPlaced: 0,
    ordersResolved: 0,
    ordersReceived: 0,
    ordersDelivered: 0,
    itemsSold: 0,
    revenue: 0,
    cogs: 0,
    grossRevenue: 0,
    grossCogs: 0,
    revenueProjected: false,
    grossProfit: 0,
    adSpend: 0,
    metaSpend: 0,
    tiktokSpend: 0,
    marketingAgencyFee: 0,
    generalAdSpend: 0,
    contributionProfit: 0,
    packaging: 0,
    shippingFeeCharged: 0,
    bostaFeesPaid: 0,
    shippingDifferencesFee: 0,
    nextDayFee: 0,
    openPackageFee: 0,
    salary: 0,
    postProduction: 0,
    subscription: 0,
    rent: 0,
    transportation: 0,
    other: 0,
    otherIncome: 0,
    chatOrders: 0,
    chatRevenue: 0,
    chatCogs: 0,
    chatItems: 0,
    bostaPenalty: 0,
    assumedDeliveryRate: null,
    projectionRate: null,
    customLines: [],
  };
}

// Always returns exactly windowSize entries, padding with empty placeholder
// days (extending backward from the earliest real day) when fewer exist.
function padToWindow(realWindow: DailyPnlRow[], windowSize: number): DailyPnlRow[] {
  const missing = windowSize - realWindow.length;
  if (missing <= 0) return realWindow;

  const anchor = realWindow.length > 0 ? new Date(realWindow[0].date + "T00:00:00Z") : new Date();
  const padding: DailyPnlRow[] = [];
  for (let i = missing; i > 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() - i);
    padding.push(emptyRow(d.toISOString().slice(0, 10)));
  }
  return [...padding, ...realWindow];
}

type Line = {
  label: string;
  values: number[];
  kind: "count" | "money-cost" | "money-profit" | "percent" | "ratio" | "decimal" | "header";
  ratioTotals?: number[]; // only for kind: "ratio" - values=resolved, ratioTotals=placed
  total?: number; // override for the Total column - needed for "percent" (a true rate over the window, not a sum/average of daily %s); everything else defaults to summing values
  bold?: boolean;
  band?: number; // rows sharing the same band number get a shared gray background
  blankBefore?: boolean;
  small?: boolean; // smaller, brand-navy styling
  subtotal?: boolean; // top border + red only when negative (Gross/Contribution/Net Income)
};

const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

// Builds the Income Statement line items from a set of period columns (days
// for the daily view, months for the monthly view). Column-agnostic: it only
// reads the aggregated per-period figures, so the same rows/rendering are
// shared between WeeklyTable and MonthlyTable.
//
// Every view leads with Delivery Rate, then the raw delivered/orders counts
// behind it.
//
// `expected` switches the rate row to a single figure repeated across every
// column - the last mature month's real rate. The daily view passes it, because
// a day's own ratio is meaningless: that day's orders have had no time to be
// delivered yet but are all in its denominator, so every column would read near
// 0%. The monthly view omits it and shows each month's own arithmetic. The
// counts row underneath is the real per-column figure either way.
export function buildLines(
  cols: DailyPnlRow[],
  opts?: { collapseFixed?: boolean; rate?: number; expected?: ExpectedDeliveryRate }
): Line[] {
  const metaSpend = cols.map((r) => r.metaSpend);
  const tiktokSpend = cols.map((r) => r.tiktokSpend);
  const cogs = cols.map((r) => r.cogs);
  const revenue = cols.map((r) => r.revenue);
  const grossProfit = cols.map((r) => r.grossProfit);
  const contributionProfit = cols.map((r) => r.contributionProfit);

  const revenueTotal = sum(revenue);
  const pctOfRevenueTotal = (n: number) => (revenueTotal ? (n / revenueTotal) * 100 : 0);

  // Delivered / every order that came in that period, cancellations and
  // never-shipped included. Not the delivered/resolved rate the open month's
  // revenue used to be projected from - this one holds unshipped, unsettled and
  // cancelled orders against the rate, so it reads lower and, for the open
  // month, climbs as orders land. Same arithmetic in every column, including the
  // open month: the count of delivered orders is a fact even where the money on
  // the row is projected. Chat orders are deliberately absent from both sides -
  // they carry no courier, so folding always-delivered orders in would flatter
  // the rate (and, through the projection, the forecast).
  // A column inside the outcome-less window has no delivered orders to count -
  // those orders never got a tracking number, so nothing was ever recorded
  // against them - and reading its arithmetic literally would print 0% directly
  // above revenue that was struck at 80%. Where the P&L assumed a rate, the rate
  // row says so, and the Total blends the assumed columns in at the same rate
  // rather than dragging the whole window's denominator against a zero.
  const totalReceived = sum(cols.map((r) => r.ordersReceived));
  const effectiveDelivered = (r: DailyPnlRow) =>
    r.assumedDeliveryRate != null ? r.assumedDeliveryRate * r.ordersReceived : r.ordersDelivered;
  const totalDelivered = sum(cols.map(effectiveDelivered));
  const expectedPct = opts?.expected?.rate != null ? opts.expected.rate * 100 : null;
  // An open-month day shows the rate its own money was struck at, which is not
  // always today's expected rate - each open day keeps the rate it was first
  // reported at. The label names a source month only when every column agrees.
  const shownPct = (r: DailyPnlRow) => (r.projectionRate ? r.projectionRate.rate * 100 : expectedPct!);
  const shownSources = new Set(
    cols.map((r) => (r.projectionRate ? (r.projectionRate.sourceMonth?.slice(0, 7) ?? null) : (opts?.expected?.month ?? null)))
  );
  const labelMonth = shownSources.size === 1 ? [...shownSources][0] : null;
  const deliveryRateLine: Line =
    expectedPct !== null
      ? {
          // One figure per column - the mature month's real rate that column is
          // projected with. Its Total weights each column by its orders rather
          // than summing: it is a rate, not a quantity.
          label: `Delivery Rate (expected${labelMonth ? `, ${labelMonth}` : ""})`,
          values: cols.map(shownPct),
          total: totalReceived ? sum(cols.map((r) => shownPct(r) * r.ordersReceived)) / totalReceived : expectedPct,
          kind: "percent",
          small: true,
        }
      : {
          label: "Delivery Rate",
          values: cols.map((r) => (r.ordersReceived ? (effectiveDelivered(r) / r.ordersReceived) * 100 : 0)),
          total: totalReceived ? (totalDelivered / totalReceived) * 100 : 0,
          kind: "percent",
          small: true,
        };
  const topLines: Line[] = [
    {
      // The counts the rate above is built from. Always the real per-column
      // figures, even when the rate row shows the expected value instead.
      label: "Delivered / Orders",
      values: cols.map((r) => r.ordersDelivered),
      ratioTotals: cols.map((r) => r.ordersReceived),
      kind: "ratio",
      small: true,
    },
    { label: "Total Items Sold", values: cols.map((r) => r.itemsSold), kind: "count", small: true },
    { label: "Total Revenue", values: revenue, kind: "money-profit", band: 1, blankBefore: true },
    { label: "Total Cost", values: cogs.map((v) => -v), kind: "money-cost", band: 1 },
    { label: "Gross Profit", values: grossProfit, kind: "money-profit", bold: true, subtotal: true },
    {
      label: "Gross Margin %",
      values: grossProfit.map((v, i) => (revenue[i] ? (v / revenue[i]) * 100 : 0)),
      total: pctOfRevenueTotal(sum(grossProfit)),
      kind: "percent",
      small: true,
    },
    { label: "Meta", values: metaSpend.map((v) => -v), kind: "money-cost", band: 2, blankBefore: true },
    { label: "TikTok", values: tiktokSpend.map((v) => -v), kind: "money-cost", band: 2 },
    { label: "Contribution Profit", values: contributionProfit, kind: "money-profit", bold: true, subtotal: true },
    {
      label: "Contribution Margin %",
      values: contributionProfit.map((v, i) => (revenue[i] ? (v / revenue[i]) * 100 : 0)),
      total: pctOfRevenueTotal(sum(contributionProfit)),
      kind: "percent",
      small: true,
    },
  ];

  const netMarginLine = (net: number[]): Line => ({
    label: "Net Margin %",
    values: net.map((v, i) => (revenue[i] ? (v / revenue[i]) * 100 : 0)),
    total: pctOfRevenueTotal(sum(net)),
    kind: "percent",
    small: true,
  });

  // Real + Meta Dashboard ratios - shown in BOTH daily and monthly views.
  // Real = delivered basis; Meta Dashboard = all-orders (100% delivery) basis.
  // Both use total marketing (Meta+TikTok). CPA Limit is per-order gross margin
  // net of fixed cost, so it's identical across both sections. Each view
  // passes its own "Real" basis: monthly = actual delivered; daily = expected
  // (all orders x expected delivery rate, since a single day isn't settled yet).
  const marketing = cols.map((r) => r.metaSpend + r.tiktokSpend);
  const grossRev = cols.map((r) => r.grossRevenue);
  const grossCogs = cols.map((r) => r.grossCogs); // COGS if every order delivered (100%)
  const placedArr = cols.map((r) => r.ordersPlaced);
  const safe = (num: number, den: number) => (den ? num / den : 0);
  const tMkt = sum(marketing);
  const tGrossRev = sum(grossRev);
  const tGrossCogs = sum(grossCogs);
  const tPlaced = sum(placedArr);
  const buildRatioLines = (netProfit: number[], realRev: number[], realCogs: number[], realOrders: number[]): Line[] => {
    const fixedCost = cols.map((_, i) => contributionProfit[i] - netProfit[i]);
    const tFixed = sum(fixedCost);
    const tRealRev = sum(realRev);
    const tRealCogs = sum(realCogs);
    const tRealOrders = sum(realOrders);
    // CPA Limit = the most we can pay per order and still break even: per-order
    // gross margin after the order's share of fixed cost, i.e.
    // (Revenue - COGS - Fixed) / Orders. Identical in both sections.
    const cpaLimit = cols.map((_, i) => safe(realRev[i] - realCogs[i] - fixedCost[i], realOrders[i]));
    const cpaLimitTotal = safe(tRealRev - tRealCogs - tFixed, tRealOrders);
    // Break-Even ROAS = (COGS + Marketing + Fixed) / Marketing - the ROAS at
    // which revenue exactly covers every cost (net profit = 0), so ROAS above
    // this line is profitable overall. Real uses the delivered-basis COGS;
    // Meta Dashboard uses 100%-delivered COGS (grossCogs), matching that
    // section's 100%-delivered revenue.
    const realBreakEvenRoas = cols.map((_, i) => safe(realCogs[i] + marketing[i] + fixedCost[i], marketing[i]));
    const realBreakEvenRoasTotal = safe(tRealCogs + tMkt + tFixed, tMkt);
    const metaBreakEvenRoas = cols.map((_, i) => safe(grossCogs[i] + marketing[i] + fixedCost[i], marketing[i]));
    const metaBreakEvenRoasTotal = safe(tGrossCogs + tMkt + tFixed, tMkt);
    return [
      { label: "Real Ratios", values: cols.map(() => 0), kind: "header", bold: true, blankBefore: true },
      { label: "ROAS", values: cols.map((_, i) => safe(realRev[i], marketing[i])), total: safe(tRealRev, tMkt), kind: "decimal", small: true },
      { label: "Break-Even ROAS", values: realBreakEvenRoas, total: realBreakEvenRoasTotal, kind: "decimal", small: true },
      { label: "CPA", values: cols.map((_, i) => safe(marketing[i], realOrders[i])), total: safe(tMkt, tRealOrders), kind: "money-profit", small: true },
      { label: "CPA Limit", values: cpaLimit, total: cpaLimitTotal, kind: "money-profit", small: true },
      { label: "Fixed Cost / Order", values: cols.map((_, i) => safe(fixedCost[i], realOrders[i])), total: safe(tFixed, tRealOrders), kind: "money-profit", small: true },
      { label: "Meta Dashboard Ratios", values: cols.map(() => 0), kind: "header", bold: true, blankBefore: true },
      { label: "ROAS", values: cols.map((_, i) => safe(grossRev[i], marketing[i])), total: safe(tGrossRev, tMkt), kind: "decimal", small: true },
      { label: "Break-Even ROAS", values: metaBreakEvenRoas, total: metaBreakEvenRoasTotal, kind: "decimal", small: true },
      { label: "CPA", values: cols.map((_, i) => safe(marketing[i], placedArr[i])), total: safe(tMkt, tPlaced), kind: "money-profit", small: true },
      { label: "CPA Limit", values: cpaLimit, total: cpaLimitTotal, kind: "money-profit", small: true },
      { label: "Fixed Cost / Order", values: cols.map((_, i) => safe(fixedCost[i], placedArr[i])), total: safe(tFixed, tPlaced), kind: "money-profit", small: true },
    ];
  };

  // A below-Contribution cost line (non-editable). Shown negated so an expense
  // renders in brackets by fmtMoney; the net calc uses the raw amounts. Shipping
  // Differences uses the same helper, so a positive raw value (we paid the
  // courier more than we charged) renders as a net cost.
  const cost = (label: string, amounts: number[], blankBefore = false): Line => ({
    label,
    values: amounts.map((v) => -v),
    kind: "money-cost",
    band: 3,
    small: true,
    blankBefore,
  });

  // One series per owner-added P&L account, in first-seen column order so the
  // line order is stable. `zeroOpen` blanks the still-open day in the daily
  // view, matching how the fixed overheads are shown there.
  type CustomSeries = { accountId: number; name: string; kind: "income" | "expense"; values: number[] };
  const customSeries = (zeroOpen: boolean): CustomSeries[] => {
    const today = egyptToday();
    const seen = new Map<number, { name: string; kind: "income" | "expense" }>();
    for (const r of cols) {
      for (const l of r.customLines) if (!seen.has(l.accountId)) seen.set(l.accountId, { name: l.name, kind: l.kind });
    }
    return [...seen.entries()].map(([accountId, meta]) => ({
      accountId,
      name: meta.name,
      kind: meta.kind,
      values: cols.map((r) =>
        zeroOpen && (!r.date || r.date === today) ? 0 : r.customLines.find((l) => l.accountId === accountId)?.amount ?? 0
      ),
    }));
  };

  // The below-Contribution section (identical line set for daily and monthly);
  // callers pass each line's per-column values and the ratio bases.
  const belowContribution = (
    salary: number[],
    marketingAgencyFee: number[],
    postProduction: number[],
    subscription: number[],
    rent: number[],
    transportation: number[],
    other: number[],
    shippingDiff: number[],
    bostaPenalty: number[],
    nextDayFee: number[],
    openPackageFee: number[],
    custom: CustomSeries[],
    realRev: number[],
    realCogs: number[],
    realOrders: number[]
  ): Line[] => {
    const customExpense = custom.filter((c) => c.kind === "expense");
    const customIncome = custom.filter((c) => c.kind === "income");
    // "Other - Income" is intentionally excluded from the Income Statement (per
    // the owner): it no longer appears as a line and no longer adds to Net
    // Income. Owner-added income accounts flagged into the P&L still apply.
    const netIncome = cols.map(
      (_, i) =>
        contributionProfit[i] -
        salary[i] -
        marketingAgencyFee[i] -
        postProduction[i] -
        subscription[i] -
        rent[i] -
        transportation[i] -
        other[i] -
        bostaPenalty[i] -
        nextDayFee[i] -
        openPackageFee[i] +
        shippingDiff[i] -
        customExpense.reduce((s, c) => s + c.values[i], 0) +
        customIncome.reduce((s, c) => s + c.values[i], 0)
    );
    return [
      cost("Salary", salary, true),
      // Directly under Salary, per the owner. Derived from the Meta + TikTok
      // spend already shown above Contribution Profit, not from anything
      // recorded, so it tracks marketing automatically month to month.
      cost("Marketing Agency Fees", marketingAgencyFee),
      // Post Production, Subscription, Rent and Transportation are deliberately
      // NOT shown, per the owner (2026-09-18) - on the Income Statement only.
      // They are still charged: every one of them is subtracted in netIncome
      // above, and they keep their own lines on the Expense pages, which is
      // where they are recorded and analysed. The consequence to know about is
      // that the visible cost lines no longer sum to Net Income - the gap is
      // exactly these four. Put them back by restoring the four cost() calls;
      // nothing else needs to change.
      cost("Other - Expense", other),
      // Owner-added expense accounts, each its own line, right after the
      // catch-all "Other - Expense" they would otherwise have been lumped into.
      ...customExpense.map((c) => cost(c.name, c.values)),
      ...customIncome.map(
        (c): Line => ({ label: c.name, values: c.values, kind: "money-profit", band: 3, small: true })
      ),
      // Shown with its raw sign: negative (bracketed) when we pay the courier
      // more than we charge the customer (a net shipping cost), positive when
      // we charge more. The net calc uses this same signed value.
      { label: "Shipping Differences", values: shippingDiff, kind: "money-cost", band: 3, small: true },
      cost("Bosta Penalty", bostaPenalty),
      cost("Next Day fees", nextDayFee),
      // Charged on every order whatever the outcome, so it sits on its own line
      // rather than inside Bosta Penalty / Shipping Differences. Zero from
      // 2026-08-04, when the fee was closed with Bosta (the Next Day fee above
      // was not - Miraj still pays that one).
      cost("Open Package fees", openPackageFee),
      { label: "Net Income", values: netIncome, kind: "money-profit", bold: true, subtotal: true, blankBefore: true },
      netMarginLine(netIncome),
      ...buildRatioLines(netIncome, realRev, realCogs, realOrders),
    ];
  };

  // Daily view: same detailed lines as monthly. Each overhead's per-day share is
  // already on the row (from daily-pnl); the still-open day is shown as zero (its
  // row is zeroed) so it isn't read as a pure loss.
  if (opts?.collapseFixed) {
    const today = egyptToday();
    const isOpen = (r: DailyPnlRow) => !r.date || r.date === today;
    const share = (get: (r: DailyPnlRow) => number) => cols.map((r) => (isOpen(r) ? 0 : get(r)));
    const bostaPenalty = cols.map((r) => (isOpen(r) ? 0 : r.bostaPenalty));
    const shippingDiff = cols.map((r) => (isOpen(r) ? 0 : r.shippingDifferencesFee));
    const nextDayFee = cols.map((r) => (isOpen(r) ? 0 : r.nextDayFee));
    const openPackageFee = cols.map((r) => (isOpen(r) ? 0 : r.openPackageFee));
    // Daily "Real" basis = expected delivered = all orders x expected delivery
    // rate (a single day is still in transit, so actual delivered is misleading).
    // An open day uses the rate its own money was struck at. Orders are the
    // received count, not placed: the rate's denominator already holds the
    // cancellations, so scaling the cancellation-free count by it would drop
    // them twice.
    const rateOf = (r: DailyPnlRow) => r.projectionRate?.rate ?? opts.rate ?? 1;
    const realRev = cols.map((r) => r.grossRevenue * rateOf(r));
    const realCogs = cols.map((r) => r.grossCogs * rateOf(r));
    const realOrders = cols.map((r) => r.ordersReceived * rateOf(r));
    return [
      deliveryRateLine,
      ...topLines,
      ...belowContribution(
        share((r) => r.salary),
        share((r) => r.marketingAgencyFee),
        share((r) => r.postProduction),
        share((r) => r.subscription),
        share((r) => r.rent),
        share((r) => r.transportation),
        share((r) => r.other),
        shippingDiff,
        bostaPenalty,
        nextDayFee,
        openPackageFee,
        customSeries(true),
        realRev,
        realCogs,
        realOrders
      ),
    ];
  }

  // Monthly view. Each overhead is the sum of its per-day shares across the
  // month (= the month's resolved amount); Bosta Penalty and Shipping
  // Differences are computed from the orders. Meta is already subtracted above.
  return [
    deliveryRateLine,
    ...topLines,
    ...belowContribution(
      cols.map((r) => r.salary),
      cols.map((r) => r.marketingAgencyFee),
      cols.map((r) => r.postProduction),
      cols.map((r) => r.subscription),
      cols.map((r) => r.rent),
      cols.map((r) => r.transportation),
      cols.map((r) => r.other),
      cols.map((r) => r.shippingDifferencesFee),
      cols.map((r) => r.bostaPenalty),
      cols.map((r) => r.nextDayFee),
      cols.map((r) => r.openPackageFee),
      customSeries(false),
      revenue,
      cogs,
      cols.map((r) => r.ordersDelivered)
    ),
  ];
}

export function WeeklyTable({
  rows,
  openMonthInfo,
  expectedDeliveryRate,
  endDate,
  onEndDateChange,
}: {
  rows: DailyPnlRow[];
  openMonthInfo: OpenMonthInfo | null;
  // The last mature month's delivery rate, shown in place of each day's own -
  // see buildLines. Daily view only; the monthly view uses real per-month rates.
  expectedDeliveryRate: ExpectedDeliveryRate;
  // Shared with the Performance/Actual tab toggle (lifted to IncomeStatementTabs)
  // so switching tabs keeps browsing the same calendar window instead of
  // always snapping back to the latest days - each mode's rows array has
  // different (sparser) dates, so the window is looked up by date, not by
  // array index, and stays meaningful across tabs. null = show the latest.
  endDate: string | null;
  onEndDateChange: (date: string) => void;
}) {
  const isMobile = useIsMobile();
  const WINDOW = isMobile ? WINDOW_MOBILE : WINDOW_DESKTOP;

  if (rows.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-400">No orders in this date range.</div>;
  }

  const firstAfterEndDate = endDate ? rows.findIndex((r) => r.date > endDate) : -1;
  const endIndex = firstAfterEndDate === -1 ? rows.length : firstAfterEndDate;

  const start = Math.max(0, endIndex - WINDOW);
  const window = padToWindow(rows.slice(start, endIndex), WINDOW);
  const canGoEarlier = start > 0;
  const canGoLater = endIndex < rows.length;

  function shiftWindow(delta: number) {
    const newEndIndex = Math.min(rows.length, Math.max(WINDOW, endIndex + delta));
    onEndDateChange(rows[newEndIndex - 1].date);
  }
  const windowTouchesOpenMonth = openMonthInfo !== null && window.some((r) => r.date >= openMonthInfo.month);
  const openMonthOrders = openMonthInfo
    ? rows
        .filter((r) => r.date >= openMonthInfo.month)
        .reduce((acc, r) => ({ placed: acc.placed + r.ordersPlaced, resolved: acc.resolved + r.ordersResolved }), {
          placed: 0,
          resolved: 0,
        })
    : null;

  // Same rate on both: openMonthInfo.rate IS getProjectionRate(mode), so the
  // Delivery Rate row and the expected-delivered basis the ratios use below it
  // are the same number. expectedDeliveryRate covers the case where the window
  // sits entirely inside closed months and there is no open month at all.
  const lines = buildLines(window, {
    collapseFixed: true,
    rate: openMonthInfo?.rate ?? expectedDeliveryRate.rate ?? undefined,
    expected: expectedDeliveryRate,
  });

  return (
    <div className="space-y-2">
      {windowTouchesOpenMonth && openMonthInfo && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {fmtMonth(openMonthInfo.month)} is still settling - figures are projected using{" "}
          {openMonthInfo.sourceMonth ? fmtMonth(openMonthInfo.sourceMonth) : "the default"}&apos;s delivery rate (
          {(openMonthInfo.rate * 100).toFixed(1)}%), not yet real per-order outcomes.{" "}
          {openMonthOrders && openMonthOrders.placed > 0 && (
            <>
              {openMonthOrders.resolved}/{openMonthOrders.placed} orders resolved so far (
              {((openMonthOrders.resolved / openMonthOrders.placed) * 100).toFixed(1)}%).
            </>
          )}{" "}
          {earlierProjectionNote(rows, openMonthInfo)}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-gray-500">
          {fmtDate(window[0].date)} – {fmtDate(window[window.length - 1].date)}
        </span>
        <button
          type="button"
          disabled={!canGoEarlier}
          onClick={() => shiftWindow(-1)}
          className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Earlier day"
        >
          ◀
        </button>
        <button
          type="button"
          disabled={!canGoLater}
          onClick={() => shiftWindow(1)}
          className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Later day"
        >
          ▶
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200">
              <th className="px-2 py-2 text-left text-xs font-medium uppercase text-gray-400">Line item</th>
              {window.map((r) => (
                <th key={r.date} className="px-4 py-2 text-right text-sm font-semibold text-gray-900">
                  {fmtDate(r.date)}
                </th>
              ))}
              <th className="border-l-2 border-l-gray-400 px-4 py-2 text-right text-sm font-semibold text-gray-900">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <LineRow key={i} line={line} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LineRow({ line }: { line: Line }) {
  const bg = line.band !== undefined ? "bg-gray-200" : "";
  const cellSizeClass = line.small ? "text-xs" : "text-sm";
  const cellStyle = line.small ? { color: BRAND_NAVY } : undefined;
  const borderTop = line.subtotal ? "border-t-2 border-t-gray-400" : "";
  const totalDivider = "border-l-2 border-l-gray-400";

  // Ratio (Orders Resolved) totals as resolved-sum/placed-sum, not a sum of
  // daily ratios; percent lines use the caller-supplied total (a true rate
  // over the window); everything else is a plain sum of the daily values.
  const total =
    line.kind === "ratio"
      ? sum(line.values)
      : line.kind === "percent" || line.kind === "decimal"
        ? line.total ?? 0
        : line.total ?? sum(line.values);
  const totalDenominator = line.kind === "ratio" ? sum(line.ratioTotals!) : undefined;

  return (
    <>
      {line.blankBefore && (
        <tr>
          <td className="h-3" colSpan={line.values.length + 2} />
        </tr>
      )}
      <tr className={bg}>
        <td
          className={`${borderTop} px-2 py-1.5 ${cellSizeClass} ${line.bold ? "font-bold text-gray-900" : "text-gray-700"}`}
          style={cellStyle}
        >
          {line.label}
        </td>
        {line.values.map((v, i) => {
          const negative = line.subtotal && v < 0;
          const valueColor = negative ? "text-red-700" : "text-gray-900";
          return (
            <td
              key={i}
              className={`${borderTop} px-1 py-1.5 text-right ${cellSizeClass} ${
                line.bold ? `font-bold ${valueColor}` : valueColor
              }`}
              style={cellStyle}
            >
              {line.kind === "header" ? (
                ""
              ) : line.kind === "decimal" ? (
                v.toFixed(2)
              ) : line.kind === "percent" ? (
                `${v.toFixed(0)}%`
              ) : line.kind === "ratio" ? (
                `${v}/${line.ratioTotals![i]}`
              ) : line.kind === "count" ? (
                v
              ) : (
                fmtMoney(v)
              )}
            </td>
          );
        })}
        {(() => {
          const negative = line.subtotal && total < 0;
          const valueColor = negative ? "text-red-700" : "text-gray-900";
          return (
            <td
              className={`${borderTop} ${totalDivider} px-2 py-1.5 text-right ${cellSizeClass} ${
                line.bold ? `font-bold ${valueColor}` : valueColor
              }`}
              style={cellStyle}
            >
              {line.kind === "header"
                ? ""
                : line.kind === "decimal"
                  ? total.toFixed(2)
                  : line.kind === "percent"
                    ? `${total.toFixed(0)}%`
                    : line.kind === "ratio"
                      ? `${total}/${totalDenominator}`
                      : line.kind === "count"
                        ? total
                        : fmtMoney(total)}
            </td>
          );
        })()}
      </tr>
    </>
  );
}
