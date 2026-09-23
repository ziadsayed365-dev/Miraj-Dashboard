"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { DailyPnlRow, OpenMonthInfo } from "@/lib/reports/daily-pnl";
import type { AnalysisAccount } from "@/lib/reports/expenses-ledger";
import { resolveEndedMonthOverheads, type Overheads, type OverheadKey } from "@/lib/pnl-fixed-expenses";

// The Expense Analysis rolls the all-time daily P&L rows up into one column per
// calendar month, then reports each expense three ways (share of sales, month-
// over-month growth, and cost per delivered order). Report-only — no data entry
// here; expense amounts are entered on the monthly Income Statement.
const MONTHLY_START = "2025-07";

// Below-contribution expenses, matching the monthly Income Statement's line
// items (marketing is excluded here - it's analysed on the Income Statement and
// Analysis by Product). Positive = the amount by which this line reduces profit
// (an expense), so every metric reads on one consistent "bigger = more cost" basis.
//   - perDay: cost that lives on each daily P&L row (computed courier fees); it's
//     SUMMED across the month's days.
//   - overheadKey: a single owner-entered monthly figure, applied ONCE. (Summing
//     it per-day would multiply it by the number of days with orders that month.)
type ExpenseSpec = {
  label: string;
  perDay?: (r: DailyPnlRow) => number; // summed across the month's days
  overheadKey?: OverheadKey; // resolved once per month: recorded actuals from the cutover on, hardcoded before
  analysisByMonth?: Record<string, number>; // analysis-only account: signed amount per month, applied once
  analysisOnly?: boolean; // true for owner-added accounts NOT in the Income Statement
  analysisKind?: "income" | "expense"; // for the row's tag
};

// Marketing + computed fees come off each daily row; the six fixed overheads are
// resolved per MONTH so the report shows what was actually recorded from
// EXPENSE_CUTOVER_MONTH on (hardcoded before). Matches the Income Statement's
// below-contribution lines.
const EXPENSES: ExpenseSpec[] = [
  { label: "Salary", overheadKey: "salary" },
  // Derived from ad spend, so it comes off the daily rows like the computed
  // courier fees rather than from a recorded monthly figure.
  { label: "Marketing Agency Fees", perDay: (r) => r.marketingAgencyFee },
  { label: "Post Production", overheadKey: "postProduction" },
  { label: "Subscription", overheadKey: "subscription" },
  { label: "Rent", overheadKey: "rent" },
  { label: "Transportation", overheadKey: "transportation" },
  { label: "Other - Expense", overheadKey: "other" },
  // Signed (shipping charged − courier fee); a net credit shows as negative.
  { label: "Shipping Differences", perDay: (r) => -r.shippingDifferencesFee },
  // Computed on the P&L: returned-order courier + open-package cost.
  { label: "Bosta Penalty", perDay: (r) => r.bostaPenalty },
  { label: "Next Day fees", perDay: (r) => r.nextDayFee },
  // Charged on every order whatever the outcome; zero from 2026-08-04.
  { label: "Open Package fees", perDay: (r) => r.openPackageFee },
];

type MonthAgg = {
  month: string; // "YYYY-MM"
  revenue: number;
  deliveredOrders: number;
  costs: number[]; // one per EXPENSES row, same order
};

type Metric = "amount" | "pctSales" | "growth" | "perOrder";

const METRICS: { key: Metric; label: string }[] = [
  { key: "amount", label: "Amount (EGP)" },
  { key: "pctSales", label: "% of Sales" },
  { key: "growth", label: "Growth MoM" },
  { key: "perOrder", label: "Per Delivered Order" },
];

