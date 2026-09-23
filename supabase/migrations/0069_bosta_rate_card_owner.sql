-- The real Bosta delivery price list, as given by the owner, replacing the
-- figures 0053 loaded for 2026-08-04.
--
-- Owner-confirmed basis, which is what makes these directly loadable:
--   * the delivery fees below are AFTER 14% VAT - the same basis
--     bosta_fee_matrix.deliver has always been stored on;
--   * the open-package fee is 5.00 BEFORE VAT, which is how
--     bosta_fee_periods.open_package_fee is stored (readers gross it up).
--
-- 0053's card (Cairo 93, Alexandria 101, then 108/128/146/169) does not match
-- either this list or Bosta's own invoices, so it is overwritten rather than
-- kept as a second period - it was never a real price the business paid.
--
-- Zone names are the canonical governorates in governorate_fees. "6th of
-- October" is not among them: src/lib/governorates.ts maps it to Giza, and the
-- owner prices both at 70, so the alias already lands on the right rate.
insert into public.bosta_fee_matrix
  (zone, shipment_size, effective_from, deliver, exchange, return_pickup, cash_collection, return_to_origin)
select v.zone, 'Small & Medium', date '2026-08-04', v.deliver, 0, 0, 0, v.deliver - 5.70
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

-- The open-package fee is charged again on this period, not closed. 0053 set it
-- to zero from 2026-08-04 on the understanding Bosta had dropped it; the owner
-- confirms it is still billed at 5.00 + 14% VAT, and Bosta's own invoices show
-- opening_package_fees of 5.00 on shipments right through May.
update public.bosta_fee_periods
set open_package_fee = 5.00,
    open_package_vat_pct = 0.1400,
    note = 'Open package still charged at 5.00 + 14% VAT (owner-confirmed); Next Day fee not applied'
where effective_from = date '2026-08-04';

notify pgrst, 'reload schema';
