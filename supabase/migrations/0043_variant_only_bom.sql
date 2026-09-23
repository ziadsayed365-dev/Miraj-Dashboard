-- Multi-variant products are costed BY VARIANT ONLY. Until now a product-level
-- BOM row (variant_id null) acted as the default every variant inherited; with
-- the Final Product tab no longer offering a product-level editor for these
-- products, such rows would be stranded - invisible but still feeding cost.
--
-- So push each product-level row down onto every variant that doesn't already
-- have that component (preserving the exact cost each variant was inheriting),
-- then drop the product-level rows for multi-variant products only.
--
-- Single-variant products are untouched: they keep costing at the product level
-- exactly as before.

with multi as (
  select product_id from public.product_variants group by product_id having count(*) > 1
)
insert into public.final_product_components (product_id, component_id, variant_id, quantity)
select f.product_id, f.component_id, v.id, f.quantity
from public.final_product_components f
join multi m on m.product_id = f.product_id
join public.product_variants v on v.product_id = f.product_id
where f.variant_id is null
  and not exists (
    select 1 from public.final_product_components existing
    where existing.variant_id = v.id and existing.component_id = f.component_id
  );

delete from public.final_product_components f
using (select product_id from public.product_variants group by product_id having count(*) > 1) m
where f.product_id = m.product_id and f.variant_id is null;

notify pgrst, 'reload schema';
