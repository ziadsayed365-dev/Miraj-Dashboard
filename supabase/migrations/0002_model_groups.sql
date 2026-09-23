-- Adds a "model" level above products, since one shoe model can exist as
-- several separate Shopify products (one per color). Cost is entered once
-- per model and shared by every color; price is synced live from Shopify
-- and stored on the individual product (color) row.
-- Safe to run more than once.

create table if not exists model_groups (
  id bigint generated always as identity primary key,
  name text not null,
  unit_cost numeric(12,2),
  refund_rate_override numeric(6,4),
  damage_rate_override numeric(6,4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table products
  add column if not exists model_group_id bigint references model_groups(id),
  add column if not exists current_price numeric(12,2),
  add column if not exists price_synced_at timestamptz;

alter table products drop column if exists unit_cost;
alter table products drop column if exists refund_rate_override;
alter table products drop column if exists damage_rate_override;
alter table products drop column if exists size_tier;

-- Box size doesn't vary by product for this business, so it's one
-- store-wide setting instead of a per-product field.
alter table settings
  add column if not exists default_box_size_tier text not null default 'S'
    check (default_box_size_tier in ('S','M','L','XL','XXL'));
