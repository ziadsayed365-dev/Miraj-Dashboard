"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type ModelGroup = { id: number; name: string };
type Row = { amount: string; groupId: string }; // groupId: "general" or String(model id)

function fmtDay(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function TikTokSpendModal({ missingDays, modelGroups }: { missingDays: string[]; modelGroups: ModelGroup[] }) {
  const router = useRouter();
  const [days, setDays] = useState(missingDays);
  const [rows, setRows] = useState<Row[]>([{ amount: "", groupId: "general" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (days.length === 0) return null;
  const date = days[0];

  function reset() {
    setRows([{ amount: "", groupId: "general" }]);
    setError(null);
  }
  function nextDay() {
    setDays((d) => d.slice(1));
    reset();
  }

  async function submit(entries: { amount: number; modelGroupId: number | null }[]) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/tiktok-spend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, entries }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      nextDay();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function handleSave() {
    const entries = rows
      .map((r) => ({ amount: Number(r.amount), modelGroupId: r.groupId === "general" ? null : Number(r.groupId) }))
      .filter((e) => Number.isFinite(e.amount) && e.amount > 0);
    submit(entries);
  }

  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-gray-900">TikTok Spend</h2>
          <span className="text-xs text-gray-400">{days.length} day{days.length > 1 ? "s" : ""} left</span>
        </div>
        <p className="mb-4 text-sm text-gray-500">
          Enter TikTok ad spend for <span className="font-medium text-gray-800">{fmtDay(date)}</span>. Pick a product for each
          amount, or <span className="font-medium">General</span> to apply it across all products.
        </p>

        <div className="space-y-2">
          <div className="flex gap-2 text-xs font-medium uppercase text-gray-400">
            <span className="w-32">Amount (EGP)</span>
            <span className="flex-1">Allocate to</span>
            <span className="w-6" />
          </div>
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                step="0.01"
                value={row.amount}
                onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))}
                placeholder="0"
                className="w-32 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
              <select
                value={row.groupId}
                onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, groupId: e.target.value } : r)))}
                className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              >
                <option value="general">General (all products)</option>
                {modelGroups.map((g) => (
                  <option key={g.id} value={String(g.id)}>
                    {g.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs))}
                className="w-6 text-gray-400 hover:text-red-600"
                aria-label="Remove row"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, { amount: "", groupId: "general" }])}
          className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-800"
        >
          + Add another
        </button>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex items-center justify-between border-t border-gray-100 pt-4">
          <button
            type="button"
            disabled={saving}
            onClick={() => submit([])}
            className="text-sm font-medium text-gray-500 hover:text-gray-800 disabled:opacity-50"
          >
            No spend this day
          </button>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">Total: {total.toLocaleString()} EGP</span>
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
