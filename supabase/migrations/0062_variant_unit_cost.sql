-- Per-variant cost. Sales are recorded against a variant (order_line_items
-- .variant_id), and a product's variants genuinely cost different amounts -
-- مصحف كسوة الكعبه sells at 250 / 350 / 400 across its three sizes - so costing
-- every variant at one product-level number misstates the margin on all but one
-- of them.
--
-- Mirrors products.unit_cost_override in both name and role, and sits one step
-- ahead of it in the engine's precedence (see src/lib/engine/margin.ts):
--
--   variant.unit_cost_override      the variant actually sold
--   -> product.unit_cost_override   the product it belongs to
--   -> model_groups.unit_cost       legacy, as of the order's own day
--
-- Null means "no variant-specific cost", which falls through to the product -
-- so this is additive and changes no existing margin until a value is entered.

alter table public.product_variants add column if not exists unit_cost_override numeric(12,2);

notify pgrst, 'reload schema';
