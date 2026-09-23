-- Per-product, per-month delivery counts for the Bosta > Delivery Rate tab.
-- One row per (product, month): how many order-lines for that product were
-- RECEIVED that month (by order date - cancellations and orders never handed to
-- a courier included, exactly like the Overall business row above them) and how
-- many were delivered. The app computes rate = delivered / received. Run once in
-- the Supabase SQL editor.
drop function if exists public.product_monthly_delivery();
create or replace function public.product_monthly_delivery()
returns table (product_id bigint, month text, received bigint, placed bigint, delivered bigint)
language sql
stable
as $$
  select
    li.product_id::bigint                                           as product_id,
    to_char(o.egypt_day, 'YYYY-MM')                                 as month,
    count(*)::bigint                                                as received,
    -- Alias for `received`, kept for the builds that read `placed` - every one
    -- before 2026-09-18. Costs a duplicate column and means a rollback to any
    -- of them still renders the tab instead of showing an empty grid.
    count(*)::bigint                                                as placed,
    count(*) filter (
      where o.outcome = 'delivered' and o.cancelled_at is null
    )::bigint                                                       as delivered
  from public.order_line_items li
  join public.orders o on o.id = li.order_id
  where li.product_id is not null
  group by li.product_id, to_char(o.egypt_day, 'YYYY-MM');
$$;

grant execute on function public.product_monthly_delivery() to anon, authenticated, service_role;
