-- Extends submit_referral() to also return what's needed to notify the
-- dealer who should follow up on a new lead — the dealer who originally
-- invited the customer that shared this link, not a fixed address, since
-- that's the person who actually owns the relationship. anon has no
-- table access at all (see rls_policies migration), so this data can
-- only come back through the same narrow, security-definer function that
-- already does the insert — not a separate query from the API, which
-- would have nothing to run it as.
--
-- CREATE OR REPLACE can't change a function's return columns, so this
-- drops and recreates it (and its grant, which a drop also removes).

drop function submit_referral(text, text, text, text, text);

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
  v_tenant tenants%rowtype;
begin
  select * into v_link from referral_links where code = p_code and kind = 'share';
  if not found then
    raise exception 'link_not_found' using errcode = 'P0002';
  end if;

  if v_link.status <> 'active' or (v_link.expires_at is not null and v_link.expires_at < now()) then
    raise exception 'link_already_used' using errcode = 'P0003';
  end if;

  select * into v_referrer from customers where customers.id = v_link.customer_id;

  -- created_by_user_id is null for a customer who was themselves
  -- auto-created from a converted referral rather than entered by a
  -- dealer directly — there's no dealer to notify in that case, and the
  -- caller (the API route) treats a null dealer_email as "nothing to
  -- send," not an error.
  select u.email, u.name into v_dealer_email, v_dealer_name
    from users u where u.id = v_referrer.created_by_user_id;

  select * into v_tenant from tenants where tenants.id = v_link.tenant_id;

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
    select
      inserted.id, inserted.submitted_at,
      v_dealer_email, v_dealer_name, v_referrer.name, v_tenant.name,
      v_tenant.send_domain_verified, v_tenant.send_from_address, v_tenant.send_from_name
    from inserted, touched;
end;
$$;

grant execute on function submit_referral(text, text, text, text, text) to anon, authenticated;
