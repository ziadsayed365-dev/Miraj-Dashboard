-- Bundle contents can hold a FRACTION of an item (0.5 of a raw material, 0.8 of
-- a member product), not just whole counts. quantity was numeric(12,2) while the
-- single-product BOM (final_product_components) is numeric(12,3) and both UIs
-- offer step="0.001" - so a third decimal silently rounded here. Match the BOM.
alter table public.bundle_items alter column quantity type numeric(12, 3);

notify pgrst, 'reload schema';
