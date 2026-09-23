-- What the Delivery Rate tab's denominator is actually made of, per month.
--
-- The rate is delivered / every order received, so a cancellation and an order
-- nobody ever handed to a courier are both in it and both drag it down. Neither
-- was visible anywhere on the tab: the only badge under a rate was "n open",
-- measured as placed - resolved, which silently mixed orders sitting at Bosta
-- with orders that never left the building - and the page then called all of
-- them "still with the courier". Sep 2026 was 301 at Bosta and 267 that no
-- courier ever received.
--
-- Counts only, for display. The rate itself still comes from the same daily_pnl
-- figures the Income Statement uses, so the two pages cannot drift apart.
--
--   never_handed      - no Bosta tracking number and not self-delivered, at any
--                       outcome. Must stay in lockstep with isHandedToCourier()
--                       in src/lib/reports/actual-mode.ts.
--   open_at_courier   - handed over, still no final outcome. Can still deliver.
--   open_never_handed - never handed over, still no final outcome. Will not
--                       deliver on its own: someone has to record what happened
--                       to it in Bosta > Unresolved Orders.
create or replace function public.monthly_order_mix()
returns table (
  month text,
  cancelled bigint,
  never_handed bigint,
  open_at_courier bigint,
  open_never_handed bigint
)
language sql
stable
as $$
  with o as (
    select
      to_char(orders.egypt_day, 'YYYY-MM') as month,
      orders.cancelled_at is not null as cancelled,
      (orders.bosta_tracking_number is null and not coalesce(orders.self_delivered, false)) as never_handed,
      coalesce(orders.outcome, '') in ('delivered', 'failed_rto', 'exchange', 'pickup_return') as resolved
    from public.orders
    where orders.egypt_day is not null
  )
  select
    o.month,
    count(*) filter (where o.cancelled)::bigint,
    count(*) filter (where o.never_handed)::bigint,
    count(*) filter (where not o.cancelled and not o.resolved and not o.never_handed)::bigint,
    count(*) filter (where not o.cancelled and not o.resolved and o.never_handed)::bigint
  from o
  group by o.month;
$$;

grant execute on function public.monthly_order_mix() to anon, authenticated, service_role;

notify pgrst, 'reload schema';
