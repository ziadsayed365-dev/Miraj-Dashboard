-- Analysis-only expense accounts: categories the owner wants to track and see
-- in the Expense Analysis report, but that must NOT reduce Net Income on the
-- Income Statement (e.g. owner drawings, one-off non-operating spend).
--
-- The Income Statement only ever reads the six fixed overhead accounts (Salary,
-- Post Production, Subscription, Rent, Transportation, Other) via ACCOUNT_TO_KEY
-- in expenses-ledger.ts, so any other account is already excluded from the P&L.
-- This flag makes that intent explicit and drives the Expense Analysis, which
-- shows in_income_statement = false accounts as their own rows.

alter table public.expense_accounts
  add column if not exists in_income_statement boolean not null default true;

notify pgrst, 'reload schema';
