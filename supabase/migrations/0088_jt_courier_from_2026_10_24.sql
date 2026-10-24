-- Miraj moved from Bosta to J&T for orders placed from 2026-10-24, the same way
-- O Garage did (its migrations 0071/0072/0074). All orders switch on that day;
-- the handful (if any) still carrying a Bosta tracking number keep Bosta's card
-- through src/lib/bosta-fees.ts shippedWithBosta, so the date alone never
-- re-prices a Bosta parcel.
--
-- From 2026-10-24 Shipping Differences and Bosta Penalty on the Income Statement
-- are priced on J&T's quotation instead of Bosta's card. The two lines keep
-- their names; only the rates behind them change. Unlike O Garage, Miraj does
-- NOT keep a "Bosta" comparison memo line - there is no newly negotiated Bosta
-- card to compare against, so that part of O Garage's change is left out.
--
-- October is still the open month, so this moves no reported day (see the
-- "reported days must not change" rule).
--
-- 1. J&T rate card ------------------------------------------------------------
-- Keyed by the same zone names as bosta_fee_matrix (governorate_fees.zone), so
-- one governorate lookup serves both cards. Effective-dated like the Bosta card
-- (see 0053): a later re-price must not restate days already reported.
--
-- J&T quotes per weight band (up to 1 kg; every Miraj parcel is inside it) and
-- excludes a 10% postal fee and 14% VAT, so each rate is quote x 1.10 x 1.14 =
-- quote x 1.254 - the same all-in, VAT-inclusive basis as the Bosta rows.
--   Zone 1  40  -> 50.16   Cairo, Giza, Alexandria, Helwan
--   Zone 2  41  -> 51.41   Delta + Canal + Beheira
--   Zone 3  63  -> 79.00   Upper Egypt + Red Sea
--   Zone 4  90  -> 112.86  Matrouh, New Valley, Sinai (North Coast prices as
--                          Matrouh through governorate_fees already)
-- Returns (return_to_origin) are 50% of the shipping charge, exchanges 150%,
-- and a return pickup ("DR") 100%.

create table if not exists public.jt_fee_matrix (
  zone text not null,
  effective_from date not null,
  deliver numeric(12,2) not null,
  exchange numeric(12,2) not null,
  return_pickup numeric(12,2) not null,
  return_to_origin numeric(12,2) not null,
  -- J&T's COD fee: 1% of the whole COD amount once it is above the threshold,
  -- nothing below (step 2). Owed only on a delivered parcel, when cash is
  -- actually collected. Stored on the card so a re-quote is a new dated row.
  cod_fee_pct numeric(6,4) not null default 0,
  cod_fee_threshold numeric(12,2) not null default 0,
  note text,
  created_at timestamptz not null default now(),
  primary key (zone, effective_from)
);

alter table public.jt_fee_matrix enable row level security;

insert into public.jt_fee_matrix
  (zone, effective_from, deliver, exchange, return_pickup, return_to_origin, cod_fee_pct, cod_fee_threshold, note)
select v.zone, date '2026-10-24',
       round(v.quote * 1.254, 2),
       round(v.quote * 1.254 * 1.5, 2),
       round(v.quote * 1.254, 2),
       round(v.quote * 1.254 * 0.5, 2),
       0.01, 1500,
       'J&T quotation: quote x 1.10 postal x 1.14 VAT; COD 1% over 1,500 EGP'
from (values
  ('Cairo', 40), ('Giza', 40), ('Alexandria', 40), ('Helwan', 40),
  ('Ismailia', 41), ('Suez', 41), ('Port Said', 41), ('Dakahlia', 41), ('Qalyubia', 41),
  ('Monufia', 41), ('Sharqia', 41), ('Gharbia', 41), ('Damietta', 41), ('Kafr El Sheikh', 41),
  ('Beheira', 41),
  ('Beni Suef', 63), ('Faiyum', 63), ('Minya', 63), ('Asyut', 63), ('Qena', 63),
  ('Luxor', 63), ('Aswan', 63), ('Red Sea', 63), ('Sohag', 63),
  ('Matrouh', 90), ('New Valley', 90), ('South Sinai', 90), ('North Sinai', 90)
) as v(zone, quote)
on conflict (zone, effective_from) do update
  set deliver = excluded.deliver,
      exchange = excluded.exchange,
      return_pickup = excluded.return_pickup,
      return_to_origin = excluded.return_to_origin,
      cod_fee_pct = excluded.cod_fee_pct,
      cod_fee_threshold = excluded.cod_fee_threshold,
      note = excluded.note;

-- 2. Bosta's Next Day fee stops on the switch day -----------------------------
-- Miraj still paid Bosta's 1% next-day cash-settlement fee up to now (0036, and
-- 0053 carried it forward). J&T parcels do not settle through Bosta, so from
-- 2026-10-24 the Bosta fee is zero and J&T's own COD fee (step 1, folded into
-- the delivery bill by margin.ts) is the only cash fee. Effective-dated, so
-- every day before 2026-10-24 keeps the 1% it was reported with. The
-- open-package fee stays closed (0, as it has been since 2026-08-04).
insert into public.bosta_fee_periods (effective_from, open_package_fee, open_package_vat_pct, cod_cash_fee_pct, note)
values (date '2026-10-24', 0, 0, 0, 'Moved to J&T - Bosta Next Day fee stops; J&T COD fee applies instead')
on conflict (effective_from) do update
  set open_package_fee = excluded.open_package_fee,
      open_package_vat_pct = excluded.open_package_vat_pct,
      cod_cash_fee_pct = excluded.cod_cash_fee_pct,
      note = excluded.note;

notify pgrst, 'reload schema';
