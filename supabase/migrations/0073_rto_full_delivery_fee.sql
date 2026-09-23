-- A returned order now costs the FULL delivery fee, plus the open-package fee.
--
-- Until now return_to_origin was delivery - 5.70, on the reading that a return
-- escapes the open-package charge. But the app charges open package on every
-- order whatever the outcome, so the two cancelled out: a returned Cairo order
-- came to 64.30 courier + 5.70 open package = 70.00, i.e. the deduction did
-- nothing except move 5.70 from the Bosta Penalty line onto the Open Package
-- line. The owner has chosen to drop the deduction and keep the open-package
-- charge, so a returned Cairo order is now 70.00 + 5.70 = 75.70.
--
-- Applied to BOTH periods, because migration 0070 made the card flat across all
-- dates - a governorate has to cost the same whenever the order was placed.
--
-- For the record, Bosta's own invoices support neither extreme cleanly: of
-- 3,445 returned shipments, 2,066 were billed an open-package fee and 1,379
-- were not. This is a deliberate, explainable convention rather than a
-- reproduction of their billing.
update public.bosta_fee_matrix
set return_to_origin = deliver, updated_at = now()
where return_to_origin <> deliver;

notify pgrst, 'reload schema';
