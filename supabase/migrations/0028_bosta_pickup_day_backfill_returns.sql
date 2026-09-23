-- 0027 only backfilled orders whose delivery leg was still typed "Send" -
-- but Bosta mutates a delivery's type in place once it's classified as a
-- Return to Origin/Exchange/Customer Return Pickup (the same tracking
-- number, not a second leg in most cases), so every returned/exchanged
-- order was skipped even though it was genuinely picked up first.
-- Confirmed live: an RTO'd order's only bosta_events row shows type
-- "Return to Origin" with no surviving "Send" row, but still carries the
-- original collectedFromBusiness timestamp.
--
-- This catches those, using the EARLIEST collectedFromBusiness across all
-- of an order's non-Created legs (so a genuine second leg, e.g. a real
-- Exchange reshipment with its own tracking number, never overrides the
-- original pickup date). Only touches rows 0027 left null. Preview first:
--
-- select o.id, o.order_number, o.egypt_day,
--        min((be.raw_payload->>'collectedFromBusiness')::timestamptz) as collected_from_business
-- from orders o
-- join bosta_events be on be.order_id = o.id
-- where be.bosta_state <> 'Created' and be.raw_payload->>'collectedFromBusiness' is not null
-- group by o.id, o.order_number, o.egypt_day;

update orders o
set bosta_picked_up_day = (be.collected_from_business + interval '3 hours')::date
from (
  select order_id, min((raw_payload->>'collectedFromBusiness')::timestamptz) as collected_from_business
  from bosta_events
  where bosta_state <> 'Created' and raw_payload->>'collectedFromBusiness' is not null
  group by order_id
) be
where be.order_id = o.id
  and o.courier = 'bosta'
  and o.bosta_picked_up_day is null;
