"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ExpenseAccount, ExpenseEntry } from "@/lib/reports/expenses-ledger";
import { MultiSelectFilter } from "./multi-select-filter";

const inputClass = "w-full rounded border border-gray-300 px-2 py-1 text-sm";
const editClass = "w-full rounded border border-gray-300 px-1.5 py-1 text-xs";
const filterClass = "w-full rounded border border-gray-200 px-1.5 py-1 text-xs";
const btnPrimary = "rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40";

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function api(url: string, method: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
}

export function ExpenseRecordingTab({ accounts, entries }: { accounts: ExpenseAccount[]; entries: ExpenseEntry[] }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState<number | "">(accounts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters for the entries table.
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterAccountIds, setFilterAccountIds] = useState<string[]>([]);
  const [filterKind, setFilterKind] = useState<"all" | "income" | "expense">("all");
  const [filterNotes, setFilterNotes] = useState<string[]>([]);

  // Like Excel's column filter, only accounts that actually appear in the
  // recorded entries are offered here (the form above still lists every one).
  const accountOptions = useMemo(() => {
    const byId = new Map<number, string>();
    for (const e of entries) byId.set(e.accountId, e.accountName);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => ({ value: String(id), label: name }));
  }, [entries]);

  const noteOptions = useMemo(() => {
    const unique = [...new Set(entries.map((e) => e.note).filter((n): n is string => !!n && n.trim() !== ""))];
    return unique.sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n }));
  }, [entries]);

  const filtered = useMemo(() => {
    return entries.filter((entry) => {
      if (filterFrom && entry.date < filterFrom) return false;
      if (filterTo && entry.date > filterTo) return false;
      if (filterAccountIds.length > 0 && !filterAccountIds.includes(String(entry.accountId))) return false;
      if (filterKind !== "all" && entry.kind !== filterKind) return false;
      if (filterNotes.length > 0 && !filterNotes.includes(entry.note ?? "")) return false;
      return true;
    });
  }, [entries, filterFrom, filterTo, filterAccountIds, filterKind, filterNotes]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (accountId === "") return setError("Pick an account.");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return setError("Amount must be a positive number.");
    setBusy(true);
    try {
      await api("/api/expense-entries", "POST", { date, accountId: Number(accountId), amount: amt, note: note.trim() || null });
      setAmount("");
      setNote("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400">
        Record actual expenses and income by date and account. Amounts are entered positive; each account is fixed as income or
        expense. Expenses feed the Income Statement for closed months; Bosta is income and stays out of the P&amp;L.
      </p>

      <form onSubmit={add} className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="w-full sm:w-auto">
          <label className="block text-xs font-medium text-gray-500">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
        </div>
        <div className="w-full sm:w-56">
          <label className="block text-xs font-medium text-gray-500">Account</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value === "" ? "" : Number(e.target.value))} className={inputClass}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="w-full sm:w-32">
          <label className="block text-xs font-medium text-gray-500">Amount (EGP)</label>
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} />
        </div>
        <div className="w-full sm:flex-1 sm:min-w-[160px]">
          <label className="block text-xs font-medium text-gray-500">Note (optional)</label>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
        </div>
        <button type="submit" disabled={busy} className={btnPrimary}>{busy ? "Adding…" : "Add"}</button>
        {error && <span className="w-full text-xs text-red-600">{error}</span>}
      </form>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div>
          <label className="block text-xs font-medium text-gray-500">From</label>
          <input type="date" aria-label="From date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} className={`${filterClass} w-auto`} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500">To</label>
          <input type="date" aria-label="To date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} className={`${filterClass} w-auto`} />
        </div>
        <div className="w-40">
          <label className="block text-xs font-medium text-gray-500">Account</label>
          <MultiSelectFilter options={accountOptions} selected={filterAccountIds} onChange={setFilterAccountIds} />
        </div>
        <div className="w-28">
          <label className="block text-xs font-medium text-gray-500">Type</label>
          <select value={filterKind} onChange={(e) => setFilterKind(e.target.value as "all" | "income" | "expense")} className={filterClass}>
            <option value="all">All</option>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
        </div>
        <div className="w-40">
          <label className="block text-xs font-medium text-gray-500">Note</label>
          <MultiSelectFilter options={noteOptions} selected={filterNotes} onChange={setFilterNotes} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Account</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2 text-right">Amount (EGP)</th>
              <th className="px-3 py-2">Note</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((entry) => (
              <EntryRow key={entry.id} entry={entry} accounts={accounts} />
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-gray-400">No entries yet. Add your first above.</td>
              </tr>
            )}
            {entries.length > 0 && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-gray-400">No entries match these filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EntryRow({ entry, accounts }: { entry: ExpenseEntry; accounts: ExpenseAccount[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(entry.date);
  const [accountId, setAccountId] = useState(entry.accountId);
  const [amount, setAmount] = useState(String(entry.amount));
  const [note, setNote] = useState(entry.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <tr className="bg-blue-50/40">
        <td className="px-3 py-2"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={editClass} /></td>
        <td className="px-3 py-2">
          <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))} className={editClass}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </td>
        <td className="px-3 py-2 text-gray-400 text-xs">{accounts.find((a) => a.id === accountId)?.kind}</td>
        <td className="px-3 py-2"><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${editClass} text-right`} /></td>
        <td className="px-3 py-2"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} className={editClass} /></td>
        <td className="px-3 py-2">
          <div className="flex gap-1">
            <button type="button" disabled={busy} onClick={() => run(() => api(`/api/expense-entries/${entry.id}`, "PATCH", { date, accountId, amount: Number(amount), note: note.trim() || null }))} className="rounded bg-gray-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50">Save</button>
            <button type="button" onClick={() => setEditing(false)} className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100">Cancel</button>
          </div>
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        </td>
      </tr>
    );
  }

  return (
    <tr className={`text-gray-700 ${busy ? "opacity-50" : ""}`}>
      <td className="px-3 py-2 text-gray-900">{entry.date}</td>
      <td className="px-3 py-2 text-gray-900">{entry.accountName}</td>
      <td className="px-3 py-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${entry.kind === "income" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>{entry.kind}</span>
      </td>
      <td className={`px-3 py-2 text-right font-medium ${entry.kind === "expense" ? "text-red-700" : "text-green-700"}`}>
        {entry.kind === "expense" ? "-" : "+"}{fmtMoney(entry.amount)}
      </td>
      <td className="px-3 py-2 text-gray-500">{entry.note ?? "—"}</td>
      <td className="px-3 py-2">
        <div className="flex gap-2">
          <button type="button" onClick={() => setEditing(true)} className="text-xs font-medium text-gray-600 hover:underline">Edit</button>
          <button type="button" onClick={() => { if (confirm("Delete this entry?")) run(() => api(`/api/expense-entries/${entry.id}`, "DELETE", {})); }} className="text-xs font-medium text-red-600 hover:underline">Delete</button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </td>
    </tr>
  );
}
