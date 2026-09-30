begin;

-- Referred friends now give their ZIP code on the lead page, so staff can
-- confirm the job is inside the business's service area before calling.
-- Stored on the referral, shown in the staff list, and included in the
-- new-lead email.
--
-- p_zip_code is added LAST and with a default, so the old 5-argument call
-- (an API deploy still running the previous code) keeps working against
-- this new function. Run this migration BEFORE deploying the API change.
alter table referrals add column zip_code text;

comment on column referrals.zip_code is 'ZIP code the referred friend entered on the lead page (US 5-digit or ZIP+4). Null for referrals submitted before this was collected.';

drop function submit_referral(text, text, text, text, text);

create function submit_referral(
  p_code text,
  p_name text,
  p_email text,
  p_phone text,
  p_message text,
  p_zip_code text default null
)
returns table (
  id uuid,
  submitted_at timestamptz,
  staff_email text,
  staff_name text,
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
  v_staff_email text;
  v_staff_name text;
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
  -- staff member directly — there's no one to notify in that case, and
  -- the caller (the API route) treats a null staff_email as "nothing to
  -- send," not an error.
  select u.email, u.name into v_staff_email, v_staff_name
    from users u where u.id = v_referrer.created_by_user_id;

  -- Every admin on this tenant, not a fixed address — array_agg over
  -- zero rows returns null, which the API route treats as "no admins to
  -- copy," the same way it already treats a null staff_email.
  select array_agg(u.email) into v_admin_emails
    from users u where u.tenant_id = v_link.tenant_id and u.role = 'admin';

  select * into v_tenant from tenants where tenants.id = v_link.tenant_id;

  return query
    with inserted as (
      insert into referrals (tenant_id, referral_link_id, name, email, phone, message, zip_code)
      values (v_link.tenant_id, v_link.id, p_name, p_email, nullif(p_phone, ''), nullif(p_message, ''), nullif(trim(coalesce(p_zip_code, '')), ''))
      returning referrals.id, referrals.submitted_at
    )
    select
      inserted.id, inserted.submitted_at,
      v_staff_email, v_staff_name, v_admin_emails, v_referrer.name, v_tenant.name,
      v_tenant.send_domain_verified, v_tenant.send_from_address, v_tenant.send_from_name
    from inserted;
end;
$$;

grant execute on function submit_referral(text, text, text, text, text, text) to anon, authenticated;

commit;
