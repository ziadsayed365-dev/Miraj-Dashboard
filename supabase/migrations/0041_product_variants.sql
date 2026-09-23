-- Variant-level costing. Until now `products` held one row per SHOPIFY PRODUCT
-- and the catalog sync read variants(first: 1), so a product sold in several
-- sizes (e.g. رطب سكري القصيم in 1 kilo and 3 kilo) collapsed into a single row
-- with a single BOM and a single built cost.
--
--   product_variants                  - one row per Shopify variant.
--   final_product_components.variant_id - a BOM row now hangs off EITHER the
--                                       product (variant_id null = applies to
--                                       every variant) OR one specific variant.
--   order_line_items.variant_id       - which variant a sale was actually for,
--                                       so margins use that variant's cost.
--
-- Products with one variant keep working exactly as before: the sync still
-- writes their sku/price onto products, and their BOM rows stay variant_id null.

create table if not exists public.product_variants (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  shopify_variant_id bigint not null unique,
  title text not null,
  sku text,
  current_price numeric(12, 2),
  position int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists product_variants_product_idx on public.product_variants (product_id);

-- BOM rows: product-level (variant_id null) or variant-specific.
alter table public.final_product_components
  add column if not exists variant_id bigint references public.product_variants(id) on delete cascade;

-- The old unique (product_id, component_id) would block the same component
-- appearing on two variants of one product, so replace it with a pair of
-- partial indexes (Postgres treats NULLs as distinct in a plain unique index,
-- which is exactly the wrong behaviour for the product-level rows).
alter table public.final_product_components
  drop constraint if exists final_product_components_product_id_component_id_key;
create unique index if not exists final_product_components_product_component_key
  on public.final_product_components (product_id, component_id)
  where variant_id is null;
create unique index if not exists final_product_components_variant_component_key
  on public.final_product_components (variant_id, component_id)
  where variant_id is not null;
create index if not exists final_product_components_variant_idx
  on public.final_product_components (variant_id);

-- Which variant each sale was for. shopify_variant_id is captured by the orders
-- sync even when the variant row doesn't exist yet, so the catalog sync can
-- relink it later (same pattern as shopify_product_id in 0029).
alter table public.order_line_items add column if not exists shopify_variant_id bigint;
alter table public.order_line_items
  add column if not exists variant_id bigint references public.product_variants(id);
create index if not exists order_line_items_variant_id_idx on public.order_line_items (variant_id);

notify pgrst, 'reload schema';
