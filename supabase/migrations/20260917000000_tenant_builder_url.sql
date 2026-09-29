begin;

-- Extends the documented shape of tenants.branding (see
-- 20260916000000_tenant_branding_shape.sql) with one more optional key:
-- builderUrl — a tenant's own 3D builder tool URL, shown as a "Design
-- Your Own Building" button on the referred-friend confirmation state
-- (fifty-template-lead.html) once they've submitted the lead form. Null
-- or missing (the common case today) means no button at all, not a
-- broken link — a tenant with no builder tool simply doesn't get one.
--
-- No schema change: the column, its CHECK, and the RLS/grants around it
-- all already exist and already accept arbitrary keys inside the jsonb
-- object (there is no key allowlist, only "is this an object at all").
-- This migration only refreshes the COMMENT so the documented shape
-- matches what the API/frontend now actually read — the same
-- "COMMENT ON is live schema metadata, always safe to refresh" pattern
-- already used for the dealer->staff rename.
--
-- Already returned end to end with zero new backend code: GET
-- /api/links/:code (routes/public.js) already selects the whole
-- tenants.branding column as tenant.branding, unfiltered by key — so
-- adding builderUrl here is purely a data change plus documentation,
-- not a new API field to wire up.
comment on column tenants.branding is 'Per-tenant look (and, as of builderUrl, one integration link) for the staff/admin dashboard and public share/lead pages: {primaryColor, primaryDark, secondary, accentColor, accentDark, bg, logoUrl, builderUrl}, every key optional. Missing keys fall back to the platform''s own neutral default where one exists (see fifty-template-dealer.html''s DEFAULT_BRANDING), or simply mean "this feature is off" where none does (builderUrl: no button shown at all). Read by GET /api/me (src/routes/me.js) as tenant_branding for the staff page, and by the public GET /api/links/:code (src/routes/public.js) as tenant.branding for the customer/lead pages — same column, same shape, two different callers depending on whether the reader is signed in.';

commit;
