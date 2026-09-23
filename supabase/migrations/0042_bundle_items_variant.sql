-- Let a bundle contain a specific VARIANT of a product, not just a whole
-- product. After 0041 a multi-variant product (e.g. رطب سكري القصيم in 1 kilo
-- and 3 kilo) has a different cost per variant, so "5 boxes of the 1 kilo"
-- can't be expressed by pointing at the product alone.
--
-- bundle_items now references EXACTLY ONE of:
--   member_product_id  - a whole single product (unchanged, existing rows)
--   member_variant_id  - one variant of a single product
--   component_id       - an "Other" component (the box)

alter table public.bundle_items
  add column if not exists member_variant_id bigint references public.product_variants(id) on delete cascade;

alter table public.bundle_items drop constraint if exists bundle_items_exactly_one_ref;
alter table public.bundle_items
  add constraint bundle_items_exactly_one_ref
    check (
      (member_product_id is not null)::int
      + (member_variant_id is not null)::int
      + (component_id is not null)::int = 1
    );

-- Backs the app's upsert on (bundle_product_id, member_variant_id), matching
-- the existing member/component unique indexes from 0040.
create unique index if not exists bundle_items_bundle_variant_key
  on public.bundle_items (bundle_product_id, member_variant_id);

notify pgrst, 'reload schema';
