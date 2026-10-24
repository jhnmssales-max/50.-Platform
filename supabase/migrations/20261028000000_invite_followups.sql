-- Wrapped in one explicit transaction, like the billing migrations: either
-- all of it lands or none of it does.
--
-- APPLY THIS BEFORE DEPLOYING THE API CODE THAT READS IT. Since
-- lib/schemaCheck.js, the API now refuses to start rather than failing one
-- route at a time -- so deploying first takes the service down loudly
-- instead of quietly, which is the improvement, not a licence to skip this.
begin;

-- ---------------------------------------------------------------------------
-- Inviting the same customer again, later.
--
-- A customer is invited once, when their dealer adds them, and that is the
-- only time they ever hear about their link. Someone who meant to share it
-- and forgot never hears again. This is the nudge: the same link, sent back
-- to them on a schedule the dealer chooses.
--
-- Per dealer, because the right interval is a matter of what they sell. A
-- shed is bought once a decade and a roof once in twenty years; a lawn-care
-- company could reasonably ask every quarter.
--
-- Null means off, and off is the default, so no dealer already on the
-- platform starts sending anything because this shipped.
-- ---------------------------------------------------------------------------
alter table tenants add column invite_followup_months smallint
  check (invite_followup_months in (3, 6, 9, 12));

comment on column tenants.invite_followup_months is
  'How often, in months, to send an invited customer their referral link again. Null (the default) is off, and nothing is sent. 3, 6, 9 or 12. At most three follow-ups ever go out per customer -- see invite_followups -- so 3 means a year of nudges and 12 means three years. Set by a 50. platform admin on the company''s Pricing screen.';

-- ---------------------------------------------------------------------------
-- Not hearing from a dealer again.
--
-- Until now no referral email carried an unsubscribe link, which is
-- defensible for a single thank-you after someone buys and is not for a
-- reminder that arrives every quarter. One per customer row, and a customer
-- row belongs to one tenant -- so unsubscribing from the shed company a
-- person bought from has no effect on the roofer they also bought from,
-- which is the behaviour someone would expect.
--
-- The token is the whole credential: it is in a link in an email, so it is
-- random, unique and never derived from anything guessable like an id or an
-- address. Honouring it needs no login, because asking someone to sign in
-- before they can stop being emailed is not an unsubscribe.
-- ---------------------------------------------------------------------------
-- Lets invite_followups point at (customer, tenant) as a pair, so a row can
-- never claim a customer belongs to a company they do not. id is already the
-- primary key, so this costs one small index and rules the mismatch out by
-- construction rather than by the worker being careful.
alter table customers add constraint customers_id_tenant_key unique (id, tenant_id);

alter table customers add column unsubscribed_at timestamptz;
alter table customers add column unsubscribe_token text unique;

comment on column customers.unsubscribed_at is
  'When this customer asked their dealer to stop emailing them about referrals. Non-null means no referral email of any kind is ever sent to them again by this tenant -- the first invite included, not only the follow-ups. Scoped to this customers row, so it says nothing about any other business they may also have bought from.';
comment on column customers.unsubscribe_token is
  'The random, unguessable credential in the unsubscribe link. Minted when a referral email is first sent to this customer and reused for every later one, so an old email still works. Never derived from the customer id or address.';

-- No index needed for the lookup: `unique` on unsubscribe_token already
-- built one, and a partial copy of it would be a second index to maintain
-- for a query the first one already answers.

