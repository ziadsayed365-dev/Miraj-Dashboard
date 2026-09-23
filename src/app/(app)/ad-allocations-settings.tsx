"use client";

import { useState } from "react";
import type { AdAllocation } from "@/lib/reports/ad-allocation";
import type { AllocationCategory } from "@/lib/products/catalog";
import { AllocationPicker, allocationIsEmpty, describeAllocation, type Allocation } from "./allocation-picker";

// Sentinel filter values, kept distinct from a real sub-category label.
const ALL_VALUE = "all";
const GENERAL_VALUE = "__general__";

// Management view of every campaign the owner has already allocated. Each row's
// sub-categories are editable inline; changing them re-runs the same allocation
// the popup does, so it applies to all of that campaign's spend (past days now,
// future days via the Meta sync). Filter by text or by sub-category to find a
// row fast.
export function AdAllocationsSettings({
  allocations,
  categoryTree,
}: {
  allocations: AdAllocation[];
  categoryTree: AllocationCategory[];
}) {
  // Flat list of every group, for the filter dropdown at the top of the table.
  const subCategories = [...new Set(categoryTree.flatMap((c) => c.groups))];
  const [list, setList] = useState(allocations);
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState(ALL_VALUE);
  // Empty = no bound on that side, so the default is the lifetime total this
  // section has always shown. Re-totalled from each campaign's daily series,
  // which ships with the page - no refetch, so the range responds as you type.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const ranged = from !== "" || to !== "";
  const q = query.trim().toLowerCase();
  const rows = list
    .map((a) => {
      if (!ranged) return { alloc: a, spend: a.spend };
      let spend = 0;
      for (const d of a.daily) {
        if (from && d.date < from) continue;
        if (to && d.date > to) continue;
        spend += d.spend;
      }
      return { alloc: a, spend };
    })
    // Biggest spender first, on whichever total is being shown - the point of
    // the range filter is to find where the money went in that window.
    .sort((x, y) => y.spend - x.spend);

  const filtered = rows.filter(({ alloc: a }) => {
    if (groupFilter === GENERAL_VALUE && !a.isGeneral) return false;
    if (groupFilter !== ALL_VALUE && groupFilter !== GENERAL_VALUE) {
      // A category pin covers its sub-categories, so filtering by one of them
      // has to match the campaign that bought the whole category too.
      const covered =
        a.subCategories.includes(groupFilter) ||
        a.categories.some((c) => (categoryTree.find((t) => t.category === c)?.groups ?? []).includes(groupFilter));
      if (!covered) return false;
    }
    if (q) {
      const hay = [a.campaignName, a.adAccountName, a.campaignId, ...a.subCategories, ...a.categories]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const filteredTotal = filtered.reduce((sum, r) => sum + r.spend, 0);

  function onChanged(campaignId: string, next: Allocation) {
    setList((l) =>
      l.map((a) =>
        a.campaignId === campaignId
          ? { ...a, subCategories: next.subCategories, categories: next.categories, isGeneral: next.isGeneral }
          : a
      )
    );
  }
  function onRemoved(campaignId: string) {
    setList((l) => l.filter((a) => a.campaignId !== campaignId));
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">Campaign Allocations</h2>
        <p className="text-xs text-gray-400">
          Which sub-category each campaign&apos;s spend is attributed to. Pick several and the spend is split equally between
          them; General spreads it across everything that sold. Changes apply to all of that campaign&apos;s spend, past and
          future. Spend shows lifetime by default; set a date range to see what each campaign cost in that window instead.
        </p>
      </div>

      {/* Header filter: free-text search + a sub-category filter. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="grow">
          <label className="block text-[11px] font-medium text-gray-500">Search</label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Campaign, ad account or sub-category…"
            className="mt-1 w-full max-w-xs rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500">Sub-category</label>
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            className="mt-1 rounded border border-gray-300 px-2 py-1 text-xs"
          >
            <option value={ALL_VALUE}>All sub-categories</option>
            <option value={GENERAL_VALUE}>General (spread across all)</option>
            {subCategories.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500">Spend from</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-500">To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="mt-1 rounded border border-gray-300 px-2 py-1 text-xs"
          />
        </div>
        {ranged && (
          <button
            type="button"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
            className="mb-[1px] rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            All time
          </button>
        )}
        <span className="pb-1 text-[11px] text-gray-400">
          {filtered.length} of {list.length} · {filteredTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })} spent
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[640px] text-xs">
          <thead className="text-left text-[10px] font-medium uppercase text-gray-400">
            <tr className="border-b border-gray-100">
              <th className="w-[34%] py-2 pl-4">Campaign</th>
              <th className="w-[10%] py-2">Source</th>
              <th className="w-[12%] py-2 text-right">{ranged ? "Spend in range" : "Spend"}</th>
              <th className="w-[44%] py-2 pl-4">Sub-category</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.map(({ alloc, spend }) => (
              <AllocationRow
                key={alloc.campaignId}
                alloc={alloc}
                spend={spend}
                categoryTree={categoryTree}
                onChanged={onChanged}
                onRemoved={onRemoved}
              />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 pl-4 text-gray-400">
                  {list.length === 0 ? "No allocations yet." : "No allocations match the filter."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AllocationRow({
  alloc,
  spend,
  categoryTree,
  onChanged,
  onRemoved,
}: {
  alloc: AdAllocation;
  spend: number; // lifetime, or just the selected date range - the section decides
  categoryTree: AllocationCategory[];
  onChanged: (campaignId: string, next: Allocation) => void;
  onRemoved: (campaignId: string) => void;
}) {
  const saved: Allocation = {
    subCategories: alloc.subCategories,
    categories: alloc.categories,
    isGeneral: alloc.isGeneral,
  };
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Allocation>(saved);
  const [error, setError] = useState<string | null>(null);

  async function save(next: Allocation) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ad-spend/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          next.isGeneral
            ? { campaignId: alloc.campaignId, isGeneral: true }
            : { campaignId: alloc.campaignId, subCategories: next.subCategories, categories: next.categories }
        ),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      onChanged(alloc.campaignId, next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ad-spend/allocate", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId: alloc.campaignId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed");
      onRemoved(alloc.campaignId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  }

  const current = describeAllocation(saved);

  return (
    <tr className="text-gray-700">
      <td className="py-2 pl-4">
        <div className="truncate font-medium text-gray-900">{alloc.campaignName ?? "(unnamed campaign)"}</div>
        <div className="truncate text-[11px] text-gray-500">{alloc.adAccountName ?? "(unknown ad account)"}</div>
        <div className="truncate text-[11px] text-gray-400">Campaign ID: {alloc.campaignId}</div>
      </td>
      <td className="py-2 text-gray-500">{alloc.source ?? "—"}</td>
      <td className="py-2 text-right">{spend.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
      <td className="py-2 pl-4">
        {editing ? (
          <div className="space-y-1">
            <AllocationPicker tree={categoryTree} value={draft} onChange={setDraft} disabled={busy} />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || allocationIsEmpty(draft)}
                onClick={() => save(draft)}
                className="rounded bg-gray-900 px-2 py-0.5 text-[11px] text-white disabled:opacity-40"
              >
                Save
              </button>
              <button type="button" disabled={busy} onClick={remove} className="text-[11px] text-red-600">
                Unallocate
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(saved);
                  setEditing(false);
                }}
                className="text-[11px] text-gray-400"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            dir="auto"
            onClick={() => setEditing(true)}
            className="rounded border border-transparent px-1 py-0.5 text-left hover:border-gray-300 hover:bg-gray-50"
          >
            {current}
            {!alloc.isGeneral && alloc.subCategories.length + alloc.categories.length > 1 && (
              <span className="ml-1 text-[10px] text-gray-400" dir="ltr">
                (split equally)
              </span>
            )}
          </button>
        )}
        {busy && <span className="ml-2 text-[11px] text-gray-400">Saving…</span>}
        {error && <span className="ml-2 text-[11px] text-red-600">{error}</span>}
      </td>
    </tr>
  );
}
