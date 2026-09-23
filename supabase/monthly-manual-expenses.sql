-- Manually-entered monthly P&L values (owner types them in the Income
-- Statement). One row per (month, account). Computed lines (Shipping
-- Differences, Bosta Penalty) are NOT stored here.
create table if not exists public.monthly_manual_expenses (
  month date not null,          -- first day of the month
  account text not null,        -- e.g. 'salaries', 'rent', 'tax'
  amount numeric(14,2) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (month, account)
);

grant all on public.monthly_manual_expenses to anon, authenticated, service_role;
