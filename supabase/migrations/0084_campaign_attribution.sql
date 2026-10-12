-- Campaigns P&L: tie each order to the Meta campaign that brought it in.
--
-- The UTM parameters of the customer's LAST AD CLICK within 7 days before the
-- order, read from Shopify's customerJourneySummary
-- (src/lib/sync/shopify-attribution.ts), and the Meta campaign / ad set that
-- click belongs to. Ads tagged utm_campaign={{campaign.id}} give the campaign
-- directly; ads tagged only with utm_term={{adset.id}} have their ad set's
-- campaign looked up from Meta. attribution_synced_at marks orders whose journey
-- has been read (with or without an ad click), so the sync can tell "no ad" apart
-- from "not checked yet". Purely additive: no existing report reads these columns.
alter table public.orders add column if not exists utm_source text;
alter table public.orders add column if not exists utm_medium text;
alter table public.orders add column if not exists utm_campaign text;
alter table public.orders add column if not exists utm_content text;
alter table public.orders add column if not exists utm_term text;
alter table public.orders add column if not exists meta_campaign_id text;
alter table public.orders add column if not exists meta_adset_id text;
alter table public.orders add column if not exists attribution_synced_at timestamptz;
create index if not exists orders_meta_campaign_id_idx on public.orders (meta_campaign_id);
create index if not exists orders_meta_adset_id_idx on public.orders (meta_adset_id);
