-- Backfills bosta_picked_up_day for orders already picked up before this
-- fix shipped, derived entirely from data already synced into
-- bosta_events.raw_payload (no Bosta API calls). Without this, historical
-- Actual-mode totals only self-heal gradually as the existing sync cron
-- re-touches each order. Review the preview SELECT before running the
-- UPDATE below.

-- Preview (run this first, inspect row count / spot-check a few rows):
-- select o.id, o.order_number, o.egypt_day,
--        be.raw_payload->>'collectedFromBusiness' as collected_from_business
-- from orders o
-- join bosta_events be on be.order_id = o.id
-- where be.bosta_type = 'Send' and be.bosta_state <> 'Created';

update orders o
set bosta_picked_up_day = (
  (be.raw_payload->>'collectedFromBusiness')::timestamptz + interval '3 hours'
)::date
from (
  select distinct on (order_id) order_id, raw_payload
  from bosta_events
  where bosta_type = 'Send' and bosta_state <> 'Created'
  order by order_id, event_timestamp desc
) be
where be.order_id = o.id
  and o.courier = 'bosta'
  and o.bosta_picked_up_day is null;
