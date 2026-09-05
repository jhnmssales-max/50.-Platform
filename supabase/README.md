# Database

Postgres schema for the referral platform, following the [backend spec](../) (schema + API design doc). This directory currently holds **schema only** — no API server, no gift-card integration yet.

## What's here

- `migrations/20260826000000_init_schema.sql` — creates all 7 core tables (`tenants`, `users`, `customers`, `referral_links`, `referrals`, `gift_card_transactions`, `audit_log`) with their constraints and indexes.
- `migrations/20260826020000_rls_policies.sql` — enables Row-Level Security on every table and adds the policies scoping each to the caller's own tenant, plus two helper functions (`current_tenant_id()`, `is_admin()`). Raw table access is fully denied to the `anon` role on every table — no grants at all. The API's dealer-facing routes (see [`../api/README.md`](../api/README.md)) impersonate `authenticated` per request, so these policies are what actually decides what a dealer can see or write, not application code.
- `migrations/20260826030000_public_link_functions.sql` — three narrow, `security definer` functions (`resolve_link`, `create_share_link`, `submit_referral`) that are the *only* thing the `anon` role is granted execute on. This is how the public routes (a friend submitting a lead, a customer generating a share link) work without any table-level access for anon: each function does one specific, vetted thing and returns only the columns it's meant to, rather than exposing a table.
- `migrations/20260826040000_audit_log_admin_insert.sql` — grants `authenticated` `INSERT` on `audit_log`, with a policy scoping it to an admin writing their own tenant's rows. The original RLS migration only gave `authenticated` `SELECT` on `audit_log`, assuming every write would come from a service-role connection later; `PATCH /api/referrals/:id/status` (see [`../api/README.md`](../api/README.md)) logs each status change as the admin who made it, under the same impersonation pattern as everything else, so it needed its own narrow write policy rather than reaching for a bypass role.
- `migrations/20260906000000_referrals_dealer_scope.sql` — replaces the original `referrals_select_same_tenant` policy (every staff member saw every referral in the tenant) with one that also checks role: a dealer sees only referrals that trace back to a customer *they* invited (`customers.created_by_user_id = auth.uid()`, via the referral's share link); an admin still sees everything in the tenant. This is what makes real per-person logins (see [`../api/README.md`](../api/README.md)) actually mean something — before this, every staff account saw the same tenant-wide list regardless of role.
- `migrations/20260907000000_tenant_tremendous_credentials.sql` — adds `tenants.tremendous_api_key_encrypted` (ciphertext, `pgp_sym_encrypt`), `tremendous_funding_source_id`, `tremendous_campaign_id`, and `tremendous_connected_at`, so each dealer company can connect its own Tremendous account — including its own campaign/branding — rather than the platform paying out from one shared one. `campaign_id` is required alongside the other two: Tremendous's own API rejects an order with neither a campaign nor a products list, confirmed against their real sandbox rather than assumed from docs. Also grants `authenticated` `INSERT`/`UPDATE` on `gift_card_transactions` (admin-only, own-tenant, same shape as the `audit_log` policy) — the first writes this table has ever had, now that `PATCH /api/referrals/:id/status` (see [`../api/README.md`](../api/README.md)) actually issues rewards instead of just changing a status. Also corrects `gift_card_transactions.provider`'s default from `'amazon_incentives'` (the original plan) to `'tremendous'` — never live data, since nothing had written to this table yet.

## Staff accounts (Supabase Auth)

`users.id` is a foreign key into `auth.users(id)` — a staff member's login *is* a Supabase Auth user; `public.users` just adds the tenant/role/name on top. Provisioning one is two steps, both one-time and done by whoever administers the Supabase project (there's no self-serve signup):

