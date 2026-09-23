-- The owner's real "Other - Expense" figures, replacing the flat 300,000/month
-- standing figure that 0064 seeded across every historical month.
--
--   2025-07            0  (no entry at all - the ledger has no zero, and the
--                          amount > 0 check would reject one)
--   2025-08 .. 2025-09    40,000
--   2025-10 .. 2026-01    80,000
--   2026-02 .. 2026-03   200,000
--
-- 2026-04 onward is deliberately untouched: the owner gave no figures past
-- March, so those months keep the 300,000 standing figure, as does the
-- Settings assumption that drives the open month.
--
-- Each listed month is rewritten wholesale - every Other - Expense entry in it
-- is removed and replaced by one entry carrying the month's total - so the
-- migration is re-runnable and lands on the same numbers whatever was there
-- before. That also means it OVERWRITES anything separately recorded against
-- this account in those months; nothing but 0064's standing figure was, at the
-- time this was written.
with target(month, amount) as (
  values
    (date '2025-08-01',  40000),
    (date '2025-09-01',  40000),
    (date '2025-10-01',  80000),
    (date '2025-11-01',  80000),
    (date '2025-12-01',  80000),
    (date '2026-01-01',  80000),
    (date '2026-02-01', 200000),
    (date '2026-03-01', 200000)
),
acct as (select id from public.expense_accounts where name = 'Other - Expense'),
wiped as (
  delete from public.expense_entries e
  using acct
  where e.account_id = acct.id
    and (
      date_trunc('month', e.date) = date '2025-07-01'
      or date_trunc('month', e.date) in (select month from target)
    )
  returning 1
)
insert into public.expense_entries (date, account_id, amount, note)
select t.month, acct.id, t.amount, 'Monthly figure (owner)'
from target t
cross join acct
where (select count(*) from wiped) >= 0;

notify pgrst, 'reload schema';
