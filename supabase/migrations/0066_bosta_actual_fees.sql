-- What Bosta ACTUALLY charged, per shipment, instead of a modelled rate card.
--
-- The rate card was always a stand-in: bosta_fee_matrix holds one row per
-- (zone, size, period), and for every day before 2026-08-04 Miraj has exactly
-- one row in it, so courier fees for Jan-Jul could not be computed at all.
--
-- Bosta's delivery-detail endpoint (/api/v0/deliveries/{_id}) returns a
-- wallet.cashCycle block holding the real amounts deducted for that shipment:
--
--   bosta_fees           119.70   total charged, VAT INCLUSIVE
--   shipping_fees        102.00   base shipping, ex-VAT
--   opening_package_fees   3.00   ex-VAT, and it genuinely varies per shipment
--   cod_fees               0.00   the "Next Day" fee - zero for Miraj throughout
--   fulfillment_fees      15.00   plus insurance/flex/escrow lines, all ex-VAT
--
-- and the ex-VAT parts sum to priceBeforeVat, which x1.14 equals bosta_fees.
-- These are the numbers on the invoice, so they need no zone lookup, no VAT
-- assumption and no effective-dating - which is why they are stored raw here
-- and the whole cashCycle is kept for audit.
--
-- The rate card is NOT removed: it still prices orders that have no Bosta
-- record yet (in_transit, or not handed over), and margin.ts falls back to it
-- whenever bosta_actual_fee is null.
alter table public.orders
  -- wallet.cashCycle.bosta_fees - the VAT-inclusive total for this shipment.
  add column if not exists bosta_actual_fee numeric(12,2),
  -- The ex-VAT components, kept split so each can feed its own P&L line.
  add column if not exists bosta_actual_shipping_fee numeric(12,2),
  add column if not exists bosta_actual_open_package_fee numeric(12,2),
  add column if not exists bosta_actual_cod_fee numeric(12,2),
  -- Everything else Bosta billed (fulfillment, insurance, flex, escrow, ...),
  -- ex-VAT, so the components always reconcile back to bosta_actual_fee.
  add column if not exists bosta_actual_other_fee numeric(12,2),
  -- The raw block, so a disputed charge can be traced without re-calling the API.
  add column if not exists bosta_cash_cycle jsonb,
  add column if not exists bosta_fees_synced_at timestamptz;

create index if not exists orders_bosta_fees_synced_idx
  on public.orders (bosta_fees_synced_at nulls first);

notify pgrst, 'reload schema';
