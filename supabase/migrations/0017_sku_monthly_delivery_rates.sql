-- Per-SKU (individual color/variant) delivery rate per calendar month,
-- mirroring monthly_delivery_rates but segmented by product instead of
-- store-wide. Used to project each SKU's own open-month revenue/COGS by
-- its own delivery rate, instead of one blanket store-wide rate. Note:
-- 0008_engine_schema.sql moved the *margin-projection* calibration from
-- per-color to per-model for sample-size reasons - this table is a
-- deliberate, separate per-color metric for the Analysis by Product page.
create table if not exists sku_monthly_delivery_rates (
  product_id bigint not null references products(id),
  month date not null, -- first day of the calendar month
  resolved_count int not null,
  delivered_count int not null,
  rate numeric(6,4) not null,
  created_at timestamptz not null default now(),
  primary key (product_id, month)
);
