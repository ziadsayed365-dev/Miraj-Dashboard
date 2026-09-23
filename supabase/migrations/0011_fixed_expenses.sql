-- Fixed operating expenses (rent, salaries, etc.) as a daily rate, so any
-- date range can compute its share by multiplying by the number of days.
alter table settings add column if not exists fixed_expenses_per_day numeric(12,2) not null default 0;
