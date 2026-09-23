-- Movers is an alternate shipping company (alongside Bosta) for some
-- already-synced Shopify orders. Flagging an order courier='movers' means:
-- it never gets a real outcome (Bosta's sync will never find it), so it's
-- always treated as projected using the same calibrated delivery rate
-- Bosta orders use once their own outcome isn't known yet - see margin.ts.
alter table orders add column if not exists courier text not null default 'bosta' check (courier in ('bosta', 'movers'));
