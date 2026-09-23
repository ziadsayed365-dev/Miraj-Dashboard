// Fixed monthly overheads for the Income Statement, below Contribution Profit.
// This is the escape hatch for overheads that predate the app: a month reads the
// hardcoded table below instead of the database when it falls before
// EXPENSE_CUTOVER_MONTH, or when it is listed in the table explicitly. Meta is
// deliberately excluded — ad spend is already subtracted above (in Contribution
// Profit).
//
// Miraj uses neither branch: the cutover sits at the first month of its data and
// the table is empty, so every month's overheads come from what is recorded in
// the app. Keep it that way where you can — a figure in the ledger is one the
// owner can see and edit, and one hardcoded here is not.
//
// Plain module (no "use client"/"server-only") so both the server P&L engine and
// the client table components can read the real values across the RSC boundary.
import { daysInMonth } from "@/lib/dates";

export type OverheadKey = "salary" | "postProduction" | "subscription" | "rent" | "transportation" | "other";

// Recorded expenses take over from this month onward; earlier months use the
// hardcoded figures below. Shared by the server resolver and the (client)
// Expense Analysis report.
//
// Set to the first month of Miraj's data (keep in step with
// SHOPIFY_ORDERS_SINCE), so no month falls into the hardcoded branch by date
// alone - a month only gets there by being named in the table.
export const EXPENSE_CUTOVER_MONTH = "2025-07";

// Display order for the monthly Income Statement (Subscription + Rent sit above
// Transportation, per the owner).
export const OVERHEAD_LABELS: { key: OverheadKey; label: string }[] = [
  { key: "salary", label: "Salary" },
  { key: "postProduction", label: "Post Production" },
  { key: "subscription", label: "Subscription" },
  { key: "rent", label: "Rent" },
  { key: "transportation", label: "Transportation" },
  { key: "other", label: "Other - Expense" },
];

export type Overheads = Record<OverheadKey, number>;
const ZERO: Overheads = { salary: 0, postProduction: 0, subscription: 0, rent: 0, transportation: 0, other: 0 };

// Keyed by "YYYY-MM". Only the fields present are listed; the rest default to 0.
//
// Empty, and meant to stay that way. Jul-Dec 2025 briefly lived here as
// 300,000/month before being recorded properly as expense_entries against
// "Other - Expense" (ids 8-13), which extended the owner's existing standing
// figure back to the start of the data. The ledger is the single source of truth
// for every month now, and the owner can edit those months in the app like any
// other. Only populate this if overheads ever need to predate the ledger itself.
const FIXED_MONTHLY_EXPENSES: Record<string, Partial<Overheads>> = {};

// All six overheads for a calendar month ("YYYY-MM"); zeros for months with no
// data yet.
export function overheadsForMonth(month: string): Overheads {
  const raw = FIXED_MONTHLY_EXPENSES[month];
  return raw ? { ...ZERO, ...raw } : ZERO;
}

// The one rule for which source an ended month's overheads come from, exported
// so the server P&L resolver and the client Expense Analysis apply it
// identically - the two used to carry their own copy, and a copy is exactly how
// the Income Statement and the expense report start disagreeing about a month.
//
// A month named in the table wins over anything recorded for it, mirroring how
// pre-cutover months have always behaved (the table is unconditional there). The
// table being empty is what hands every month to the ledger — so if you ever add
// a row here, know that it silently outranks whatever the owner records for that
// month in the app.
export function resolveEndedMonthOverheads(month: string, recorded: Overheads | undefined): Overheads {
  if (month < EXPENSE_CUTOVER_MONTH || month in FIXED_MONTHLY_EXPENSES) return overheadsForMonth(month);
  return recorded ?? ZERO;
}

export function overheadsTotal(o: Overheads): number {
  return o.salary + o.postProduction + o.subscription + o.rent + o.transportation + o.other;
}

// One day's share of its month's total overheads (month total / days in month),
// so daily and arbitrary-range views can carry the fixed cost per day.
export function fixedOverheadShareForDay(date: string): number {
  const total = overheadsTotal(overheadsForMonth(date.slice(0, 7)));
  return total === 0 ? 0 : total / daysInMonth(date);
}
