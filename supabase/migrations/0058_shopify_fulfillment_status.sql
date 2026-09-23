-- Shopify already knows which unresolved orders were hand-delivered, and it is
-- a far better signal than "has no Bosta tracking number".
--
-- An order fulfilled by a courier carries a fulfilment whose displayStatus
-- moves IN_TRANSIT -> DELIVERED and has tracking info attached. An order
-- someone marked fulfilled by hand sits at plain 'FULFILLED' forever, with no
-- tracking company, no tracking number and no delivered timestamp - because no
-- courier was ever involved. That is exactly the private-delivery case.
--
-- So store the fulfilment displayStatus alongside the outcome:
--   'FULFILLED'              -> marked fulfilled by hand, no courier
--   'IN_TRANSIT'/'DELIVERED' -> really is with a courier (sync will resolve it)
--   null                     -> never fulfilled at all
-- The Unresolved Orders tab uses it to pre-select the hand-delivered ones.

alter table public.orders
  add column if not exists shopify_fulfillment_status text;

comment on column public.orders.shopify_fulfillment_status is
  'displayStatus of the order''s Shopify fulfilments. Plain FULFILLED with no tracking = fulfilled by hand, no courier.';
