-- Two corrections to what Bosta actually charges Miraj, both of which have been
-- silently wrong since setup and both of which land on Shipping Differences.
--
-- 1. THE ZONE MAP WAS NEVER FILLED IN.
--    governorate_fees held all 28 canonical governorates with zone = NULL on
--    every one except Helwan. margin.ts resolves a fee as
--        zoneFor(governorate) -> feesFor(zone, size, day)
--    and feeFor() returns 0 when that lookup misses, so EVERY order has been
--    booking a courier fee of zero: allocated_courier_fee is 0 on 5,840 of
--    5,847 January line items, 15,772 of 15,793 in February, and so on.
--
--    The knock-on effect is exactly what the owner is seeing. Shipping
--    Differences = shipping charged - courier fee paid, so with the paid side
--    stuck at zero it has been reporting the FULL shipping fee charged as a
--    credit (~219k in January, ~541k in February). Bosta Penalty, which is the
--    return-to-origin fee, has been reading near zero for the same reason.
--
--    The 2026-08-04 card already names its zones after the governorates, and
--    all 28 exist there, so the map is one-to-one.
update public.governorate_fees
set zone = governorate, updated_at = now()
where zone is null;

-- 2. THE OPEN-PACKAGE FEE WAS 7.00, NOT 5.00.
--    0053 seeded the opening period from settings.bosta_open_package_fee, which
--    held 7.00. The owner confirms Bosta charges 5.00 EGP before 14% VAT
--    (= 5.70 all-in). This restates the open-package line for every order up to
--    2026-08-03; from 2026-08-04 the fee is closed (0.00) and is untouched here.
update public.bosta_fee_periods
set open_package_fee = 5.00,
    open_package_vat_pct = 0.1400,
    note = 'Open package 5.00 + 14% VAT (owner-confirmed); was seeded at 7.00 from settings'
where effective_from = date '2000-01-01';

-- The "Next Day" COD cash-settlement fee is already 0.0000 in both periods and
-- allocated_cod_cash_fee sums to zero in every month, which matches the owner's
-- "I don't apply next day fees". Left as-is deliberately - nothing to change.

notify pgrst, 'reload schema';
