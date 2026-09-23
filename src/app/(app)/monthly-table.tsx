"use client";

import { useEffect, useState } from "react";
import type { DailyPnlRow, OpenMonthInfo } from "@/lib/reports/daily-pnl";
import { buildLines, LineRow, fmtMonthShort, earlierProjectionNote } from "./weekly-table";

// Monthly Income Statement starts here per Ziad's request - earlier data
// isn't presented month-by-month.
const MONTHLY_START = "2025-07";
// Show up to 7 months at once; once more than 7 exist the ◀ ▶ arrows shuffle
// back to MONTHLY_START / forward to the current month, one month per click.
const WINDOW_DESKTOP = 7;
const WINDOW_MOBILE = 3;

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

function fmtMonthLong(month: string): string {
  const date = new Date(month + "-01T00:00:00Z");
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function emptyMonth(month: string): DailyPnlRow {
  return {
    date: month, // "YYYY-MM" - column key/label only, never a real day
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
    // Never set on a month: its days can carry different projection rates.
    projectionRate: null,
    customLines: [],
  };
}

type LineType = ReturnType<typeof buildLines>[number];

// Only the plain-number fields are summed key-by-key; `customLines` is an array
// and is merged per account separately below.
type NumericKey = { [K in keyof DailyPnlRow]: DailyPnlRow[K] extends number ? K : never }[keyof DailyPnlRow];

const SUMMABLE_KEYS: NumericKey[] = [
  "ordersPlaced",
  "ordersResolved",
  "ordersReceived",
  "ordersDelivered",
  "itemsSold",
  "revenue",
  "cogs",
  "grossRevenue",
  "grossCogs",
  "grossProfit",
  "adSpend",
  "metaSpend",
  "tiktokSpend",
  "marketingAgencyFee",
  "generalAdSpend",
  "contributionProfit",
  "packaging",
  "shippingFeeCharged",
  "bostaFeesPaid",
  "shippingDifferencesFee",
  "nextDayFee",
  "openPackageFee",
  "salary",
  "postProduction",
  "subscription",
  "rent",
  "transportation",
  "other",
  "otherIncome",
  "chatOrders",
  "chatRevenue",
  "chatCogs",
  "chatItems",
  "bostaPenalty",
];

// Rolls the all-time daily rows up into one column per calendar month (from
// MONTHLY_START onward). Only months that actually have activity get a column -
// months with no data (e.g. Jan-Mar 2026, before any orders existed) are
// skipped rather than shown as empty zero columns. Every figure is additive
// across days - salaries and rent are already spread per-day in daily-pnl.ts,
// so summing them yields the correct monthly total - and the table recomputes
// margins/net from these aggregates, so a plain sum is exact.
function aggregateMonthly(rows: DailyPnlRow[]): DailyPnlRow[] {
  const byMonth = new Map<string, DailyPnlRow>();
  for (const r of rows) {
    const month = r.date.slice(0, 7);
    if (month < MONTHLY_START) continue;
    let m = byMonth.get(month);
    if (!m) {
      m = emptyMonth(month);
      byMonth.set(month, m);
    }
    for (const k of SUMMABLE_KEYS) m[k] += r[k];
    // Not summable - a month inherits the flag from any day inside it, so a
    // month built on projected revenue can be labelled as such.
    m.revenueProjected ||= r.revenueProjected;
    // Likewise not summable. Every day in the outcome-less window carries the
    // same assumption, so first-seen is the month's, and a month outside the
    // window never sets one.
    m.assumedDeliveryRate ??= r.assumedDeliveryRate;
    // Owner-added P&L accounts: sum each account's day-shares into the month,
    // keeping first-seen order so the line order matches the daily view.
    for (const l of r.customLines) {
      const cur = m.customLines.find((c) => c.accountId === l.accountId);
      if (cur) cur.amount += l.amount;
      else m.customLines.push({ ...l });
    }
  }
  return [...byMonth.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function MonthlyTable({
  rows,
  openMonthInfo,
  isOwner,
}: {
  rows: DailyPnlRow[];
  openMonthInfo: OpenMonthInfo | null;
  // Staff can read the monthly table but not pull the whole P&L out as a file.
  isOwner: boolean;
}) {
  const isMobile = useIsMobile();

  // Export the FULL monthly P&L (all months, not just the visible window) as a
  // styled .xlsx that mirrors the on-screen table: same per-kind cell formats,
  // the blank spacer rows before sections, the section-header rows, bold
  // subtotals, gray bands, red negatives, and the Total-column divider. exceljs
  // is loaded lazily so it never ships in the initial bundle.
  async function exportXlsx() {
    const allMonths = aggregateMonthly(rows);
    const exportLines = buildLines(allMonths);
    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
    // The Total column, computed exactly as LineRow does.
    const totalOf = (line: LineType): number =>
      line.kind === "ratio"
        ? sum(line.values)
        : line.kind === "percent" || line.kind === "decimal"
          ? line.total ?? 0
          : line.total ?? sum(line.values);

    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Monthly P&L", {
      views: [{ state: "frozen", xSplit: 1, ySplit: 1 }],
    });

    const lastCol = allMonths.length + 2; // Line item + one per month + Total

    // Palette mirrors the dashboard (Tailwind gray-200 bands, brand navy for the
    // "small" lines, gray-900 text, red-700 negatives, gray-400 gridlines).
    const BAND = "FFE5E7EB";
    const NAVY = "FF050A30";
    const RED = "FFB91C1C";
    const DARK = "FF111827";
    const GRID = "FF9CA3AF";
    const numFmtFor = (kind: LineType["kind"]) =>
      kind === "percent" ? '0"%"' : kind === "decimal" ? "0.00" : kind === "count" ? "#,##0" : "#,##0;(#,##0)";

    ws.getColumn(1).width = 24;
    for (let c = 2; c <= lastCol; c++) ws.getColumn(c).width = 11;

    // Header row (matches the gray thead).
    const headerRow = ws.addRow(["Line item", ...allMonths.map((r) => fmtMonthShort(r.date + "-01")), "Total"]);
    headerRow.eachCell((cell, col) => {
      cell.font = { bold: true, color: { argb: DARK } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
      cell.alignment = { horizontal: col === 1 ? "left" : "right" };
      cell.border = {
        bottom: { style: "medium", color: { argb: GRID } },
        ...(col === lastCol ? { left: { style: "medium", color: { argb: GRID } } } : {}),
      };
    });

    for (const line of exportLines) {
      if (line.blankBefore) ws.addRow([]);
      const values: (string | number | null)[] = line.values.map((v, i) =>
        line.kind === "header" ? null : line.kind === "ratio" ? `${v}/${line.ratioTotals![i]}` : v
      );
      const totalCell =
        line.kind === "header"
          ? null
          : line.kind === "ratio"
            ? `${sum(line.values)}/${sum(line.ratioTotals!)}`
            : totalOf(line);
      const row = ws.addRow([line.label, ...values, totalCell]);

      const numFmt = numFmtFor(line.kind);
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const isLabel = col === 1;
        const isTotal = col === lastCol;
        const negativeSubtotal = line.subtotal && typeof cell.value === "number" && cell.value < 0;
        cell.font = {
          bold: !!line.bold,
          size: line.small ? 10 : 11,
          color: { argb: negativeSubtotal ? RED : line.small ? NAVY : DARK },
        };
        cell.alignment = { horizontal: isLabel ? "left" : "right" };
        if (!isLabel && line.kind !== "ratio" && line.kind !== "header") cell.numFmt = numFmt;
        if (line.band !== undefined) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
        const border: Partial<Record<"top" | "left", { style: "medium"; color: { argb: string } }>> = {};
        if (line.subtotal) border.top = { style: "medium", color: { argb: GRID } };
        if (isTotal) border.left = { style: "medium", color: { argb: GRID } };
        if (border.top || border.left) cell.border = border;
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `miraj-pnl-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }
  const WINDOW = isMobile ? WINDOW_MOBILE : WINDOW_DESKTOP;
  const [endIndexOverride, setEndIndexOverride] = useState<number | null>(null);

  const months = aggregateMonthly(rows);
  if (months.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-400">No monthly data yet.</div>;
  }

  const endIndex = endIndexOverride === null ? months.length : Math.min(endIndexOverride, months.length);
  const start = Math.max(0, endIndex - WINDOW);
  const window = months.slice(start, endIndex);
  const canGoEarlier = start > 0;
  const canGoLater = endIndex < months.length;

  function shiftWindow(delta: number) {
    const next = Math.min(months.length, Math.max(WINDOW, endIndex + delta));
    setEndIndexOverride(next);
  }

  const openMonth = openMonthInfo ? openMonthInfo.month.slice(0, 7) : null;
  const windowTouchesOpenMonth = openMonth !== null && window.some((r) => r.date >= openMonth);
  const openMonthOrders =
    openMonth !== null
      ? months
          .filter((r) => r.date >= openMonth)
          .reduce((acc, r) => ({ placed: acc.placed + r.ordersPlaced, resolved: acc.resolved + r.ordersResolved }), {
            placed: 0,
            resolved: 0,
          })
      : null;

  const lines = buildLines(window);

  return (
    <div className="space-y-2">
      {windowTouchesOpenMonth && openMonthInfo && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {fmtMonthLong(openMonth!)} is still settling - figures are projected using{" "}
          {openMonthInfo.sourceMonth ? fmtMonthLong(openMonthInfo.sourceMonth.slice(0, 7)) : "the default"}&apos;s delivery rate (
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
      {(canGoEarlier || canGoLater) && (
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-gray-500">
            {fmtMonthShort(window[0].date + "-01")} – {fmtMonthShort(window[window.length - 1].date + "-01")}
          </span>
          <button
            type="button"
            disabled={!canGoEarlier}
            onClick={() => shiftWindow(-1)}
            className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Earlier month"
          >
            ◀
          </button>
          <button
            type="button"
            disabled={!canGoLater}
            onClick={() => shiftWindow(1)}
            className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 bg-white text-base text-gray-700 shadow-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Later month"
          >
            ▶
          </button>
        </div>
      )}

      {isOwner && (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={exportXlsx}
            className="rounded-md border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Export
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200">
              <th className="w-28 px-2 py-2 text-left text-xs font-medium uppercase text-gray-400">Line item</th>
              {window.map((r) => (
                <th key={r.date} className="px-1 py-2 text-right text-xs font-semibold text-gray-900">
                  {fmtMonthShort(r.date + "-01")}
                  {/* These orders never reached Bosta, so no outcome was ever
                      recorded and the whole column - revenue, COGS, courier fees
                      and Bosta Penalty alike - is struck at an assumed delivery
                      rate rather than measured. Marked so an estimate is never
                      read as a measurement. */}
                  {r.revenueProjected && (
                    <span
                      title={
                        r.assumedDeliveryRate != null
                          ? `Estimated: these orders have no delivery outcomes, so the whole month - revenue, COGS, courier fees and Bosta Penalty - is struck at an assumed ${(r.assumedDeliveryRate * 100).toFixed(0)}% delivery rate.`
                          : "Revenue and COGS are estimated: these orders have no delivery outcomes, so gross is scaled by the expected delivery rate."
                      }
                      className="ml-0.5 cursor-help font-normal text-amber-600"
                    >
                      ~
                    </span>
                  )}
                </th>
              ))}
              <th className="border-l-2 border-l-gray-400 px-2 py-2 text-right text-xs font-semibold text-gray-900">Total</th>
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
