"use client";

import { Fragment, useState } from "react";
import type { MonthlyRate, ProductRatesResult, RateCell } from "@/lib/bosta/shared";

function fmtMonthShort(month: string): string {
  const d = new Date(month + "-01T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function fmtRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

// A delivery rate reads better with a little colour: healthy (green), soft
// (amber), weak (red). Neutral when there's no data.
function rateColor(rate: number | null): string {
  if (rate === null) return "text-gray-300";
  if (rate >= 0.85) return "text-green-700";
  if (rate >= 0.75) return "text-amber-600";
  return "text-red-700";
}

function RateCells({ months, byMonth }: { months: string[]; byMonth: Record<string, RateCell> }) {
  return (
    <>
      {months.map((m) => {
        const cell = byMonth[m];
        return (
          <td
            key={m}
            className={`px-3 py-1.5 text-right ${rateColor(cell?.rate ?? null)}`}
            title={cell ? `${cell.delivered} delivered / ${cell.received} received` : ""}
          >
            {fmtRate(cell?.rate ?? null)}
          </td>
        );
      })}
    </>
  );
}

type OrderRow = {
  orderNumber: string;
  day: string;
  status: string; // Delivered | Not delivered | In progress | Never handed to courier
  outcome: string | null;
  cancelled: boolean;
  trackingNumber: string | null;
  governorate: string | null;
  courier: string | null;
  totalPrice: number | null;
};

// Which slice of a month's orders to download. "" is the whole denominator.
type OrderFilter = "" | "in_progress" | "never_handed";

// delivery-<scope>-<month>.csv, the same filename shape IZAR's analysis export
// uses, so the two projects' files sit together in a downloads folder.
const FILE_SCOPE: Record<OrderFilter, string> = {
  "": "all",
  in_progress: "in-progress",
  never_handed: "never-handed-to-courier",
};

// Pulls the orders behind one month of the Overall business row and saves them
// as a CSV - every order the rate was divided by, cancellations and
// never-handed-over ones included, so the file's row count IS the denominator.
async function downloadMonthOrders(month: string, filter: OrderFilter) {
  const params = new URLSearchParams({ month });
  if (filter) params.set("status", filter);

  const res = await fetch(`/api/bosta/delivery-orders?${params}`);
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body?.error ?? `request failed (${res.status})`);

  const orders = body.orders as OrderRow[];
  // Same columns, in the same order, with the same headings as IZAR's Analysis
  // export (src/lib/shipping/analysis-export.ts there), so whoever reads both
  // files reads them the same way. Tracking Number is the one addition: it is
  // Miraj's evidence of the handover the Status column asserts.
  const header = [
    "Order Number",
    "Order Placed Date",
    "Status",
    "Courier",
    "Raw Outcome",
    "Cancelled",
    "Total Price",
    "Governorate",
    "Tracking Number",
  ];
  const rows = orders.map((o) => [
    o.orderNumber,
    o.day,
    o.status,
    o.courier ?? "",
    o.outcome ?? "",
    o.cancelled ? "YES" : "NO",
    o.totalPrice === null ? "" : String(o.totalPrice),
    o.governorate ?? "",
    o.trackingNumber ?? "",
  ]);
  // RFC-4180: quote only the cells that need it, exactly as IZAR's toCsv does.
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const BOM = String.fromCharCode(0xfeff); // so Excel opens it as UTF-8
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `delivery-${FILE_SCOPE[filter]}-${month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Spells the denominator out on hover: what the rate divided by, and which
// parts of it never had a courier attempt behind them. This is the tab's whole
// claim - that a cancellation and an order nobody shipped both count against
// the business - so it should not need taking on trust.
function denominatorTitle(o: MonthlyRate, hasOrders: boolean): string {
  const parts = [`${o.delivered.toLocaleString()} delivered / ${o.received.toLocaleString()} received`];
  if (o.mix) {
    const of: string[] = [];
    if (o.mix.cancelled > 0) of.push(`${o.mix.cancelled.toLocaleString()} cancelled`);
    if (o.mix.neverHanded > 0) of.push(`${o.mix.neverHanded.toLocaleString()} never handed to a courier`);
    if (o.mix.openAtCourier > 0) of.push(`${o.mix.openAtCourier.toLocaleString()} still at Bosta`);
    if (of.length > 0) parts.push(`including ${of.join(", ")}`);
  } else if (o.inProgress > 0) {
    parts.push(`${o.inProgress.toLocaleString()} still in progress`);
  }
  if (hasOrders) parts.push("click to download every one of them");
  return parts.join(" — ");
}

export function BostaRateTable({ overall, product }: { overall: MonthlyRate[]; product: ProductRatesResult }) {
  const months = overall.map((m) => m.month);
  const overallByMonth = new Map(overall.map((m) => [m.month, m]));
  // Models start collapsed - the subtotal rows are the summary; expand a model
  // to see its products.
  const [openModels, setOpenModels] = useState<Set<string>>(new Set());
  // Which download is in flight (one at a time - each is a full order scan, and
  // the browser can only save one file per click anyway).
  const [busy, setBusy] = useState<string | null>(null);

  function toggle(key: string) {
    setOpenModels((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  async function download(key: string, month: string, filter: OrderFilter) {
    setBusy(key);
    try {
      await downloadMonthOrders(month, filter);
    } catch (err) {
      alert(`Could not download the orders: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setBusy(null);
    }
  }

  if (months.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-gray-400">No orders yet.</div>;
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-200">
              <th className="sticky left-0 z-10 bg-gray-200 px-3 py-2 text-left text-xs font-medium uppercase text-gray-400">
                Delivery rate
              </th>
              {months.map((m) => (
                <th key={m} className="px-3 py-2 text-right text-xs font-semibold text-gray-900">
                  {fmtMonthShort(m)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            <tr className="bg-gray-50 font-semibold">
              <td className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-gray-900">Overall business</td>
              {months.map((m) => {
                const o = overallByMonth.get(m);
                const mix = o?.mix ?? null;
                // Without the mix RPC there is only the undivided open count, so
                // the badge stays as it was rather than claiming a split it
                // cannot make.
                const atCourier = mix ? mix.openAtCourier : o?.inProgress ?? 0;
                const neverHanded = mix?.neverHanded ?? 0;
                const hasOrders = (o?.received ?? 0) > 0;
                return (
                  <td
                    key={m}
                    className="px-3 py-2 text-right align-top"
                    title={o ? denominatorTitle(o, hasOrders) : ""}
                  >
                    <button
                      type="button"
                      disabled={!hasOrders || busy !== null}
                      onClick={() => download(m, m, "")}
                      className={`${rateColor(o?.rate ?? null)} ${hasOrders ? "hover:underline" : "cursor-default"} disabled:opacity-60`}
                    >
                      {busy === m ? "…" : fmtRate(o?.rate ?? null)}
                    </button>
                    {atCourier > 0 && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => download(`${m}|open`, m, "in_progress")}
                        title={`${atCourier.toLocaleString()} orders are at Bosta with no final outcome yet, so this month can still rise`}
                        className="block w-full text-right text-[10px] font-normal text-amber-600 hover:underline disabled:opacity-60"
                      >
                        {busy === `${m}|open` ? "…" : `${atCourier.toLocaleString()} at courier`}
                      </button>
                    )}
                    {neverHanded > 0 && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => download(`${m}|nh`, m, "never_handed")}
                        title={`${neverHanded.toLocaleString()} orders no courier ever received - counted in the ${o?.received.toLocaleString()} this rate divides by${
                          mix && mix.openNeverHanded > 0
                            ? `, ${mix.openNeverHanded.toLocaleString()} of them still with no recorded outcome`
                            : ""
                        }`}
                        className="block w-full text-right text-[10px] font-normal text-rose-500 hover:underline disabled:opacity-60"
                      >
                        {busy === `${m}|nh` ? "…" : `${neverHanded.toLocaleString()} never handed over`}
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>

            {product.rpcMissing ? (
              <tr>
                <td colSpan={months.length + 1} className="px-3 py-4 text-xs text-amber-700">
                  Per-product rates need a one-time setup: run <code>supabase/product-monthly-delivery.sql</code> in the Supabase SQL
                  editor, then refresh.
                </td>
              </tr>
            ) : (
              product.groups.map((group) => {
                const open = openModels.has(group.modelKey);
                return (
                  <Fragment key={group.modelKey}>
                    <tr
                      className="cursor-pointer bg-gray-100/70 font-semibold text-gray-900 hover:bg-gray-100"
                      onClick={() => toggle(group.modelKey)}
                    >
                      <td className="sticky left-0 z-10 bg-gray-100/70 px-3 py-2">
                        <span className="mr-1.5 text-[9px] text-gray-400">{open ? "▼" : "▶"}</span>
                        {group.modelKey}
                        <span className="ml-1.5 text-[10px] font-normal text-gray-400">({group.products.length})</span>
                      </td>
                      <RateCells months={months} byMonth={group.byMonth} />
                    </tr>
                    {open &&
                      group.products.map((p) => (
                        <tr key={p.productId} className="text-gray-700">
                          <td className="sticky left-0 z-10 bg-white py-1.5 pl-8 pr-3 text-gray-700">{p.name}</td>
                          <RateCells months={months} byMonth={p.byMonth} />
                        </tr>
                      ))}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400">
        Every rate here is delivered ÷ <span className="font-medium text-gray-500">every order received</span> that month — orders
        that were cancelled, and orders nobody ever handed to a courier, both stay in the denominator, because the question is how
        much of what the store took actually reached a customer. The two counts under an overall rate say how much of it is which:{" "}
        <span className="text-amber-600">n at courier</span> is at Bosta with no delivered or returned stamp yet, so that month
        isn&apos;t closed and its rate can still rise, while <span className="text-rose-500">n never handed over</span> is the orders
        no courier ever received — cancelled, delivered privately, or still sitting in the building. Click a rate to download every
        order behind it, or either count for just that slice.
      </p>
    </div>
  );
}
