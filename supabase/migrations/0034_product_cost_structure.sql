-- Product List cost structure (the 3-tab cost tool).
-- Each single product has a base cost (before packaging) plus the packaging
-- types attached to it; each bundle is built from member single products.
-- A product's built cost (single = base + packaging, bundle = sum of members)
-- feeds the margin engine as its unit cost.

alter table public.products
  add column if not exists is_bundle boolean not null default false,
  add column if not exists base_cost numeric(12,2);

-- Reusable packaging types with a unit cost (e.g. box, tape, sticker).
create table if not exists public.packaging_types (
  id bigint generated always as identity primary key,
  name text not null unique,
  unit_cost numeric(12,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Which packaging types a single product uses (quantity defaults to 1).
create table if not exists public.product_packaging (
  product_id bigint not null references public.products(id) on delete cascade,
  packaging_type_id bigint not null references public.packaging_types(id) on delete cascade,
  quantity numeric(12,2) not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, packaging_type_id)
);

-- Which single products (and how many) make up a bundle.
create table if not exists public.bundle_items (
  bundle_product_id bigint not null references public.products(id) on delete cascade,
  member_product_id bigint not null references public.products(id) on delete cascade,
  quantity numeric(12,2) not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bundle_product_id, member_product_id),
  constraint bundle_not_self check (bundle_product_id <> member_product_id)
);

create index if not exists product_packaging_product_idx on public.product_packaging (product_id);
create index if not exists bundle_items_bundle_idx on public.bundle_items (bundle_product_id);

notify pgrst, 'reload schema';
