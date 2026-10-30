-- Which dealers may appear on referwith50.com.
--
-- The marketing site is getting a strip of dealer logos at the bottom, drawn
-- from this platform rather than hand-maintained. That means the platform is
-- now deciding, on its own, which companies get named in public -- so the
-- default has to be "no".
--
-- A dealer bought a referral program. They did not necessarily agree to be a
-- public reference, and some will not want competitors seeing they use one.
-- Being listed is a thing to be asked for and granted, not assumed, so this
-- defaults to false for every company including the ones already live.
-- Joseph turns it on per dealer once they have said yes.
--
-- Nothing is backfilled. The strip is empty until somebody is switched on,
-- which is the correct starting state for a list of people who have consented.
begin;

alter table tenants
  add column list_on_website boolean not null default false;

comment on column tenants.list_on_website is
  'May this company''s name, logo and colour be shown publicly in the dealer strip on referwith50.com? Defaults to false for everyone: buying the platform is not consent to be a public reference. Set true per dealer only once they have agreed. Read by the unauthenticated GET /api/public/dealers, which also requires activation_paid_at is not null and closed_at is null.';

commit;

-- ---------------------------------------------------------------------------
-- The public read.
--
-- Same shape as resolve_link and the other public functions: security definer,
-- pinned search_path, granted to anon. The marketing site is a static page on
-- another domain with no session, so it cannot read `tenants` directly and
-- should not be able to. This function is the only thing it can see, and it
-- returns three fields and nothing else -- no slug, no id, no fee, no counts,
-- nothing that says how much anybody pays.
--
-- Three conditions, all required:
--   list_on_website  -- they said yes
--   activation_paid_at is not null  -- they actually joined; a half-built
--                                      account is not a customer
--   closed_at is null  -- still with us; a company that left stops appearing
--                         on the morning it leaves, with no action by anyone
-- ---------------------------------------------------------------------------
begin;

create or replace function public_dealer_logos()
returns table (
  name text,
  logo_url text,
  color text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    t.name,
    nullif(t.branding ->> 'logoUrl', '')      as logo_url,
    nullif(t.branding ->> 'primaryColor', '') as color
  from tenants t
  where t.list_on_website
    and t.activation_paid_at is not null
    and t.closed_at is null
  order by t.activation_paid_at;
$$;

comment on function public_dealer_logos() is
  'The dealer strip on referwith50.com. Unauthenticated, via GET /api/public/dealers. Returns only name, logo URL and brand colour, for companies that have list_on_website set, have paid their activation, and are not closed. Deliberately exposes nothing about money or volume.';

grant execute on function public_dealer_logos() to anon, authenticated;

commit;
