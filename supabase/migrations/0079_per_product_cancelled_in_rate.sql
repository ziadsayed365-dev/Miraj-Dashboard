-- Analysis by Product: put cancelled orders back into the base the delivery rate
-- is applied to.
--
-- The page reports expected money as gross x the product's delivery rate, and
-- that rate (sku_monthly_delivery_rates, see finalizeSkuMonthlyRates) already
-- counts every cancellation in its denominator - a cancellation is one of the
-- orders the rate says will not deliver. per_product_stats dropped cancelled
-- orders before the rate was applied, so every cancellation was discounted
-- twice. The Income Statement had the same bug in its open month and was fixed
-- on 2026-09-11 (getRateProjectedRows' cancelledInRate); on 2026-09-12 this one
-- left Analysis by Product ~6,550 EGP of revenue below it.
--
-- Only the MONEY takes cancellations in. Order and item counts stay on orders
-- still standing, as they do on the Income Statement.
--
-- margin.ts zeroes revenue and COGS on a cancelled line (it earned nothing), so
-- the gross value is rebuilt here: price x quantity, and the unit cost with
-- margin.ts's precedence - the variant sold, the product, the model's cost as of
-- the order day, the model's current cost.

create or replace function public.line_unit_cost(p_variant_id bigint, p_product_id bigint, p_day date)
returns numeric
language sql
stable
as $function$
  select coalesce(
    (select v.unit_cost_override from public.product_variants v where v.id = p_variant_id),
    (select p.unit_cost_override from public.products p where p.id = p_product_id),
    (select h.unit_cost
       from public.model_group_cost_history h
       join public.products p on p.model_group_id = h.model_group_id
      where p.id = p_product_id and h.effective_from <= p_day
      order by h.effective_from desc, h.created_at desc
      limit 1),
    (select m.unit_cost
       from public.model_groups m
       join public.products p on p.model_group_id = m.id
      where p.id = p_product_id),
    0
  );
$function$;

grant execute on function public.line_unit_cost(bigint, bigint, date) to anon, authenticated, service_role;

create or replace function public.per_product_stats(p_mode text, p_from date, p_to date)
returns table(product_id bigint, variant_id bigint, orders_placed bigint, orders_resolved bigint, items_sold bigint, revenue numeric, cogs numeric)
language sql
stable
as $function$
  with ord as (
    select o.id, o.outcome, o.egypt_day, (o.cancelled_at is not null) as cancelled
    from public.orders o
    where o.egypt_day >= p_from
      and o.egypt_day <= p_to
      -- Must stay in lockstep with isHandedToCourier() in src/lib/reports/actual-mode.ts.
      and (p_mode = 'performance' or o.bosta_tracking_number is not null or o.self_delivered)
  )
  select
    l.product_id,
    l.variant_id,
    count(*) filter (where not ord.cancelled) as orders_placed,
    count(*) filter (where not ord.cancelled and ord.outcome in ('delivered','failed_rto','exchange','pickup_return')) as orders_resolved,
    coalesce(sum(l.quantity) filter (where not ord.cancelled), 0) as items_sold,
    sum(case when ord.cancelled then coalesce(l.quantity, 0) * coalesce(l.unit_price, 0)
             else coalesce(l.revenue, 0) end) as revenue,
    sum(case when ord.cancelled then coalesce(l.quantity, 0) * public.line_unit_cost(l.variant_id, l.product_id, ord.egypt_day)
             else coalesce(l.cost_of_goods, 0) end) as cogs
  from ord
  join public.order_line_items l on l.order_id = ord.id
  where l.product_id is not null
  group by l.product_id, l.variant_id;
$function$;

grant execute on function public.per_product_stats(text, date, date) to anon, authenticated, service_role;

-- The per-product Rollforward's daily counterpart, on exactly the same basis, so
-- summing its days still ties back to the product's row in the table above.
create or replace function public.per_product_daily_stats(p_product_id bigint, p_mode text, p_from date, p_to date)
returns table(day date, items_sold bigint, revenue numeric, cogs numeric)
language sql
stable
as $function$
  select
    o.egypt_day as day,
    coalesce(sum(l.quantity) filter (where o.cancelled_at is null), 0) as items_sold,
    sum(case when o.cancelled_at is not null then coalesce(l.quantity, 0) * coalesce(l.unit_price, 0)
             else coalesce(l.revenue, 0) end) as revenue,
    sum(case when o.cancelled_at is not null then coalesce(l.quantity, 0) * public.line_unit_cost(l.variant_id, l.product_id, o.egypt_day)
             else coalesce(l.cost_of_goods, 0) end) as cogs
  from public.order_line_items l
  join public.orders o on o.id = l.order_id
  where l.product_id = p_product_id
    and o.egypt_day >= p_from
    and o.egypt_day <= p_to
    and (p_mode = 'performance' or o.bosta_tracking_number is not null or o.self_delivered)
  group by o.egypt_day;
$function$;

grant execute on function public.per_product_daily_stats(bigint, text, date, date) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
