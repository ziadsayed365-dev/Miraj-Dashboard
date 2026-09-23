-- Ad spend can now be pinned to a whole CATEGORY, not just a sub-category.
--
-- 0063 pinned spend to sub_categories, where the "sub-category" is really
-- `sub_category || category` - the same fallback per-product.ts groups on, so a
-- product with no sub-category is grouped under its category name. That covers
-- two of the three real cases:
--
--   1. a campaign promotes one specific sub-category   -> sub_categories
--   3. a brand campaign promotes everything            -> is_general
--
-- but not the middle one the owner actually runs: a campaign for a whole
-- category, e.g. all of "سجاد صلاة", which spans ten sub-categories. Until now
-- that had to be faked by ticking all ten by hand, which silently froze the
-- list - a sub-category added to the category later would never receive any of
-- that campaign's spend.
--
-- Storing the CATEGORY instead keeps the membership live: it is expanded to
-- whatever sub-categories the category currently holds at read time, and the
-- spend is split equally across them, exactly like a multi-sub-category pin.
--
-- Kept as a separate column rather than reusing sub_categories, because the two
-- mean different things and the UI has to show which one was chosen. A campaign
-- may carry both (one named sub-category plus a whole other category); the
-- expansion below de-duplicates before splitting so nothing is double-counted.
alter table public.ad_model_assignments add column if not exists categories text[];
alter table public.ad_spend add column if not exists categories text[];

create index if not exists ad_spend_categories_idx on public.ad_spend using gin (categories);

notify pgrst, 'reload schema';
