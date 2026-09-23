-- Persists the ad_id -> model_group_id mapping the owner picks in the ad
-- allocation popup, so it survives beyond the rows that exist today. The
-- Meta sync re-applies this to any new (still-unmapped) ad_spend rows for
-- the same ad_id, since one ad keeps promoting the same model for its
-- whole run - the owner shouldn't have to re-allocate it every time it
-- spends on a new day.
create table if not exists ad_model_assignments (
  ad_id text primary key,
  model_group_id bigint not null references model_groups(id),
  created_at timestamptz not null default now()
);
