-- Test questions (POST /api/agent/nightly?test=1): asked and answered exactly
-- like real ones, but an answer records nothing - the bot replies with what it
-- would have saved. label names the item in that reply.
alter table agent_requests add column if not exists test boolean not null default false;
alter table agent_requests add column if not exists label text;
