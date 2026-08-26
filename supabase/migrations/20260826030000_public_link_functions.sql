-- Narrow, security-definer functions that are the *only* surface the public
-- (anon) routes are allowed to touch. Raw table access for anon stays fully
-- denied (see rls_policies migration) — even a coding mistake that skipped
-- the API layer and queried a table directly would hit that wall. These
-- functions are deliberately minimal: one job each, explicit return
-- columns (never a raw row), and no dynamic SQL.
--
-- There is no tenant/user identity for these calls to scope by — a friend
-- submitting a lead form isn't logged in. Safety instead comes from each
-- function touching only the single row matched by the caller-supplied
-- `code`, which is what the API's rate limiting and validation exist to
-- protect against being brute-forced or spammed.

-- ---------------------------------------------------------------------------
-- resolve_link — what GET /api/links/:code reads. Returns only what an
-- anonymous visitor should see: first name, never phone/email; tenant
-- branding; and an *effective* status that accounts for expiry even though
-- nothing has proactively flipped the stored status column yet.
-- ---------------------------------------------------------------------------
create or replace function resolve_link(p_code text)
returns table (
  kind text,
  status text,
  referrer_first_name text,
  tenant_name text,
  tenant_reward_amount_cents integer,
  tenant_reward_currency text,
  tenant_branding jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link referral_links%rowtype;
  v_customer_name text;
begin
  select * into v_link from referral_links where code = p_code;
  if not found then
    return; -- empty result set; caller (API) turns this into 404
  end if;

  select c.name into v_customer_name from customers c where c.id = v_link.customer_id;

  return query
    select
      v_link.kind,
      case
        when v_link.status = 'used' then 'used'
        when v_link.expires_at is not null and v_link.expires_at < now() then 'expired'
        else v_link.status
      end,
      split_part(v_customer_name, ' ', 1),
      t.name,
      t.reward_amount_cents,
      t.reward_currency,
      t.branding
    from tenants t
    where t.id = v_link.tenant_id;
end;
$$;

grant execute on function resolve_link(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_share_link — POST /api/links/:code/share. `p_code` is any
-- existing, currently-active link (an invite link a dealer sent, or a
-- share link a referred friend-turned-customer received) — its owning
-- customer becomes the referrer of the new share link, with
-- parent_link_id pointing back at it. This is what lets a referral chain
-- extend to arbitrary depth without special-casing link kinds.
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
begin
  -- referral_links.code/.status must stay qualified below: this function's
  -- OUT columns are also named code/status, and plpgsql resolves a bare
  -- reference to those as the OUT variable, not the table column.
  select * into v_link from referral_links where referral_links.code = p_code;
  if not found then
    raise exception 'link_not_found' using errcode = 'P0002';
  end if;

  if v_link.status <> 'active' or (v_link.expires_at is not null and v_link.expires_at < now()) then
    raise exception 'link_not_active' using errcode = 'P0002';
  end if;

  return query
    insert into referral_links (tenant_id, code, kind, customer_id, parent_link_id)
    values (v_link.tenant_id, p_new_code, 'share', v_link.customer_id, v_link.id)
    returning referral_links.code, referral_links.status, referral_links.created_at;
end;
$$;

grant execute on function create_share_link(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- submit_referral — POST /api/links/:code/referrals. `p_code` must be a
-- 'share' link. Creates the referral and marks the link used in one
-- transaction; the unique constraint on referrals.referral_link_id is the
-- final backstop against a double-submit race even under concurrent calls.
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
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link referral_links%rowtype;
begin
  select * into v_link from referral_links where code = p_code and kind = 'share';
  if not found then
    raise exception 'link_not_found' using errcode = 'P0002';
  end if;

  if v_link.status <> 'active' or (v_link.expires_at is not null and v_link.expires_at < now()) then
    raise exception 'link_already_used' using errcode = 'P0003';
  end if;

  -- Both writes must happen together. A CTE that's never referenced by the
  -- outer query is never executed by Postgres — so `touched` is joined into
  -- the FROM clause purely to force the update to run, even though only
  -- `inserted`'s columns are selected.
  return query
    with inserted as (
      insert into referrals (tenant_id, referral_link_id, name, email, phone, message)
      values (v_link.tenant_id, v_link.id, p_name, p_email, nullif(p_phone, ''), nullif(p_message, ''))
      returning referrals.id, referrals.submitted_at
    ),
    touched as (
      update referral_links set status = 'used', used_at = now()
      where referral_links.id = v_link.id
      returning referral_links.id
    )
    select inserted.id, inserted.submitted_at
    from inserted, touched;
end;
$$;

grant execute on function submit_referral(text, text, text, text, text) to anon, authenticated;
