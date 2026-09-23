  -- Replace the simplified base+surcharge fee model with Bosta's real
-- zone x size x type price grid, confirmed from their actual Pricing Plan
-- page. Prices here are already VAT-inclusive (confirmed against the
-- merchant's own pricing screenshots), so settings.vat_multiplier is set
-- to 1 (no-op) rather than applied again on top of these.

alter table governorate_fees drop column if exists delivery_fee_base;
alter table governorate_fees drop column if exists rto_fee_base;
alter table governorate_fees add column if not exists zone text;

drop table if exists size_surcharges;

create table if not exists bosta_fee_matrix (
  zone text not null,
  shipment_size text not null,
  deliver numeric(12,2) not null,
  exchange numeric(12,2) not null,
  return_pickup numeric(12,2) not null,
  cash_collection numeric(12,2) not null,
  return_to_origin numeric(12,2) not null,
  updated_at timestamptz not null default now(),
  primary key (zone, shipment_size)
);

alter table settings drop column if exists default_box_size_tier;
alter table settings add column if not exists default_box_size_tier text not null default 'Small & Medium'
  check (default_box_size_tier in ('Small & Medium','Large','X-Large','XXL (White Bag)','Light Bulky','Heavy Bulky'));
