"use client";

import { useState } from "react";

const MAX_DAYS = 7;

function dayCount(from: string, to: string): number {
  const ms = Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z");
  if (Number.isNaN(ms)) return 0;
  return Math.floor(ms / 86_400_000) + 1;
}

// "Export PDF" control for the Income Statement. Pick the exact day columns (a
// From–To range, one day = one column, max 7) and tick which sections to
// include - the Income Statement (+ ratios), Analysis by Product (+ Key
// Ratios), or both. Opens the standalone /print/income-statement view in a new
// tab, which auto-triggers the browser's Save-as-PDF.
export function ExportPdfModal({ defaultTo }: { defaultTo: string }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(defaultTo);
  const [to, setTo] = useState(defaultTo);
  const [includeIncome, setIncludeIncome] = useState(true);
  const [includeProduct, setIncludeProduct] = useState(false);
  // How far down Analysis by Product's Category > Sub-category > Products tree
  // the PDF goes. "sub" matches what the export printed before this choice
  // existed, so the default output is unchanged.
  const [productLevel, setProductLevel] = useState<"category" | "sub" | "item">("sub");

  const days = dayCount(from, to);
  const rangeInvalid = from > to;
  const tooManyDays = days > MAX_DAYS;
  const nothingSelected = !includeIncome && !includeProduct;
  const canGenerate = !rangeInvalid && !tooManyDays && !nothingSelected && days >= 1;

  function generate() {
    if (!canGenerate) return;
    const url =
      `/print/income-statement?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
      `&is=${includeIncome ? 1 : 0}&product=${includeProduct ? 1 : 0}` +
      `&level=${productLevel}`;
    window.open(url, "_blank", "noopener");
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
      >
        Export PDF
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Export PDF</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500">Days to export (one day = one column, max {MAX_DAYS})</label>
                <div className="mt-1 grid grid-cols-2 gap-3">
                  <div>
                    <span className="block text-[11px] text-gray-400">From</span>
                    <input
                      type="date"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                      className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                  </div>
                  <div>
                    <span className="block text-[11px] text-gray-400">To</span>
                    <input
                      type="date"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                  </div>
                </div>
                <div className="mt-1 text-xs">
                  {rangeInvalid ? (
                    <span className="text-red-600">“From” must be on or before “To”.</span>
                  ) : tooManyDays ? (
                    <span className="text-red-600">
                      {days} days selected — the maximum is {MAX_DAYS}.
                    </span>
                  ) : (
                    <span className="text-gray-400">
                      {days} {days === 1 ? "column" : "columns"}.
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500">Include (pick one or both)</label>
                <div className="mt-1 space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded border border-gray-200 p-2 text-sm hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={includeIncome}
                      onChange={(e) => setIncludeIncome(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium text-gray-900">Income Statement &amp; Ratios</span>
                      <span className="block text-xs text-gray-500">All accounts and ratios for the selected days.</span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded border border-gray-200 p-2 text-sm hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={includeProduct}
                      onChange={(e) => setIncludeProduct(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium text-gray-900">Analysis by Product &amp; Ratios</span>
                      <span className="block text-xs text-gray-500">Per-product table and Key Ratios for the selected days.</span>
                    </span>
                  </label>
                  {includeProduct && (
                    <div className="ml-6 space-y-1.5 rounded border border-gray-200 bg-gray-50 p-2">
                      <span className="block text-[11px] font-medium text-gray-500">Break down by</span>
                      {([
                        ["category", "Category", "One line per category — the shortest report."],
                        ["sub", "Sub Category", "Each category, then the sub-categories inside it."],
                        ["item", "By Item", "Down to every product and variant. The longest report."],
                      ] as const).map(([key, label, hint]) => (
                        <label key={key} className="flex cursor-pointer items-start gap-2 text-sm">
                          <input
                            type="radio"
                            name="product-breakdown"
                            checked={productLevel === key}
                            onChange={() => setProductLevel(key)}
                            className="mt-0.5"
                          />
                          <span>
                            <span className="font-medium text-gray-900">{label}</span>
                            <span className="block text-xs text-gray-500">{hint}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                {nothingSelected && <div className="mt-1 text-xs text-red-600">Select at least one section.</div>}
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={generate}
                disabled={!canGenerate}
                className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Generate PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
