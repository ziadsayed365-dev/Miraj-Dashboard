-- "General" ad spend: brand/general campaigns that don't promote one model and
-- should be spread across all of them.
--
-- This can NOT be represented as model_group_id = null, because null already
-- means "not allocated yet" - it's exactly what the allocation popup lists
-- (getUnmappedAds). A general ad marked that way would reappear in the popup
-- forever. Hence an explicit flag.

alter table public.ad_spend add column if not exists is_general boolean not null default false;
create index if not exists ad_spend_is_general_idx on public.ad_spend (is_general) where is_general;

-- The ad_id -> model mapping now records a general choice too, so the Meta sync
-- re-applies it to future days for that ad (same as a model assignment).
alter table public.ad_model_assignments add column if not exists is_general boolean not null default false;
alter table public.ad_model_assignments alter column model_group_id drop not null;
alter table public.ad_model_assignments drop constraint if exists ad_model_assignments_target_check;
alter table public.ad_model_assignments
  add constraint ad_model_assignments_target_check
    check ((model_group_id is not null) <> is_general);

notify pgrst, 'reload schema';
