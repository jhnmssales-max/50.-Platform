# Referral platform API

Referral platform API, per the [backend spec](../supabase/README.md): dealer-facing endpoints (creating a referral link, listing/searching referrals) and public endpoints (resolving a link, generating a share link, submitting a referral). No email sending and no gift card integration yet.

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

### `GET /api/links/:code`

Public — no auth, rate-limited (30/min per IP). Resolves either an invite or a share code for the customer page or the lead page to render its greeting. Returns the referrer's first name only — never phone/email — and an *effective* status (`active`/`used`/`expired`) that accounts for `expires_at` even though nothing proactively flips the stored column. An unknown code and an expired one both come back as a plain 404: nothing distinguishes "never existed" from "used up."

```json
{
  "kind": "share",
  "status": "active",
  "referrer_first_name": "Sarah",
  "tenant": { "name": "Acme", "reward_amount_cents": 5000, "reward_currency": "USD", "branding": {} }
}
```

### `POST /api/links/:code/share`

Public — no auth, rate-limited (10/min per IP). The customer taps "Share": mints a new share-kind link off of whatever link got them here (their invite, or — for a referred friend who's since become a customer — their own share link), so a referral chain can extend to any depth without special-casing link kinds.

```json
{ "code": "MvWNLtZkQh", "url": "/50/refer/MvWNLtZkQh", "status": "active", "created_at": "..." }
```

### `POST /api/links/:code/referrals`

Public — no auth, rate-limited (5/min per IP, the tightest of the three since this is the actual lead-capture write). `:code` must be a share-kind link. Body: `{ "name", "email", "phone"?, "message"? }` — email is required (no SMS channel, matching the schema). A second submission against an already-used link returns `409`, distinct from the `404` for a code that never existed or isn't a share link.

```json
{ "id": "...", "submitted_at": "..." }
```

## How the public routes stay safe without an account

There's no JWT here — a friend filling out a lead form isn't logged in — so these three routes can't lean on RLS the way the dealer routes do. Instead they're the *only* thing Postgres lets the `anon` role touch at all: three narrow, `security definer` functions (`resolve_link`, `create_share_link`, `submit_referral` — `supabase/migrations/20260826030000_public_link_functions.sql`), each doing one specific, vetted thing and returning only the columns it should. `anon` has no grants on any table directly, so a code path that accidentally queried a table instead of calling one of these functions would simply fail with a permission error, not silently succeed. Each request still runs as `anon` (`withPublicTransaction` in `src/db.js`), matching the same impersonation pattern as the dealer routes rather than connecting with some broader "service" role.

Everything else is what actually carries the weight for an endpoint anyone on the internet can hit: strict `zod` validation (including a regex on `:code` itself, rejected before it ever reaches the database), per-route rate limiting tuned to how often a real visitor would legitimately call each one (`src/middleware/rateLimit.js`), and error responses written to never leak more than a real visitor needs — "not found" and "expired" are indistinguishable, and a `POST` that hits a genuine double-submit race gets caught by the database's own unique constraint on `referrals.referral_link_id`, not just an application-level check that a concurrent request could slip past.

## How dealer auth works — and why it isn't bypassing RLS

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

The public routes, on the same live setup: the full chain end-to-end — resolved an invite link, generated a share link from it, resolved *that*, submitted a referral against it as the friend, confirmed it flipped to `used`, and confirmed a second submission on the same link is rejected with `409` while the invite-link version of that same request (wrong kind) is `404`. Also: a malformed `:code` (SQL-shaped garbage) rejected before touching the database; missing `email` → `400`; `GET /api/links/:code` hitting `429` on the 31st call in a minute and `POST .../referrals` on the 6th; `Access-Control-Allow-Origin` present on responses; and, directly at the database level, that `anon` still can't `select` from a table even though it can call the functions.

## The frontend prototype pages

The three static pages at the repo root (`fifty-template-dealer.html`, `fifty-template-customer.html`, `fifty-template-lead.html`) call this API directly — no build step, no framework, just `fetch()`. Each has an `API_BASE` constant near the top of its `<script>` block (next to the existing `TENANT` config object) — that's the one line to change per deployment.

- **Dealer page**: has no real login yet, so it gets a "Demo settings" panel (matching the pattern the other two pages already used for their own demo affordances) where you paste a Supabase access token by hand — remembered in `localStorage` so it doesn't need re-entry every reload. The "mark as paid" toggle from the original mockup is now a disabled, read-only pill reflecting live status, since there's no write endpoint for it yet (see "Not yet built" below) — a real one would be admin-gated regardless.
- **Customer & lead pages**: their existing demo panels already worked as a manual code-entry fallback (lead page) or got simplified into one (customer page, which previously faked a referrer identity with free-text fields — now that identity always comes from a real backend row, there's nothing to fake).
- Since the friend-facing forms now hit a real backend that requires a real email, each page's original single "phone number or email" field became two fields — email (required) and phone (optional) — the one visible UI change beyond wiring, and a direct consequence of the schema decision to be email-only (no SMS).
- The dealer's referral list now shows one row per friend submission rather than per invited customer (see `GET /api/referrals` above) — same row/pill styling, different underlying data, which changes what's shown in each row (the friend's name/contact, plus who referred them) though not the page's look.
- Invite/share links are constructed client-side as `${window.location.origin}/<sibling-page>.html?code=...`/`?ref=...` rather than trusting the API's own domain-based `url` fields, so a shared link is always genuinely clickable against wherever these particular files are actually being served — useful since there's no URL-rewriting layer (the `/50/...` paths in the API's responses) in front of static files yet.
- `routes/customers.js` and `routes/referrals.js` now also mount `cors()`, matching `routes/public.js` — safe here for the same reason it was safe there: auth is a bearer token the calling page must already possess and attach itself, never a cookie the browser sends automatically, so an open CORS policy doesn't add a CSRF-style risk. Without it, a static page served from any origin other than the API's own couldn't call these routes at all.

**Verified**: ran the full three-page flow through an actual headless browser (Playwright) against a live API + Postgres, with the pages served from a different origin/port than the API (genuinely exercising CORS, not masked by same-origin) — dealer submits the form → real confirmation with a working invite link → customer page resolves it and shares → lead page resolves the share link and submits → dealer's list picks up the new referral with the correct referrer attribution and searches for it correctly → revisiting the same share link shows "already used" → an invalid code shows "not valid" → marking the referral's gift card issued directly in the ledger flips it to the disabled, checked "paid" pill on next load. Also checked: no-token and invalid-token states on the dealer page, and that empty-email submission is blocked client-side before ever reaching the API. The only browser console error across the whole run was the pre-existing Google Fonts stylesheet request, unrelated to this integration and blocked by this sandbox's own network policy, not something introduced here.

## Not yet built

Admin-only endpoints (`PATCH /api/referrals/:id/status`, and so the frontend's "mark as paid" control), email sending, the Amazon Incentives integration, and the order-system webhook. See the [backend spec](../supabase/README.md) and the published spec artifact for the full picture.
