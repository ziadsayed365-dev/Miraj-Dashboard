"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function MarketingAgencyFeeSettings({ monthlyAmount }: { monthlyAmount: number }) {
  const router = useRouter();
  const saved = String(monthlyAmount);
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
      const res = await fetch("/api/marketing-agency-fee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyAmount: amt }),
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

  const perDay = (Number(amount) || 0) / 30;

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        The marketing agency&apos;s flat monthly fee, charged on the Income Statement below Contribution Profit at{" "}
        <strong>this amount ÷ 30 per day</strong>, every day from <strong>19 Oct 2026</strong> onward. Days before that
        keep the old fee of 12.5% of ad spend and are never affected by this value.
      </p>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Fee</th>
              <th className="px-3 py-2 text-right">Monthly (EGP)</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            <tr className={busy ? "opacity-50" : ""}>
              <td className="px-3 py-2 text-gray-900">
                Marketing Agency Fees
                <span className="ml-2 text-xs text-gray-400">≈ {perDay.toLocaleString(undefined, { maximumFractionDigits: 2 })}/day</span>
              </td>
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
          </tbody>
        </table>
      </div>
    </div>
  );
}
