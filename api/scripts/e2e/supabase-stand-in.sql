-- Test-only. Recreates the parts of a Supabase project the migrations in
-- supabase/migrations/ depend on but don't create themselves, so the full
-- chain can be applied to a plain, throwaway Postgres 16 database:
--
--   - the anon/authenticated roles (cluster-wide; created only if missing)
--   - auth.users and auth.uid(), reading the same request.jwt.claim(s)
--     settings src/db.js's withUserTransaction sets per request
--   - Supabase's default privileges on sequences and functions.
--
-- What it deliberately does NOT do any more is grant new TABLES to anon
-- and authenticated. It used to, so that Row-Level Security rather than
-- table grants was the barrier, matching a real Supabase project. From
-- 30 October 2026 Supabase stops granting new tables in public
-- automatically, and every table needs its own GRANT in the migration
-- that creates it.
--
-- Keeping the old behaviour here would have made this harness the one
-- place the new rule did not apply: a new table with no grant would pass
-- every check and then fail for real users, because src/db.js runs each
-- signed-in request as `authenticated` (SET LOCAL ROLE) and so is subject
-- to table grants exactly as PostgREST is, direct connection or not.
--
-- Checked when this changed: every table the authenticated role touches
-- already carries its own grant, and the whole suite passes without the
-- line below. The two tables with no grant at all -- billing_emails and
-- rep_reminder_emails -- are written only by the hourly workers, which
-- run as the connection's own user and need none.
--
-- Run once against an empty database, before the first migration. Never
-- against a real Supabase project: it already has all of this, for real.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;

alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
