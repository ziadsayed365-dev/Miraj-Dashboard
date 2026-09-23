-- Lets us upsert bosta_events by tracking number so re-checking an order
-- updates its existing record instead of creating a duplicate.
drop index if exists bosta_events_delivery_id_idx;
create unique index if not exists bosta_events_delivery_id_key on bosta_events (bosta_delivery_id);
