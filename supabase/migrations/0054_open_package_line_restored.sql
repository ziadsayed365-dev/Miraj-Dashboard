-- Restore 0038's open-package split, which 0039 silently reverted.
--
-- 0039 rebased daily_pnl onto the courier-handover day, but it was written from
-- 0036's 14-column body, so the open_package_fee output column vanished and the
-- fee went back to being folded into bosta_penalty / bosta_fees_paid.
-- daily-pnl.ts still reads `r.open_package_fee ?? 0`, so the Income Statement's
-- open-package amount has been reading as zero ever since, with the money
-- silently inside the two Bosta fee lines.
--
-- Net Income was never wrong - the app's netProfit subtracts an openPackageFee
-- that was simply zero, and the fee was still being deducted inside the bundled
-- lines. What was wrong is the split: Bosta Fees Paid and Bosta Penalty each
-- carried an open-package amount that is not a courier fee, and the line meant
-- to show it showed nothing.
--
-- This is 0039's body with 0038's three fee expressions. The eff_day CASE and
-- every other expression are unchanged, so which day each mode buckets on does
-- not move - only how the same total is divided between three lines. From
-- 2026-08-04 the fee is zero anyway (0053), so this restates closed months only.
--
-- The return type changes, so the function must be dropped rather than replaced.
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
  open_package_fee numeric,
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
$$;

grant execute on function public.daily_pnl(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
