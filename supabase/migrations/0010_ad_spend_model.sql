-- Ad campaigns promote a model (e.g. "Lilly Mary Jane"), not one specific
-- color/SKU, so ad spend maps to model_groups, not products.
alter table ad_spend drop column if exists product_id;
alter table ad_spend add column if not exists model_group_id bigint references model_groups(id);
