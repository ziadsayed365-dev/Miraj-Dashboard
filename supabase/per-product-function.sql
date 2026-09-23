-- Aggregates per-product stats in the DATABASE for the Analysis by Product page,
-- so the app doesn't pull ~126k line-items on every load. Covers the MATURE range
-- only; the still-open month is projected in-app (per-SKU delivery rate).
-- p_mode: 'performance' (egypt_day) or 'actual' (courier pickup / movers date).
-- Mirrors getPerProductReport's mature branch: revenue/cogs use stored per-line
-- values (all outcomes), placed = line-item count, resolved = final-outcome count.
drop function if exists public.per_product_stats(text, date, date);
create or replace function public.per_product_stats(p_mode text, p_from date, p_to date)
returns table (
  product_id bigint,
  orders_placed bigint,
  orders_resolved bigint,
  items_sold bigint,
  revenue numeric,
  cogs numeric
)
language sql
stable
as $$
  with ord as (
    select
      o.id,
      case
        when p_mode = 'performance' then o.egypt_day
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
    count(*) as orders_placed,
    count(*) filter (where ord2.outcome in ('delivered','failed_rto','exchange','pickup_return')) as orders_resolved,
    sum(coalesce(l.quantity, 0)) as items_sold,
    sum(coalesce(l.revenue, 0)) as revenue,
    sum(coalesce(l.cost_of_goods, 0)) as cogs
  from ord2
  join public.order_line_items l on l.order_id = ord2.id
  where l.product_id is not null
  group by l.product_id;
$$;

grant execute on function public.per_product_stats(text, date, date) to anon, authenticated, service_role;
