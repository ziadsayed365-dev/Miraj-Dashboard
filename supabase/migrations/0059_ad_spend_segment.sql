-- Miraj runs FOUR Meta ad accounts. Three are retail and pool into one retail
-- ad-spend number; the fourth is wholesale and must be reportable entirely on
-- its own (its own spend, and later its own sales).
--
-- The segment is decided by WHICH AD ACCOUNT the spend came from (see
-- src/lib/meta-accounts.ts), so it is stamped once at sync time rather than
-- being re-derived by every report.
--
-- 'retail' is the default because it is the overwhelmingly common case and
-- because TikTok spend (typed in by hand, src/lib/tiktok-spend.ts) inserts
-- rows without naming a segment.

alter table public.ad_spend
  add column if not exists segment text not null default 'retail',
  -- Which Meta ad account the row came from. The three retail accounts are
  -- POOLED in reporting, so this is not a reporting dimension - it is kept for
  -- traceability, for de-duplicating a campaign that moves between accounts,
  -- and so a mis-segmented account can be corrected with one UPDATE.
  add column if not exists ad_account_id text;

alter table public.ad_spend drop constraint if exists ad_spend_segment_check;
alter table public.ad_spend
  add constraint ad_spend_segment_check check (segment in ('retail', 'wholesale'));

-- Every P&L/report read is "spend for these days, for this segment".
create index if not exists ad_spend_segment_date_idx on public.ad_spend (segment, date);

-- An ad belongs to exactly one segment for its whole life (it lives in one ad
-- account), so the allocation mapping carries the segment too. This lets the
-- allocation popup group by segment, and stops a wholesale ad from being
-- offered against a retail-only model list.
alter table public.ad_model_assignments
  add column if not exists segment text not null default 'retail';

alter table public.ad_model_assignments drop constraint if exists ad_model_assignments_segment_check;
alter table public.ad_model_assignments
  add constraint ad_model_assignments_segment_check check (segment in ('retail', 'wholesale'));

notify pgrst, 'reload schema';
