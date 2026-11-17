-- ---------------------------------------------------------------------------
-- A dealer's own settings, reachable by a dealer's own login.
--
-- The dealer dashboard gained a Settings page (fifty-settings.html, behind
-- the gear at the foot of fifty-template-dealer.html): their wording, their
-- logo and colours, their CRM key, their referral playbook. Two of those
-- were already possible, but only from 50.'s side of the house -- a platform
-- admin editing a dealer's branding through /api/rep-dealers/:tenantId/brand
-- -- which made every "change 'shed' to 'garage' on my invite email" a
-- message to Joseph and an evening of his time.
--
-- This migration is the one thing that could not be done in application code:
-- the API-key screen was admin-only in RLS as well as in the route, and the
-- route's half has already moved (routes/tenantSettings.js's
-- requireStaffCtx). Without this, a salesperson opening Connect your CRM sees
-- an empty list and a key they create vanishes from it -- the policy, not the
-- route, is what hides it.
--
-- Why the admin requirement goes rather than gets a second role beside it:
-- `role` on users exists for 50.'s side of this product, not the dealer's.
-- Every dealer login 50. has ever created is made by routes/reps.js, which
-- always creates an admin, and the ones that are not are salespeople at a
-- company with no "admin" in any sense the company would recognise. An
-- admin-only settings screen is therefore a settings screen almost no dealer
-- can open. There is no separation to preserve here, so none is invented.
--
-- What this does NOT widen. The tenant is still the wall: every policy below
-- keeps `tenant_id = current_tenant_id()`, so a login still cannot see or
-- touch another company's keys, and PostgREST -- which accepts the same login
-- token the dealer page holds -- is bounded by exactly these policies.
-- Nothing here grants insert on api_keys (creation still runs through
-- withServiceRole after the route has resolved who is asking), nothing here
-- exposes key_hash (no policy ever did), and nothing here touches the tenants
-- table: branding is written by the service role on a tenant id resolved from
-- the caller's own login, precisely so that `authenticated` keeps no UPDATE
-- on tenants and the activation-gate migration's reasoning stands untouched.
--
-- What a key can do is the measure of the risk, and it has not changed: one
-- endpoint on one tenant, add a customer and send that customer their own
-- referral link. Its holder could already do that by hand on the dashboard.
-- ---------------------------------------------------------------------------
begin;

-- Listing keys. Same rows as before minus the is_admin() clause.
drop policy if exists api_keys_select_own_tenant_admin on api_keys;
create policy api_keys_select_own_tenant on api_keys
  for select to authenticated
  using (tenant_id = current_tenant_id());

-- Revoking is an update of revoked_at. Still no delete policy at all: a key
-- that has been used stays in the table, revoked, rather than vanishing.
drop policy if exists api_keys_update_own_tenant_admin on api_keys;
create policy api_keys_update_own_tenant on api_keys
  for update to authenticated
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

comment on table api_keys is
  'One row per CRM integration key. Readable and revocable by any login on the owning tenant (see 20261117000000_dealer_settings_any_login) -- created only through the service role, and key_hash is never exposed to a signed-in person by any policy.';

commit;
