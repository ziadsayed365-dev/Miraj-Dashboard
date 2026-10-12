-- AI MIRAJ's questions to the owner on Telegram (src/lib/agent/requests.ts),
-- one row per thing it asked: a day's TikTok spend, a product's cost, or a
-- campaign's allocation (a poll). The owner's reply or vote is matched back to
-- its row by the Telegram message / poll it answers, so every answer lands on
-- the right item no matter when it comes.
create table if not exists agent_requests (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  -- 'tiktok' | 'cost' | 'allocation', or 'report' marking a day whose report
  -- has gone out.
  kind text not null check (kind in ('tiktok', 'cost', 'allocation', 'report')),
  -- The date, product id or campaign id asked about; the day, for 'report'.
  item_key text not null,
  -- The day being reported when this was asked.
  day text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  -- The question's Telegram message (text requests).
  message_id bigint,
  -- Allocation only: its polls - [{ pollId, messageId, step, options, answer }].
  -- Two steps when there are more groups than a poll can hold: category first,
  -- then the groups inside each chosen category.
  polls jsonb not null default '[]'::jsonb,
  resolved_at timestamptz
);

-- Never ask the same thing twice while it is still open, and send each day's
-- report once.
create unique index if not exists agent_requests_open_uniq on agent_requests (kind, item_key) where status = 'open';
create unique index if not exists agent_requests_report_uniq on agent_requests (item_key) where kind = 'report';
create index if not exists agent_requests_message_idx on agent_requests (message_id);

drop table if exists agent_chat_messages;
