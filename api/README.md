# Referral platform API

Dealer-facing API, per the [backend spec](../supabase/README.md). Currently implements exactly two endpoints — creating a referral link and listing/searching the dealer's referrals — with no public routes, no email sending, and no gift card integration yet.

## Endpoints

### `POST /api/customers`

A dealer enters a customer's name/contact and gets back that customer's invite (referral) link, created atomically in one transaction. No email is sent — the caller is responsible for handing the link to the customer for now.

```
POST /api/customers
Authorization: Bearer <supabase access token>
Content-Type: application/json

{ "name": "Sarah Johnson", "email": "sarah@email.com", "phone": "7175550134" }
```

```json
{
  "customer": { "id": "...", "name": "Sarah Johnson", "email": "sarah@email.com", "phone": "7175550134", "created_at": "..." },
  "invite_link": { "code": "sarahjohnson-8m27uh", "url": "https://acme.50platform.com/50/sarahjohnson-8m27uh", "status": "active", "created_at": "..." }
}
```

### `GET /api/referrals`

The dealer's searchable pipeline — one row per friend who has submitted the lead form against one of the dealer's customers' share links. This is the "Referrals in progress" list from the dealer page prototype, now backed by a real query instead of browser storage.

Status lives **per referral, not per customer**: a single customer can hold several share links and generate several referrals, and each gets paid out independently — Sarah's referral of Mike can be `paid` while her referral of Priya is still `pending`, on the same customer. "Paid" is computed live from `gift_card_transactions.referral_id`, never stored redundantly, and the raw `referrals.status` lifecycle (`new` → `contacted` → `ordered` → `rewarded`, or `declined`) is included alongside the collapsed `pending`/`paid` view for anything that needs more detail.

Query params (all optional): `query` (matches the friend's name/email/phone, or the referrer's name), `status` (`pending` or `paid`), `limit` (default 20, max 100), `offset` (default 0).

```json
{
  "referrals": [
    { "id": "...", "name": "Mike Torres", "email": "...", "phone": null, "message": null,
      "submitted_at": "...", "referral_status": "rewarded", "status": "paid",
      "referrer": { "id": "...", "name": "Sarah Johnson" } },
    { "id": "...", "name": "Priya Patel", "email": "...", "phone": null, "message": null,
      "submitted_at": "...", "referral_status": "new", "status": "pending",
      "referrer": { "id": "...", "name": "Sarah Johnson" } }
  ],
  "pagination": { "limit": 20, "offset": 0, "total": 2 },
  "counts": { "pending": 1, "paid": 1 }
}
```

## How auth works — and why it isn't bypassing RLS

Every route requires `Authorization: Bearer <token>`, verified against `SUPABASE_JWT_SECRET` (`src/middleware/auth.js`). That only establishes *identity* (the caller's `auth.uid()`) — it does not look up or trust a tenant or role from the token.

Each request then runs inside a Postgres transaction that impersonates that identity (`src/db.js`, `withUserTransaction`):

```sql
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '<verified user id>', true);
```

This is exactly the session state Supabase's own PostgREST layer sets up, so `auth.uid()` and the RLS policies from `supabase/migrations/20260826020000_rls_policies.sql` apply unmodified. The API has no separate "is this the caller's tenant?" logic of its own — a dealer only ever sees or writes their own tenant's rows because Postgres, not this code, rejects anything else. This holds for the search filter too: even a `query` string engineered to match another tenant's data returns nothing, because the join it runs against (`referrals` → `referral_links` → `customers`) is RLS-scoped before the `WHERE` clause ever sees a row. `DATABASE_URL` must point at a role that's a member of `authenticated` (Supabase's default `postgres` connection already is) — a role that bypasses RLS (e.g. the `service_role` key) would defeat the point.

## Running it

```bash
cd api
cp .env.example .env   # fill in DATABASE_URL and SUPABASE_JWT_SECRET
npm install
npm run dev
```

`scripts/gen_test_jwt.js` mints a throwaway HS256 token for local testing without a real Supabase project — `node scripts/gen_test_jwt.js <jwt-secret> <user-uuid>`. Never use it against a real deployment's secret.

## Verified

Ran end-to-end against a scratch Postgres 16 database — both migrations applied as a non-superuser role (`apiuser`, granted membership in `authenticated`/`anon`, mirroring Supabase's own `postgres` connection role rather than a privilege-bypassing one) — with the server actually running and real HTTP requests against it:

- No token → 401; malformed token → 401; a valid token with no matching `users` row → 403
- Invalid body (missing required `email`) → 400 with field-level detail
- A dealer creates a customer + invite link → 201, both rows present and linked
- Seeded one customer with **two separate referrals**, only one paid: `GET /api/referrals` returns both as independent rows with independent `status` — the paid one doesn't leak onto the pending one, and vice versa
- Search matches on the friend's own fields *and* on the referrer's name (searching "Sarah" surfaces both of her referrals); `status=paid`/`status=pending` filters both work correctly
- **Cross-tenant isolation, at the live HTTP layer**: a second tenant's dealer never sees the first tenant's referrals, and a search string that names the other tenant's data returns zero rows rather than erroring — enforced by RLS on the join, not application code
- `POST /api/customers` re-verified unaffected by the `GET /api/referrals` change

## Not yet built

Public/unauthenticated routes (`GET /api/links/:code`, `POST /api/links/:code/share`, `POST /api/links/:code/referrals`), admin-only endpoints (`PATCH /api/referrals/:id/status`), email sending, the Amazon Incentives integration, and the order-system webhook. See the [backend spec](../supabase/README.md) and the published spec artifact for the full picture.
