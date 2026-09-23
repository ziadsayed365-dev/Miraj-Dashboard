-- Replace the single lump fixed-expense rate with named categories that
-- match the income statement layout (Rent and SG&A are manual inputs, like
-- the old field; Bosta Penalty is also manual since we have no data source
-- for it; Packaging and Transportation are derived from existing per-order
-- data, not stored here).
alter table settings drop column if exists fixed_expenses_per_day;
alter table settings add column if not exists sga_per_day numeric(12,2) not null default 0;
alter table settings add column if not exists rent_per_day numeric(12,2) not null default 0;
alter table settings add column if not exists bosta_penalty_per_day numeric(12,2) not null default 0;
