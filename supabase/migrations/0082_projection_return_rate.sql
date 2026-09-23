-- Bosta Penalty stops being charged on everything that failed to deliver.
--
-- The open month projects each order's return cost as (1 - delivery rate) x the
-- RTO fee. That share is not the return rate: it is returns PLUS cancellations
-- PLUS orders still unresolved when the source month closed. For Aug 2026 that
-- is 19.49% charged a return fee against 11.14% that actually came back - most
-- of the excess being cancellations, and only 39 of August's 492 cancellations
-- ever reached Bosta to be billed a return at all. September was carrying
-- roughly 14,900 EGP of penalty that Bosta will never charge.
--
-- Closed months have always been right about this: margin.ts bills a
-- cancellation only when it has a tracking number. This is the projection
-- catching up with them.
--
-- So each frozen month now also carries the share of its orders that were
-- actually BILLED A RETURN:
--
--   returned_count = outcome 'failed_rto', plus cancellations that had already
--                    shipped (they went out and came back - migration 0075
--                    charges them a return in closed months, so the estimate of
--                    them has to as well). Counted once if an order is both.
--   return_rate    = returned_count / order_count, the same denominator the
--                    delivery rate on this row uses: every order received for
--                    'performance', only orders handed over for 'actual'.
--
-- Frozen alongside the delivery rate, written once and never updated, so a day
-- already reported keeps the pair it was struck at.
alter table public.projection_rates
  add column if not exists returned_count bigint,
  add column if not exists return_rate numeric(8,6);

with counts as (
  select
    date_trunc('month', o.egypt_day)::date as month,
    count(*) filter (
      where o.outcome = 'failed_rto'
         or (o.cancelled_at is not null and o.bosta_tracking_number is not null)
    ) as all_returned,
    count(*) filter (
      where (o.bosta_tracking_number is not null or o.self_delivered)
        and (o.outcome = 'failed_rto'
             or (o.cancelled_at is not null and o.bosta_tracking_number is not null))
    ) as handed_returned
  from public.orders o
  where o.egypt_day is not null
  group by 1
)
update public.projection_rates pr
set returned_count = case when pr.mode = 'performance' then c.all_returned else c.handed_returned end,
    return_rate = case
      when pr.order_count = 0 then 0
      else (case when pr.mode = 'performance' then c.all_returned else c.handed_returned end)::numeric / pr.order_count
    end
from counts c
where c.month = pr.month
  and pr.return_rate is null;

-- A frozen month with no return figure would silently fall back to the old
-- (1 - rate) behaviour, so the column is required from here on.
update public.projection_rates set returned_count = 0, return_rate = 0 where return_rate is null;
alter table public.projection_rates alter column returned_count set not null;
alter table public.projection_rates alter column return_rate set not null;

notify pgrst, 'reload schema';
