-- Meta ad spend is allocated to SUB-CATEGORIES instead of model groups.
--
-- Model groups are no longer assigned to products (the Product List dropped
-- them in favour of the storefront taxonomy), so an allocation keyed on
-- model_group_id can never reach a product again. The storefront sub-category
-- is what a campaign actually promotes - "سجاد ايليت", "مصحف بريميوم" - so that
-- is what spend is pinned to now.
--
-- An array, not a single value: one campaign can promote several sub-categories
-- at once. Its spend is then split EQUALLY across them at read time (see
-- src/lib/reports/per-product.ts) rather than duplicated into several rows, so
-- the stored figure always stays the real amount Meta charged.
--
--   sub_categories = ['سجاد ايليت']                 -> all of it to one
--   sub_categories = ['سجاد ايليت','سجاد نَقْش']    -> half each
--   is_general = true                                -> spread across everything selling
--   both empty                                       -> still an open decision, shows in the popup
--
-- model_group_id is left in place on both tables, unread, so historical
-- allocations remain inspectable rather than being destroyed by this migration.

alter table public.ad_model_assignments add column if not exists sub_categories text[];
alter table public.ad_spend add column if not exists sub_categories text[];

-- The account a campaign ran in, shown in the allocation popup so it is obvious
-- which business line the spend came from before picking a sub-category.
alter table public.ad_spend add column if not exists ad_account_name text;

create index if not exists ad_spend_sub_categories_idx on public.ad_spend using gin (sub_categories);

-- Backfill names for spend already synced. New rows get theirs from the Meta
-- sync (src/lib/sync/meta-spend.ts), which reads the account's real name.
update public.ad_spend set ad_account_name = v.name
from (values
  ('1518608163278697', 'Miraj - Other Products'),
  ('1668737277337610', 'Miraj - Rugs'),
  ('1751981066254683', 'Miraj - Zamzam & Ehram'),
  ('1476476430760056', 'Miraj Gomla')
) as v(account_id, name)
where public.ad_spend.ad_account_id = v.account_id
  and public.ad_spend.ad_account_name is null;

notify pgrst, 'reload schema';
