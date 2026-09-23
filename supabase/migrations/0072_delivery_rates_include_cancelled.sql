-- Re-derive every delivery rate WITH cancelled orders counted, per the owner.
--
-- 0071 cleared these tables so they could be rebuilt without cancelled orders.
-- The owner's call is the opposite: a cancelled order that Bosta had already
-- picked up comes back as failed_rto, and that return is a real failed delivery
-- that really cost a courier fee - so it belongs in the rate. Cancellations
-- that never reached a courier carry no delivered/failed_rto outcome and drop
-- out on their own (221 of June's 379).
--
-- Clearing is again the only way to restate: both finalizers walk forward from
-- the newest stored month and never revisit one that already has a row.
delete from public.sku_monthly_delivery_rates;
delete from public.monthly_delivery_rates;

notify pgrst, 'reload schema';
