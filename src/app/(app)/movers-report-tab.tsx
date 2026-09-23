"use client";

import { useMemo, useState } from "react";
import { egyptToday } from "@/lib/dates";
import type { MoversOrderReportRow } from "@/lib/movers/orders";

// Same convention as the Income Statement's WeeklyTable: parentheses for
// negative, no decimals.
function fmtMoney(n: number): string {
  const rounded = Math.round(n);
  const abs = Math.abs(rounded).toLocaleString("en-US");
  return rounded < 0 ? `(${abs})` : abs;
}

function fmtSyncedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function MoversReportTab({ rows, syncedAt }: { rows: MoversOrderReportRow[]; syncedAt: string | null }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(egyptToday());

  // Same sync-gating as the Record Data report - a flag/unflag (or the
  // margin recompute it depends on) only shows up here after the next Sync.
  const synced = useMemo(() => (syncedAt ? rows.filter((r) => r.updatedAt <= syncedAt) : []), [rows, syncedAt]);
  const pendingCount = rows.length - synced.length;

  const filtered = useMemo(
    () => synced.filter((r) => (!from || r.date >= from) && (!to || r.date <= to)),
    [synced, from, to]
  );

  const ordersPlaced = filtered.length;
  const itemsSold = filtered.reduce((sum, r) => sum + r.itemsSold, 0);
  const revenue = filtered.reduce((sum, r) => sum + r.revenue, 0);
  const cogs = filtered.reduce((sum, r) => sum + r.cogs, 0);
  const grossProfit = revenue - cogs;
  const grossMarginPct = revenue !== 0 ? (grossProfit / revenue) * 100 : 0;

  const inputClass = "mt-1 rounded border border-gray-300 px-2 py-1 text-sm";

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {syncedAt ? (
          <>
            Showing data as of the last Sync ({fmtSyncedAt(syncedAt)}).
            {pendingCount > 0 && ` ${pendingCount} new/edited order${pendingCount === 1 ? "" : "s"} will appear after the next Sync.`}
          </>
        ) : (
          "No Sync has run yet - this report will stay empty until the owner clicks Sync."
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <label className="block text-xs font-medium text-gray-500">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
        </div>
        {from && (
          <button type="button" onClick={() => setFrom("")} className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700">
            Clear from (all time)
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            <tr className="text-gray-700">
              <td className="px-3 py-2">Orders Resolved</td>
              <td className="px-3 py-2 text-right">0/{ordersPlaced}</td>
            </tr>
            <tr className="text-gray-700">
              <td className="px-3 py-2">Total Items Sold</td>
              <td className="px-3 py-2 text-right">{itemsSold}</td>
            </tr>
            <tr className="text-gray-700">
              <td className="px-3 py-2">Total Revenue</td>
              <td className="px-3 py-2 text-right">{fmtMoney(revenue)}</td>
            </tr>
            <tr className="text-gray-700">
              <td className="px-3 py-2">Total Cost</td>
              <td className="px-3 py-2 text-right">{fmtMoney(-cogs)}</td>
            </tr>
            <tr className="border-t-2 border-gray-400 font-bold text-gray-900">
              <td className="px-3 py-2">Gross Profit</td>
              <td className={`px-3 py-2 text-right ${grossProfit < 0 ? "text-red-700" : ""}`}>{fmtMoney(grossProfit)}</td>
            </tr>
            <tr className="text-gray-700">
              <td className="px-3 py-2">Gross Margin %</td>
              <td className="px-3 py-2 text-right">{grossMarginPct.toFixed(0)}%</td>
            </tr>
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-sm text-gray-400">
            {synced.length === 0 ? "No synced Movers orders to report yet." : "No Movers orders in this date range."}
          </div>
        )}
      </div>
    </div>
  );
}
