-- Return fee = delivery fee - 5.70, and the open-package fee is charged on
-- every order including returns. Reverts 0073.
--
-- The two are separate charges that happen to sum to the delivery fee, and that
-- is the point: Bosta bills the return leg at 5.70 less than a delivery, and
-- bills the open package on every shipment whatever its outcome. Reporting them
-- on their own lines is what makes the Income Statement readable -
--
--   returned Cairo order:  Bosta Penalty 64.30  +  Open Package 5.70  =  70.00
--
-- so the Penalty line shows the courier's own return charge and the Open
-- Package line shows the handling fee, rather than one line carrying both.
update public.bosta_fee_matrix
set return_to_origin = deliver - 5.70, updated_at = now()
where return_to_origin <> deliver - 5.70;

notify pgrst, 'reload schema';
