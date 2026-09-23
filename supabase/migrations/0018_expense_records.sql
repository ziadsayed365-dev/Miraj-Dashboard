-- "Record Data" feature, Expenses tab: a manual ledger for entries that
-- don't come from Shopify/Bosta/Meta (cash collections, subscriptions,
-- refunds, etc.). account_types is the reference list of accounts and
-- whether each one is income or expense, seeded from the user's
-- Expense.xlsx; recorded_transactions is the actual entered rows. type is
-- copied from the account onto the transaction at insert time so a later
-- reclassification of an account doesn't rewrite history.
create table if not exists account_types (
  id bigint generated always as identity primary key,
  name text not null unique,
  type text not null check (type in ('income', 'expense')),
  created_at timestamptz not null default now()
);

insert into account_types (name, type) values
  ('Ta7selat', 'income'),
  ('Tasne3', 'expense'),
  ('Marketing', 'expense'),
  ('Subscriptions', 'expense'),
  ('Packaging', 'expense'),
  ('Transportation', 'expense'),
  ('Salary', 'expense'),
  ('Bosta', 'income'),
  ('Refund', 'expense'),
  ('Media Buyer', 'expense'),
  ('Moverz', 'income'),
  ('Other Income', 'income'),
  ('Other Expense', 'expense')
on conflict (name) do nothing;

create table if not exists recorded_transactions (
  id bigint generated always as identity primary key,
  date date not null,
  account_type_id bigint not null references account_types(id),
  type text not null check (type in ('income', 'expense')),
  description text,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);
