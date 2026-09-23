"use client";

import { useState } from "react";
import type { MoversOrder, MoversOrderReportRow } from "@/lib/movers/orders";
import { RecordOrdersTab } from "./record-orders-tab";
import { MoversReportTab } from "./movers-report-tab";

const TABS = [
  { key: "record" as const, label: "Record Orders" },
  { key: "report" as const, label: "Report" },
];

export function MoversOrdersTabs({
  orders,
  report,
  syncedAt,
}: {
  orders: MoversOrder[];
  report: MoversOrderReportRow[];
  syncedAt: string | null;
}) {
  const [active, setActive] = useState<"record" | "report">("record");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActive(tab.key)}
            className={`px-4 py-2 text-sm font-medium ${
              active === tab.key ? "border-b-2 border-gray-900 text-gray-900" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {active === "record" && <RecordOrdersTab initialOrders={orders} />}
      {active === "report" && <MoversReportTab rows={report} syncedAt={syncedAt} />}
    </div>
  );
}
