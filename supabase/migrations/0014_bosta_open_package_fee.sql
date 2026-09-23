-- Bosta charges a flat "open package" handling fee per shipment (lets the
-- customer inspect before paying), plus VAT on top - separate from the
-- zone/size-based courier fee in bosta_fee_matrix (which is already
-- VAT-inclusive, hence settings.vat_multiplier staying at 1; this fee is
-- not, so it gets its own VAT rate rather than reusing that field).
alter table settings add column if not exists bosta_open_package_fee numeric(12,2) not null default 7.00;
alter table settings add column if not exists bosta_open_package_vat_pct numeric(6,4) not null default 0.14;

alter table order_line_items add column if not exists allocated_open_package_fee numeric(12,2);
