-- Test-only. Recreates the parts of a Supabase project the migrations in
-- supabase/migrations/ depend on but don't create themselves, so the full
-- chain can be applied to a plain, throwaway Postgres 16 database:
--
--   - the anon/authenticated roles (cluster-wide; created only if missing)
--   - auth.users and auth.uid(), reading the same request.jwt.claim(s)
--     settings src/db.js's withUserTransaction sets per request
--   - Supabase's default privileges: every new table in public is
--     granted ALL to anon and authenticated, so Row-Level Security — not
--     table grants — is the barrier, exactly as on a real Supabase
--     project. (Plain Postgres would deny at the grant level first, which
--     would hide any RLS gap rather than test it.)
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

alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
