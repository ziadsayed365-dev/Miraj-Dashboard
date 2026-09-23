-- Reconcile the two Income Statement modes, and add the Delivery Rate denominator.
--
-- 1. Actual reported NOTHING. It dated every order by o.bosta_picked_up_day,
--    which is null on all 36,180 orders - Bosta's collectedFromBusiness stamp
--    has never come through (see the note in src/lib/sync/bosta-deliveries.ts).
--    daily_pnl('actual') returned zero rows and the tab was blank. `o.courier`
--    is no better: it is owner-entered and has never been filled either.
--
--    Both modes now date by the Shopify order day. The mode changes exactly one
--    thing: WHICH orders contribute. Actual counts only orders that were
--    physically handed over - a Bosta tracking number, or self_delivered where
--    we did the handover ourselves. That also makes the two modes comparable:
--    an order placed 30 July and collected 2 August used to sit in July under
--    Performance and August under Actual.
--
-- 2. orders_received is new: every order that came in that day, cancellations
--    and never-shipped included, and deliberately mode-INDEPENDENT. It is the
--    denominator of the Income Statement's Delivery Rate row, so both views
--    read against one total. Kept separate from orders_placed, which drops
--    cancellations because they earn nothing.
drop function if exists public.daily_pnl(text);
create or replace function public.daily_pnl(p_mode text)
returns table (
  day date,
  orders_placed bigint,
  orders_resolved bigint,
  orders_received bigint,
  delivered_count bigint,
  items_sold bigint,
  revenue numeric,
  cogs numeric,
  gross_revenue numeric,
  gross_cogs numeric,
  packaging numeric,
  bosta_penalty numeric,
  bosta_fees_paid numeric,
  cod_cash_fee numeric,
  open_package_fee numeric,
  shipping_fee_charged numeric
)
language sql
stable
as $$
  with ord as (
    select
      o.id,
      o.egypt_day,
      o.outcome,
      o.cancelled_at,
      o.shipping_fee_charged,
      o.bosta_tracking_number,
      -- Must stay in lockstep with isHandedToCourier() in
      -- src/lib/reports/actual-mode.ts.
      (o.bosta_tracking_number is not null or o.self_delivered) as handed_over
    from public.orders o
    where o.egypt_day is not null
  ),
  -- Every order, whatever its mode or outcome: the Delivery Rate denominator.
  received_agg as (
    select egypt_day as day, count(*) as orders_received
    from ord
    group by egypt_day
  ),
  -- The orders this mode actually reports money and counts on.
  ord2 as (
    select * from ord
    where cancelled_at is null
      and (p_mode = 'performance' or handed_over)
  ),
  -- Cancelled but already handed to Bosta: the package went out and came back,
  -- so it owes a return fee and an open-package fee and nothing else. Included
  -- in both modes - it did reach a courier, so Actual owes it too.
  cancelled_shipped as (
    select
      o.egypt_day as day,
      sum(coalesce(l.allocated_courier_fee, 0)) as penalty,
      sum(coalesce(l.allocated_open_package_fee, 0)) as open_package
    from ord o
    join public.order_line_items l on l.order_id = o.id
    where o.cancelled_at is not null
      and o.bosta_tracking_number is not null
    group by 1
  ),
  order_agg as (
    select
      egypt_day as day,
      count(*) as orders_placed,
      count(*) filter (where outcome in ('delivered','failed_rto','exchange','pickup_return')) as orders_resolved,
      count(*) filter (where outcome = 'delivered') as delivered_count,
      sum(case when outcome is distinct from 'failed_rto' then coalesce(shipping_fee_charged,0) else 0 end) as shipping_fee_charged
    from ord2
    group by egypt_day
  ),
  line_agg as (
    select
      ord2.egypt_day as day,
      sum(l.quantity) as items_sold,
      sum(case when ord2.outcome = 'delivered' then coalesce(l.revenue,0) else 0 end) as revenue,
      sum(case when ord2.outcome = 'delivered'
               then coalesce(l.cost_of_goods,0) - coalesce(l.refund_adjustment,0) - coalesce(l.damage_adjustment,0)
               else 0 end) as cogs,
      sum(coalesce(l.revenue,0)) as gross_revenue,
      sum(coalesce(l.cost_of_goods,0)) as gross_cogs,
      sum(coalesce(l.packing_cost,0)) as packaging,
      sum(case when ord2.outcome = 'failed_rto' then coalesce(l.allocated_courier_fee,0) else 0 end) as bosta_penalty,
      sum(case when ord2.outcome is distinct from 'failed_rto' then coalesce(l.allocated_courier_fee,0) else 0 end) as bosta_fees_paid,
      sum(case when ord2.outcome is distinct from 'failed_rto' then coalesce(l.allocated_cod_cash_fee,0) else 0 end) as cod_cash_fee,
      sum(coalesce(l.allocated_open_package_fee,0)) as open_package_fee
    from ord2
    join public.order_line_items l on l.order_id = ord2.id
    group by ord2.egypt_day
  ),
  days as (
    select day from received_agg
    union select day from order_agg
    union select day from line_agg
    union select day from cancelled_shipped
  )
  select
    d.day,
    coalesce(oa.orders_placed, 0),
    coalesce(oa.orders_resolved, 0),
    coalesce(ra.orders_received, 0),
    coalesce(oa.delivered_count, 0),
    coalesce(la.items_sold, 0),
    coalesce(la.revenue, 0),
    coalesce(la.cogs, 0),
    coalesce(la.gross_revenue, 0),
    coalesce(la.gross_cogs, 0),
    coalesce(la.packaging, 0),
    -- Returns plus cancellations that had already shipped.
    coalesce(la.bosta_penalty, 0) + coalesce(cs.penalty, 0),
    coalesce(la.bosta_fees_paid, 0),
    coalesce(la.cod_cash_fee, 0),
    coalesce(la.open_package_fee, 0) + coalesce(cs.open_package, 0),
    coalesce(oa.shipping_fee_charged, 0)
  from days d
  left join received_agg ra on ra.day = d.day
  left join order_agg oa on oa.day = d.day
  left join line_agg la on la.day = d.day
  left join cancelled_shipped cs on cs.day = d.day;
$$;

grant execute on function public.daily_pnl(text) to anon, authenticated, service_role;

-- Analysis by Product's Actual mode had the identical bug and the identical
-- fix, so the two pages keep agreeing on what "Actual" means.
create or replace function public.per_product_stats(p_mode text, p_from date, p_to date)
returns table(product_id bigint, variant_id bigint, orders_placed bigint, orders_resolved bigint, items_sold bigint, revenue numeric, cogs numeric)
language sql
stable
as $function$
  with ord2 as (
    select o.id, o.outcome
    from public.orders o
    where o.cancelled_at is null
      and o.egypt_day >= p_from
      and o.egypt_day <= p_to
      and (p_mode = 'performance' or o.bosta_tracking_number is not null or o.self_delivered)
  )
  select
    l.product_id,
    l.variant_id,
    count(*) as orders_placed,
    count(*) filter (where ord2.outcome in ('delivered','failed_rto','exchange','pickup_return')) as orders_resolved,
    sum(coalesce(l.quantity, 0)) as items_sold,
    sum(coalesce(l.revenue, 0)) as revenue,
    sum(coalesce(l.cost_of_goods, 0)) as cogs
  from ord2
  join public.order_line_items l on l.order_id = ord2.id
  where l.product_id is not null
  group by l.product_id, l.variant_id;
$function$;

grant execute on function public.per_product_stats(text, date, date) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
