-- Row-Level Security policies for the referral platform.
--
-- Scope: RLS only — no API code, no gift card integration. This is the
-- backstop described in the backend spec's hosting section: the primary
-- data path is the Node/Express API (connecting with a privileged role
-- that bypasses RLS entirely), but if a dealer/admin session ever queries
-- Postgres directly through Supabase's authenticated client, these
-- policies are what stops one tenant from seeing another's data.
--
-- Deliberately NOT covered here: the public, unauthenticated actions
-- (a friend submitting the lead form, a customer generating a share
-- link, gift card issuance). Those have no policies for the `anon` role
-- below, so they are denied by default — by design, they are meant to
-- go through the service-role API, not a direct client connection.
--
-- Depends on the previous migration (init_schema) and on Supabase's
-- built-in `auth.uid()` and `authenticated`/`anon` roles.

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- The tenant of the currently authenticated staff user, or null if the
-- caller isn't a recognized staff member (e.g. the anon role, or an
-- auth.users row with no matching `users` row yet).
--
-- security definer + a fixed search_path so this runs as the function's
-- owner rather than the calling role — otherwise looking up `users` here
-- would itself be subject to the very policy below that calls this
-- function, which would recurse.
create or replace function current_tenant_id() returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select tenant_id from users where id = auth.uid()
$$;

comment on function current_tenant_id() is 'Tenant of the calling staff user (from users.tenant_id via auth.uid()), or null for anon/unrecognized callers. security definer to avoid recursing into the RLS policies that call it.';

-- Whether the currently authenticated user is an admin (vs. a dealer).
create or replace function is_admin() returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from users where id = auth.uid() and role = 'admin'
  )
$$;

comment on function is_admin() is 'True if the calling staff user has role = admin. security definer for the same reason as current_tenant_id().';

-- ---------------------------------------------------------------------------
-- tenants — staff can see and (if admin) edit only their own tenant row.
-- Tenant provisioning itself (creating a new row) is a platform-level
-- operation done with the service role, not exposed here.
-- ---------------------------------------------------------------------------
alter table tenants enable row level security;

grant select, update on tenants to authenticated;

create policy tenants_select_own on tenants
  for select to authenticated
  using (id = current_tenant_id());

create policy tenants_update_own_admin on tenants
  for update to authenticated
  using (id = current_tenant_id() and is_admin())
  with check (id = current_tenant_id() and is_admin());

-- ---------------------------------------------------------------------------
-- users — staff can see their tenant's own roster. Account provisioning
-- (invites, role changes) goes through the service role for now.
-- ---------------------------------------------------------------------------
alter table users enable row level security;

grant select on users to authenticated;

create policy users_select_same_tenant on users
  for select to authenticated
  using (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- customers — dealers create them (POST /api/customers in the spec) and
-- can fix their own entries; admins can fix any in the tenant.
-- ---------------------------------------------------------------------------
alter table customers enable row level security;

grant select, insert, update on customers to authenticated;

create policy customers_select_same_tenant on customers
  for select to authenticated
  using (tenant_id = current_tenant_id());

create policy customers_insert_same_tenant on customers
  for insert to authenticated
  with check (tenant_id = current_tenant_id());

create policy customers_update_own_or_admin on customers
  for update to authenticated
  using (tenant_id = current_tenant_id() and (is_admin() or created_by_user_id = auth.uid()))
  with check (tenant_id = current_tenant_id() and (is_admin() or created_by_user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- referral_links — dealers create invite links for their tenant; only
-- admins can change a link's status directly (e.g. manually expiring
-- one). The "used" transition normally happens via the public referral
-- submission, which runs under the service role.
-- ---------------------------------------------------------------------------
alter table referral_links enable row level security;

grant select, insert, update on referral_links to authenticated;

create policy referral_links_select_same_tenant on referral_links
  for select to authenticated
  using (tenant_id = current_tenant_id());

create policy referral_links_insert_same_tenant on referral_links
  for insert to authenticated
  with check (tenant_id = current_tenant_id());

create policy referral_links_update_admin on referral_links
  for update to authenticated
  using (tenant_id = current_tenant_id() and is_admin())
  with check (tenant_id = current_tenant_id() and is_admin());

-- ---------------------------------------------------------------------------
-- referrals — staff can view their tenant's referrals. Only admins can
-- change status (matches PATCH /api/referrals/:id/status being
-- admin-only in the spec, since it can trigger a payout). No insert
-- policy: a referral is only ever created by the public lead-form
-- submission, via the service role.
-- ---------------------------------------------------------------------------
alter table referrals enable row level security;

grant select, update on referrals to authenticated;

create policy referrals_select_same_tenant on referrals
  for select to authenticated
  using (tenant_id = current_tenant_id());

create policy referrals_update_admin on referrals
  for update to authenticated
  using (tenant_id = current_tenant_id() and is_admin())
  with check (tenant_id = current_tenant_id() and is_admin());

-- ---------------------------------------------------------------------------
-- gift_card_transactions — read-only ledger for staff. All writes are
-- the payout job's, under the service role.
-- ---------------------------------------------------------------------------
alter table gift_card_transactions enable row level security;

grant select on gift_card_transactions to authenticated;

create policy gift_card_transactions_select_same_tenant on gift_card_transactions
  for select to authenticated
  using (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- audit_log — admin-only read access; it's an internal trail, not a
-- dealer-facing view. All writes are system-generated, under the
-- service role.
-- ---------------------------------------------------------------------------
alter table audit_log enable row level security;

grant select on audit_log to authenticated;

create policy audit_log_select_admin on audit_log
  for select to authenticated
  using (tenant_id = current_tenant_id() and is_admin());
