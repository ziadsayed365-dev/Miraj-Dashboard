"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AllocationCategory } from "@/lib/products/catalog";

// What a campaign's spend can be pinned to. Three shapes, because that is how
// the owner actually buys ads:
//   sub      - one named sub-category ("سجاد ايليت")
//   category - a whole category, spread across every sub-category it holds
//   general  - a brand campaign, spread across everything selling
export type Allocation = {
  subCategories: string[];
  categories: string[];
  isGeneral: boolean;
};

export const EMPTY_ALLOCATION: Allocation = { subCategories: [], categories: [], isGeneral: false };

export function allocationIsEmpty(a: Allocation): boolean {
  return !a.isGeneral && a.subCategories.length === 0 && a.categories.length === 0;
}

// How many ways the spend ends up being split. General is spread at read time
// over whatever sold, so it has no fixed count and is excluded here.
export function allocationTargetCount(a: Allocation, tree: AllocationCategory[]): number {
  if (a.isGeneral) return 0;
  const groups = new Set(a.subCategories);
  for (const category of a.categories) {
    for (const g of tree.find((c) => c.category === category)?.groups ?? []) groups.add(g);
  }
  return groups.size;
}

export function describeAllocation(a: Allocation): string {
  if (a.isGeneral) return "General (spread across all)";
  const parts = [...a.categories.map((c) => `All of ${c}`), ...a.subCategories];
  return parts.length > 0 ? parts.join(" + ") : "—";
}

const GENERAL_KEY = "__general__";

type Option =
  | { key: string; kind: "general"; label: string; sublabel: string }
  | { key: string; kind: "category"; label: string; category: string; groupCount: number; hasSubCategories: boolean }
  | { key: string; kind: "sub"; label: string; category: string };

// Multi-select dropdown over the category tree, with a search box pinned to the
// top of the panel. Replaces a flat wrap of ~30 Arabic pills, which had no way
// to find a label and no way to say "the whole category".
export function AllocationPicker({
  tree,
  value,
  onChange,
  disabled,
  placeholder = "Choose where this spend belongs",
}: {
  tree: AllocationCategory[];
  value: Allocation;
  onChange: (next: Allocation) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Click-away and Escape both close it - a panel this tall over a table is
  // easy to lose track of otherwise.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const options = useMemo<Option[]>(() => {
    const out: Option[] = [
      { key: GENERAL_KEY, kind: "general", label: "General", sublabel: "spread across everything selling" },
    ];
    for (const c of tree) {
      // Offered for EVERY category, even one that currently holds a single
      // group named after itself. The two are not the same pick: the group is
      // a fixed label, the category is "whatever this category holds", so a
      // sub-category added later is picked up by the category pin and missed by
      // the group one. Only the sublabel changes between the two cases.
      out.push({
        key: "cat:" + c.category,
        kind: "category",
        label: c.category,
        category: c.category,
        groupCount: c.groups.length,
        hasSubCategories: c.hasSubCategories,
      });
      for (const g of c.groups) out.push({ key: "sub:" + g, kind: "sub", label: g, category: c.category });
    }
    return out;
  }, [tree]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.kind !== "general" && o.category.toLowerCase().includes(q))
    );
  }, [options, query]);

  const isOn = (o: Option) =>
    o.kind === "general" ? value.isGeneral : o.kind === "category" ? value.categories.includes(o.category) : value.subCategories.includes(o.label);

  function toggle(o: Option) {
    if (o.kind === "general") {
      // General means "everything", so it cannot coexist with a narrower pick.
      onChange(value.isGeneral ? EMPTY_ALLOCATION : { subCategories: [], categories: [], isGeneral: true });
      return;
    }
    const base = { ...value, isGeneral: false };
    if (o.kind === "category") {
      const on = base.categories.includes(o.category);
      onChange({
        ...base,
        categories: on ? base.categories.filter((c) => c !== o.category) : [...base.categories, o.category],
        // Picking the whole category subsumes any of its own sub-categories
        // already ticked - leaving both would give that one a double share.
        subCategories: on
          ? base.subCategories
          : base.subCategories.filter((s) => !(tree.find((c) => c.category === o.category)?.groups ?? []).includes(s)),
      });
      return;
    }
    const on = base.subCategories.includes(o.label);
    onChange({
      ...base,
      subCategories: on ? base.subCategories.filter((s) => s !== o.label) : [...base.subCategories, o.label],
    });
  }

  const summary = allocationIsEmpty(value) ? placeholder : describeAllocation(value);
  const splitCount = allocationTargetCount(value, tree);

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-xs ${
          allocationIsEmpty(value) ? "border-gray-300 text-gray-400" : "border-gray-400 text-gray-900"
        } bg-white hover:border-gray-500 disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <span className="truncate" dir="auto">
          {summary}
        </span>
        <span className="shrink-0 text-gray-400">▾</span>
      </button>

      {splitCount > 1 && (
        <p className="mt-1 text-[11px] text-gray-500">
          Split equally across {splitCount} — {(100 / splitCount).toFixed(splitCount > 2 ? 1 : 0)}% each
        </p>
      )}

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[260px] rounded-md border border-gray-200 bg-white shadow-lg">
          <div className="sticky top-0 border-b border-gray-100 bg-white p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search categories…"
              dir="auto"
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-gray-500"
            />
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 && <li className="px-3 py-2 text-xs text-gray-400">No match.</li>}
            {filtered.map((o) => {
              const on = isOn(o);
              return (
                <li key={o.key}>
                  <button
                    type="button"
                    onClick={() => toggle(o)}
                    className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50 ${
                      o.kind === "sub" ? "pl-6" : ""
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border text-[9px] ${
                        on ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300"
                      }`}
                    >
                      {on ? "✓" : ""}
                    </span>
                    <span className="min-w-0">
                      <span
                        className={`block truncate ${o.kind === "sub" ? "text-gray-700" : "font-medium text-gray-900"}`}
                        dir="auto"
                      >
                        {o.kind === "category" ? `General — all of ${o.label}` : o.label}
                      </span>
                      {o.kind === "general" && <span className="block text-[11px] text-gray-400">{o.sublabel}</span>}
                      {o.kind === "category" && (
                        <span className="block text-[11px] text-gray-400">
                          {o.hasSubCategories
                            ? `spread across its ${o.groupCount} sub-categories`
                            : "the whole category, including any sub-category added later"}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
