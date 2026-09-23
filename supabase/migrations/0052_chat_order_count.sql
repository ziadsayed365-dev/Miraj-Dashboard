-- A single chat_orders row can stand for MORE THAN ONE real order. The owner
-- sometimes bundles several chats into one record (e.g. 10 orders typed as one).
-- Revenue, COGS and items are already the bundle's totals, so those need no
-- scaling - but the Shipping Difference is a PER-ORDER figure (see
-- src/lib/reports/daily-pnl.ts), so reporting has to know how many real orders a
-- row represents to estimate it. Defaults to 1 - one row, one order - which is
-- exactly how every existing record and every future single-order record behaves.
alter table public.chat_orders
  add column if not exists order_count int not null default 1 check (order_count > 0);

notify pgrst, 'reload schema';