function fmtMonthShort(month: string): string {
  const date = new Date(month + "-01T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function fmtMonthLong(month: string): string {
  const date = new Date(month + "-01T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// Whole-EGP amount; a credit (negative, e.g. Shipping Differences) shows in
// parentheses, matching the Income Statement's convention.
function fmtMoney(n: number): string {
  const r = Math.round(n);
  const abs = Math.abs(r).toLocaleString("en-US");
  return r < 0 ? `(${abs})` : abs;
}

export function ExpenseAnalysisTab({
  rows,
  openMonthInfo,
  isOwner,
  recordedOverheads,
  recordedOtherIncome,
  analysisAccounts,
}: {
  rows: DailyPnlRow[];
  openMonthInfo: OpenMonthInfo | null;
  isOwner: boolean;
  recordedOverheads: Record<string, Overheads>;
  recordedOtherIncome: Record<string, number>;
  analysisAccounts: AnalysisAccount[];
}) {
  const [metric, setMetric] = useState<Metric>("amount");

  // The fixed P&L expense lines, then the "Other - Income" P&L credit, then one
  // analysis-only row per owner-added account (those never touch the Income
  // Statement). Income is a CREDIT, so its recorded amounts enter the cost-
  // oriented report negated - the same signed convention as Shipping Differences.
  const specs = useMemo<ExpenseSpec[]>(() => {
    const negate = (byMonth: Record<string, number>) => {
      const out: Record<string, number> = {};
      for (const [m, v] of Object.entries(byMonth)) out[m] = -v;
      return out;
    };
    return [
      ...EXPENSES,
      // A real Income Statement line (adds to Net Income), shown here as a credit.
      { label: "Other - Income", analysisByMonth: negate(recordedOtherIncome), analysisKind: "income" as const },
      // Owner-added accounts. Those flagged into the P&L carry their own named
      // Income Statement line, so they are NOT tagged "not in P&L" here.
      ...analysisAccounts.map((a) => ({
        label: a.name,
        analysisByMonth: a.kind === "income" ? negate(a.byMonth) : { ...a.byMonth },
        analysisOnly: !a.inIncomeStatement,
        analysisKind: a.kind,
      })),
    ];
  }, [analysisAccounts, recordedOtherIncome]);

  const months = useMemo<MonthAgg[]>(() => {
    // Each month's six overheads, resolved by the same shared rule the Income
    // Statement's server-side resolver uses - hardcoded where the table names
    // the month, recorded actuals otherwise - so this report and the statement
    // can never show a month two different ways.
    const overheadFor = (month: string): Overheads =>
      resolveEndedMonthOverheads(month, recordedOverheads[month]);

    const byMonth = new Map<string, MonthAgg>();
    for (const r of rows) {
      const month = r.date.slice(0, 7);
      if (month < MONTHLY_START) continue;
      let m = byMonth.get(month);
      if (!m) {
        m = { month, revenue: 0, deliveredOrders: 0, costs: specs.map(() => 0) };
        byMonth.set(month, m);
      }
      m.revenue += r.revenue;
      m.deliveredOrders += r.ordersDelivered;
      // Per-day lines (marketing + computed fees) sum across the month's days.
      specs.forEach((e, i) => {
        if (e.perDay) m!.costs[i] += e.perDay(r);
      });
    }
    // Overhead + analysis-only lines apply their resolved monthly amount once.
    for (const m of byMonth.values()) {
      const ov = overheadFor(m.month);
      specs.forEach((e, i) => {
        if (e.overheadKey) m.costs[i] += ov[e.overheadKey];
        if (e.analysisByMonth) m.costs[i] += e.analysisByMonth[m.month] ?? 0;
      });
    }
    return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  }, [rows, recordedOverheads, specs]);

  // Total Expenses row = sum of every expense line, per month.
  const totalCosts = useMemo(() => months.map((m) => m.costs.reduce((a, b) => a + b, 0)), [months]);

  // Row order is FIXED across every metric view: ranked by total amount (EGP),
  // largest expense first. Derived once from the Amount totals so % of Sales,
  // Growth MoM and Per Delivered Order all show the same ranking.
  const rowOrder = useMemo(() => {
    const totals = specs.map((_, i) => months.reduce((s, m) => s + m.costs[i], 0));
    return specs.map((_, i) => i).sort((a, b) => totals[b] - totals[a]);
  }, [months, specs]);

  const openMonth = openMonthInfo ? openMonthInfo.month.slice(0, 7) : null;

  // Metric value for a given expense row's cost series at column index i, and
  // for the summary column (period aggregate). Returns null where undefined
  // (no revenue/orders, or no prior month for growth) so it renders as "—".
  function cellValue(costs: number[], revenues: number[], orders: number[], i: number): number | null {
    const c = costs[i];
    if (metric === "amount") return c;
    if (metric === "pctSales") return revenues[i] ? (c / revenues[i]) * 100 : null;
    if (metric === "perOrder") return orders[i] ? c / orders[i] : null;
    // growth
    if (i === 0) return null;
    const prev = costs[i - 1];
    return prev === 0 ? null : ((c - prev) / Math.abs(prev)) * 100;
  }
  function summaryValue(costs: number[], revenues: number[], orders: number[]): number | null {
    const totalCost = costs.reduce((a, b) => a + b, 0);
    if (metric === "amount") return totalCost;
    if (metric === "pctSales") {
      const totalRev = revenues.reduce((a, b) => a + b, 0);
      return totalRev ? (totalCost / totalRev) * 100 : null;
    }
    if (metric === "perOrder") {
      const totalOrders = orders.reduce((a, b) => a + b, 0);
      return totalOrders ? totalCost / totalOrders : null;
    }
    // growth: whole-period change, first month → last month
    const first = costs.find((c) => c !== 0);
    const last = [...costs].reverse().find((c) => c !== 0);
    if (first === undefined || last === undefined || first === 0) return null;
    return ((last - first) / Math.abs(first)) * 100;
  }

  const revenues = months.map((m) => m.revenue);
  const orders = months.map((m) => m.deliveredOrders);

  function fmt(v: number | null): string {
    if (v === null) return "—";
    if (metric === "amount") return fmtMoney(v);
    if (metric === "perOrder") return Math.round(v).toLocaleString("en-US");
    // pctSales / growth are percentages
    const sign = metric === "growth" && v > 0 ? "+" : "";
    return `${sign}${v.toFixed(1)}%`;
  }

  // Growth colouring: a rising cost is unfavourable (red), a falling cost
  // favourable (green). The other metrics stay neutral.
  function cellColor(v: number | null): string {
    if (v === null) return "text-gray-300";
    if (metric !== "growth") return "text-gray-800";
    if (v > 0.05) return "text-red-700";
    if (v < -0.05) return "text-green-700";
    return "text-gray-800";
  }

  if (months.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-400">No monthly data yet.</div>;
  }

  const summaryLabel = metric === "amount" ? "Total" : metric === "growth" ? "Full period" : "Overall";
  const totalRevenue = months.reduce((a, m) => a + m.revenue, 0);

  // The Delivered Revenue row takes on the selected tab's concept: its own
  // month-over-month growth in the Growth MoM tab, revenue per delivered order
  // in the Per Delivered Order tab; the EGP base in Amount / % of Sales.
  function revenueValue(i: number): number | null {
    if (metric === "perOrder") return orders[i] ? revenues[i] / orders[i] : null;
    if (metric === "growth") {
      if (i === 0) return null;
      const prev = revenues[i - 1];
      return prev === 0 ? null : ((revenues[i] - prev) / Math.abs(prev)) * 100;
    }
    return revenues[i];
  }
  function revenueSummaryValue(): number | null {
    if (metric === "perOrder") {
      const o = orders.reduce((a, b) => a + b, 0);
      return o ? totalRevenue / o : null;
    }
    if (metric === "growth") {
      const first = revenues.find((v) => v !== 0);
      const last = [...revenues].reverse().find((v) => v !== 0);
      return first === undefined || last === undefined || first === 0 ? null : ((last - first) / Math.abs(first)) * 100;
    }
    return totalRevenue;
  }
  function fmtRevenue(v: number | null): string {
    if (v === null) return "—";
    if (metric === "growth") return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
    if (metric === "perOrder") return Math.round(v).toLocaleString("en-US");
    return fmtMoney(v);
  }
  // Revenue growth is favourable when it rises (green), unlike a cost.
  function revenueColor(v: number | null): string {
    if (metric !== "growth" || v === null) return "";
    return v > 0.05 ? "text-green-700" : v < -0.05 ? "text-red-700" : "";
  }

  return (
    <div className="space-y-4">
      {isOwner && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          Report only. Expenses come from the monthly Income Statement (entered there). &ldquo;% of Sales&rdquo; is each expense over that month&rsquo;s Delivered Revenue (shown in the first row).
          {openMonth && months.some((m) => m.month === openMonth) && (
            <> {fmtMonthLong(openMonth)} is still settling, so its figures are projected — treat that column as partial.</>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500">View:</span>
        <div className="flex gap-1 rounded-md border border-gray-200 bg-gray-50 p-0.5">
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMetric(m.key)}
              className={`rounded px-3 py-1 text-xs font-medium ${
                metric === m.key ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {isOwner && <AddAccountControl />}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200">
              <th className="sticky left-0 z-10 bg-gray-200 px-3 py-2 text-left text-xs font-medium uppercase text-gray-400">
                Expense
              </th>
              {months.map((m) => (
                <th
                  key={m.month}
                  className={`px-3 py-2 text-right text-xs font-semibold ${
                    m.month === openMonth ? "text-amber-700" : "text-gray-900"
                  }`}
                >
                  {fmtMonthShort(m.month)}
                </th>
              ))}
              <th className="border-l-2 border-l-gray-400 px-3 py-2 text-right text-xs font-semibold text-gray-900">
                {summaryLabel}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {/* The base that "% of Sales" divides by (and general context for
                the other views): delivered revenue per month, always in EGP. */}
            <tr className="bg-blue-50/50 text-gray-600">
              <td className="sticky left-0 z-10 bg-blue-50 px-3 py-1.5 text-xs font-semibold uppercase text-gray-500">
                Delivered Revenue
              </td>
              {months.map((_, i) => (
                <td key={i} className={`px-3 py-1.5 text-right text-xs ${revenueColor(revenueValue(i))}`}>
                  {fmtRevenue(revenueValue(i))}
                </td>
              ))}
              <td className={`border-l-2 border-l-gray-400 px-3 py-1.5 text-right text-xs font-semibold ${revenueColor(revenueSummaryValue())}`}>
                {fmtRevenue(revenueSummaryValue())}
              </td>
            </tr>
            {rowOrder.map((rowIdx) => {
              const e = specs[rowIdx];
              const costs = months.map((m) => m.costs[rowIdx]);
              return (
                <tr key={e.label} className="text-gray-700">
                  <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-gray-700">
                    {e.label}
                    {e.analysisOnly && (
                      <span
                        className={`ml-1.5 rounded px-1 py-0.5 text-[9px] font-medium uppercase ${
                          e.analysisKind === "income" ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {e.analysisKind === "income" ? "income · not in P&L" : "not in P&L"}
                      </span>
                    )}
                  </td>
                  {months.map((_, i) => {
                    const v = cellValue(costs, revenues, orders, i);
                    return (
                      <td key={i} className={`px-3 py-1.5 text-right ${cellColor(v)}`}>
                        {fmt(v)}
                      </td>
                    );
                  })}
                  <td className={`border-l-2 border-l-gray-400 px-3 py-1.5 text-right font-medium ${cellColor(summaryValue(costs, revenues, orders))}`}>
                    {fmt(summaryValue(costs, revenues, orders))}
                  </td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-gray-900">
              <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2">Total Expenses</td>
              {months.map((_, i) => {
                const v = cellValue(totalCosts, revenues, orders, i);
                return (
                  <td key={i} className={`px-3 py-2 text-right ${cellColor(v)}`}>
                    {fmt(v)}
                  </td>
                );
              })}
              <td className={`border-l-2 border-l-gray-400 px-3 py-2 text-right ${cellColor(summaryValue(totalCosts, revenues, orders))}`}>
                {fmt(summaryValue(totalCosts, revenues, orders))}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Adds an owner-defined income/expense account. It always shows here; ticking
// "Show in Income Statement" also gives it its own named line on the P&L below
// Contribution Profit (an expense reduces Net Income, an income adds to it).
// Once created, amounts are recorded against it in the Expense Recording tab
// like any other account.
function AddAccountControl() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"expense" | "income">("expense");
  // Off by default: adding an account should never silently move Net Income.
  const [inIncomeStatement, setInIncomeStatement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/expense-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kind, inIncomeStatement }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      setName("");
      setKind("expense");
      setInIncomeStatement(false);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
      >
        + Add account
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="ml-auto flex flex-wrap items-center gap-1">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Account name"
        disabled={busy}
        className="w-40 rounded border border-gray-300 px-2 py-1 text-xs"
      />
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as "expense" | "income")}
        disabled={busy}
        className="rounded border border-gray-300 px-1.5 py-1 text-xs"
      >
        <option value="expense">Expense</option>
        <option value="income">Income</option>
      </select>
      <label className="flex cursor-pointer items-center gap-1 text-[11px] text-gray-600">
        <input
          type="checkbox"
          checked={inIncomeStatement}
          onChange={(e) => setInIncomeStatement(e.target.checked)}
          disabled={busy}
        />
        Show in Income Statement
      </label>
      <button type="submit" disabled={busy} className="rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50">
        Add
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setName("");
          setKind("expense");
          setInIncomeStatement(false);
          setError(null);
        }}
        disabled={busy}
        className="px-1 text-xs text-gray-400 hover:text-gray-600"
      >
        Cancel
      </button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
      <span className="w-full text-[10px] text-gray-400">
        {inIncomeStatement
          ? `Gets its own line on the Income Statement — recorded amounts will ${
              kind === "income" ? "ADD to" : "reduce"
            } Net Income.`
          : "Analysis only — shows here, never in the P&L."}
      </span>
    </form>
  );
}
