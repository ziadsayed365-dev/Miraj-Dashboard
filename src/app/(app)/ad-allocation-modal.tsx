"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { UnmappedAd } from "@/lib/reports/ad-allocation";
import type { AllocationCategory } from "@/lib/products/catalog";
import { AllocationPicker, EMPTY_ALLOCATION, allocationIsEmpty, type Allocation } from "./allocation-picker";

export function AdAllocationModal({ ads, categoryTree }: { ads: UnmappedAd[]; categoryTree: AllocationCategory[] }) {
  const [open, setOpen] = useState(true);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const visible = ads.filter((ad) => !skipped.has(ad.campaignId));
  if (!open || visible.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xl rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-red-700">New campaigns need a sub-category</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="shrink-0 text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>
        <p className="mt-2 text-sm text-gray-600">
          These campaigns have spend that isn&apos;t allocated yet, so they&apos;re missing from the per-product marketing
          figures. Pick what each one promotes — one sub-category, a whole category, or General — and it applies to that
          campaign&apos;s whole run, past and future. Choose several and the spend is split equally between them.
        </p>
        <ul className="mt-3 max-h-96 space-y-3 overflow-y-auto">
          {visible.map((ad) => (
            <AdRow
              key={ad.campaignId}
              ad={ad}
              categoryTree={categoryTree}
              onSkip={() => setSkipped((s) => new Set(s).add(ad.campaignId))}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function AdRow({ ad, categoryTree, onSkip }: { ad: UnmappedAd; categoryTree: AllocationCategory[]; onSkip: () => void }) {
  const router = useRouter();
  const [allocation, setAllocation] = useState<Allocation>(EMPTY_ALLOCATION);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAllocate() {
    if (allocationIsEmpty(allocation)) {
      setError("Pick a category or sub-category.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/ad-spend/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          allocation.isGeneral
            ? { campaignId: ad.campaignId, isGeneral: true }
            : {
                campaignId: ad.campaignId,
                subCategories: allocation.subCategories,
                categories: allocation.categories,
              }
        ),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to allocate");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to allocate");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <li className="rounded-md border border-gray-200 p-3 text-sm">
      <div className="flex justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-gray-900">{ad.campaignName ?? "(unnamed campaign)"}</p>
          <p className="truncate text-xs text-gray-500">{ad.adAccountName ?? "(unknown ad account)"}</p>
          <p className="truncate text-xs text-gray-400">Campaign ID: {ad.campaignId}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-medium text-gray-900">{ad.spend.toLocaleString("en-US", { maximumFractionDigits: 0 })} EGP</p>
          <p className="text-xs text-gray-400">{ad.date}</p>
        </div>
      </div>

      <div className="mt-2">
        <AllocationPicker tree={categoryTree} value={allocation} onChange={setAllocation} disabled={submitting} />
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={handleAllocate}
          disabled={submitting}
          className="ml-auto rounded bg-gray-900 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          Allocate
        </button>
        <button type="button" onClick={onSkip} className="text-xs text-gray-400 hover:text-gray-600">
          Skip
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}
