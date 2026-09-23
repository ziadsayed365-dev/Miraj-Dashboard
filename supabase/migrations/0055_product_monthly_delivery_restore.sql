-- Restores public.product_monthly_delivery() to its original four-column shape.
-- An earlier revision of this file added an in_progress column for a per-product
-- "still open" badge on the Delivery Rate tab; that badge is only wanted on the
-- Overall business row, which derives its count from the Income Statement rows
-- instead, so the per-product column had no reader.

drop function if exists public.product_monthly_delivery();

create or replace function public.product_monthly_delivery()
returns table (product_id bigint, month text, placed bigint, delivered bigint)
language sql
stable
as $$
  select
    li.product_id::bigint                                          as product_id,
    to_char(o.egypt_day, 'YYYY-MM')                                as month,
    count(*)::bigint                                               as placed,
    count(*) filter (where o.outcome = 'delivered')::bigint        as delivered
  from public.order_line_items li
  join public.orders o on o.id = li.order_id
  where li.product_id is not null
    and o.cancelled_at is null
  group by li.product_id, to_char(o.egypt_day, 'YYYY-MM');
$$;

grant execute on function public.product_monthly_delivery() to anon, authenticated, service_role;
