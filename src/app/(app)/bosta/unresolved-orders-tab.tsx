"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ResolveAction, UnresolvedOrder } from "@/lib/bosta/shared";

// Orders Bosta never resolved. Most of them never went through Bosta at all -
// they were handed to the customer privately - so nothing will ever resolve
// them automatically and their revenue stays out of the Income Statement until
// someone records what happened. See src/lib/bosta/unresolved.ts.

const ACTION_LABELS: Record<ResolveAction, string> = {
  delivered_private: "Delivered privately",
  returned: "Returned",
  cancelled: "Cancelled",
  undo: "Back to in progress",
};

const ACTION_HINTS: Record<ResolveAction, string> = {
  delivered_private: "We delivered it ourselves — counts as delivered, earns its revenue, charged no courier fee.",
  returned: "It came back — treated exactly like a Bosta RTO.",
  cancelled: "It never happened — drops out of every report.",
  undo: "Put it back to unresolved.",
};

function fmtMoney(v: number | null): string {
  return v === null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

type Filter = "all" | "hand_fulfilled" | "never_shipped" | "at_courier";

// Shared by the dropdown and the exported sheet's header, so a saved file says
// what it was a list of.
const FILTER_LABELS: Record<Filter, string> = {
  all: "All unresolved",
  hand_fulfilled: "Fulfilled by hand in Shopify",
  never_shipped: "Never handed to Bosta",
  at_courier: "Still at Bosta",
};

// How Shopify's fulfilment state reads to someone looking at the row.
function shopifyLabel(o: UnresolvedOrder): { text: string; className: string } {
  if (o.handFulfilled) return { text: "Fulfilled by hand", className: "text-amber-700" };
  if (o.shopifyStatus === null) return { text: "Never fulfilled", className: "text-red-700" };
  return { text: o.shopifyStatus.replaceAll("_", " ").toLowerCase(), className: "text-gray-600" };
}

export function UnresolvedOrdersTab({ orders }: { orders: UnresolvedOrder[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [minAge, setMinAge] = useState(0);
  // Placed-date window, both ends optional (blank = open-ended).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const shown = useMemo(
    () =>
      orders.filter((o) => {
        if (o.ageDays < minAge) return false;
        // ISO dates, so a plain string compare is a date compare.
        if (from && o.day < from) return false;
        if (to && o.day > to) return false;
        if (filter === "hand_fulfilled") return o.handFulfilled;
        if (filter === "never_shipped") return !o.atCourier;
        if (filter === "at_courier") return o.atCourier;
        return true;
      }),
    [orders, filter, minAge, from, to]
  );

  const shownValue = shown.reduce((s, o) => s + (o.totalPrice ?? 0), 0);
  const selectedInView = shown.filter((o) => selected.has(o.orderNumber));
  const allShownSelected = shown.length > 0 && selectedInView.length === shown.length;

  function toggle(orderNumber: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(orderNumber)) next.add(orderNumber);
      return next;
    });
  }

  function toggleAllShown() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownSelected) for (const o of shown) next.delete(o.orderNumber);
      else for (const o of shown) next.add(o.orderNumber);
      return next;
    });
  }

  async function apply(action: ResolveAction) {
    const orderNumbers = selectedInView.map((o) => o.orderNumber);
    if (orderNumbers.length === 0) return;
    if (!confirm(`${ACTION_LABELS[action]} — apply to ${orderNumbers.length} order(s)?`)) return;

    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/bosta/resolve-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumbers, action }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error ?? `request failed (${res.status})`);
      setSelected(new Set());
      setMessage(`${ACTION_LABELS[action]}: ${body.matched} order(s) updated and margins rebuilt.`);
      router.refresh();
    } catch (err) {
      setMessage(`Failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  if (orders.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-400">Nothing unresolved — every order has a final outcome.</div>;
  }

  const neverShipped = orders.filter((o) => !o.atCourier).length;
  const handFulfilled = orders.filter((o) => o.handFulfilled);
  const handValue = handFulfilled.reduce((s, o) => s + (o.totalPrice ?? 0), 0);

  // Exports exactly what the table is showing - every filter (status, age, date
  // window) is already applied to `shown`, so the file matches the screen. The
  // active filters are written into the sheet header so a saved file still says
  // what it was a list of. exceljs is loaded lazily to keep it out of the
  // initial bundle.
  async function exportXlsx() {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Unresolved orders", { views: [{ state: "frozen", ySplit: 2 }] });

    const BAND = "FFE5E7EB";
    const DARK = "FF111827";
    const AMBER = "FFB45309";
    const GRID = "FF9CA3AF";

    const filterBits = [
      filter === "all" ? "all unresolved" : FILTER_LABELS[filter],
      minAge > 0 ? `${minAge}+ days old` : null,
      from || to ? `placed ${from || "…"} to ${to || "…"}` : null,
    ].filter(Boolean);

    const title = ws.addRow([`Unresolved orders — ${filterBits.join(", ")} — ${shown.length} order(s), ${fmtMoney(shownValue)} EGP`]);
    title.font = { bold: true, size: 11, color: { argb: DARK } };
    ws.mergeCells(1, 1, 1, 7);

    const headers = ["Order", "Placed", "Age (days)", "Where", "Shopify says", "Governorate", "Value"];
    const headerRow = ws.addRow(headers);
    headerRow.eachCell((cell, col) => {
      cell.font = { bold: true, color: { argb: DARK } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
      cell.alignment = { horizontal: col === 7 || col === 3 ? "right" : "left" };
      cell.border = { bottom: { style: "medium", color: { argb: GRID } } };
    });

    const widths = [12, 12, 11, 18, 20, 18, 12];
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

    for (const o of shown) {
      const row = ws.addRow([
        o.orderNumber,
        o.day,
        o.ageDays,
        o.atCourier ? "At Bosta" : "Never handed over",
        shopifyLabel(o).text,
        o.governorate ?? "",
        o.totalPrice ?? null,
      ]);
      row.getCell(3).numFmt = "#,##0";
      row.getCell(7).numFmt = "#,##0;(#,##0)";
      row.getCell(3).alignment = { horizontal: "right" };
      row.getCell(7).alignment = { horizontal: "right" };
      // The two columns that carry the judgement get the same amber the table
      // uses, so a scan of the file reads like a scan of the screen.
      if (o.handFulfilled) row.getCell(5).font = { color: { argb: AMBER } };
      if (!o.atCourier) row.getCell(4).font = { color: { argb: AMBER } };
    }

    const totals = ws.addRow(["Total", "", "", "", "", "", shownValue]);
    totals.font = { bold: true, color: { argb: DARK } };
    totals.getCell(7).numFmt = "#,##0;(#,##0)";
    totals.eachCell((cell) => (cell.border = { top: { style: "medium", color: { argb: GRID } } }));

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `unresolved-orders-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // One click to line up exactly the orders Shopify says were fulfilled by hand
  // - nothing is recorded until an action button is pressed.
  function selectHandFulfilled() {
    setFilter("hand_fulfilled");
    setMinAge(0);
    setFrom("");
    setTo("");
    setSelected(new Set(handFulfilled.map((o) => o.orderNumber)));
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        {orders.length} order{orders.length === 1 ? "" : "s"} have no final outcome. Shopify says{" "}
        <span className="font-medium text-amber-700">{handFulfilled.length}</span> of them were fulfilled by hand — no tracking
        number, no courier scan, nothing that will ever resolve on its own — worth {fmtMoney(handValue)} EGP. Those are almost
        certainly your private deliveries. Until they are recorded they count against your delivery rate and their revenue stays out
        of the Income Statement.
      </p>

      {handFulfilled.length > 0 && (
        <button
          type="button"
          onClick={selectHandFulfilled}
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
        >
          Select the {handFulfilled.length} fulfilled by hand
        </button>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className="rounded-md border border-gray-300 px-2 py-1.5 text-gray-700"
        >
          <option value="all">
            {FILTER_LABELS.all} ({orders.length})
          </option>
          <option value="hand_fulfilled">
            {FILTER_LABELS.hand_fulfilled} ({handFulfilled.length})
          </option>
          <option value="never_shipped">
            {FILTER_LABELS.never_shipped} ({neverShipped})
          </option>
          <option value="at_courier">
            {FILTER_LABELS.at_courier} ({orders.length - neverShipped})
          </option>
        </select>
        <select
          value={minAge}
          onChange={(e) => setMinAge(Number(e.target.value))}
          className="rounded-md border border-gray-300 px-2 py-1.5 text-gray-700"
        >
          <option value={0}>Any age</option>
          <option value={14}>14+ days old</option>
          <option value={30}>30+ days old</option>
          <option value={60}>60+ days old</option>
        </select>
        <label className="flex items-center gap-1 text-gray-500">
          Placed
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-gray-700"
          />
          <span className="text-gray-400">to</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1 text-gray-700"
          />
        </label>
        {(from || to) && (
          <button
            type="button"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
            className="text-gray-500 underline hover:text-gray-700"
          >
            clear dates
          </button>
        )}
        <span className="text-gray-400">
          {shown.length} shown · {fmtMoney(shownValue)} EGP · {selectedInView.length} selected
        </span>
        <button
          type="button"
          disabled={shown.length === 0}
          onClick={exportXlsx}
          title="Downloads exactly the rows shown, with the filters above applied"
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40"
        >
          ⬇ Export to Excel ({shown.length})
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["delivered_private", "returned", "cancelled", "undo"] as ResolveAction[]).map((a) => (
          <button
            key={a}
            type="button"
            disabled={busy || selectedInView.length === 0}
            onClick={() => apply(a)}
            title={ACTION_HINTS[a]}
            className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${
              a === "delivered_private"
                ? "bg-gray-900 text-white hover:bg-gray-700"
                : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-100"
            }`}
          >
            {busy ? "Working…" : ACTION_LABELS[a]}
          </button>
        ))}
      </div>

      {message && <p className="text-xs text-gray-700">{message}</p>}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200 text-xs uppercase text-gray-400">
              <th className="px-3 py-2 text-left">
                <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} aria-label="Select all shown" />
              </th>
              <th className="px-3 py-2 text-left">Order</th>
              <th className="px-3 py-2 text-left">Placed</th>
              <th className="px-3 py-2 text-right">Age</th>
              <th className="px-3 py-2 text-left">Where</th>
              <th className="px-3 py-2 text-left">Shopify says</th>
              <th className="px-3 py-2 text-left">Governorate</th>
              <th className="px-3 py-2 text-right">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {shown.map((o) => (
              <tr key={o.orderNumber} className={selected.has(o.orderNumber) ? "bg-gray-50" : ""}>
                <td className="px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={selected.has(o.orderNumber)}
                    onChange={() => toggle(o.orderNumber)}
                    aria-label={`Select ${o.orderNumber}`}
                  />
                </td>
                <td className="px-3 py-1.5 font-medium text-gray-900">{o.orderNumber}</td>
                <td className="px-3 py-1.5 text-gray-600">{o.day}</td>
                <td className={`px-3 py-1.5 text-right ${o.ageDays >= 60 ? "text-red-700" : "text-gray-600"}`}>{o.ageDays}d</td>
                <td className="px-3 py-1.5">
                  {o.atCourier ? (
                    <span className="text-gray-600">At Bosta</span>
                  ) : (
                    <span className="text-amber-700">Never handed over</span>
                  )}
                </td>
                <td className={`px-3 py-1.5 ${shopifyLabel(o).className}`}>{shopifyLabel(o).text}</td>
                <td className="px-3 py-1.5 text-gray-600">{o.governorate ?? "—"}</td>
                <td className="px-3 py-1.5 text-right text-gray-700">{fmtMoney(o.totalPrice)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
