# Referral platform API

Referral platform API, per the [backend spec](../supabase/README.md): dealer-facing endpoints (creating a referral link and emailing it, listing/searching referrals, marking one paid) and public endpoints (resolving a link, generating a share link, submitting a referral). No gift card integration yet.

## Endpoints

### `POST /api/customers`

A dealer enters a customer's name/contact; the customer and their invite (referral) link are created atomically in one transaction, then the invite is emailed to them through Postmark.

```
POST /api/customers
Authorization: Bearer <supabase access token>
Content-Type: application/json

{ "name": "Sarah Johnson", "email": "sarah@email.com", "phone": "7175550134" }
```

```json
{
  "customer": { "id": "...", "name": "Sarah Johnson", "email": "sarah@email.com", "phone": "7175550134", "created_at": "..." },
  "invite_link": { "code": "sarahjohnson-8m27uh", "url": "https://acme.50platform.com/fifty-template-customer.html?code=sarahjohnson-8m27uh", "status": "active", "created_at": "..." },
  "email": { "sent": true }
}
```

Sending is a best-effort side effect, attempted only *after* the customer and link are safely committed — if Postmark fails (bad recipient, bad token, network error), the response is still `201` with the customer and link both real, just `"email": { "sent": false, "error": "<Postmark's message>" }`. The link is always returned either way, so the dealer always has something to hand over manually if the email didn't go out.

### `GET /api/referrals`

The dealer's searchable pipeline — one row per friend who has submitted the lead form against one of the dealer's customers' share links. This is the "Referrals in progress" list from the dealer page prototype, now backed by a real query instead of browser storage.

Status lives **per referral, not per customer**: a single customer can hold several share links and generate several referrals, and each gets paid out independently — Sarah's referral of Mike can be `paid` while her referral of Priya is still `pending`, on the same customer. "Paid" is `true` once either signal says so: `referrals.status = 'rewarded'` (set today by `PATCH /api/referrals/:id/status` below, an admin marking it by hand) or a `gift_card_transactions` row shows `issued` (not wired up yet — once the Amazon Incentives integration exists, the payout job will set both together). Never stored redundantly as its own column; computed live from whichever signals actually exist. The raw `referrals.status` lifecycle (`new` → `contacted` → `ordered` → `rewarded`, or `declined`) is included alongside the collapsed `pending`/`paid` view for anything that needs more detail.

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

### `PATCH /api/referrals/:id/status`

Admin-only. Backs the dealer page's "mark as paid" toggle. Body: `{ "status": "contacted" | "ordered" | "rewarded" | "declined" }` — a manual override for statuses that don't yet flow in automatically; setting `rewarded` is exactly what the (not-yet-built) Amazon Incentives payout job will eventually do on its own once an order comes in, so today a human triggers the same transition a webhook will later.

No gift card is issued here — that's explicitly out of scope until the Amazon integration exists. What this endpoint *does* guarantee: it's server-authoritative (the client sends only a target status, nothing about amounts or "did it work"), and idempotent under real concurrency, not just sequential double-clicks — a guarded `UPDATE ... WHERE status IS DISTINCT FROM $1` means the transition, and the single `audit_log` row for it, happens exactly once no matter how many identical requests land at once.

```
PATCH /api/referrals/40000000-0000-0000-0000-000000000001/status
Authorization: Bearer <admin's access token>
Content-Type: application/json

{ "status": "rewarded" }
```

```json
{ "id": "40000000-0000-0000-0000-000000000001", "status": "rewarded" }
```

`403` if the caller isn't an admin (a dealer's own token works for every other route but this one). `404` for a referral that doesn't exist *or* belongs to another tenant — the same row is visible to any staff member via `GET /api/referrals`, so this can't be used to probe for IDs across tenants; only the write is admin-gated. A repeat call with the same target status returns `200` with the unchanged current state rather than erroring or re-logging.

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

## How the invite email works

