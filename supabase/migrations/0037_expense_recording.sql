-- Expense recording ledger + open-month assumptions. Replaces the hardcoded
-- fixed monthly expenses going forward (Jul 2026+): closed calendar months read
-- their recorded actuals, the current month reads the Settings assumption, and
-- months before the cutover keep the hardcoded MIRAJ figures (in code).

create table if not exists public.expense_accounts (
  id bigint generated always as identity primary key,
  name text not null unique,
  kind text not null check (kind in ('income', 'expense')),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

insert into public.expense_accounts (name, kind, sort_order) values
  ('Salary', 'expense', 1),
  ('Post Production', 'expense', 2),
  ('Subscription', 'expense', 3),
  ('Rent', 'expense', 4),
  ('Transportation', 'expense', 5),
  ('Other', 'expense', 6),
  ('Bosta', 'income', 7)
on conflict (name) do nothing;

-- Actual recorded entries (amount is always positive; income vs expense comes
-- from the account's kind).
create table if not exists public.expense_entries (
  id bigint generated always as identity primary key,
  date date not null,
  account_id bigint not null references public.expense_accounts(id),
  amount numeric(12,2) not null check (amount > 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists expense_entries_date_idx on public.expense_entries (date);
create index if not exists expense_entries_account_idx on public.expense_entries (account_id);

-- One monthly assumption per expense account, used for the current (open)
-- calendar month.
create table if not exists public.expense_assumptions (
  account_id bigint primary key references public.expense_accounts(id),
  monthly_amount numeric(12,2) not null default 0,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
