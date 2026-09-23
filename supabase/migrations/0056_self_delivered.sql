-- Some Shopify orders never go through Bosta at all - they are handed to the
-- customer privately. Bosta has no record of them, so the delivery sync can
-- never resolve them: they sit at 'in_transit' forever, drag the delivery rate
-- down, and (because revenue is only recognised on a delivered order) keep
-- their revenue and COGS out of the Income Statement entirely.
--
-- The fix is to let someone record the real outcome. A privately delivered
-- order is stamped outcome = 'delivered' - so every existing rule about
-- delivered orders (revenue, COGS, delivery rate, "resolved") applies with no
-- special-casing - plus this flag, which tells the margin engine the order paid
-- no courier fee, no open-package fee and no COD cash fee, because no courier
-- ever touched it. See src/lib/engine/margin.ts.

alter table public.orders
  add column if not exists self_delivered boolean not null default false;

comment on column public.orders.self_delivered is
  'Delivered by us, not by the courier. Counts as delivered everywhere; carries no courier/open-package/COD fees.';

-- The Unresolved Orders tab reads "not cancelled and not resolved" over the
-- whole table on every load.
create index if not exists orders_outcome_open_idx
  on public.orders (egypt_day)
  where cancelled_at is null
    and coalesce(outcome, '') not in ('delivered', 'failed_rto', 'exchange', 'pickup_return');
