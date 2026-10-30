-- Which dealers may appear on referwith50.com.
--
-- The marketing site has a strip of dealer logos at the bottom, drawn from
-- this platform rather than hand-maintained. That means the platform is now
-- deciding, on its own, which companies get named in public -- so the default
-- has to be "no".
--
-- A dealer bought a referral program. They did not necessarily agree to be a
-- public reference, and some will not want competitors seeing they use one.
-- Being listed is a thing to be asked for and granted, not assumed, so this
-- defaults to false for every company including the ones already live.
-- Joseph turns it on per dealer once they have said yes.
--
-- Nothing is backfilled. The strip is empty until somebody is switched on,
-- which is the correct starting state for a list of people who have consented.
--
-- Written to be safe to run twice: `if not exists` on the column and
-- `create or replace` on the function, so re-running it after a partial or
-- earlier application changes nothing and fails nothing.
begin;

alter table tenants
  add column if not exists list_on_website boolean not null default false;

comment on column tenants.list_on_website is
  'May this company''s name, logo and colour be shown publicly in the dealer strip on referwith50.com? Defaults to false for everyone: buying the platform is not consent to be a public reference. Set true per dealer only once they have agreed. Read by the unauthenticated GET /api/public/dealers.';

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
-- WHO COUNTS AS A LIVE DEALER
--
-- Not "has paid". Good Steward Structures, North Mountain Structures and 50.
-- itself are permanently billing_exempt (billing_required = false, see
-- 20261001000000_activation_gate_and_referral_fee.sql), so their
-- activation_paid_at is null forever. A plain "activation_paid_at is not null"
-- test would silently exclude the two companies most likely to go on the site
-- first, and nothing would explain why switching them on did nothing.
--
-- So: either they paid, or they were never required to. Plus closed_at is
-- null, so a company that leaves drops off the morning it leaves with nobody
-- having to remember.
--
-- THE LOGO MUST BE AN ABSOLUTE https URL
--
-- Some tenants carry a relative path left from before the brand editor
-- validated this (Silver Run's is 'assets/silver-run-logo.png'). A relative
-- path resolves against whatever page renders it, so on referwith50.com it
-- points at a file that does not exist and draws a broken image on the sales
-- page. Anything that is not absolute https is returned as null here, and the
-- site skips it -- the same rule inviteEmail.js already applies.
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
    case
      when t.branding ->> 'logoUrl' ~* '^https://[^[:space:]"''<>]+$'
        then t.branding ->> 'logoUrl'
      else null
    end                                       as logo_url,
    nullif(t.branding ->> 'primaryColor', '') as color
  from tenants t
  where t.list_on_website
    and (t.activation_paid_at is not null or not t.billing_required)
    and t.closed_at is null
  order by coalesce(t.activation_paid_at, t.created_at);
$$;

comment on function public_dealer_logos() is
  'The dealer strip on referwith50.com. Unauthenticated, via GET /api/public/dealers. Returns only name, logo URL and brand colour, for companies that have list_on_website set, are either paid or permanently billing-exempt, and are not closed. A logo that is not an absolute https URL comes back null and is skipped. Deliberately exposes nothing about money or volume.';

grant execute on function public_dealer_logos() to anon, authenticated;

commit;
