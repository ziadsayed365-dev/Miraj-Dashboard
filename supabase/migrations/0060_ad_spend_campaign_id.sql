-- Name the ad-spend key for what it actually holds: a CAMPAIGN id.
--
-- This lineage began on a dashboard that allocated per AD, so ad_spend carried
-- ad_id / adset_id / adset_name. Miraj runs one CAMPAIGN per product, and the
-- Meta sync has always written campaign_id into BOTH ad_id and adset_id, with
-- campaign_name in adset_name. Two columns holding an identical value, and all
-- three named for the wrong level - which made the allocation UI read as if it
-- were mapping individual ads.
--
-- Done now because the database is still empty. After the first backfill this
-- stops being a rename and becomes a data migration.
--
-- One nuance kept in mind: for a campaign listed in ADSET_LEVEL_CAMPAIGNS
-- (src/lib/ad-split.ts) the sync deliberately stores the AD SET id here, so
-- each ad set can be allocated separately. That list is empty for Miraj. The
-- column means "the thing an allocation decision is made about", which is the
-- campaign in every case unless a campaign is explicitly split.

do $$
begin
  -- Composite unique (date, adset_id, ad_id) becomes (date, campaign_id).
  alter table public.ad_spend drop constraint if exists ad_spend_date_adset_id_ad_id_key;

  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='ad_spend' and column_name='adset_id') then
    alter table public.ad_spend drop column adset_id;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='ad_spend' and column_name='ad_id') then
    alter table public.ad_spend rename column ad_id to campaign_id;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='ad_spend' and column_name='adset_name') then
    alter table public.ad_spend rename column adset_name to campaign_name;
  end if;

  -- Every writer sets it (the Meta sync from the API, the TikTok popup with a
  -- synthetic "tiktok:<group>" key), so it can carry a NOT NULL.
  alter table public.ad_spend alter column campaign_id set not null;

  if not exists (select 1 from pg_constraint where conname = 'ad_spend_date_campaign_key') then
    alter table public.ad_spend add constraint ad_spend_date_campaign_key unique (date, campaign_id);
  end if;

  -- The allocation mapping is keyed by the same thing.
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='ad_model_assignments' and column_name='ad_id') then
    alter table public.ad_model_assignments rename column ad_id to campaign_id;
  end if;
end $$;

notify pgrst, 'reload schema';
