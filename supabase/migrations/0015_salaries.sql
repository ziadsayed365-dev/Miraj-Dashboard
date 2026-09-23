-- Replace the flat SG&A monthly setting with a two-employee salary model:
-- employee 1 is a flat monthly amount (spread over each calendar month's
-- real day count in application code), employee 2 earns a percentage of
-- that day's revenue (real once resolved, projected while the month is
-- still open - same revenue figure already used elsewhere in the report).
alter table settings drop column if exists sga_per_day;
alter table settings add column if not exists salary_employee1_monthly numeric(12,2) not null default 5000.00;
alter table settings add column if not exists salary_employee2_pct numeric(6,4) not null default 0.07;
