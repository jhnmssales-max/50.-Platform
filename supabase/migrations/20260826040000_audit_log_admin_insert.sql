-- Lets an admin write their own tenant's audit_log rows.
--
-- The original RLS migration only granted audit_log SELECT to
-- authenticated, on the assumption every write would come from a
-- service-role connection later (the payout job). PATCH
-- /api/referrals/:id/status logs each status change as the authenticated
-- admin who made it, not a separate service-role connection — the same
-- "the database enforces it, not the API" pattern used everywhere else in
-- this schema — so it needs its own narrow insert policy rather than
-- reaching for a bypass role. Every other write to audit_log is still
-- expected to be system-generated once the payout job exists.

grant insert on audit_log to authenticated;

create policy audit_log_insert_admin on audit_log
  for insert to authenticated
  with check (tenant_id = current_tenant_id() and is_admin());