-- ---------------------------------------------------------------------------
-- One row per follow-up actually sent, which is the whole "has this gone
-- out?" record -- the same claim pattern as billing_emails, for the same
-- reason: two overlapping worker runs, or two servers, must never both send
-- the same person the same reminder.
--
-- `sequence` is which nudge this is, 1 to 3. Unique per customer, so the
-- third is the last however long the dealer keeps the setting on, and
-- changing the interval later never re-sends one that has already gone.
-- ---------------------------------------------------------------------------
-- Both references cascade, and that is not a detail. remove_company deletes
-- a company that never traded by deleting its customers and then the tenant
-- itself. A plain reference here would make the database refuse both the
-- moment one follow-up had ever been sent, and the Reps page would show its
-- generic failure with nothing saying why -- the same shape of bug the
-- fix_removal_constraints migration was written for. A reminder is worth
-- nothing once the company it belonged to is gone, so it goes with it.
--
-- The customer reference is a pair, (customer_id, tenant_id), so a row can
-- never say a customer belongs to a company they do not.
create table invite_followups (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  customer_id  uuid not null,
  sequence     smallint not null check (sequence between 1 and 3),
  claimed_at   timestamptz not null default now(),
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  constraint invite_followups_one_per_sequence unique (customer_id, sequence),
  constraint invite_followups_customer foreign key (customer_id, tenant_id)
    references customers (id, tenant_id) on delete cascade
);

create index invite_followups_tenant_idx on invite_followups (tenant_id);

comment on table invite_followups is
  'One row per follow-up invite claimed for a customer. A sender inserts the claim, sends, then stamps sent_at; a failed send deletes the claim so the next hourly cycle retries, and a claim left unsent for 15 minutes may be re-claimed by anyone. At most three rows per customer, enforced by the sequence CHECK and the unique constraint together. Deliberately holds no copy of the address it went to: remove_company scrubs a closed company''s customer emails, and a second copy here would survive that cleanup for no benefit -- which customer and which of their three sends is the whole record worth keeping.';

-- RLS on, service role only: nothing a signed-in dealer does touches this
-- table -- the worker writes it and nobody reads it from a page.
alter table invite_followups enable row level security;

-- ---------------------------------------------------------------------------
-- Honouring the link, without a login and without giving anon the table.
--
-- anon has no table access anywhere in this schema -- the public pages reach
-- the database only through narrow security definer functions
-- (resolve_link, create_share_link, submit_referral). Unsubscribing is the
-- same shape of problem: a stranger holding a token, and nothing else, needs
-- to do exactly one thing. So it gets the same treatment rather than an
-- exception, and rather than the API reaching for the service role on a
-- public route.
--
-- Each takes the token and nothing else, and neither reveals whether a token
-- it does not recognise ever existed: both return no rows, and the page says
-- the same thing either way. Telling a stranger which tokens are real would
-- turn this into a way to confirm that an address is on a dealer's list.
-- ---------------------------------------------------------------------------
create or replace function unsubscribe_lookup(p_token text)
returns table (tenant_name text, already boolean)
language sql
security definer
set search_path = public
as $$
  select t.name, c.unsubscribed_at is not null
    from customers c join tenants t on t.id = c.tenant_id
   where c.unsubscribe_token = p_token;
$$;

-- Idempotent: a second click keeps the original timestamp rather than moving
-- it, so the record says when they actually asked.
create or replace function unsubscribe_confirm(p_token text)
returns table (tenant_name text)
language sql
security definer
set search_path = public
as $$
  with done as (
    update customers
       set unsubscribed_at = coalesce(unsubscribed_at, now())
     where unsubscribe_token = p_token
     returning tenant_id
  )
  select t.name from done join tenants t on t.id = done.tenant_id;
$$;

revoke all on function unsubscribe_lookup(text) from public;
revoke all on function unsubscribe_confirm(text) from public;
grant execute on function unsubscribe_lookup(text) to anon, authenticated;
grant execute on function unsubscribe_confirm(text) to anon, authenticated;

comment on function unsubscribe_lookup(text) is
  'What the unsubscribe page shows: whose emails these are, and whether this person has already stopped them. Security definer because anon has no access to customers, by design. Returns no rows for a token that does not exist, which the page renders identically to one that does -- a stranger must not be able to use it to confirm an address is on a list.';
comment on function unsubscribe_confirm(text) is
  'Stops every referral email to this customer from this tenant. Security definer, for the same reason as unsubscribe_lookup. Idempotent: a repeat keeps the original unsubscribed_at.';

commit;
