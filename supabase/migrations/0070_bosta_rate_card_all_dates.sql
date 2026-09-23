-- One rule for every order, on the owner's instruction: the Bosta delivery fee
-- for the order's governorate, against the shipping fee the website charged.
--
-- 0069 loaded the owner's price list from 2026-08-04 only, which left January
-- to July on the pre-cutover period - and that period held exactly ONE row
-- (Helwan), so courier fees there computed to zero. This backdates the same
-- list to the opening period, so a governorate prices identically whatever the
-- order's date.
--
-- Deliberately a flat card, not an effective-dated one. Bosta's own invoices
-- show they billed less earlier in the year (Cairo 53 ex-VAT in February
-- against the 70 inc-VAT here), so this does overstate the early months
-- slightly - the owner has chosen one consistent, explainable rate per
-- governorate over per-period accuracy. The invoice figures remain in
-- orders.bosta_actual_* and can be switched back on in margin.ts.
insert into public.bosta_fee_matrix
  (zone, shipment_size, effective_from, deliver, exchange, return_pickup, cash_collection, return_to_origin)
select v.zone, 'Small & Medium', date '2000-01-01', v.deliver, 0, 0, 0, v.deliver - 5.70
from (values
  ('Cairo', 70.00), ('Giza', 70.00),
  ('Alexandria', 75.00), ('Beheira', 75.00),
  ('Dakahlia', 81.00), ('Qalyubia', 81.00), ('Sharqia', 81.00), ('Gharbia', 81.00),
  ('Ismailia', 81.00), ('Damietta', 81.00), ('Suez', 81.00), ('Port Said', 81.00),
  ('Monufia', 81.00), ('Kafr El Sheikh', 81.00), ('Helwan', 81.00),
  ('Asyut', 96.00), ('Faiyum', 96.00), ('Sohag', 96.00), ('Beni Suef', 96.00), ('Minya', 96.00),
  ('Red Sea', 108.00), ('Qena', 108.00), ('Matrouh', 108.00), ('Aswan', 108.00), ('Luxor', 108.00),
  ('South Sinai', 132.00), ('North Sinai', 132.00), ('New Valley', 132.00)
) as v(zone, deliver)
on conflict (zone, shipment_size, effective_from) do update
  set deliver = excluded.deliver,
      return_to_origin = excluded.return_to_origin,
      updated_at = now();

-- Same open-package fee across the whole history, for the same reason.
update public.bosta_fee_periods
set open_package_fee = 5.00, open_package_vat_pct = 0.1400
where effective_from = date '2000-01-01';

notify pgrst, 'reload schema';
