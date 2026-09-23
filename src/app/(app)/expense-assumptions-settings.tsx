"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ExpenseAssumption } from "@/lib/reports/expenses-ledger";

export function ExpenseAssumptionsSettings({ assumptions }: { assumptions: ExpenseAssumption[] }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        Monthly assumption per expense account, used for the <strong>current (open) calendar month</strong> in the Income Statement
        (Performance and Actual, daily and monthly). Once a month ends it switches to the actual recorded expenses.
      </p>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Account</th>
              <th className="px-3 py-2 text-right">Monthly assumption (EGP)</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {assumptions.map((a) => (
              <AssumptionRow key={a.accountId} assumption={a} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AssumptionRow({ assumption }: { assumption: ExpenseAssumption }) {
  const router = useRouter();
  const saved = String(assumption.monthlyAmount);
  const [amount, setAmount] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = amount !== saved;

  async function save() {
    setError(null);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) return setError("Must be zero or a positive number.");
    setBusy(true);
    try {
      const res = await fetch("/api/expense-assumptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: assumption.accountId, monthlyAmount: amt }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className={busy ? "opacity-50" : ""}>
      <td className="px-3 py-2 text-gray-900">{assumption.accountName}</td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1">
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-32 rounded border border-gray-300 px-1.5 py-1 text-right text-sm"
          />
        </div>
      </td>
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="rounded bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-40"
        >
          Save
        </button>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </td>
    </tr>
  );
}