`src/lib/postmark.js` is a thin wrapper over Postmark's HTTP API (no SDK dependency — just `fetch`, built into Node 22). `src/lib/inviteEmail.js` builds the subject/HTML/text from the tenant's name and reward amount, so the copy is never hardcoded to one tenant's numbers.

**Sender identity**: a tenant with its own verified domain (`tenants.send_domain_verified` + `send_from_address`/`send_from_name`, columns that have existed since the schema was first designed) sends as that domain. Every other tenant — today, that's all of them — falls back to the platform's single verified sender, `EMAIL_FROM_ADDRESS` (currently `ben@goodstewardstructures.com`, verified in Postmark). Nothing is hardcoded in application code; both are configuration, read at send time.

**The link in the email** is built by `buildInviteUrl()` in `routes/customers.js`: if `FRONTEND_BASE_URL` is set, it's `<FRONTEND_BASE_URL>/fifty-template-customer.html?code=...` — a real, working link wherever the static pages actually are — rather than the tenant's domain + the `/50/...` path scheme from earlier responses, which has no routing layer behind it and won't resolve. That fallback is still there for a deployment that hasn't set `FRONTEND_BASE_URL` yet, but it's not clickable until one exists. This is also the exact URL shown in the dealer page's confirmation box, so what a dealer sees matches what actually got emailed.

**Never blocks or reverts the core action**: the send is attempted only once the customer + link transaction has committed, and its failure is caught and reported, never thrown back as a request failure — a real customer and a real, usable link exist either way, whether or not Postmark cooperated.

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
cp .env.example .env   # fill in DATABASE_URL, SUPABASE_JWT_SECRET, POSTMARK_SERVER_TOKEN, EMAIL_FROM_ADDRESS, FRONTEND_BASE_URL
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
- `PATCH /api/referrals/:id/status`: a dealer's token → `403`; a bad status value → `400`; a malformed id → `400`; targeting another tenant's referral → `404`, not leaking that it exists; an admin's request → `200` and the row actually changes (including `rewarded_at` being set); the identical request repeated → `200` with no second `audit_log` row; **10 genuinely concurrent identical requests fired at once against the same referral** → all `200`, and exactly one `audit_log` row, not ten — proving the idempotency holds under a real race, not just a sequential double-click; `GET /api/referrals` immediately reflects the new `paid` status on the next call
- Invite email: against a local stand-in for Postmark's real `/email` endpoint (not the live API — no real send during tests) — a successful call sends the exact headers and body Postmark expects (`X-Postmark-Server-Token`, `From`/`To`/`Subject`/`HtmlBody`/`TextBody`), with the reward amount correctly formatted from the tenant's `reward_amount_cents`/`reward_currency` and the sender falling back to `EMAIL_FROM_ADDRESS` when the tenant has no verified domain of its own; the stand-in returning a Postmark-shaped error (bad recipient) or a `401` (bad server token) both still leave the customer and link committed in the database, with `email.sent: false` and Postmark's real error message surfaced in the response. **The emailed link itself was loaded in a real headless browser and correctly greeted the right customer** — not just asserted to look right.

The public routes, on the same live setup: the full chain end-to-end — resolved an invite link, generated a share link from it, resolved *that*, submitted a referral against it as the friend, confirmed it flipped to `used`, and confirmed a second submission on the same link is rejected with `409` while the invite-link version of that same request (wrong kind) is `404`. Also: a malformed `:code` (SQL-shaped garbage) rejected before touching the database; missing `email` → `400`; `GET /api/links/:code` hitting `429` on the 31st call in a minute and `POST .../referrals` on the 6th; `Access-Control-Allow-Origin` present on responses; and, directly at the database level, that `anon` still can't `select` from a table even though it can call the functions.

## The frontend prototype pages

The three static pages at the repo root (`fifty-template-dealer.html`, `fifty-template-customer.html`, `fifty-template-lead.html`) call this API directly — no build step, no framework, just `fetch()`. Each has an `API_BASE` constant near the top of its `<script>` block (next to the existing `TENANT` config object) — that's the one line to change per deployment.

