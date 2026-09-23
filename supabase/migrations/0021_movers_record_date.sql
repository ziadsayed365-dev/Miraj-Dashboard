-- The date you record/hand off an order to Movers, distinct from the
-- order's own Shopify egypt_day (which still drives all financial
-- reporting/date-range filtering unchanged) - purely for the Movers
-- Orders tab's own Record/Report display.
alter table orders add column if not exists movers_record_date date;
