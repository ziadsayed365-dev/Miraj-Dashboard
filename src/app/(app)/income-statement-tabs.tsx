"use client";

import { useState } from "react";
import type { DailyPnlResult } from "@/lib/reports/daily-pnl";
import { WeeklyTable } from "./weekly-table";
import { MonthlyTable } from "./monthly-table";

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " EGP";
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

const TABS = [
  { key: "performance" as const, label: "Performance", subtitle: "Every Shopify order, whether or not it has shipped yet." },
  {
    key: "actual" as const,
    label: "Actual",
    subtitle: "Only orders actually handed over — with a Bosta tracking number, or delivered by us. Dated by the Shopify order day, same as Performance.",
  },
];

export function IncomeStatementTabs({
  performance,
  actual,
  from,
  to,
  isOwner,
}: {
  performance: DailyPnlResult;
  actual: DailyPnlResult;
  from: string;
  to: string;
  // Everyone can browse the monthly view; only the owner gets the xlsx export.
  isOwner: boolean;
}) {
  const [active, setActive] = useState<"performance" | "actual">("performance");
  const [granularity, setGranularity] = useState<"daily" | "monthly">("daily");
  // Shared across both tabs so switching keeps browsing the same calendar window.
  const [windowEndDate, setWindowEndDate] = useState<string | null>(null);
  const data = active === "performance" ? performance : actual;
  const tab = TABS.find((t) => t.key === active)!;
  const t = data.totals;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => setActive(tb.key)}
            className={`px-4 py-2 text-sm font-medium ${
              active === tb.key ? "border-b-2 border-gray-900 text-gray-900" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="px-4 pt-3 text-xs text-gray-400">{tab.subtitle}</div>
        <div className="space-y-4 px-4 py-4">
          <form className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <span className="self-center text-xs text-gray-400">Summary period:</span>
            <div>
              <label className="block text-xs font-medium text-gray-500">From</label>
              <input type="date" name="from" defaultValue={from} className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500">To</label>
              <input type="date" name="to" defaultValue={to} className="mt-1 rounded border border-gray-300 px-2 py-1 text-sm" />
            </div>
            <button type="submit" className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700">
              Apply
            </button>
          </form>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <SummaryCard label="Orders" value={String(t.ordersPlaced)} />
            <SummaryCard label="Items Sold" value={String(t.itemsSold)} />
            <SummaryCard label="Marketing Spend" value={fmt(t.adSpend)} />
            <SummaryCard
              label="Contribution Profit"
              value={fmt(t.contributionProfit)}
              highlight={t.contributionProfit >= 0 ? "positive" : "negative"}
            />
            <SummaryCard label="Contribution Margin %" value={pct(t.contributionProfit, t.revenue)} />
            <SummaryCard label="Net Income" value={fmt(t.netProfit)} highlight={t.netProfit >= 0 ? "positive" : "negative"} />
            <SummaryCard label="Net Margin %" value={pct(t.netProfit, t.revenue)} />
            {/* Chat orders count on both sides - real orders, always resolved.
                Added here rather than on the totals' order fields, which feed
                the Bosta delivery rate (see the Orders Resolved line in
                weekly-table.tsx). */}
            <SummaryCard
              label="Orders resolved"
              value={`${t.ordersResolved + t.chatOrders} / ${t.ordersPlaced + t.chatOrders}`}
            />
          </div>

          <div className="border-t border-gray-100 pt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-gray-400">
                {granularity === "daily"
                  ? "Day-by-day, independent of the summary period above — browse the full history with the arrows."
                  : "Month-by-month from Jan 2026, independent of the summary period above — browse with the arrows."}
              </div>
              <div className="flex gap-1 rounded-md border border-gray-200 bg-gray-50 p-0.5">
                {(["daily", "monthly"] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGranularity(g)}
                    className={`rounded px-3 py-1 text-xs font-medium capitalize ${
                      granularity === g ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
            {granularity === "daily" ? (
              <WeeklyTable
                rows={data.rows}
                openMonthInfo={data.openMonthInfo}
                expectedDeliveryRate={data.expectedDeliveryRate}
                endDate={windowEndDate}
                onEndDateChange={setWindowEndDate}
              />
            ) : (
              <MonthlyTable rows={data.rows} openMonthInfo={data.openMonthInfo} isOwner={isOwner} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "positive" | "negative";
}) {
  const color = highlight === "positive" ? "text-green-700" : highlight === "negative" ? "text-red-700" : "text-gray-900";
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}
