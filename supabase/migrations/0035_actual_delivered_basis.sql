-- The "Actual" P&L view now means orders delivered on Bosta (outcome =
-- 'delivered'), dated by order day (egypt_day). Courier is never recorded on
-- Miraj orders (always null), so the old courier-pickup basis made Actual
-- empty. Revenue, COGS, orders count and items count all come from delivered
-- orders. The still-open month keeps its rate projection (handled in the app,
-- getOpenMonthRows, not here). Performance mode is unchanged.
--
-- Dropped first: this changes the function's OUT columns, and Postgres refuses
-- to "create or replace" a function whose return type differs (42P13). Every
-- other daily_pnl migration already does this; these two were the exceptions,
-- which only surfaced when the whole chain was replayed onto a fresh database.
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
        when o.outcome = 'delivered' then o.egypt_day  -- actual: delivered orders only, dated by order day
        else null
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
      sum(case when ord2.outcome is distinct from 'failed_rto'
               then coalesce(l.allocated_courier_fee,0) + coalesce(l.allocated_open_package_fee,0) + coalesce(l.allocated_cod_cash_fee,0)
               else 0 end) as bosta_fees_paid
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
    coalesce(oa.shipping_fee_charged, 0)
  from order_agg oa
  full outer join line_agg la on oa.day = la.day;
$$;

notify pgrst, 'reload schema';
