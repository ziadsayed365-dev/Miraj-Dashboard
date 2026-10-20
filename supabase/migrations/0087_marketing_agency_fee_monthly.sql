-- The marketing agency switched its billing on 2026-10-19 from 12.5% of what
-- Miraj spends on ads to a flat 50,000 EGP/month. The owner can change the
-- monthly figure from Settings, so it lives on the settings singleton beside the
-- other money parameters rather than being hardcoded.
--
-- It is NOT backdated: daily-pnl.ts keeps the 12.5% derivation for every day
-- before 2026-10-19 (reported days must not move) and charges this flat fee, at
-- amount / 30 per day, only from that date on. The column default seeds the
-- figure the agency actually moved to.
alter table public.settings
  add column if not exists marketing_agency_fee_monthly numeric(12,2) not null default 50000;

notify pgrst, 'reload schema';
