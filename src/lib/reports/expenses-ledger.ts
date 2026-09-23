import "server-only";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { egyptToday } from "@/lib/dates";
import {
  resolveEndedMonthOverheads,
  EXPENSE_CUTOVER_MONTH,
  type Overheads,
  type OverheadKey,
} from "@/lib/pnl-fixed-expenses";

const CUTOVER_MONTH = EXPENSE_CUTOVER_MONTH;

const ZERO: Overheads = { salary: 0, postProduction: 0, subscription: 0, rent: 0, transportation: 0, other: 0 };

// Recorded expense amounts summed by "YYYY-MM" + account (expense accounts only;
// Bosta income is excluded from every overhead calc).
async function loadRecordedByMonth(): Promise<Map<string, Overheads>> {
  const entries = await fetchAllRows<{
    date: string;
    amount: number;
    expense_accounts: { name: string; kind: "income" | "expense" } | null;
  }>(supabase, "expense_entries", "id, date, amount, expense_accounts(name, kind)");
  const recorded = new Map<string, Overheads>();
  for (const e of entries) {
    const acct = e.expense_accounts;
    if (!acct || acct.kind !== "expense") continue;
    const key = ACCOUNT_TO_KEY[acct.name];
    if (!key) continue;
    const month = e.date.slice(0, 7);
    const cur = recorded.get(month) ?? { ...ZERO };
    cur[key] += Number(e.amount);
    recorded.set(month, cur);
  }
  return recorded;
}

// For the Expense Analysis report: the recorded actuals per month (cutover on),
// which the report shows instead of the assumption/hardcoded for those months.
export async function getRecordedOverheadsByMonth(): Promise<Record<string, Overheads>> {
  return Object.fromEntries(await loadRecordedByMonth());
}

// The Income Statement's "Other - Income" line: a recorded income account that
// ADDS to Net Income (unlike Bosta income, which is tracked but never in the
// P&L). Summed by "YYYY-MM" from its recorded entries.
export const OTHER_INCOME_ACCOUNT = "Other - Income";

async function loadOtherIncomeByMonth(): Promise<Map<string, number>> {
  const entries = await fetchAllRows<{
    date: string;
    amount: number;
    expense_accounts: { name: string; kind: "income" | "expense" } | null;
  }>(supabase, "expense_entries", "id, date, amount, expense_accounts(name, kind)");
  const byMonth = new Map<string, number>();
  for (const e of entries) {
    if (e.expense_accounts?.name !== OTHER_INCOME_ACCOUNT) continue;
    const month = e.date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + Number(e.amount));
  }
  return byMonth;
}

// For the Expense Analysis report: recorded "Other - Income" per month.
export async function getRecordedOtherIncomeByMonth(): Promise<Record<string, number>> {
  return Object.fromEntries(await loadOtherIncomeByMonth());
}

// The six expense accounts that map to the Income Statement's below-contribution
// lines. Bosta (income) is recorded but never enters the P&L.
const ACCOUNT_TO_KEY: Record<string, OverheadKey> = {
  Salary: "salary",
  "Post Production": "postProduction",
  Subscription: "subscription",
  Rent: "rent",
  Transportation: "transportation",
  // The P&L "Other" overhead account. Both names map here so the rename from
  // "Other" to "Other - Expense" doesn't drop its recorded amounts.
  Other: "other",
  "Other - Expense": "other",
};

// Bosta courier income: recorded for the record, but deliberately NEVER part of
// the P&L and never an Expense Analysis row.
const BOSTA_ACCOUNT = "Bosta";

// Accounts the reports already handle by name, each with its own dedicated
// field on DailyPnlRow. Everything else is an owner-added "custom" account,
// whose in_income_statement flag decides whether it gets a P&L line.
//
// Bosta is listed here rather than relying on its in_income_statement value:
// migration 0047 defaulted the column to true for every pre-existing row, so
// Bosta's flag reads true even though it must stay out of the P&L. Reserving
// the name keeps that correct without rewriting the row (flipping the flag
// would instead make Bosta appear as an Expense Analysis line, which it never
// has been).
function isReservedAccount(name: string): boolean {
  return name in ACCOUNT_TO_KEY || name === OTHER_INCOME_ACCOUNT || name === BOSTA_ACCOUNT;
}

