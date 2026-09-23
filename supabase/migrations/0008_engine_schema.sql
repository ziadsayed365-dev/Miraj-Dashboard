-- Prepares the schema for the valuation engine.

-- Success rates are calibrated per MODEL (where cost/price already live),
-- not per individual color listing.
alter table product_success_rates drop column if exists product_id;
alter table product_success_rates add column if not exists model_group_id bigint references model_groups(id);
alter table product_success_rates drop constraint if exists product_success_rates_pkey;
alter table product_success_rates add primary key (model_group_id, as_of_date);

-- Simplify/expand order_line_items engine fields: one generic courier fee
-- (whichever of deliver/exchange/return_pickup/return_to_origin applies to
-- the order's outcome) instead of separate named columns, since the size
-- surcharge concept is now baked into the Bosta fee matrix itself. Adds
-- explicit revenue/cost fields and a full audit breakdown for the
-- Reconcile page.
alter table order_line_items drop column if exists allocated_delivery_fee;
alter table order_line_items drop column if exists allocated_rto_fee;
alter table order_line_items drop column if exists size_surcharge;

alter table order_line_items add column if not exists revenue numeric(12,2);
alter table order_line_items add column if not exists cost_of_goods numeric(12,2);
alter table order_line_items add column if not exists allocated_courier_fee numeric(12,2);
alter table order_line_items add column if not exists fee_breakdown jsonb;
