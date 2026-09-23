-- An order we delivered ourselves (self_delivered, recorded on the Unresolved
-- Orders tab) has no courier handover stamp - no bosta_picked_up_day, no
-- movers_record_date - so the "actual" basis, which dates an order on the day a
-- courier collected it, found no date for it and dropped it from the report
-- entirely. It was visible in Performance and invisible in Actual.
--
-- We handed it over ourselves on the day it was placed, so that is its actual
-- date. Both mode-aware report functions get the same extra branch; everything
-- else in them is unchanged.

CREATE OR REPLACE FUNCTION public.daily_pnl(p_mode text)
 RETURNS TABLE(day date, orders_placed bigint, orders_resolved bigint, delivered_count bigint, items_sold bigint, revenue numeric, cogs numeric, gross_revenue numeric, gross_cogs numeric, packaging numeric, bosta_penalty numeric, bosta_fees_paid numeric, cod_cash_fee numeric, open_package_fee numeric, shipping_fee_charged numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with ord as (
    select
      o.id,
      case
        when p_mode = 'performance' then o.egypt_day
        when o.self_delivered then o.egypt_day  -- we delivered it ourselves, on its order day
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
      -- Courier fee only, both sides (open package split out below).
      sum(case when ord2.outcome = 'failed_rto' then coalesce(l.allocated_courier_fee,0) else 0 end) as bosta_penalty,
      sum(case when ord2.outcome is distinct from 'failed_rto' then coalesce(l.allocated_courier_fee,0) else 0 end) as bosta_fees_paid,
      sum(case when ord2.outcome is distinct from 'failed_rto' then coalesce(l.allocated_cod_cash_fee,0) else 0 end) as cod_cash_fee,
      -- Open package fee on every order, any outcome.
      sum(coalesce(l.allocated_open_package_fee,0)) as open_package_fee
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
    coalesce(la.open_package_fee, 0),
    coalesce(oa.shipping_fee_charged, 0)
  from order_agg oa
  full outer join line_agg la on oa.day = la.day;
$function$;

CREATE OR REPLACE FUNCTION public.per_product_stats(p_mode text, p_from date, p_to date)
 RETURNS TABLE(product_id bigint, variant_id bigint, orders_placed bigint, orders_resolved bigint, items_sold bigint, revenue numeric, cogs numeric)
 LANGUAGE sql
 STABLE
AS $function$
  with ord as (
    select
      o.id,
      case
        when p_mode = 'performance' then o.egypt_day
        when o.self_delivered then o.egypt_day  -- we delivered it ourselves, on its order day
        when o.courier = 'movers' then o.movers_record_date
        when o.courier = 'bosta' then o.bosta_picked_up_day
        else null
      end as eff_day,
      o.outcome
    from public.orders o
    where o.cancelled_at is null
  ),
  ord2 as (
    select * from ord where eff_day is not null and eff_day >= p_from and eff_day <= p_to
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

