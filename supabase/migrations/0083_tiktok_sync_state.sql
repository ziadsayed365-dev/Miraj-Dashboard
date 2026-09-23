-- Cursor for the TikTok Marketing API spend sync (src/lib/sync/tiktok-spend.ts).
-- The sync reads this row with .single(), so it must exist before the first run.
-- cursor starts null: the sync then begins at TIKTOK_SPEND_SINCE.
insert into public.sync_state (source) values ('tiktok') on conflict (source) do nothing;

notify pgrst, 'reload schema';
