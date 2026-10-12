"use client";

import { useState } from "react";
import type { CampaignRow } from "@/lib/reports/campaign-pnl";
import { CampaignPnlTable, CampaignProductsList } from "./campaign-tables";

type View = "pnl" | "products";

export function CampaignsTabs({
  campaigns,
  canViewPnl,
  canViewProducts,
}: {
  campaigns: CampaignRow[];
  canViewPnl: boolean;
  canViewProducts: boolean;
}) {
  // Each view is its own permission (Settings → Users), so a user can be given
  // either or both; the page only lets them in with at least one.
  const views = ([canViewPnl && "pnl", canViewProducts && "products"] as const).filter((v): v is View => v !== false);
  const [view, setView] = useState<View>(views[0]);
  const labels: Record<View, string> = { pnl: "P&L", products: "Products Sold" };

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className={`flex gap-1 border-b border-gray-200 px-4 pt-3 ${views.length > 1 ? "" : "hidden"}`}>
        {views.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              view === v ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {labels[v]}
          </button>
        ))}
      </div>
      <div className="p-4">
        {view === "pnl" ? (
          <>
            <CampaignPnlTable campaigns={campaigns} />
            <p className="mt-3 text-xs text-gray-400">
              Orders credited to the campaign of the customer&apos;s last ad click. Revenue and COGS are the full value of every
              order, excluding shipping fees. Contribution = Revenue − COGS − Marketing. Contribution after returns applies each
              product&apos;s expected delivery rate to its revenue and COGS. Cancelled orders count in Orders, Revenue, COGS and
              Contribution like any order, and as not delivered after returns.
            </p>
          </>
        ) : (
          <CampaignProductsList campaigns={campaigns} />
        )}
      </div>
    </div>
  );
}
