# Database

Postgres schema for the referral platform, following the [backend spec](../) (schema + API design doc). This directory currently holds **schema only** — no API server, no gift-card integration yet.

## What's here

- `migrations/20260826000000_init_schema.sql` — creates all 7 core tables (`tenants`, `users`, `customers`, `referral_links`, `referrals`, `gift_card_transactions`, `audit_log`) with their constraints and indexes. No RLS policies, functions, or triggers yet — those are deferred until the API/auth layer is built.

## Running it

**Against a Supabase project** (recommended — matches the hosting plan in the spec):

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

**Against local Supabase** (`supabase start`), or **plain Postgres** for a quick check:

```bash
psql "$DATABASE_URL" -f supabase/migrations/20260826000000_init_schema.sql
```

Note: `users.id` references `auth.users(id)`, which Supabase provisions itself. Running this against a Postgres instance with no `auth` schema (i.e. not Supabase) will fail on the `users` table unless you first create a stand-in:

```sql
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());
```

## Verified

The migration has been applied to a scratch Postgres 16 database and smoke-tested: happy-path inserts across the full tenant → dealer → customer → invite link → share link → referral → gift-card-transaction chain, plus confirmation that the constraints that matter reject bad data — an invalid `kind`, a missing `email`, a second referral against an already-used link, and a duplicate `idempotency_key`.

## Not yet built

Per the spec's open questions and the current scope: RLS policies, the Node/Express API, email sending (per-tenant verified domains), the Amazon Incentives integration, and the order-system webhook.
