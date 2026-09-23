-- The Report tab must not reflect new/edited entries until the owner
-- clicks Sync - record_data_synced_at is the cutoff the Report tab
-- filters recorded_transactions.updated_at against. updated_at (distinct
-- from created_at) lets an edit to an old row also wait for the next sync.
alter table settings add column if not exists record_data_synced_at timestamptz;
alter table recorded_transactions add column if not exists updated_at timestamptz not null default now();