// ---- Types -----------------------------------------------------------------

export type ExpenseAccount = { id: number; name: string; kind: "income" | "expense"; sortOrder: number; inIncomeStatement: boolean };
// An owner-added account (income or expense) with its recorded amount per
// "YYYY-MM". `kind` lets the report show income as a credit and expense as a
// cost; `inIncomeStatement` says whether it also gets its own P&L line.
export type AnalysisAccount = {
  id: number;
  name: string;
  kind: "income" | "expense";
  inIncomeStatement: boolean;
  byMonth: Record<string, number>;
};
// One owner-added account's contribution to a single month of the Income
// Statement, as its own named line below Contribution Profit.
export type CustomPnlLine = { accountId: number; name: string; kind: "income" | "expense"; amount: number };
export type ExpenseEntry = { id: number; date: string; accountId: number; accountName: string; kind: "income" | "expense"; amount: number; note: string | null };
export type ExpenseAssumption = { accountId: number; accountName: string; monthlyAmount: number };

// ---- Accounts --------------------------------------------------------------

export async function getExpenseAccounts(): Promise<ExpenseAccount[]> {
  const rows = await fetchAllRows<{
    id: number;
    name: string;
    kind: "income" | "expense";
    sort_order: number;
    in_income_statement: boolean | null;
  }>(supabase, "expense_accounts", "id, name, kind, sort_order, in_income_statement");
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      sortOrder: r.sort_order,
      // Rows created before this column existed are the six fixed overheads,
      // which do belong in the P&L - treat a missing value as true.
      inIncomeStatement: r.in_income_statement ?? true,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

// Create a new owner-added account (income or expense). It always shows in the
// Expense Analysis; `inIncomeStatement` additionally gives it its own named
// line on the Income Statement, below Contribution Profit, where an expense
// reduces Net Income and an income adds to it. Defaults to analysis-only, so
// adding an account never silently moves the bottom line.
export async function createAnalysisAccount(
  name: string,
  kind: "income" | "expense",
  inIncomeStatement = false
): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Account name is required");
  if (kind !== "income" && kind !== "expense") throw new Error("Kind must be income or expense");
  // Reserved names already have dedicated P&L handling; reusing one would make
  // its amounts count twice (once via its own line, once via the fixed field).
  if (isReservedAccount(trimmed)) throw new Error(`"${trimmed}" is a built-in account name — pick a different one`);

  const { data: existing } = await supabase.from("expense_accounts").select("id").ilike("name", trimmed).maybeSingle();
  if (existing) throw new Error("An account with that name already exists");

  const { data: maxRow } = await supabase
    .from("expense_accounts")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = (maxRow?.sort_order ?? 0) + 1;

  const { data, error } = await supabase
    .from("expense_accounts")
    .insert({ name: trimmed, kind, sort_order: nextSort, in_income_statement: inIncomeStatement })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create account: ${error?.message}`);
  return data.id;
}

// Recorded amounts per month for every owner-added (non-reserved) account,
// whether or not it carries a P&L line. The Expense Analysis lists them all;
// `inIncomeStatement` tells it which ones to tag as analysis-only.
export async function getCustomAccountsByMonth(): Promise<AnalysisAccount[]> {
  const accounts = (await getExpenseAccounts()).filter((a) => !isReservedAccount(a.name));
  if (accounts.length === 0) return [];
  const known = new Set(accounts.map((a) => a.id));

  const entries = await fetchAllRows<{ date: string; amount: number; account_id: number }>(
    supabase,
    "expense_entries",
    "id, date, amount, account_id"
  );
  const byAccount = new Map<number, Record<string, number>>();
  for (const e of entries) {
    if (!known.has(e.account_id)) continue;
    const month = e.date.slice(0, 7);
    const cur = byAccount.get(e.account_id) ?? {};
    cur[month] = (cur[month] ?? 0) + Number(e.amount);
    byAccount.set(e.account_id, cur);
  }
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    inIncomeStatement: a.inIncomeStatement,
    byMonth: byAccount.get(a.id) ?? {},
  }));
}

// ---- Entries (the recording ledger) ----------------------------------------

export async function getExpenseEntries(): Promise<ExpenseEntry[]> {
  const rows = await fetchAllRows<{
    id: number;
    date: string;
    account_id: number;
    amount: number;
    note: string | null;
    expense_accounts: { name: string; kind: "income" | "expense" } | null;
  }>(supabase, "expense_entries", "id, date, account_id, amount, note, expense_accounts(name, kind)");
  return rows
    .map((r) => ({
      id: r.id,
      date: r.date,
      accountId: r.account_id,
      accountName: r.expense_accounts?.name ?? "?",
      kind: r.expense_accounts?.kind ?? "expense",
      amount: Number(r.amount),
      note: r.note,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)); // newest first
}

export async function createExpenseEntry(input: { date: string; accountId: number; amount: number; note?: string | null }): Promise<number> {
  if (!input.date) throw new Error("Date is required");
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("Amount must be a positive number");
  const { data, error } = await supabase
    .from("expense_entries")
    .insert({ date: input.date, account_id: input.accountId, amount: input.amount, note: input.note ?? null })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to add entry: ${error?.message}`);
  return data.id;
}

