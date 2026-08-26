# Database

Postgres schema for the referral platform, following the [backend spec](../) (schema + API design doc). This directory currently holds **schema only** — no API server, no gift-card integration yet.

## What's here

- `migrations/20260826000000_init_schema.sql` — creates all 7 core tables (`tenants`, `users`, `customers`, `referral_links`, `referrals`, `gift_card_transactions`, `audit_log`) with their constraints and indexes.
- `migrations/20260826020000_rls_policies.sql` — enables Row-Level Security on every table and adds the policies scoping each to the caller's own tenant, plus two helper functions (`current_tenant_id()`, `is_admin()`). Raw table access is fully denied to the `anon` role on every table — no grants at all. The API's dealer-facing routes (see [`../api/README.md`](../api/README.md)) impersonate `authenticated` per request, so these policies are what actually decides what a dealer can see or write, not application code.
- `migrations/20260826030000_public_link_functions.sql` — three narrow, `security definer` functions (`resolve_link`, `create_share_link`, `submit_referral`) that are the *only* thing the `anon` role is granted execute on. This is how the public routes (a friend submitting a lead, a customer generating a share link) work without any table-level access for anon: each function does one specific, vetted thing and returns only the columns it's meant to, rather than exposing a table.

## Running it

**Against a Supabase project** (recommended — matches the hosting plan in the spec):

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

**Against local Supabase** (`supabase start`), or **plain Postgres** for a quick check:

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260826000000_init_schema.sql
psql "$DATABASE_URL" -f supabase/migrations/20260826020000_rls_policies.sql
psql "$DATABASE_URL" -f supabase/migrations/20260826030000_public_link_functions.sql
```

Note: this depends on Supabase's own `auth` schema (`auth.users`, `auth.uid()`) and its standard `anon`/`authenticated` roles. Running against a Postgres instance with none of that (i.e. not Supabase, and not `supabase start`) will fail unless you first create stand-ins — see `auth.uid()`'s definition in the RLS migration for the shape Supabase provides.

## Verified

- The init migration: applied to a scratch Postgres 16 database and smoke-tested with happy-path inserts across the full tenant → dealer → customer → invite link → share link → referral → gift-card-transaction chain, plus confirmation that the constraints that matter reject bad data — an invalid `kind`, a missing `email`, a second referral against an already-used link, and a duplicate `idempotency_key`.
- The RLS migration: applied on top of the above with a stubbed `auth` schema and `anon`/`authenticated` roles, seeded with two tenants. Verified a dealer sees and can only write within their own tenant; a cross-tenant insert is rejected by the `with check` clause; a dealer's attempt to update a referral's status (admin-only) affects 0 rows while an admin's succeeds; an admin reads only their own tenant's `audit_log`; and the `anon` role is denied outright (permission denied at the grant level, before RLS even evaluates) on all 7 tables.
- The public-functions migration: exercised through the live API (see [`../api/README.md`](../api/README.md)) end-to-end — resolve an invite link, generate a share link from it, resolve the share link, submit a referral against it, confirm the link flips to `used` and a second submission is rejected — plus confirmed directly that `anon` still can't read a table row even though it can call the functions.

## Not yet built

Per the spec's open questions and the current scope: most of the Node/Express API (see [`../api/README.md`](../api/README.md) for the endpoints that do exist), email sending (per-tenant verified domains), the Amazon Incentives integration, and the order-system webhook.
