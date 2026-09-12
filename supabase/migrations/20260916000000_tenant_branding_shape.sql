begin;

-- Gives tenants.branding (init_schema.sql — always existed, but never
-- given a defined shape or a reader) an actual, documented shape and
-- wires it into GET /api/me, so the staff/admin dashboard page
-- (fifty-template-dealer.html) can render each tenant's own colors and
-- logo after sign-in instead of one tenant's branding being hardcoded
-- into that file. No new column: this is exactly the "if it isn't
-- already" case — the column already existed, just unused.
--
-- Shape (a jsonb object; every key optional, missing keys mean "use the
-- platform's own neutral default" — enforced client-side in
-- fifty-template-dealer.html, not here, so a tenant can set only
-- primaryColor/accentColor/logoUrl and still get a coherent look):
--   primaryColor  text  -- main brand color (buttons, headings)
--   primaryDark   text  -- hover/active shade of primaryColor
--   secondary     text  -- lighter accent, used sparingly (e.g. "paid" state)
--   accentColor   text  -- secondary brand color (tags, links, dashed borders)
--   accentDark    text  -- hover/active shade of accentColor
--   bg            text  -- card background
--   logoUrl       text  -- absolute or root-relative URL to this tenant's logo
--
-- All hex colors or URLs, deliberately unconstrained by a CHECK beyond
-- "is a JSON object" — validating hex-color syntax belongs to whatever
-- UI eventually lets a tenant set their own branding (not built yet),
-- not to this column.
comment on column tenants.branding is 'Per-tenant look for the staff/admin dashboard and public share/lead pages: {primaryColor, primaryDark, secondary, accentColor, accentDark, bg, logoUrl}, every key optional. Missing keys fall back to the platform''s own neutral default (see fifty-template-dealer.html''s DEFAULT_BRANDING). Read by GET /api/me (src/routes/me.js) as tenant_branding, and already returned to the public link-resolve endpoint as tenant.branding (src/routes/public.js) — this migration only documents/constrains the shape, it does not change either route''s existing behavior.';

-- Fail loudly rather than silently store something GET /api/me and the
-- dashboard page can't use: the column's own default ('{}'::jsonb) and
-- every existing row already satisfy this, so this is a pure guard
-- against a future bad write (e.g. branding set to a JSON array or a
-- bare string), not a data change.
alter table tenants
  add constraint tenants_branding_is_object check (jsonb_typeof(branding) = 'object');

commit;
