-- Rent moves from a flat per-day rate to a monthly amount (spread over
-- each calendar month's real day count in application code, same as the
-- employee 1 salary). Transportation becomes a flat per-day average.
-- Bosta Penalty stops being a manual flat setting - it's now computed
-- from the estimated/real cost of returned orders (application code),
-- so the old per-day rate goes away.
alter table settings drop column if exists rent_per_day;
alter table settings add column if not exists rent_monthly numeric(12,2) not null default 8000.00;
alter table settings add column if not exists transportation_per_day numeric(12,2) not null default 32.00;
alter table settings drop column if exists bosta_penalty_per_day;

update settings set packing_cost_per_unit = 12.00 where id = 1;
