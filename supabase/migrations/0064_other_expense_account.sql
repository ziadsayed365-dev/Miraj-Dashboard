-- The catch-all overhead account reads "Other - Expense" on the Income
-- Statement and in the Expense Analysis (both labels are hardcoded there), but
-- the account row was still seeded as plain "Other" by 0037. Everything driven
-- by the account NAME - the Expense Recording account list and Settings ->
-- Fixed Expense Assumptions - therefore showed "Other", which the owner could
-- not match to the statement line.
--
-- Rename the row so all four places agree. ACCOUNT_TO_KEY in expenses-ledger.ts
-- already maps BOTH names to the "other" overhead key, so no recorded amount
-- changes hands.
update public.expense_accounts set name = 'Other - Expense' where name = 'Other';

-- The owner's standing figure for this account: 300,000 EGP per month for every
-- historical (ended) month of Miraj's data, 2026-01 .. 2026-07. An ended month
-- reads its RECORDED entries (never the assumption), so the figure has to exist
-- as one ledger entry per month. Skipped for any month that already has an
-- entry on this account, so re-running never doubles a month and never
-- overwrites a real recorded amount.
insert into public.expense_entries (date, account_id, amount, note)
select m::date, a.id, 300000, 'Standing monthly figure - 300,000/month (owner)'
from public.expense_accounts a
cross join generate_series(date '2026-01-01', date '2026-07-01', interval '1 month') as m
where a.name = 'Other - Expense'
  and not exists (
    select 1
    from public.expense_entries e
    where e.account_id = a.id and date_trunc('month', e.date) = m
  );

-- The open (current) calendar month reads the Settings assumption instead, so
-- the same 300,000 carries forward month after month until the owner edits it
-- under Settings -> Fixed Expense Assumptions.
insert into public.expense_assumptions (account_id, monthly_amount, updated_at)
select a.id, 300000, now()
from public.expense_accounts a
where a.name = 'Other - Expense'
on conflict (account_id) do update set monthly_amount = 300000, updated_at = now();

notify pgrst, 'reload schema';
