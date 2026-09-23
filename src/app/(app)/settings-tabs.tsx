"use client";

import { useState } from "react";
import type { AppUser } from "@/lib/settings/users";
import type { ExpenseAssumption } from "@/lib/reports/expenses-ledger";
import type { AdAllocation } from "@/lib/reports/ad-allocation";
import type { AllocationCategory } from "@/lib/products/catalog";

import { SettingsPage } from "./settings-page";
import { ExpenseAssumptionsSettings } from "./expense-assumptions-settings";
import { AdAllocationsSettings } from "./ad-allocations-settings";

const TABS = [
  { key: "users" as const, label: "Users" },
  { key: "assumptions" as const, label: "Fixed Expense Assumptions" },
  { key: "ads" as const, label: "Ad Allocation" },
];

type SettingsTab = (typeof TABS)[number]["key"];

export function SettingsTabs({
  users,
  assumptions,
  adAllocations,
  categoryTree,
}: {
  users: AppUser[];
  assumptions: ExpenseAssumption[];
  adAllocations: AdAllocation[];
  categoryTree: AllocationCategory[];
}) {
  const [active, setActive] = useState<SettingsTab>("users");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={`px-4 py-2 text-sm font-medium ${
              active === t.key ? "border-b-2 border-gray-900 text-gray-900" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active === "users" && <SettingsPage users={users} />}
      {active === "assumptions" && <ExpenseAssumptionsSettings assumptions={assumptions} />}
      {active === "ads" && <AdAllocationsSettings allocations={adAllocations} categoryTree={categoryTree} />}
    </div>
  );
}