- **Dealer page**: has no real login yet, so it gets a "Demo settings" panel (matching the pattern the other two pages already used for their own demo affordances) where you paste a Supabase access token by hand — remembered in `localStorage` so it doesn't need re-entry every reload. The "mark as paid" toggle calls `PATCH /api/referrals/:id/status` for real now. Its confirm dialog no longer claims this "sends the $50 gift card" (the original mockup's copy) — that would be false until the Amazon integration exists — and says so plainly instead. A `403` (a dealer's own token, not an admin's) reverts the toggle and explains why rather than pretending the click worked. Submitting the "send referral" form now shows "Emailed to ..." when it actually sent, or a plain explanation plus the link to send manually when it didn't — the copy-link box never disappears, it's just no longer the primary instruction.
- **Customer & lead pages**: their existing demo panels already worked as a manual code-entry fallback (lead page) or got simplified into one (customer page, which previously faked a referrer identity with free-text fields — now that identity always comes from a real backend row, there's nothing to fake).
- Since the friend-facing forms now hit a real backend that requires a real email, each page's original single "phone number or email" field became two fields — email (required) and phone (optional) — the one visible UI change beyond wiring, and a direct consequence of the schema decision to be email-only (no SMS).
- The dealer's referral list now shows one row per friend submission rather than per invited customer (see `GET /api/referrals` above) — same row/pill styling, different underlying data, which changes what's shown in each row (the friend's name/contact, plus who referred them) though not the page's look.
- The customer page's own onward **share** link is still built client-side, as `${window.location.origin}/fifty-template-lead.html?ref=...` — that hasn't changed. The dealer's **invite** link is now built server-side (see "How the invite email works" above) since it has to be a real, working URL before it's put in an email the API sends on its own, not just displayed for a human to copy.
- `routes/customers.js` and `routes/referrals.js` now also mount `cors()`, matching `routes/public.js` — safe here for the same reason it was safe there: auth is a bearer token the calling page must already possess and attach itself, never a cookie the browser sends automatically, so an open CORS policy doesn't add a CSRF-style risk. Without it, a static page served from any origin other than the API's own couldn't call these routes at all.

**Verified**: ran the full three-page flow through an actual headless browser (Playwright) against a live API + Postgres, with the pages served from a different origin/port than the API (genuinely exercising CORS, not masked by same-origin) — dealer submits the form → real confirmation with a working invite link → customer page resolves it and shares → lead page resolves the share link and submits → dealer's list picks up the new referral with the correct referrer attribution and searches for it correctly → revisiting the same share link shows "already used" → an invalid code shows "not valid". Also checked: no-token and invalid-token states on the dealer page, and that empty-email submission is blocked client-side before ever reaching the API. The only browser console error across the whole run was the pre-existing Google Fonts stylesheet request, unrelated to this integration and blocked by this sandbox's own network policy, not something introduced here.

The "mark as paid" toggle, separately, through the same kind of live browser run: an admin clicking it on a pending referral shows the honest confirm copy, calls the real endpoint, and the row flips to a disabled, checked "Marked paid" pill; a dealer's token gets the `403` alert and the toggle visibly reverts to unchecked rather than silently failing.

Invite email, through the dealer page itself, in the browser: submitting the form with the Postmark stand-in healthy shows "Emailed to Jordan Kim (jordan@email.com)" and a working link; with the stand-in returning an error, the same form shows "Jordan Kim created — but the email couldn't be sent" with Postmark's real error message and the link still there to copy — the dealer is never left not knowing which happened.

## Not yet built

The Amazon Incentives integration (so `PATCH /api/referrals/:id/status` changes a status but issues no actual gift card yet), the order-system webhook that would set `ordered` automatically instead of by hand, and per-tenant verified sending domains (every tenant currently sends through the one platform-wide verified address). See the [backend spec](../supabase/README.md) and the published spec artifact for the full picture.
