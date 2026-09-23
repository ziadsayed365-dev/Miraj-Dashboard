-- Starting success-rate assumption used only until a product has enough
-- matured, resolved Bosta data to calibrate its own real rate (per the
-- locked calibration rules: 150+ resolved = trust the product's own rate,
-- fewer = blend with this/store-wide, under ~10 = use this as-is).
alter table settings add column if not exists default_success_rate_estimate numeric(6,4) not null default 0.70;
