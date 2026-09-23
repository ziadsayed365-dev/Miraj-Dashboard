-- Preserve the original line-item title even when the product can't be
-- matched (deleted from Shopify, e.g. "Lady boot"), so revenue is never
-- silently dropped or misattributed.
alter table order_line_items add column if not exists product_title_raw text;

-- Lets us upsert line items by their Shopify id on re-sync without wiping
-- out engine-computed fields (margin, fees) that get added in a later step.
create unique index if not exists order_line_items_shopify_line_item_id_key
  on order_line_items (shopify_line_item_id);
