-- Purchasing against a single variant.
--
-- 0050 let a purchase target a component or a product, and wrote a product
-- purchase to products.unit_cost_override. 0062 then put
-- product_variants.unit_cost_override AHEAD of the product's cost in the
-- engine, so a product purchase never reaches a variant that has a cost of its
-- own - the expense posts but the margin doesn't move. Multi-variant products
-- genuinely cost different amounts per size, so the purchase has to be able to
-- name the variant.
--
-- A purchase now targets exactly one of component / product / variant. A
-- variant purchase writes product_variants.unit_cost_override.

alter table public.purchases
  add column if not exists variant_id bigint references public.product_variants(id) on delete cascade;

alter table public.purchases drop constraint if exists purchases_one_target;
alter table public.purchases add constraint purchases_one_target check (
  num_nonnulls(component_id, product_id, variant_id) = 1
);

create index if not exists purchases_variant_idx on public.purchases (variant_id, date);

notify pgrst, 'reload schema';
