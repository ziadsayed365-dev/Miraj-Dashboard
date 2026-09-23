-- Shopify charges shipping once per order (not per line item); we need it
-- to compute the Shipping Differences Fee line (shipping charged on the
-- site minus the Bosta courier fee actually paid).
alter table orders add column if not exists shipping_fee_charged numeric(12,2);

-- Store-wide delivery rate per calendar month, computed once a month has
-- fully matured (calendar month-end + the same Bosta maturity buffer the
-- per-model calibration engine uses). Used to project the still-open
-- month's Income Statement uniformly, until that month matures and gets
-- its own row here.
create table if not exists monthly_delivery_rates (
  month date primary key, -- first day of the calendar month
  resolved_count int not null,
  delivered_count int not null,
  rate numeric(6,4) not null,
  computed_at timestamptz not null default now()
);
