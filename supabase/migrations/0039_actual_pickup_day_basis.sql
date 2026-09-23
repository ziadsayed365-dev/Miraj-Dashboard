-- Actual mode buckets on the day the package was handed to the courier, not
-- the Shopify order day. This restores the original intent of migration 0026:
-- Shopify auto-forwards every order to Bosta the instant it's placed (leg state
-- "Created"), but the owner may not hand the physical package over for days
-- (observed: ordered Jun 28, collected by Bosta Jul 13 - median lag 1 day, max
-- 31), so the order day says nothing about when an order actually shipped.
--
-- Why this was broken: the 0027/0028 backfills were gated on `courier =
-- 'bosta'`, but courier is owner-entered from the Shipping Orders tab and is
-- NULL on every Miraj order - so both matched zero rows, bosta_picked_up_day
-- stayed null forever, and 0035 concluded the pickup basis "made Actual empty"
-- and fell back to dating delivered orders by their order day. That made Actual
-- a near-copy of Performance: same revenue by construction (revenue is
-- delivered-only in BOTH modes), and byte-identical in the still-open month.
--
-- Part 1 re-runs the 0028 backfill without the courier gate. Part 2 repoints the
-- aggregate at bosta_picked_up_day. Going forward the Bosta sync maintains the
-- column itself (see pickedUpDay() in src/lib/sync/bosta-deliveries.ts).
--
-- NOTE: part 2 is based on the function as it exists in the live database, which
-- is 0036's 14-column shape (day..cod_cash_fee, shipping_fee_charged) - NOT the
-- 15-column 0038 shape, since 0038 was never applied here. Only the eff_day CASE
-- differs from the live definition; every other expression is byte-identical, so
-- this changes which day/orders each mode sees and nothing else. Keep the
-- signature in sync with whatever is live or `create or replace` will fail with
-- "cannot change return type of existing function".

-- Part 1: backfill bosta_picked_up_day from data already in bosta_events.
-- Earliest collectedFromBusiness across all non-"Created" legs (Bosta mutates a
-- leg's type in place on RTO/Exchange, so this cannot filter on type 'Send';
-- earliest so a genuine second shipment never overrides the original pickup).
-- +3 hours = the fixed UTC+3 Egypt offset used for egypt_day everywhere else.
update public.orders o
set bosta_picked_up_day = (be.collected_from_business + interval '3 hours')::date
from (
  select order_id, min((raw_payload->>'collectedFromBusiness')::timestamptz) as collected_from_business
  from public.bosta_events
  where bosta_state <> 'Created'
    and raw_payload->>'collectedFromBusiness' is not null
  group by order_id
) be
where be.order_id = o.id
  and o.bosta_picked_up_day is null;

-- Part 2: Actual = orders handed to a courier, dated by that handover day.
-- Orders never handed over (no pickup date on either courier) are excluded
-- entirely - an order Shopify auto-forwarded but that never physically shipped
-- has no place in a fulfillment view. Performance mode is unchanged.
--
-- Dropped first: changing the OUT columns of an existing function is a 42P13
-- error, not a replace. See the same note in 0035.
drop function if exists public.daily_pnl(text);
create or replace function public.daily_pnl(p_mode text)
returns table (
  day date,
  orders_placed bigint,
  orders_resolved bigint,
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
  shipping_fee_charged numeric
)
language sql
stable
as $$
  with ord as (
    select
      o.id,
      case
        when p_mode = 'performance' then o.egypt_day
        else coalesce(o.bosta_picked_up_day, o.movers_record_date)  -- actual: courier handover day
      end as eff_day,
      o.outcome,
      o.shipping_fee_charged
    from public.orders o
    where o.cancelled_at is null
  ),
  ord2 as (select * from ord where eff_day is not null),
  order_agg as (
    select
      eff_day as day,
      count(*) as orders_placed,
      count(*) filter (where outcome in ('delivered','failed_rto','exchange','pickup_return')) as orders_resolved,
      count(*) filter (where outcome = 'delivered') as delivered_count,
      sum(case when outcome is distinct from 'failed_rto' then coalesce(shipping_fee_charged,0) else 0 end) as shipping_fee_charged
    from ord2
    group by eff_day
  ),
  line_agg as (
    select
      ord2.eff_day as day,
      sum(l.quantity) as items_sold,
      sum(case when ord2.outcome = 'delivered' then coalesce(l.revenue,0) else 0 end) as revenue,
      sum(case when ord2.outcome = 'delivered'
               then coalesce(l.cost_of_goods,0) - coalesce(l.refund_adjustment,0) - coalesce(l.damage_adjustment,0)
               else 0 end) as cogs,
      sum(coalesce(l.revenue,0)) as gross_revenue,
      sum(coalesce(l.cost_of_goods,0)) as gross_cogs,
      sum(coalesce(l.packing_cost,0)) as packaging,
      sum(case when ord2.outcome = 'failed_rto'
               then coalesce(l.allocated_courier_fee,0) + coalesce(l.allocated_open_package_fee,0)
               else 0 end) as bosta_penalty,
      -- Courier + open-package on the non-returned side (COD cash fee split out below).
      sum(case when ord2.outcome is distinct from 'failed_rto'
               then coalesce(l.allocated_courier_fee,0) + coalesce(l.allocated_open_package_fee,0)
               else 0 end) as bosta_fees_paid,
      sum(case when ord2.outcome is distinct from 'failed_rto'
               then coalesce(l.allocated_cod_cash_fee,0)
               else 0 end) as cod_cash_fee
    from ord2
    join public.order_line_items l on l.order_id = ord2.id
    group by ord2.eff_day
  )
  select
    coalesce(oa.day, la.day) as day,
    coalesce(oa.orders_placed, 0),
    coalesce(oa.orders_resolved, 0),
    coalesce(oa.delivered_count, 0),
    coalesce(la.items_sold, 0),
    coalesce(la.revenue, 0),
    coalesce(la.cogs, 0),
    coalesce(la.gross_revenue, 0),
    coalesce(la.gross_cogs, 0),
    coalesce(la.packaging, 0),
    coalesce(la.bosta_penalty, 0),
    coalesce(la.bosta_fees_paid, 0),
    coalesce(la.cod_cash_fee, 0),
    coalesce(oa.shipping_fee_charged, 0)
  from order_agg oa
  full outer join line_agg la on oa.day = la.day;
$$;

notify pgrst, 'reload schema';
