-- Finvisor COD Dashboard: initial schema
-- Products, orders, line items, Bosta audit trail, fee tables, settings,
-- success-rate calibration history, sync bookkeeping, ad spend.

create table products (
  id bigint generated always as identity primary key,
  shopify_product_id bigint unique,
  name text not null,
  sku text,
  size_tier text not null default 'M' check (size_tier in ('S','M','L','XL','XXL')),
  unit_cost numeric(12,2),
  refund_rate_override numeric(6,4),
  damage_rate_override numeric(6,4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table orders (
  id bigint generated always as identity primary key,
  shopify_order_id bigint unique not null,
  order_number text not null,
  order_created_at timestamptz not null,
  -- Egypt day = fixed UTC+3 offset, not a timezone database lookup.
  -- Set by application code on insert/update (Postgres won't allow this
  -- calculation inside a generated column, since it involves timestamptz).
  egypt_day date not null,
  total_price numeric(12,2),
  currency text default 'EGP',
  governorate_shopify text,
  cancelled_at timestamptz,
  financial_status text,

  bosta_tracking_number text,
  outcome text check (outcome in ('in_transit','delivered','failed_rto','exchange','pickup_return','cancelled_return')),
  outcome_governorate text,
  attempt_number int default 1,
  cod_amount_collected numeric(12,2),
  resolved_at timestamptz,
  stock_received_at timestamptz,
  last_bosta_sync_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_egypt_day_idx on orders (egypt_day);
create index orders_order_number_idx on orders (order_number);

create table order_line_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id) on delete cascade,
  product_id bigint references products(id),
  shopify_line_item_id bigint,
  quantity int not null check (quantity > 0),
  unit_price numeric(12,2) not null,

  -- filled in by the valuation engine
  allocated_delivery_fee numeric(12,2),
  allocated_rto_fee numeric(12,2),
  allocated_cod_cash_fee numeric(12,2),
  packing_cost numeric(12,2),
  size_surcharge numeric(12,2),
  refund_adjustment numeric(12,2),
  damage_adjustment numeric(12,2),
  success_rate_used numeric(6,4),
  expected_margin numeric(12,2),
  realized_margin numeric(12,2),
  margin_computed_at timestamptz,

  created_at timestamptz not null default now()
);
create index order_line_items_order_id_idx on order_line_items (order_id);
create index order_line_items_product_id_idx on order_line_items (product_id);

-- Raw, append-only log of every Bosta status update (audit trail / dedup source)
create table bosta_events (
  id bigint generated always as identity primary key,
  order_id bigint references orders(id),
  bosta_delivery_id text not null,
  business_reference text,
  bosta_type text,
  bosta_state text,
  attempt_number int,
  cod_amount numeric(12,2),
  governorate text,
  event_timestamp timestamptz,
  raw_payload jsonb,
  synced_at timestamptz not null default now()
);
create index bosta_events_order_id_idx on bosta_events (order_id);
create index bosta_events_delivery_id_idx on bosta_events (bosta_delivery_id);

create table governorate_fees (
  governorate text primary key,
  delivery_fee_base numeric(12,2) not null default 0,
  rto_fee_base numeric(12,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table size_surcharges (
  size_tier text primary key check (size_tier in ('S','M','L','XL','XXL')),
  surcharge_base numeric(12,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table settings (
  id int primary key default 1 check (id = 1),
  vat_multiplier numeric(6,4) not null default 1.14,
  cod_cash_fee_pct numeric(6,4) not null default 0,
  packing_cost_per_unit numeric(12,2) not null default 10,
  exchange_fee_base numeric(12,2) not null default 0,
  pickup_fee_base numeric(12,2) not null default 0,
  pickup_cash_refund_pct numeric(6,4) not null default 0,
  refund_rate_default numeric(6,4) not null default 0.03,
  damage_rate_default numeric(6,4) not null default 0.03,
  calibration_min_sample int not null default 150,
  calibration_min_ignore int not null default 10,
  attempt2_factor numeric(6,4) not null default 0.6,
  attempt3plus_factor numeric(6,4) not null default 0.25,
  updated_at timestamptz not null default now()
);
insert into settings (id) values (1);

create table product_success_rates (
  product_id bigint not null references products(id),
  as_of_date date not null,
  raw_rate numeric(6,4),
  resolved_sample_size int,
  store_wide_rate numeric(6,4),
  blended_rate numeric(6,4),
  attempt_adjusted_rates jsonb,
  created_at timestamptz not null default now(),
  primary key (product_id, as_of_date)
);

create table sync_state (
  source text primary key,
  last_synced_at timestamptz,
  cursor text,
  updated_at timestamptz not null default now()
);
insert into sync_state (source) values ('shopify'), ('bosta'), ('meta');

create table ad_spend (
  id bigint generated always as identity primary key,
  date date not null,
  ad_id text,
  adset_id text not null,
  adset_name text,
  product_id bigint references products(id),
  spend numeric(12,2) not null,
  currency text default 'EGP',
  synced_at timestamptz not null default now(),
  unique (date, adset_id, ad_id)
);

-- Seed Egypt's 27 governorates with placeholder fees (fill in real numbers later via Settings)
insert into governorate_fees (governorate) values
  ('Cairo'), ('Alexandria'), ('Giza'), ('Qalyubia'), ('Port Said'), ('Suez'),
  ('Dakahlia'), ('Sharqia'), ('Gharbia'), ('Monufia'), ('Beheira'), ('Ismailia'),
  ('Damietta'), ('Kafr El Sheikh'), ('Faiyum'), ('Beni Suef'), ('Minya'), ('Asyut'),
  ('Sohag'), ('Qena'), ('Aswan'), ('Luxor'), ('Red Sea'), ('New Valley'),
  ('Matrouh'), ('North Sinai'), ('South Sinai');

insert into size_surcharges (size_tier) values ('S'), ('M'), ('L'), ('XL'), ('XXL');
