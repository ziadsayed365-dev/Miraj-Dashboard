-- Force every delivery rate to be recomputed, after the cancelled-order fix in
-- src/lib/engine/monthly-rate.ts.
--
-- Both finalizers deliberately never revisit a month that already has a row -
-- they walk forward from the latest one stored. That makes them cheap and
-- idempotent, but it also means a corrected formula does NOT restate history:
-- the wrong rates would sit there permanently. Clearing both tables is the
-- supported way to re-derive them; the next finalize run rebuilds every mature
-- month from the orders themselves.
--
-- Safe to delete: both tables are pure derivations of public.orders. Nothing is
-- hand-entered here, and nothing else references them by id.
--
-- What was wrong: neither finalizer filtered cancelled orders. A cancelled
-- order still carries an outcome - normally failed_rto, since the package comes
-- back - so it counted in the resolved denominator while the delivered
-- numerator ignored it. Rates were understated by up to 6.5 points (May read
-- 0.8626 against a true 0.9275; June 0.8330 against 0.8802), which flowed into
-- the open month's revenue, COGS and Bosta Penalty projections.
delete from public.sku_monthly_delivery_rates;
delete from public.monthly_delivery_rates;

notify pgrst, 'reload schema';
