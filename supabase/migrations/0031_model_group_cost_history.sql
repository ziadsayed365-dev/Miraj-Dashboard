-- Effective-dated cost timeline per model, so a cost change made today
-- doesn't silently rewrite already-reported historical margins. A model's
-- first-ever cost entry is backdated (see app code) to cover its past
-- orders too, since those were never priced at all before; later changes
-- are only ever inserted with today's date, applying from then on.
create table if not exists model_group_cost_history (
  id bigint generated always as identity primary key,
  model_group_id bigint not null references model_groups(id),
  unit_cost numeric(12,2) not null,
  effective_from date not null,
  created_at timestamptz not null default now()
);
create index if not exists model_group_cost_history_model_idx on model_group_cost_history (model_group_id, effective_from);
