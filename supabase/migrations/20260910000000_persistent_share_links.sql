-- Makes a customer's share link persistent and reusable, instead of a
-- new one-time link minted per click:
--
--   1. Drops the unique constraint on referrals.referral_link_id — it
--      existed specifically to make "one link, one referral" a hard
--      database guarantee. That guarantee is exactly what's being
--      removed: one share link should now back as many independent
--      referrals as different friends submit against it.
--   2. create_share_link() becomes idempotent per customer: if the
--      customer already has a share-kind link, return it instead of
--      minting a new one. Same OUT columns, so CREATE OR REPLACE is
--      enough — unlike submit_referral() below, this one's shape never
--      needed to change historically either.
--   3. submit_referral() drops the "already used" lockout (the whole
--      reason for the unique constraint above) and gains a self-referral
--      check: a friend whose submitted email or phone matches the
--      link's own customer record is rejected, so the persistent code
--      can't be used to pay the referrer their own reward.
--
-- Return columns for submit_referral() are unchanged from the last
-- migration, so CREATE OR REPLACE works here too — no drop needed.

alter table referrals drop constraint referrals_referral_link_id_key;
create index referrals_referral_link_id_idx on referrals (referral_link_id);

comment on table referrals is 'One row per friend who submits against a share link — no longer 1:1 with referral_links (that unique constraint is gone as of this migration): a persistent share link can back any number of independent referrals, each with its own payout status.';

-- ---------------------------------------------------------------------------
-- create_share_link — now idempotent per customer. p_code is still any
-- existing link that identifies the customer (their invite link, or their
-- own share link if they're a referred-friend-turned-customer); the new
-- code is only actually used the first time, when there isn't already one.
-- ---------------------------------------------------------------------------
create or replace function create_share_link(p_code text, p_new_code text)
returns table (
  code text,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link referral_links%rowtype;
  v_existing referral_links%rowtype;
begin
  select * into v_link from referral_links where referral_links.code = p_code;
  if not found then
    raise exception 'link_not_found' using errcode = 'P0002';
  end if;

  if v_link.status <> 'active' or (v_link.expires_at is not null and v_link.expires_at < now()) then
    raise exception 'link_not_active' using errcode = 'P0002';
  end if;

  -- One persistent code per customer, forever: if they already have a
  -- share-kind link, hand back that same row instead of minting another.
  -- order by created_at asc + limit 1 keeps this deterministic even if
  -- more than one somehow already exists from before this migration.
  select * into v_existing
    from referral_links
    where referral_links.customer_id = v_link.customer_id and referral_links.kind = 'share'
    order by referral_links.created_at asc
    limit 1;

  if found then
    return query
      select v_existing.code, v_existing.status, v_existing.created_at;
    return;
  end if;

  return query
    insert into referral_links (tenant_id, code, kind, customer_id, parent_link_id)
    values (v_link.tenant_id, p_new_code, 'share', v_link.customer_id, v_link.id)
    returning referral_links.code, referral_links.status, referral_links.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_referral — the "already used" lockout is gone (a share link can
-- now back any number of independent referrals); a self-referral check
-- takes its place as the thing standing between a customer and paying
-- themselves through their own permanent link. Matches on email
-- (case-insensitive) or phone (digits only, so formatting never matters),
-- and only compares phone when both sides actually have one on file.
-- ---------------------------------------------------------------------------
create or replace function submit_referral(
  p_code text,
  p_name text,
  p_email text,
  p_phone text,
  p_message text
)
returns table (
  id uuid,
  submitted_at timestamptz,
  dealer_email text,
  dealer_name text,
  admin_emails text[],
  referrer_name text,
  tenant_name text,
  tenant_send_domain_verified boolean,
  tenant_send_from_address text,
  tenant_send_from_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link referral_links%rowtype;
  v_referrer customers%rowtype;
  v_dealer_email text;
  v_dealer_name text;
  v_admin_emails text[];
  v_tenant tenants%rowtype;
  v_phone_digits text;
  v_referrer_phone_digits text;
begin
  select * into v_link from referral_links where code = p_code and kind = 'share';
  if not found or v_link.status <> 'active'
     or (v_link.expires_at is not null and v_link.expires_at < now())
  then
    raise exception 'link_not_found' using errcode = 'P0002';
  end if;

  select * into v_referrer from customers where customers.id = v_link.customer_id;

  v_phone_digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_referrer_phone_digits := regexp_replace(coalesce(v_referrer.phone, ''), '\D', '', 'g');

  if lower(trim(p_email)) = lower(trim(coalesce(v_referrer.email, '')))
     or (v_phone_digits <> '' and v_phone_digits = v_referrer_phone_digits)
  then
    raise exception 'self_referral' using errcode = 'P0003';
  end if;

  -- created_by_user_id is null for a customer who was themselves
  -- auto-created from a converted referral rather than entered by a
  -- dealer directly — there's no dealer to notify in that case, and the
  -- caller (the API route) treats a null dealer_email as "nothing to
  -- send," not an error.
  select u.email, u.name into v_dealer_email, v_dealer_name
    from users u where u.id = v_referrer.created_by_user_id;

  -- Every admin on this tenant, not a fixed address — array_agg over
  -- zero rows returns null, which the API route treats as "no admins to
  -- copy," the same way it already treats a null dealer_email.
  select array_agg(u.email) into v_admin_emails
    from users u where u.tenant_id = v_link.tenant_id and u.role = 'admin';

  select * into v_tenant from tenants where tenants.id = v_link.tenant_id;

  return query
    with inserted as (
      insert into referrals (tenant_id, referral_link_id, name, email, phone, message)
      values (v_link.tenant_id, v_link.id, p_name, p_email, nullif(p_phone, ''), nullif(p_message, ''))
      returning referrals.id, referrals.submitted_at
    )
    select
      inserted.id, inserted.submitted_at,
      v_dealer_email, v_dealer_name, v_admin_emails, v_referrer.name, v_tenant.name,
      v_tenant.send_domain_verified, v_tenant.send_from_address, v_tenant.send_from_name
    from inserted;
end;
$$;
