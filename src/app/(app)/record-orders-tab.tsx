"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { egyptToday } from "@/lib/dates";
import type { MoversOrder } from "@/lib/movers/orders";

export function RecordOrdersTab({ initialOrders }: { initialOrders: MoversOrder[] }) {
  const router = useRouter();

  const [date, setDate] = useState(egyptToday());
  const [orderNumber, setOrderNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!orderNumber.trim()) {
      setFormError("Enter an order number.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/movers/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber, date }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to flag order");

      setOrderNumber("");
      router.refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to flag order");
    } finally {
      setSubmitting(false);
    }
  }

  const allSelected = initialOrders.length > 0 && initialOrders.every((o) => selectedIds.has(o.id));

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(initialOrders.map((o) => o.id)));
  }

  async function handleRemoveSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Unflag ${selectedIds.size} order(s) back to Bosta?`)) return;

    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await fetch("/api/movers/orders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to unflag orders");
      setSelectedIds(new Set());
      router.refresh();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Failed to unflag orders");
    } finally {
      setRemoving(false);
    }
  }

  const inputClass = "mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm";

  return (
    <div className="space-y-4">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <div className="w-full sm:w-auto">
          <label className="block text-xs font-medium text-gray-500">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required className={inputClass} />
        </div>
        <div className="w-full sm:flex-1 sm:min-w-[200px]">
          <label className="block text-xs font-medium text-gray-500">Shopify order number</label>
          <div className="mt-1 flex overflow-hidden rounded border border-gray-300">
            <span className="flex select-none items-center bg-gray-100 px-2 text-sm text-gray-500">#</span>
            <input
              type="text"
              placeholder="4756"
              value={orderNumber}
              onChange={(e) => setOrderNumber(e.target.value.replace(/^#+/, ""))}
              className="w-full px-2 py-1 text-sm outline-none"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 sm:w-auto"
        >
          {submitting ? "Adding…" : "Add"}
        </button>
      </form>

      {formError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-red-700">Can&apos;t add this order</h2>
            <p className="mt-2 text-sm text-gray-600">{formError}</p>
            <button
              type="button"
              onClick={() => setFormError(null)}
              className="mt-4 w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
          <span className="text-amber-800">{selectedIds.size} selected</span>
          <button
            type="button"
            onClick={handleRemoveSelected}
            disabled={removing}
            className="rounded bg-red-700 px-3 py-1 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50"
          >
            {removing ? "Removing…" : "Unflag selected"}
          </button>
          <button type="button" onClick={() => setSelectedIds(new Set())} className="text-xs text-amber-800 hover:underline">
            Clear selection
          </button>
          {removeError && <span className="text-xs text-red-600">{removeError}</span>}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-400">
            <tr>
              <th className="w-[8%] px-3 py-2">
                <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} aria-label="Select all" />
              </th>
              <th className="w-[26%] px-3 py-2">Date</th>
              <th className="w-[66%] px-3 py-2">Order Number</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialOrders.map((o) => (
              <tr key={o.id} className="text-gray-700">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(o.id)}
                    onChange={() => toggleSelected(o.id)}
                    aria-label={`Select order ${o.orderNumber}`}
                  />
                </td>
                <td className="px-3 py-2">{o.date}</td>
                <td className="px-3 py-2">{o.orderNumber}</td>
              </tr>
            ))}
            {initialOrders.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-gray-400">
                  No orders flagged as Movers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
