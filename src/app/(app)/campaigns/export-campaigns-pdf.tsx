"use client";

import { useState } from "react";

// "Export PDF" for the Campaigns P&L: pick a From–To range and open the
// standalone /print/campaigns view (both tabs, one after the other) in a new
// tab, which auto-triggers the browser's Save-as-PDF. Any range length - both
// sections are single tables totalled over the range.
export function ExportCampaignsPdf({ defaultFrom, defaultTo }: { defaultFrom: string; defaultTo: string }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const rangeInvalid = !from || !to || from > to;

  function generate() {
    if (rangeInvalid) return;
    window.open(`/print/campaigns?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, "_blank", "noopener");
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

            <label className="block text-xs font-medium text-gray-500">Date range to export</label>
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
              ) : (
                <span className="text-gray-400">Includes the P&amp;L and the Products Sold summary for this range.</span>
              )}
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
                disabled={rangeInvalid}
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
