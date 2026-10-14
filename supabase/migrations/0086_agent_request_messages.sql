-- AI MIRAJ asks every chat on TELEGRAM_CHAT_ID, so a text question now has a
-- message in each: [{ chat, id }]. A reply is matched by chat and message id
-- together, since message ids are only unique within a chat. message_id stays
-- for questions asked before this.
alter table agent_requests add column if not exists messages jsonb not null default '[]'::jsonb;
create index if not exists agent_requests_messages_idx on agent_requests using gin (messages jsonb_path_ops);
