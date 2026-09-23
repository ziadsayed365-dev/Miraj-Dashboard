-- Shopify's product status (ACTIVE/ARCHIVED/DRAFT), so the Product List
-- page can filter out archived/draft items by default.
alter table products add column if not exists status text;
