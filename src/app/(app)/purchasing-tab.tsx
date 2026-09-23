"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { egyptToday } from "@/lib/dates";
import { COMPONENT_TYPES, COMPONENT_TYPE_LABELS, COMPONENT_UNIT_LABELS } from "@/lib/products/component-types";
import { unitCostFromTotal } from "@/lib/purchases/unit-cost";
import type { PurchaseRecord, PurchaseTargetOption } from "@/lib/purchases/purchases";

// A new cost this much above the current one triggers a confirm dialog.
const INCREASE_THRESHOLD = 0.2;

const inputClass = "w-full rounded border border-gray-300 px-2 py-1.5 text-sm";

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// The dropdown mixes two kinds of target, so each option is keyed by both.
function optionKey(kind: string, id: number): string {
  return `${kind}:${id}`;
}

export function PurchasingTab({
  targets,
  initialPurchases,
}: {
  targets: PurchaseTargetOption[];
  initialPurchases: PurchaseRecord[];
}) {
  const router = useRouter();

  const [date, setDate] = useState(egyptToday());
  const [selectedKey, setSelectedKey] = useState(targets[0] ? optionKey(targets[0].kind, targets[0].id) : "");
  const [quantity, setQuantity] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When set, the 20%+ confirm dialog is shown before saving.
  const [confirmIncrease, setConfirmIncrease] = useState<{ pct: number; current: number; newCost: number } | null>(null);

  const selected = useMemo(
    () => targets.find((t) => optionKey(t.kind, t.id) === selectedKey) ?? null,
    [targets, selectedKey]
  );

  // Components grouped by catalog type, then all products in their own group.
  const componentsByType = useMemo(() => {
    const map = new Map<string, PurchaseTargetOption[]>();
    for (const t of targets) {
      if (t.kind !== "component" || !t.type) continue;
      const list = map.get(t.type) ?? [];
      list.push(t);
      map.set(t.type, list);
    }
    return map;
  }, [targets]);

  const products = useMemo(() => targets.filter((t) => t.kind === "product"), [targets]);

  const unitLabel = selected ? COMPONENT_UNIT_LABELS[selected.unit] : "unit";

  // The per-unit cost derived from the total, shown live and used for the 20%
  // check. Same helper the server stores with, so what's shown is what's saved.
  const perUnit =
    Number(quantity) > 0 && totalAmount.trim() !== "" && Number.isFinite(Number(totalAmount))
      ? unitCostFromTotal(Number(totalAmount), Number(quantity))
      : null;

  async function save() {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: selected.kind,
          targetId: selected.id,
          date,
          quantity: Number(quantity),
          totalAmount: Number(totalAmount),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      setQuantity("");
      setTotalAmount("");
      setConfirmIncrease(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selected) {
      setError("Pick a component or a product.");
      return;
    }
    const total = Number(totalAmount);
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Enter a valid quantity.");
      return;
    }
    if (totalAmount.trim() === "" || !Number.isFinite(total) || total < 0) {
      setError("Enter a valid total amount.");
      return;
    }
    // The check compares the derived per-unit cost, not the total - a bigger
    // order at the same price per unit is not a price increase.
    const newCost = unitCostFromTotal(total, qty);
    const current = selected.currentCost;
    if (current !== null && current > 0 && newCost >= current * (1 + INCREASE_THRESHOLD)) {
      setConfirmIncrease({ pct: (newCost / current - 1) * 100, current, newCost });
      return;
    }
    save();
  }

  return (
    <div className="space-y-6">
      {/* ---- Record a purchase ---- */}
      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <div className="w-full sm:w-auto">
          <label className="block text-xs font-medium text-gray-500">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
        </div>
        <div className="w-full sm:min-w-[18rem] sm:grow">
          <label className="block text-xs font-medium text-gray-500">Component or product</label>
          <select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)} className={inputClass}>
            {COMPONENT_TYPES.map((t) =>
              (componentsByType.get(t) ?? []).length === 0 ? null : (
                <optgroup key={t} label={COMPONENT_TYPE_LABELS[t]}>
                  {(componentsByType.get(t) ?? []).map((c) => (
                    <option key={optionKey(c.kind, c.id)} value={optionKey(c.kind, c.id)}>
                      {c.name} ({COMPONENT_UNIT_LABELS[c.unit]}
                      {c.currentCost === null ? "" : `, now ${fmt(c.currentCost)}/${COMPONENT_UNIT_LABELS[c.unit]}`})
                    </option>
                  ))}
                </optgroup>
              )
            )}
            {products.length > 0 && (
              <optgroup label="Finished products">
                {products.map((p) => (
                  <option key={optionKey(p.kind, p.id)} value={optionKey(p.kind, p.id)}>
                    {p.name}
                    {p.currentCost === null ? "" : ` — now ${fmt(p.currentCost)}`}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="w-full sm:w-24">
          <label className="block text-xs font-medium text-gray-500">Quantity ({unitLabel})</label>
          <input
            type="number"
            min="0"
            step="0.001"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="w-full sm:w-32">
          <label className="block text-xs font-medium text-gray-500">Total amount (EGP)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="w-full sm:w-28">
          <label className="block text-xs font-medium text-gray-500">Cost / {unitLabel}</label>
          <p className="mt-1 px-2 py-1.5 text-sm font-medium text-gray-900">{perUnit === null ? "—" : fmt(perUnit)}</p>
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Record purchase"}
        </button>

        {/* Buying a finished product that is currently costed from its model
            group detaches it onto a flat cost of its own, so say so plainly
            rather than letting it happen silently. */}
        {selected?.overridesModelCost && (
          <p className="w-full rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="font-medium">{selected.name}</span> is currently costed from its model group. Recording a
            purchase sets a flat cost for this product alone — its model will no longer determine its cost.
          </p>
        )}
        {error && <p className="w-full text-xs text-red-600">{error}</p>}
      </form>

      {/* ---- Purchases list ---- */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2 text-right">Quantity</th>
              <th className="px-3 py-2 text-right">Total (EGP)</th>
              <th className="px-3 py-2 text-right">Cost / unit</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {initialPurchases.map((p) => (
              <PurchaseRow key={p.id} purchase={p} />
            ))}
            {initialPurchases.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-gray-400">
                  No purchases recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ---- 20%+ increase confirmation ---- */}
      {confirmIncrease && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-amber-700">Cost increase check</h2>
            <p className="mt-2 text-sm text-gray-700">
              This new cost of <span className="font-semibold">{fmt(confirmIncrease.newCost)}</span> is{" "}
              <span className="font-semibold">{confirmIncrease.pct.toFixed(0)}% more</span> than the current cost of{" "}
              <span className="font-semibold">{fmt(confirmIncrease.current)}</span>. Is this correct?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmIncrease(null)}
                disabled={submitting}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={submitting}
                className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Yes, save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PurchaseRow({ purchase: p }: { purchase: PurchaseRecord }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const unit = COMPONENT_UNIT_LABELS[p.unit];

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch("/api/purchases", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={`text-gray-700 ${busy ? "opacity-50" : ""}`}>
      <td className="px-3 py-2">{p.date}</td>
      <td className="px-3 py-2 text-gray-900">
        {p.targetName}
        <span className="text-xs text-gray-400"> · {p.kind === "component" ? "component" : "product"}</span>
      </td>
      <td className="px-3 py-2 text-right">
        {fmt(p.quantity)} {unit}
      </td>
      <td className="px-3 py-2 text-right">{fmt(p.total)}</td>
      <td className="px-3 py-2 text-right text-gray-600">
        {fmt(p.amount)} /{unit}
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="px-1 text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
          title="Remove"
        >
          ×
        </button>
      </td>
    </tr>
  );
}
