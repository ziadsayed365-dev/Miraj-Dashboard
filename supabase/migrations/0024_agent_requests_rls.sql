-- agent_requests is read only by the server, with the secret key (which bypasses
-- RLS); without this the public key could read and write it through the API.
alter table agent_requests enable row level security;
revoke all on agent_requests from anon, authenticated;
