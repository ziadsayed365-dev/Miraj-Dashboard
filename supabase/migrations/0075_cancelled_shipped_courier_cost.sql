-- Cancelled orders that had already reached Bosta now carry their courier cost.
--
-- The owner's rule, in their words: of 100 orders with 10 returned and 10
-- cancelled (3 of which reached Bosta), revenue and COGS scale by 80/100, but
-- the penalty and open-package fee are charged on the 10 returns plus those 3
-- cancellations - not on the 7 that never left the building.
--
-- daily_pnl has always filtered `cancelled_at is null` outright, so a cancelled
-- order contributed nothing at all. That is still right for revenue, COGS,
-- shipping charged and the order counts - a cancellation earns nothing and its
-- stock comes back. It is wrong for the two courier lines: Bosta really did
-- carry 810 of these packages out and back, and really did bill for them.
--
-- So the cancelled side is added as its own aggregate feeding ONLY
-- bosta_penalty and open_package_fee. margin.ts prices those line items at the
-- zone's return_to_origin rate plus the open-package fee (and at zero for
-- cancellations with no tracking number), so this just sums what it wrote.
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
  -- Cancelled but already handed to Bosta: the package went out and came back,
  -- so it owes a return fee and an open-package fee and nothing else.
  cancelled_shipped as (
    select
      case
        when p_mode = 'performance' then o.egypt_day
        else coalesce(o.bosta_picked_up_day, o.movers_record_date)
      end as day,
      sum(coalesce(l.allocated_courier_fee, 0)) as penalty,
      sum(coalesce(l.allocated_open_package_fee, 0)) as open_package
    from public.orders o
    join public.order_line_items l on l.order_id = o.id
    where o.cancelled_at is not null
      and o.bosta_tracking_number is not null
    group by 1
  ),
  cancelled2 as (select * from cancelled_shipped where day is not null),
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
      sum(case when ord2.outcome = 'failed_rto' then coalesce(l.allocated_courier_fee,0) else 0 end) as bosta_penalty,
      sum(case when ord2.outcome is distinct from 'failed_rto' then coalesce(l.allocated_courier_fee,0) else 0 end) as bosta_fees_paid,
      sum(case when ord2.outcome is distinct from 'failed_rto' then coalesce(l.allocated_cod_cash_fee,0) else 0 end) as cod_cash_fee,
      sum(coalesce(l.allocated_open_package_fee,0)) as open_package_fee
    from ord2
    join public.order_line_items l on l.order_id = ord2.id
    group by ord2.eff_day
  ),
  days as (
    select day from order_agg
    union select day from line_agg
    union select day from cancelled2
  )
  select
    d.day,
    coalesce(oa.orders_placed, 0),
    coalesce(oa.orders_resolved, 0),
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
  left join order_agg oa on oa.day = d.day
  left join line_agg la on la.day = d.day
  left join cancelled2 cs on cs.day = d.day;
$$;

grant execute on function public.daily_pnl(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