1. **Create the login.** Supabase Dashboard → Authentication → Users → "Add user" (or "Invite user", if you'd rather they set their own password by email). Copy the UUID it creates.
2. **Attach it to a tenant and role** — run once per person, as the project's `postgres` (superuser) role, which bypasses RLS the same way tenant provisioning already does:

   ```sql
   insert into public.users (id, tenant_id, email, name, role)
   values (
     '<uuid from step 1>',
     (select id from tenants where slug = '<the tenant's slug>'),
     '<their email>',
     '<their name>',
     'admin' -- or 'dealer'
   );
   ```

For Good Steward Structures specifically, once its `tenants` row exists in the real project: Joseph as `'admin'`, Ben (`ben@goodstewardstructures.com`) as `'dealer'`. This isn't something this session can run for you — it requires the real project's dashboard and its `tenants.slug`, which only exist in your live Supabase project, not in any environment this session has access to.

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
psql "$DATABASE_URL" -f supabase/migrations/20260826040000_audit_log_admin_insert.sql
```

Note: this depends on Supabase's own `auth` schema (`auth.users`, `auth.uid()`) and its standard `anon`/`authenticated` roles. Running against a Postgres instance with none of that (i.e. not Supabase, and not `supabase start`) will fail unless you first create stand-ins — see `auth.uid()`'s definition in the RLS migration for the shape Supabase provides.

## Verified

- The init migration: applied to a scratch Postgres 16 database and smoke-tested with happy-path inserts across the full tenant → dealer → customer → invite link → share link → referral → gift-card-transaction chain, plus confirmation that the constraints that matter reject bad data — an invalid `kind`, a missing `email`, a second referral against an already-used link, and a duplicate `idempotency_key`.
- The RLS migration: applied on top of the above with a stubbed `auth` schema and `anon`/`authenticated` roles, seeded with two tenants. Verified a dealer sees and can only write within their own tenant; a cross-tenant insert is rejected by the `with check` clause; a dealer's attempt to update a referral's status (admin-only) affects 0 rows while an admin's succeeds; an admin reads only their own tenant's `audit_log`; and the `anon` role is denied outright (permission denied at the grant level, before RLS even evaluates) on all 7 tables.
- The public-functions migration: exercised through the live API (see [`../api/README.md`](../api/README.md)) end-to-end — resolve an invite link, generate a share link from it, resolve the share link, submit a referral against it, confirm the link flips to `used` and a second submission is rejected — plus confirmed directly that `anon` still can't read a table row even though it can call the functions.
- The `audit_log` insert policy: applied and exercised through `PATCH /api/referrals/:id/status` — an admin's status change writes exactly one `audit_log` row (verified directly), a dealer's attempt is rejected before it ever reaches this policy (the endpoint's own admin check), and a burst of 10 concurrent identical requests against the same referral still produces exactly one row, not ten.
- The dealer-scoped referrals policy: seeded one tenant with two dealers (each having invited their own customer, each with one referral) and an admin. Verified directly in SQL and through the live `GET /api/referrals` endpoint: each dealer's request returns only their own referral (1 row), the admin's returns both (2 rows) — see [`../api/README.md`](../api/README.md) for the full login-flow verification this was part of.
- The Tremendous credentials columns and the `gift_card_transactions` write policies: verified the stored key is genuine ciphertext (decrypts correctly with the right passphrase, raises pgcrypto's own error with any other), and — through the live `PATCH /api/referrals/:id/status` endpoint — that exactly one `gift_card_transactions` row and one call to a Tremendous stand-in results even under 10 genuinely concurrent requests against the same referral. Full detail in [`../api/README.md`](../api/README.md)'s "How a reward actually gets issued" and "Verified" sections.

## Not yet built

Per the spec's open questions and the current scope: per-tenant verified sending domains for invite emails (every tenant currently sends through one platform-wide verified address — unrelated to each tenant's own Tremendous credentials, which are per-tenant already), the order-system webhook, and a "new customer" reward (the schema anticipates a second `gift_card_transactions` row per referral for the referred friend, not just the referrer — nothing issues it yet). See [`../api/README.md`](../api/README.md) for what does exist.
