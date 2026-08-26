# Referral platform API

Dealer-facing API, per the [backend spec](../supabase/README.md). Currently implements exactly two endpoints — creating a referral link and listing/searching the dealer's pipeline — with no public routes, no email sending, and no gift card integration yet.

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

### `GET /api/customers`

The dealer's searchable pipeline — every customer they (or a teammate) have invited, and whether their referral has paid out yet. This is the "Referrals in progress" list from the dealer page prototype, now backed by a real query instead of browser storage. "Paid" is computed live from `gift_card_transactions`, not stored redundantly.

Query params (all optional): `query` (matches name/email/phone), `status` (`pending` or `paid`), `limit` (default 20, max 100), `offset` (default 0).

```json
{
  "customers": [
    { "id": "...", "name": "Sarah Johnson", "email": "...", "phone": "...", "created_at": "...",
      "invite_link": { "code": "...", "created_at": "..." }, "status": "paid" }
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

This is exactly the session state Supabase's own PostgREST layer sets up, so `auth.uid()` and the RLS policies from `supabase/migrations/20260826020000_rls_policies.sql` apply unmodified. The API has no separate "is this the caller's tenant?" logic of its own — a dealer only ever sees or writes their own tenant's rows because Postgres, not this code, rejects anything else. `DATABASE_URL` must point at a role that's a member of `authenticated` (Supabase's default `postgres` connection already is) — a role that bypasses RLS (e.g. the `service_role` key) would defeat the point.

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
- `GET /api/customers` lists and searches correctly, with accurate counts
- **Cross-tenant isolation, at the live HTTP layer**: a second tenant's dealer creating and listing customers never sees the first tenant's data, and vice versa — enforced by RLS, not application code
- Marking a referral's gift card `issued` in the ledger flips that customer's computed `status` from `pending` to `paid` on the very next list call, and `status=paid`/`status=pending` filters both work correctly

## Not yet built

Public/unauthenticated routes (`GET /api/links/:code`, `POST /api/links/:code/share`, `POST /api/links/:code/referrals`), admin-only endpoints (`PATCH /api/referrals/:id/status`), email sending, the Amazon Incentives integration, and the order-system webhook. See the [backend spec](../supabase/README.md) and the published spec artifact for the full picture.
