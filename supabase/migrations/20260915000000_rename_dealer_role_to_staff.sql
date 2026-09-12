begin;

-- Renames the non-admin staff role from 'dealer' to 'staff' — this
-- platform now serves any kind of business (gutters, pole barns,
-- landscaping, plumbing...), not just shed dealers, and 'dealer' as a
-- role name baked that original narrow framing into something a login
-- screen and every admin-vs-staff check actually depends on. Confirmed
-- before writing this migration that 'dealer' as a *role value* is
-- referenced in exactly one piece of executable logic in the entire
-- schema — this CHECK constraint itself — everywhere else (every RLS
-- policy, every API route) already only ever compares against 'admin' or
-- calls is_admin(), treating "not admin" as the other role generically
-- rather than literally comparing against 'dealer'. That's what makes
-- this rename mechanically simple even though it touches a live enum
-- value: one constraint, one data backfill, and then a sweep of
-- documentation/comments/API-side field names that used 'dealer' as
-- prose, not logic.
--
-- Old migration files that mention 'dealer' (init_schema.sql,
-- rls_policies.sql, referrals_dealer_scope.sql, and this project's own
-- migration filenames) are left exactly as they were written —
-- migrations are an immutable historical record of what was true when
-- they ran, not living documentation. supabase/README.md and
-- api/README.md are the living documentation, and are updated
-- separately, in the same change as this migration.
alter table users drop constraint users_role_check;

update users set role = 'staff' where role = 'dealer';

alter table users
  add constraint users_role_check check (role in ('admin', 'staff'));

comment on column users.role is '''admin'' or ''staff'' — staff was named ''dealer'' before this platform served any kind of business, not just shed dealers (see this migration). Nothing in RLS or the API ever compares against the literal string ''staff''/''dealer'' directly except this CHECK — every other check is role = ''admin'' or is_admin(), treating the other role generically.';

-- Refreshes two comments from older, already-merged migrations that
-- described the old role name directly — COMMENT ON replaces in place,
-- so this is the one part of "old migrations stay as written" that's
-- meant to actually change: a comment is live schema metadata someone
-- might read today (\d+, pg_description), not a historical narration of
-- what a past migration did.
comment on policy referrals_select_own_or_admin on referrals is
  'Staff see only referrals from customers they personally invited; admins see every referral in their tenant.';

comment on column customers.created_by_user_id is 'Null when this customer was auto-created from a converted referral rather than entered by a staff member.';

-- submit_referral() returns dealer_email/dealer_name — actual column
-- names in its RETURNS TABLE, not just prose, read directly by
-- routes/public.js. CREATE OR REPLACE can't change return columns (same
-- restriction the original dealer-notification migration hit), so this
-- is a drop + recreate, identical in every other respect to the version
-- in 20260910000000_persistent_share_links.sql — self-referral check,
-- persistent (non-single-use) share links, all unchanged.
drop function submit_referral(text, text, text, text, text);

create function submit_referral(
  p_code text,
  p_name text,
  p_email text,
  p_phone text,
  p_message text
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
      insert into referrals (tenant_id, referral_link_id, name, email, phone, message)
      values (v_link.tenant_id, v_link.id, p_name, p_email, nullif(p_phone, ''), nullif(p_message, ''))
      returning referrals.id, referrals.submitted_at
    )
    select
      inserted.id, inserted.submitted_at,
      v_staff_email, v_staff_name, v_admin_emails, v_referrer.name, v_tenant.name,
      v_tenant.send_domain_verified, v_tenant.send_from_address, v_tenant.send_from_name
    from inserted;
end;
$$;

grant execute on function submit_referral(text, text, text, text, text) to anon, authenticated;

commit;
