-- courier should reflect reality, not a blanket default: 'bosta' only once
-- Bosta sync actually confirms tracking legs for the order, 'movers' only
-- when manually flagged via the Movers Orders tab, null otherwise (not
-- yet shipped by either). Backfill undoes the previous migration's
-- incorrect blanket default of 'bosta' for every order.
alter table orders alter column courier drop not null;
alter table orders alter column courier drop default;

update orders set courier = null where courier = 'bosta' and bosta_tracking_number is null;
