-- Bosta > Delivery Rate: put the per-product rows on the same denominator as
-- the Overall business row above them.
--
-- The overall row is delivered / EVERY order received - cancellations and
-- orders nobody ever handed to a courier both counted (daily_pnl's
-- orders_received, migration 0076, and countMonthDeliveries in
-- src/lib/engine/monthly-rate.ts, which is what the projections run on).
-- product_monthly_delivery dropped cancelled orders, so every model and
-- product read several points better than the business they add up to:
-- Aug 2026 was 86.2% per product against 81.8% overall, May 2026 91.2%
-- against 80.7%. Two rates on one screen answering different questions.
--
-- Cancellations now count in the denominator only - a cancelled line delivered
-- nothing, so it can never reach the numerator. Orders never handed to a
-- courier were already in: there has never been a handover filter here, and
-- there must not be one, since "of everything Shopify took, how much reached a
-- customer" is exactly the question this tab asks.
--
-- Display only. The rates the engine projects money with (monthly_delivery_rates,
-- sku_monthly_delivery_rates, projection_rates) are computed elsewhere and are
-- untouched, so no reported day moves.
--
-- placed -> received names the denominator honestly; renaming an OUT parameter
-- needs the drop.
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

notify pgrst, 'reload schema';
