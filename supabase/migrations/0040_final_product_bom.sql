-- Product List: switch from the base-cost + packaging cost model to the
-- bill-of-materials model (mirrors the Laurel dashboard's Product List).
--
--   product_components        - the raw materials / packaging / stickers /
--                               other inputs, each priced per unit (pcs/L/KG).
--   final_product_components  - a single product's BOM: which components (and
--                               how much of each) it is built from.
--   bundle_items (extended)   - a bundle's contents: member single products
--                               AND/OR "Other" components (e.g. the box).
--
-- A product's built cost (single = Σ component line costs, bundle = Σ contents)
-- feeds the margin engine via getBuiltCostByProduct(). is_bundle already exists
-- from 0034. The old packaging_types / product_packaging / products.base_cost
-- objects are left in place but are no longer read by the app.

-- Components catalog. Kept in sync with COMPONENT_TYPES / COMPONENT_UNITS in
-- src/lib/products/component-types.ts.
create table if not exists public.product_components (
  id bigint generated always as identity primary key,
  type text not null check (type in ('raw_material', 'product_package', 'sticker', 'other')),
  account text not null,
  unit text not null check (unit in ('pcs', 'l', 'kg')),
  cost numeric(12, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists product_components_type_idx on public.product_components (type);

-- Bill of materials: single products -> the components they are built from.
create table if not exists public.final_product_components (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  component_id bigint not null references public.product_components(id) on delete cascade,
  quantity numeric(12, 3) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, component_id)
);
create index if not exists final_product_components_product_idx on public.final_product_components (product_id);
create index if not exists final_product_components_component_idx on public.final_product_components (component_id);

-- Extend bundle_items so a bundle row references EXACTLY ONE of a member single
-- product OR an "Other" component (the box). Was: composite PK
-- (bundle_product_id, member_product_id), member NOT NULL. Existing member rows
-- are preserved. Guarded so re-running is a no-op.
do $$
begin
  -- Drop the old composite primary key so member_product_id can become nullable.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.bundle_items'::regclass and conname = 'bundle_items_pkey'
  ) then
    alter table public.bundle_items drop constraint bundle_items_pkey;
  end if;

  -- Surrogate id primary key (fills existing rows).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bundle_items' and column_name = 'id'
  ) then
    alter table public.bundle_items add column id bigint generated always as identity primary key;
  end if;

  -- component_id: the "Other" component alternative to a member product.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bundle_items' and column_name = 'component_id'
  ) then
    alter table public.bundle_items
      add column component_id bigint references public.product_components(id) on delete cascade;
  end if;
end $$;

alter table public.bundle_items alter column member_product_id drop not null;
alter table public.bundle_items drop constraint if exists bundle_not_self;
alter table public.bundle_items drop constraint if exists bundle_items_exactly_one_ref;
alter table public.bundle_items
  add constraint bundle_items_exactly_one_ref
    check ((member_product_id is not null)::int + (component_id is not null)::int = 1);

-- Re-establish uniqueness now that the composite PK is gone (these back the
-- app's upserts on (bundle_product_id, member_product_id) and (…, component_id)).
create unique index if not exists bundle_items_bundle_member_key
  on public.bundle_items (bundle_product_id, member_product_id);
create unique index if not exists bundle_items_bundle_component_key
  on public.bundle_items (bundle_product_id, component_id);

notify pgrst, 'reload schema';
