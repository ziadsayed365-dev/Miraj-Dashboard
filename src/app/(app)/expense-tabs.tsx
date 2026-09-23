"use client";

import { useState } from "react";
import type { DailyPnlRow, OpenMonthInfo } from "@/lib/reports/daily-pnl";
import type { AnalysisAccount, ExpenseAccount, ExpenseEntry } from "@/lib/reports/expenses-ledger";
import type { Overheads } from "@/lib/pnl-fixed-expenses";
import { ExpenseAnalysisTab } from "./expense-analysis-tab";
import { ExpenseRecordingTab } from "./expense-recording-tab";

export function ExpenseTabs({
  rows,
  openMonthInfo,
  isOwner,
  accounts,
  entries,
  recordedOverheads,
  recordedOtherIncome,
  analysisAccounts,
}: {
  rows: DailyPnlRow[];
  openMonthInfo: OpenMonthInfo | null;
  isOwner: boolean;
  accounts: ExpenseAccount[];
  entries: ExpenseEntry[];
  recordedOverheads: Record<string, Overheads>;
  recordedOtherIncome: Record<string, number>;
  analysisAccounts: AnalysisAccount[];
}) {
  const [active, setActive] = useState<"analysis" | "recording">("analysis");
  // The recording ledger is owner-only.
  const tabs = isOwner
    ? ([
        { key: "analysis", label: "Analysis" },
        { key: "recording", label: "Expense Recording" },
      ] as const)
    : ([{ key: "analysis", label: "Analysis" }] as const);

  return (
    <div className="space-y-4">
      {isOwner && (
        <div className="flex gap-1 border-b border-gray-200">
          {tabs.map((t) => (
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
      )}

      {active === "recording" && isOwner ? (
        <ExpenseRecordingTab accounts={accounts} entries={entries} />
      ) : (
        <ExpenseAnalysisTab
          rows={rows}
          openMonthInfo={openMonthInfo}
          isOwner={isOwner}
          recordedOverheads={recordedOverheads}
          recordedOtherIncome={recordedOtherIncome}
          analysisAccounts={analysisAccounts}
        />
      )}
    </div>
  );
}
