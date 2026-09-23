-- Row-level security for every table this project owns.
--
-- Miraj keeps its tables in its own schema, not public: src/lib/supabase.ts
-- sets db.schema from SUPABASE_SCHEMA=public. Two consequences worth stating,
-- because neither is obvious:
--
--   1. Supabase's rls_disabled_in_public advisor only inspects the public
--      schema, so this project never appeared in the security warning emails.
--      That means the advisor was not looking - not that the data was safe.
--   2. PostgREST serves miraj all the same (the app reaches it over the Data
--      API with the schema header; a request with Accept-Profile: miraj
--      returns rows), so with RLS off the anon key - a key designed to be handed
--      to browsers - could read, edit and delete every row.
--
-- Enabling RLS with NO policies denies anon and authenticated everything, which
-- is exactly right here: this app has no browser-side database access to
-- preserve. src/lib/supabase.ts is server-only and authenticates with the
-- service-role SUPABASE_SECRET_KEY, which carries BYPASSRLS, so every server
-- query keeps working untouched - the sync routes and scripts/*.mjs included.
-- If a table ever does need direct client reads, add a policy for it then;
-- until a policy exists the table is simply closed.
--
-- Covers public too. It looks empty on this project (a request for public.orders
-- returns nothing), but this codebase was forked from Laundor and several early
-- migrations still carry unqualified or laundor-qualified creates, so anything
-- that did land in public gets closed rather than left behind. A loop, not a
-- hand-listed set, for the same reason: the catalog is the only reliable record
-- of what actually exists here.
do $$
declare
  t record;
begin
  for t in
    select schemaname, tablename
    from pg_tables
    where schemaname in ('public', 'public')
    order by schemaname, tablename
  loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
    raise notice 'RLS enabled on %.%', t.schemaname, t.tablename;
  end loop;
end
$$;

-- Verification - every row should read rowsecurity = true:
--   select schemaname, tablename, rowsecurity from pg_tables
--   where schemaname in ('public', 'public') order by schemaname, tablename;
