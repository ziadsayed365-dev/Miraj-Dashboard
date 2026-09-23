-- Actual mode must bucket/include a Bosta order by the date Bosta actually
-- received the package, not the Shopify order date - Shopify auto-forwards
-- every order to Bosta the instant it's placed (state "Created"), but the
-- owner may not hand off the physical package for days. egypt_day stays
-- the original Shopify order date unchanged, so Performance mode is
-- unaffected. Null until Bosta's state moves past "Created".
alter table orders add column if not exists bosta_picked_up_day date;
create index if not exists orders_bosta_picked_up_day_idx on orders (bosta_picked_up_day);
