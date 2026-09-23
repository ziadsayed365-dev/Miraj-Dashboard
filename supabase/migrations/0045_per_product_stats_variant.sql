-- Analysis by Product aggregates on product_id only, so a product sold in
-- several variants (each with its own price AND its own cost since 0041) shows
-- as one blended row. Add variant_id to the grouping so the report can break a
-- product down by variant.
--
-- variant_id is NULL for single-variant products and for old lines whose
-- Shopify variant was later deleted; the app treats a NULL group as the
-- product-level row, so nothing is dropped and totals are unchanged.

drop function if exists public.per_product_stats(text, date, date);
create or replace function public.per_product_stats(p_mode text, p_from date, p_to date)
returns table (
  product_id bigint,
  variant_id bigint,
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
$$;

grant execute on function public.per_product_stats(text, date, date) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
