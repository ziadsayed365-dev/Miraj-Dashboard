-- Bosta's rate card changed on 2026-08-04: new (lower) VAT-inclusive delivery
-- fees per governorate, and the open-package handling fee is closed from that
-- date. The "Next Day" COD cash-settlement fee is NOT closed here - Miraj
-- still pays it (this is where this business differs from O Garage, which
-- closed both on the same date).
--
-- None of this could be expressed before. bosta_fee_matrix held exactly one
-- rate per (zone, size), and the two add-ons were single columns on settings, so
-- editing any of them rewrote already-reported history: margin.ts recomputes a
-- rolling window that still reaches back into June. Both now carry an
-- effective_from and are read as-of each order's own egypt_day.
--
-- This is deliberately a different rule from product costs, which 0050 keeps
-- flat on purpose (the built cost is a live BOM rollup, so it cannot pretend to
-- be effective-dated). A courier rate card is not a rollup - it genuinely
-- changes on a date and both sides of that date are correct, so it is dated.
--
-- The pre-2026-08-04 rows below are the rates that were live until now, seeded
-- verbatim from the existing table/settings, so historical margins recompute to
-- exactly the numbers already reported.

-- 1. Effective-date the zone x size grid ------------------------------------
alter table public.bosta_fee_matrix
  add column if not exists effective_from date not null default date '2000-01-01';

alter table public.bosta_fee_matrix drop constraint if exists bosta_fee_matrix_pkey;
alter table public.bosta_fee_matrix
  add constraint bosta_fee_matrix_pkey primary key (zone, shipment_size, effective_from);

-- 2. Effective-date the two flat add-ons ------------------------------------
-- One row per pricing period. They are separate columns because Bosta prices
-- them separately - as this very change shows, one can close while the other
-- carries on.
create table if not exists public.bosta_fee_periods (
  effective_from date primary key,
  -- Flat per-shipment "open package" handling fee, charged whatever the
  -- outcome. Stored ex-VAT (unlike the matrix, which is VAT-inclusive), so
  -- readers gross it up by open_package_vat_pct.
  open_package_fee numeric(12,2) not null,
  open_package_vat_pct numeric(6,4) not null,
  -- "Next Day" cash-settlement fee, as a fraction of COD collected.
  cod_cash_fee_pct numeric(6,4) not null,
  note text,
  created_at timestamptz not null default now()
);

alter table public.bosta_fee_periods enable row level security;

-- Opening period carries whatever settings holds right now (7.00 + 14% VAT,
-- 1% COD), read from the table rather than hardcoded so this can't drift.
insert into public.bosta_fee_periods (effective_from, open_package_fee, open_package_vat_pct, cod_cash_fee_pct, note)
select date '2000-01-01', s.bosta_open_package_fee, s.bosta_open_package_vat_pct, s.cod_cash_fee_pct,
       'Opening period - migrated from settings'
from public.settings s where s.id = 1
on conflict (effective_from) do nothing;

-- Open package closed; the next-day fee carries over unchanged, again read from
-- settings so this period cannot silently diverge from what was in force.
insert into public.bosta_fee_periods (effective_from, open_package_fee, open_package_vat_pct, cod_cash_fee_pct, note)
select date '2026-08-04', 0, 0, s.cod_cash_fee_pct,
       'Open-package fee closed; Next Day fee still charged'
from public.settings s where s.id = 1
on conflict (effective_from) do nothing;

-- settings is no longer the source of truth for these three - drop them rather
-- than leave a second, silently-stale copy (the way vat_multiplier was left
-- behind by 0005 and has been dead ever since).
alter table public.settings drop column if exists bosta_open_package_fee;
alter table public.settings drop column if exists bosta_open_package_vat_pct;
alter table public.settings drop column if exists cod_cash_fee_pct;

-- 3. Helwan becomes its own zone --------------------------------------------
-- The new card prices Helwan at 108 while Cairo is 93, so it can no longer be
-- folded into Cairo (src/lib/governorates.ts drops that alias in the same
-- change). Its pre-2026-08-04 rates are Cairo's, so orders that previously
-- resolved to Cairo through the alias keep costing exactly what they did.
insert into public.governorate_fees (governorate, zone, updated_at)
values ('Helwan', 'Helwan', now())
on conflict (governorate) do update set zone = excluded.zone, updated_at = now();

insert into public.bosta_fee_matrix
  (zone, shipment_size, effective_from, deliver, exchange, return_pickup, cash_collection, return_to_origin)
values ('Helwan', 'Small & Medium', date '2000-01-01', 104.88, 0, 0, 0, 99.18)
on conflict (zone, shipment_size, effective_from) do nothing;

-- 4. The new card, effective 2026-08-04 -------------------------------------
-- Fees as given by the owner, already VAT-inclusive (same basis as the existing
-- rows). Return-to-origin keeps the rule the existing card already follows
-- exactly: delivery fee - 5.70 (5 EGP + 14% VAT), confirmed unchanged.
insert into public.bosta_fee_matrix
  (zone, shipment_size, effective_from, deliver, exchange, return_pickup, cash_collection, return_to_origin)
select v.zone, 'Small & Medium', date '2026-08-04', v.deliver, 0, 0, 0, v.deliver - 5.70
from (values
  ('Cairo', 93.00), ('Giza', 93.00),
  ('Alexandria', 101.00), ('Beheira', 101.00),
  ('Dakahlia', 108.00), ('Qalyubia', 108.00), ('Sharqia', 108.00), ('Gharbia', 108.00),
  ('Ismailia', 108.00), ('Damietta', 108.00), ('Suez', 108.00), ('Port Said', 108.00),
  ('Monufia', 108.00), ('Kafr El Sheikh', 108.00), ('Helwan', 108.00),
  ('Asyut', 128.00), ('Faiyum', 128.00), ('Sohag', 128.00), ('Beni Suef', 128.00), ('Minya', 128.00),
  ('Red Sea', 146.00), ('Qena', 146.00), ('Matrouh', 146.00), ('Aswan', 146.00), ('Luxor', 146.00),
  ('South Sinai', 169.00), ('North Sinai', 169.00), ('New Valley', 169.00)
) as v(zone, deliver)
on conflict (zone, shipment_size, effective_from) do update
  set deliver = excluded.deliver, return_to_origin = excluded.return_to_origin, updated_at = now();

notify pgrst, 'reload schema';
