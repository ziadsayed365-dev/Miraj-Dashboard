-- Lets unresolved line items (product not yet in our products table) be
-- deterministically relinked once the catalog sync creates that product,
-- instead of relying only on a fuzzy product_title_raw text match.
alter table order_line_items add column if not exists shopify_product_id bigint;
