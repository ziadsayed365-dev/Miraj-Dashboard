-- Freeze the delivery rate each still-open day is projected at.
--
-- An open month's days are struck at the most recent mature month's delivery
-- rate. That rate used to be read live on every page load, so a day the owner
-- had already sent to a client kept moving afterwards:
--
--   * On the 11th of every month the next month matures and every open day was
--     re-projected at it - 2026-09-01..10 went from July's 81.9% to August's
--     80.5% on 2026-09-11, a day after those P&Ls had gone out.
--   * The source month's own figure kept drifting as late outcomes synced in.
--
-- Each open day now keeps the rate that was current when it was first reported
-- (see getOpenMonthRows), and reads it from here: one row per (month, mode),
-- written once and never updated. Seeded below for every month already mature,
-- from the same counts getMonthDeliveryRate() takes; months that mature later
-- are frozen by the app the first time a projection asks for them.
create table if not exists public.projection_rates (
  month date not null,
  mode text not null check (mode in ('performance', 'actual')),
  delivered_count bigint not null,
  -- performance: every order received that month, cancellations included;
  -- actual: only orders handed to a courier (tracking number or self-delivered).
  order_count bigint not null,
  rate numeric(8,6) not null,
  frozen_at timestamptz not null default now(),
  primary key (month, mode)
);

with egypt as (
  select ((now() at time zone 'utc') + interval '3 hours')::date as today
),
counts as (
  select
    date_trunc('month', o.egypt_day)::date as month,
    count(*) as all_orders,
    count(*) filter (where o.outcome = 'delivered') as all_delivered,
    count(*) filter (where o.bosta_tracking_number is not null or o.self_delivered) as handed,
    count(*) filter (where (o.bosta_tracking_number is not null or o.self_delivered) and o.outcome = 'delivered') as handed_delivered
  from public.orders o
  where o.egypt_day is not null
  group by 1
),
mature as (
  -- Same test as isMonthMature(): mature 10 days after the month ends.
  select c.* from counts c, egypt e
  where c.month + interval '1 month' + interval '10 days' <= e.today
)
insert into public.projection_rates (month, mode, delivered_count, order_count, rate)
select month, 'performance', all_delivered, all_orders, all_delivered::numeric / all_orders
from mature where all_orders > 0
union all
select month, 'actual', handed_delivered, handed, handed_delivered::numeric / handed
from mature where handed > 0
on conflict (month, mode) do nothing;

notify pgrst, 'reload schema';