export async function updateExpenseEntry(id: number, patch: { date?: string; accountId?: number; amount?: number; note?: string | null }): Promise<void> {
  const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.date !== undefined) values.date = patch.date;
  if (patch.accountId !== undefined) values.account_id = patch.accountId;
  if (patch.amount !== undefined) {
    if (!Number.isFinite(patch.amount) || patch.amount <= 0) throw new Error("Amount must be a positive number");
    values.amount = patch.amount;
  }
  if (patch.note !== undefined) values.note = patch.note;
  const { error } = await supabase.from("expense_entries").update(values).eq("id", id);
  if (error) throw new Error(`Failed to update entry: ${error.message}`);
}

export async function deleteExpenseEntry(id: number): Promise<void> {
  const { error } = await supabase.from("expense_entries").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete entry: ${error.message}`);
}

// ---- Assumptions (open-month, per expense account) -------------------------

export async function getExpenseAssumptions(): Promise<ExpenseAssumption[]> {
  const accounts = (await getExpenseAccounts()).filter((a) => a.kind === "expense");
  const rows = await fetchAllRows<{ account_id: number; monthly_amount: number }>(
    supabase,
    "expense_assumptions",
    "account_id, monthly_amount",
    undefined,
    ["account_id"]
  );
  const byId = new Map(rows.map((r) => [r.account_id, Number(r.monthly_amount)]));
  return accounts.map((a) => ({ accountId: a.id, accountName: a.name, monthlyAmount: byId.get(a.id) ?? 0 }));
}

export async function setExpenseAssumption(accountId: number, monthlyAmount: number): Promise<void> {
  if (!Number.isFinite(monthlyAmount) || monthlyAmount < 0) throw new Error("Assumption must be zero or a positive number");
  const { error } = await supabase
    .from("expense_assumptions")
    .upsert({ account_id: accountId, monthly_amount: monthlyAmount, updated_at: new Date().toISOString() }, { onConflict: "account_id" });
  if (error) throw new Error(`Failed to save assumption: ${error.message}`);
}

// ---- The resolver used by the P&L ------------------------------------------

export type OverheadResolver = {
  forMonth: (month: string) => Overheads;
  otherIncomeForMonth: (month: string) => number;
  // Owner-added accounts flagged into the P&L, each its own named line. Always
  // returns every such account (amount 0 when nothing is recorded) so a line
  // doesn't blink in and out of the statement month to month.
  customLinesForMonth: (month: string) => CustomPnlLine[];
};

// Resolves each month's six overhead amounts:
//   current calendar month -> the Settings assumption
//   any ended month        -> resolveEndedMonthOverheads: the hardcoded table
//                             where it has that month (empty for Miraj), else
//                             recorded actuals
// Loaded once (two small reads) then resolved synchronously per month.
export async function getOverheadResolver(): Promise<OverheadResolver> {
  const recorded = await loadRecordedByMonth();
  const recordedOtherIncome = await loadOtherIncomeByMonth();

  const assumptionRows = await fetchAllRows<{ account_id: number; monthly_amount: number }>(
    supabase,
    "expense_assumptions",
    "account_id, monthly_amount",
    undefined,
    ["account_id"]
  );
  const accounts = await getExpenseAccounts();
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));
  const assumption: Overheads = { ...ZERO };
  let otherIncomeAssumption = 0;
  // Open-month assumption per owner-added P&L account, keyed by account id.
  const customAssumption = new Map<number, number>();
  for (const r of assumptionRows) {
    const name = nameById.get(r.account_id) ?? "";
    const key = ACCOUNT_TO_KEY[name];
    if (key) assumption[key] = Number(r.monthly_amount);
    else if (name === OTHER_INCOME_ACCOUNT) otherIncomeAssumption = Number(r.monthly_amount);
    else customAssumption.set(r.account_id, Number(r.monthly_amount));
  }

  // The owner-added accounts that carry a P&L line, and what each recorded per
  // month. Reserved accounts are excluded - they already have their own fields.
  const customAccounts = accounts.filter((a) => !isReservedAccount(a.name) && a.inIncomeStatement);
  const customRecorded = new Map<number, Map<string, number>>();
  if (customAccounts.length > 0) {
    const ids = new Set(customAccounts.map((a) => a.id));
    const entries = await fetchAllRows<{ date: string; amount: number; account_id: number }>(
      supabase,
      "expense_entries",
      "id, date, amount, account_id"
    );
    for (const e of entries) {
      if (!ids.has(e.account_id)) continue;
      const month = e.date.slice(0, 7);
      const cur = customRecorded.get(e.account_id) ?? new Map<string, number>();
      cur.set(month, (cur.get(month) ?? 0) + Number(e.amount));
      customRecorded.set(e.account_id, cur);
    }
  }

  const currentMonth = egyptToday().slice(0, 7);

  return {
    forMonth(month: string): Overheads {
      if (month === currentMonth) return { ...assumption }; // open month -> assumption
      if (month > currentMonth) return { ...ZERO }; // future month
      return resolveEndedMonthOverheads(month, recorded.get(month)); // hardcoded where listed, else recorded
    },
    // Income has no hardcoded history, so before the cutover it's simply zero.
    otherIncomeForMonth(month: string): number {
      if (month < CUTOVER_MONTH) return 0;
      if (month < currentMonth) return recordedOtherIncome.get(month) ?? 0; // recorded actuals
      if (month === currentMonth) return otherIncomeAssumption; // open month -> assumption
      return 0;
    },
    // Same month basis as the fixed overheads: recorded actuals once a month has
    // ended, the Settings assumption for the open month. Owner-added accounts
    // have no hardcoded history, so pre-cutover months are zero.
    customLinesForMonth(month: string): CustomPnlLine[] {
      return customAccounts.map((a) => {
        let amount = 0;
        if (month >= CUTOVER_MONTH && month <= currentMonth) {
          amount = month < currentMonth ? customRecorded.get(a.id)?.get(month) ?? 0 : customAssumption.get(a.id) ?? 0;
        }
        return { accountId: a.id, name: a.name, kind: a.kind, amount };
      });
    },
  };
}
