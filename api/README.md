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

### `GET /api/me`

Who the caller is: `{ "name", "email", "role", "tenant_name" }`, read from `users`/`tenants` via the same `getCallerContext` every other route uses. `403` if the token belongs to no staff account. This is what the dealer page calls right after sign-in to show "Signed in as ... · dealer" and to decide client-side whether to let this session interact with the "mark as paid" toggle — display only, never a trust boundary; `PATCH /api/referrals/:id/status` still enforces admin-only server-side regardless of what this returns.

### `GET /api/referrals`

The dealer's searchable pipeline — one row per friend who has submitted the lead form against one of the dealer's customers' share links. This is the "Referrals in progress" list from the dealer page prototype, now backed by a real query instead of browser storage.

**Scoped by role, not just by tenant**: a dealer sees only referrals that trace back to a customer *they* invited; an admin sees every referral in the tenant. This isn't an `if (role === 'admin')` in this file — it's enforced by the RLS policy in `supabase/migrations/20260906000000_referrals_dealer_scope.sql`, the same "the database decides, not application code" property as everything else here. A dealer's `query`/`status` filters run against that already-narrowed set, so there's no way to search your way into seeing a coworker's referrals.

Status lives **per referral, not per customer**: a single customer can hold several share links and generate several referrals, and each gets paid out independently — Sarah's referral of Mike can be `paid` while her referral of Priya is still `pending`, on the same customer. "Paid" is `true` once either signal says so: `referrals.status = 'rewarded'` (set by `PATCH /api/referrals/:id/status` below, whether that's an admin marking it by hand or the reward attempt it triggers) or a `gift_card_transactions` row shows `issued` directly. Never stored redundantly as its own column; computed live from whichever signals actually exist. The raw `referrals.status` lifecycle (`new` → `contacted` → `ordered` → `rewarded`, or `declined`) is included alongside the collapsed `pending`/`paid` view for anything that needs more detail.

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

Admin-only. Backs the dealer page's "mark as paid" toggle. Body: `{ "status": "contacted" | "ordered" | "rewarded" | "declined" }` — a manual override for statuses that don't yet flow in automatically; setting `rewarded` is exactly what the (not-yet-built) order-system webhook will eventually do on its own once an order comes in, so today a human triggers the same transition a webhook will later.

**Setting `rewarded` now also attempts a real reward** — see "How a reward actually gets issued" below — funded by *this tenant's own* connected Tremendous account, never a shared one. A tenant with nothing connected behaves exactly as before: the status flips, no reward is attempted, `reward` is simply absent from the response.

What this endpoint guarantees regardless: it's server-authoritative (the client sends only a target status, nothing about amounts or "did it work"), and idempotent under real concurrency, not just sequential double-clicks — a guarded `UPDATE ... WHERE status IS DISTINCT FROM $1` means the status transition, and the single `audit_log` row for it, happens exactly once no matter how many identical requests land at once. The reward attempt has the same guarantee, separately (see below): at most one Tremendous order is ever created per referral, no matter how many times or how simultaneously this is called.

```
PATCH /api/referrals/40000000-0000-0000-0000-000000000001/status
Authorization: Bearer <admin's access token>
Content-Type: application/json

{ "status": "rewarded" }
```

```json
{ "id": "40000000-0000-0000-0000-000000000001", "status": "rewarded", "reward": { "issued": true } }
```

`reward.issued: false` carries an `error` message (Tremendous's own, when they rejected the order — e.g. an underfunded funding source) rather than a generic failure — the dealer page surfaces this directly so an admin knows to send that reward by hand, since a failed attempt is never retried automatically (see below).

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

Also notifies — best-effort, invisible to this response either way — the dealer who actually owns this lead (see "How the dealer gets notified of a new lead" below).

### `PUT` / `GET` / `DELETE /api/tenant/tremendous-credentials`

Admin-only. Lets a company connect *its own* Tremendous account — API key, funding source, and campaign — so `PATCH /api/referrals/:id/status` pays rewards from that company's own card, under that company's own campaign, never a shared platform account. `PUT` body: `{ "api_key", "funding_source_id", "campaign_id" }` — all three required; `campaign_id` isn't optional because Tremendous's own API rejects an order that has neither a campaign nor a products list (confirmed against their real sandbox, not just assumed from docs).

`GET` and the `PUT` response only ever return `{ "configured": true|false, "funding_source_id", "campaign_id", "connected_at" }` — the key itself is write-only from here on out; nothing in this API ever decrypts it back to a client, not even the admin who set it. See "How a reward actually gets issued" below for how it's stored and used. `DELETE` clears all four columns (`{ "configured": false }`).

## How the invite email works

`src/lib/postmark.js` is a thin wrapper over Postmark's HTTP API (no SDK dependency — just `fetch`, built into Node 22). `src/lib/inviteEmail.js` builds the subject/HTML/text from the tenant's name and reward amount, so the copy is never hardcoded to one tenant's numbers.

**Sender identity**: a tenant with its own verified domain (`tenants.send_domain_verified` + `send_from_address`/`send_from_name`, columns that have existed since the schema was first designed) sends as that domain. Every other tenant — today, that's all of them — falls back to the platform's single verified sender, `EMAIL_FROM_ADDRESS` (currently `ben@goodstewardstructures.com`, verified in Postmark). Nothing is hardcoded in application code; both are configuration, read at send time.

**The link in the email** is built by `buildInviteUrl()` in `routes/customers.js`: if `FRONTEND_BASE_URL` is set, it's `<FRONTEND_BASE_URL>/fifty-template-customer.html?code=...` — a real, working link wherever the static pages actually are — rather than the tenant's domain + the `/50/...` path scheme from earlier responses, which has no routing layer behind it and won't resolve. That fallback is still there for a deployment that hasn't set `FRONTEND_BASE_URL` yet, but it's not clickable until one exists. This is also the exact URL shown in the dealer page's confirmation box, so what a dealer sees matches what actually got emailed.

**Never blocks or reverts the core action**: the send is attempted only once the customer + link transaction has committed, and its failure is caught and reported, never thrown back as a request failure — a real customer and a real, usable link exist either way, whether or not Postmark cooperated.

## How the dealer gets notified of a new lead

`POST /api/links/:code/referrals` (a friend submitting the lead form) also emails **whichever dealer actually owns this lead** — the dealer who originally invited the customer that shared this link — not a fixed address, since that's the person who needs to follow up. `src/lib/leadNotificationEmail.js` builds the subject/body from the tenant's name, the dealer's name, the lead's own name/contact/message, and the referring customer's name.

**Who "owns" a lead, and where that comes from**: the caller here is `anon` — a friend filling out a lead form isn't logged in, and `anon` has no table access at all (see "How the public routes stay safe without an account" below). So the dealer's email/name, the referrer's name, and the tenant's sender config all come back as extra columns from `submit_referral()` itself (`supabase/migrations/20260906010000_submit_referral_dealer_notification.sql`) — the same narrow, security-definer function that already does the insert — rather than a second query the route has no privilege to run. A customer with no inviting dealer on record (auto-created from an earlier referral conversion, not entered by a dealer directly) comes back with a null `dealer_email`; the route treats that as "nothing to notify," not an error.

**Same sender-resolution and best-effort rules as the invite email above** — tenant's own verified domain if set, else the platform default; attempted only after the referral is safely committed; never blocks or reverts it. One difference: since the caller submitting the lead form is the anonymous friend, not the dealer, whether this notification succeeded is never reported back in the public response either way — there's no one on that end of the request who should see it. A failure is only visible in the server's own logs.

## How a reward actually gets issued

Each tenant connects their own Tremendous account (`PUT /api/tenant/tremendous-credentials` above) — their own API key, funding their own card via their own funding source id, under their own campaign (their own branding and choice of reward — e.g. a campaign locked to Amazon.com gift cards). `PATCH /api/referrals/:id/status` is where that gets used: transitioning a referral to `rewarded` looks up *that referral's own tenant's* credentials and, only if all three (key, funding source, campaign) are on file, places one Tremendous order for the referrer (the customer who shared the link), for that tenant's own `reward_amount_cents`/`reward_currency`. There is no shared platform Tremendous account anywhere in this code — a tenant with nothing (or only partially) connected simply never has an order attempted, same as before this integration existed.

**Encrypted at rest, never returned**: `tenants.tremendous_api_key_encrypted` is ciphertext (`pgp_sym_encrypt`, pgcrypto), decrypted only inside the one query that needs the plaintext key to actually call Tremendous — held in memory just long enough to make that one HTTP call, never logged, never part of any API response. `TENANT_CREDENTIALS_ENCRYPTION_KEY` (the passphrase) lives only in this API's own environment, never in the database — losing it makes every tenant's stored key permanently undecryptable, same trade-off as losing any other password-hashing pepper.

**A reward is attempted at most once per referral, ever** — this is the part that actually matters, since it's real money: before calling Tremendous, the request claims an idempotency slot by inserting a `gift_card_transactions` row with `status = 'pending'` and a unique `idempotency_key` (`<referral_id>:referrer`), using `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`. Only a request that actually got a row back proceeds to call Tremendous; a concurrent or later request for the same referral sees the conflict, gets nothing back, and does not call Tremendous at all. This holds under genuine concurrency, not just sequential double-clicks — verified by firing 10 simultaneous `PATCH` requests at the same referral and confirming exactly one Tremendous call and one `gift_card_transactions` row resulted (see "Verified" below). The Tremendous call itself happens *after* that claim commits, outside any open database transaction (a slow external HTTP call should never hold one open); the outcome — `issued` with Tremendous's own order id, or `failed` with nothing further recorded — is written back to that same row in a second, separate transaction.

**A failed attempt is not retried automatically.** If Tremendous rejects the order (an underfunded funding source, a bad key), the `gift_card_transactions` row is left `status = 'failed'` and the referral stays `rewarded` regardless — the status change and the reward are two different guarantees, and a payment failure should never look like the referral itself is stuck. But because the idempotency slot is already claimed, clicking "mark as paid" again on that same referral will not try Tremendous a second time; today, recovering from a failed attempt means fixing the underlying problem (funding the card, rotating the key) and handling that one reward manually — see "Not yet built" below.

## How the public routes stay safe without an account

There's no JWT here — a friend filling out a lead form isn't logged in — so these three routes can't lean on RLS the way the dealer routes do. Instead they're the *only* thing Postgres lets the `anon` role touch at all: three narrow, `security definer` functions (`resolve_link`, `create_share_link`, `submit_referral` — `supabase/migrations/20260826030000_public_link_functions.sql`), each doing one specific, vetted thing and returning only the columns it should. `anon` has no grants on any table directly, so a code path that accidentally queried a table instead of calling one of these functions would simply fail with a permission error, not silently succeed. Each request still runs as `anon` (`withPublicTransaction` in `src/db.js`), matching the same impersonation pattern as the dealer routes rather than connecting with some broader "service" role.

Everything else is what actually carries the weight for an endpoint anyone on the internet can hit: strict `zod` validation (including a regex on `:code` itself, rejected before it ever reaches the database), per-route rate limiting tuned to how often a real visitor would legitimately call each one (`src/middleware/rateLimit.js`), and error responses written to never leak more than a real visitor needs — "not found" and "expired" are indistinguishable, and a `POST` that hits a genuine double-submit race gets caught by the database's own unique constraint on `referrals.referral_link_id`, not just an application-level check that a concurrent request could slip past.

## How dealer auth works — and why it isn't bypassing RLS

Every route requires `Authorization: Bearer <token>`, verified in `src/middleware/auth.js`. That only establishes *identity* (the caller's `auth.uid()`) — it does not look up or trust a tenant or role from the token.

**Verified against Supabase's JWKS, not a static secret**: this project's Supabase tokens are signed with an asymmetric key (ES256) that Supabase rotates on its own, not the legacy shared HS256 secret — so `requireAuth` fetches the project's current public signing key from `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` (via `jwks-rsa`, cached in memory for 10 minutes) and verifies against whichever key matches the token's `kid`, restricted to `ES256` specifically — never left open to whatever algorithm a token happens to claim, which is the classic "alg confusion" hole in JWT verification. `SUPABASE_URL` is the only required config for this; `SUPABASE_JWKS_URL` exists solely to point it at a local stand-in for tests (see "Verified" below).

**Where the token comes from**: real Supabase Auth, not a pasted string. The dealer page signs in against `<SUPABASE_URL>/auth/v1/token?grant_type=password` directly (no `supabase-js` — it's a plain page, so this is one `fetch` with the project's public anon key), gets back an access + refresh token pair, and stores them in `localStorage`. Every `apiFetch` call attaches the access token; a `401` triggers exactly one refresh-token attempt (`grant_type=refresh_token`) before giving up and signing the page out — no silent retry loop, no token ever sent after a refresh fails. [`../supabase/README.md`](../supabase/README.md)'s "Staff accounts" section covers how a person actually gets an account in the first place (there's no self-serve signup).

Each request then runs inside a Postgres transaction that impersonates that identity (`src/db.js`, `withUserTransaction`):

```sql
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '<verified user id>', true);
```

This is exactly the session state Supabase's own PostgREST layer sets up, so `auth.uid()` and the RLS policies from `supabase/migrations/20260826020000_rls_policies.sql` apply unmodified. The API has no separate "is this the caller's tenant?" logic of its own — a dealer only ever sees or writes their own tenant's rows because Postgres, not this code, rejects anything else. This holds for the search filter too: even a `query` string engineered to match another tenant's data returns nothing, because the join it runs against (`referrals` → `referral_links` → `customers`) is RLS-scoped before the `WHERE` clause ever sees a row. `DATABASE_URL` must point at a role that's a member of `authenticated` (Supabase's default `postgres` connection already is) — a role that bypasses RLS (e.g. the `service_role` key) would defeat the point.

## Running it

```bash
cd api
cp .env.example .env   # fill in DATABASE_URL, SUPABASE_URL, POSTMARK_SERVER_TOKEN, EMAIL_FROM_ADDRESS, FRONTEND_BASE_URL

# the dealer page also needs its own two lines filled in (SUPABASE_URL,
# SUPABASE_ANON_KEY, near API_BASE) — see "How dealer auth works" above
npm install
npm run dev
```

`scripts/gen_test_jwt.js` mints a throwaway ES256 token for local testing without a real Supabase project — `node scripts/gen_test_jwt.js <keypair-file> <user-uuid>` (generates the keypair file on first use). `scripts/serve_test_jwks.js <keypair-file> [port]` serves that same keypair's public half as a real JWKS response, so `SUPABASE_JWKS_URL` can point at it locally. Neither has any connection to a real Supabase project's actual signing key.

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
- Real login: same live setup, plus a local stand-in for Supabase Auth's `/auth/v1/token` endpoint (password + refresh-token grants — again, no live Supabase project credentials exist in this environment). Through the actual dealer page in a real browser (Playwright): wrong password shows Supabase's own error message and leaves the login form up; signing in as a seeded dealer shows "Signed in as Ben · dealer" and a referrals list containing **only** the one referral from a customer Ben invited; signing in as a seeded admin for the same tenant shows both dealers' referrals and an enabled "mark as paid" toggle, while the dealer's own view renders that same toggle disabled with an "Only admins can mark a referral paid" tooltip; the session survives a page reload (no re-login); signing out clears it and shows the login form again. `POST /api/customers` re-verified working unchanged under a real logged-in session.
- Tenant Tremendous credentials: a dealer's token → `403` on `PUT`; `PUT` missing `campaign_id` (or either other field) → `400` with field-level detail, before any DB write; an admin's complete `PUT` → `configured: true`, and the stored value is genuinely ciphertext — decrypting it directly in the database with the correct passphrase recovers the original key, and with any other passphrase raises pgcrypto's own "Wrong key or corrupt data" rather than returning anything. `GET` never returns key material, only `configured`/`funding_source_id`/`campaign_id`/`connected_at`.
- Reward issuance: against a local stand-in for Tremendous's `/orders` endpoint, updated to reject (the same way the real sandbox did — see below) a request missing `campaign_id`, so the stand-in can't drift back out of sync with reality. A tenant with no credentials connected → status flips to `rewarded`, zero `gift_card_transactions` rows, nothing sent to the stand-in. A tenant with a key and funding source but no `campaign_id` (e.g. mid-setup) → same as fully unconfigured, not a broken request. A tenant with all three connected → the stand-in receives the tenant's *own* API key, funding source id, and campaign id (never shared ones), the referrer's own name/email, the tenant's own `reward_amount_cents`/`reward_currency`, and an `Idempotency-Key` header — response is `reward: { issued: true }` and one `gift_card_transactions` row (`status = 'issued'`, the stand-in's order id recorded). The stand-in rejecting the order (simulating an underfunded funding source) → `reward: { issued: false, error: "..." }` with Tremendous's real error message, the referral still `rewarded`, and the row left `status = 'failed'`. **10 genuinely concurrent identical requests fired at once against the same referral** (fully connected) → all `200`, but exactly one reached the stand-in and exactly one `gift_card_transactions` row exists — the idempotency claim holds under a real race, not just a sequential double-click. A repeat request after a referral is already `rewarded` (whether the earlier reward succeeded or failed) → no further call to the stand-in at all.
- **The real Tremendous sandbox** (`testflight.tremendous.com`) rejected an order with no `campaign_id` — `campaign_id or products must be set` — before this field existed in this integration at all. That's what `campaign_id` being required (not optional) here reflects; the stub above was updated to enforce the same thing so it can't silently drift from what the real API actually requires. This is the one part of the Tremendous integration confirmed against Tremendous's real API rather than only their docs — see the note at the top of `src/lib/tremendous.js`.
- JWKS-based auth: no live Supabase project reachable from this environment, so verified against the real fix code with a real EC P-256 keypair, a real ES256-signed token minted from it, and a real JWKS response served over local HTTP — `GET /api/me` with a matching `kid` → `200` with the correct user; a tampered signature, and a token signed with an unrelated keypair (`kid` not in the JWKS), both → `401`; no header → `401` (unchanged). Full browser end-to-end: signed in on the actual dealer page against an ES256-signing Supabase Auth stub and correctly resolved "Signed in as Joseph · admin."
- Dealer lead notification: seeded a dealer who invited a customer, and a second customer with no inviting dealer on record (auto-created from a conversion). Submitting a referral against the first customer's share link → the *actual inviting dealer's* address received the email (not a fixed one), with the tenant's real name, the lead's own message/contact, and the referring customer's name all correctly filled in; the public response stayed `{ id, submitted_at }` either way. Submitting against the second customer's link → succeeds normally, zero email attempts (no inviting dealer to notify, not an error). Killing the Postmark stand-in entirely and resubmitting → the referral still commits and returns `201`; the failure is only ever visible in the server's own logs, never in the (anonymous) caller's response.

The public routes, on the same live setup: the full chain end-to-end — resolved an invite link, generated a share link from it, resolved *that*, submitted a referral against it as the friend, confirmed it flipped to `used`, and confirmed a second submission on the same link is rejected with `409` while the invite-link version of that same request (wrong kind) is `404`. Also: a malformed `:code` (SQL-shaped garbage) rejected before touching the database; missing `email` → `400`; `GET /api/links/:code` hitting `429` on the 31st call in a minute and `POST .../referrals` on the 6th; `Access-Control-Allow-Origin` present on responses; and, directly at the database level, that `anon` still can't `select` from a table even though it can call the functions.

## The frontend prototype pages

The three static pages at the repo root (`fifty-template-dealer.html`, `fifty-template-customer.html`, `fifty-template-lead.html`) call this API directly — no build step, no framework, just `fetch()`. Each has an `API_BASE` constant near the top of its `<script>` block (next to the existing `TENANT` config object) — that's the one line to change per deployment.

- **Dealer page**: real login now — email + password against Supabase Auth directly (see "How dealer auth works" above), not a pasted token. Signed out, it shows a login form and nothing else; signed in, it shows "Signed in as ... · role", the send-referral form, and the referrals list, scoped to whatever `GET /api/referrals` returns for that person. The "mark as paid" toggle calls `PATCH /api/referrals/:id/status` for real; it's rendered disabled for a dealer (with a tooltip explaining why) since the endpoint is admin-only anyway — display-only, the server-side check is what actually matters. Its confirm dialog no longer claims this "sends the $50 gift card" (the original mockup's copy) — that would be false until the gift-card integration exists — and says so plainly instead. Any `401` from the API (including a failed token refresh) signs the page out rather than showing a confusing error. Submitting the "send referral" form shows "Emailed to ..." when it actually sent, or a plain explanation plus the link to send manually when it didn't — the copy-link box never disappears, it's just no longer the primary instruction.
- **Customer & lead pages**: their existing demo panels already worked as a manual code-entry fallback (lead page) or got simplified into one (customer page, which previously faked a referrer identity with free-text fields — now that identity always comes from a real backend row, there's nothing to fake).
- Since the friend-facing forms now hit a real backend that requires a real email, each page's original single "phone number or email" field became two fields — email (required) and phone (optional) — the one visible UI change beyond wiring, and a direct consequence of the schema decision to be email-only (no SMS).
- The dealer's referral list now shows one row per friend submission rather than per invited customer (see `GET /api/referrals` above) — same row/pill styling, different underlying data, which changes what's shown in each row (the friend's name/contact, plus who referred them) though not the page's look.
- The customer page's own onward **share** link is still built client-side, as `${window.location.origin}/fifty-template-lead.html?ref=...` — that hasn't changed. The dealer's **invite** link is now built server-side (see "How the invite email works" above) since it has to be a real, working URL before it's put in an email the API sends on its own, not just displayed for a human to copy.
- `routes/customers.js` and `routes/referrals.js` now also mount `cors()`, matching `routes/public.js` — safe here for the same reason it was safe there: auth is a bearer token the calling page must already possess and attach itself, never a cookie the browser sends automatically, so an open CORS policy doesn't add a CSRF-style risk. Without it, a static page served from any origin other than the API's own couldn't call these routes at all.

**Verified**: ran the full three-page flow through an actual headless browser (Playwright) against a live API + Postgres, with the pages served from a different origin/port than the API (genuinely exercising CORS, not masked by same-origin) — dealer submits the form → real confirmation with a working invite link → customer page resolves it and shares → lead page resolves the share link and submits → dealer's list picks up the new referral with the correct referrer attribution and searches for it correctly → revisiting the same share link shows "already used" → an invalid code shows "not valid". Also checked: no-token and invalid-token states on the dealer page, and that empty-email submission is blocked client-side before ever reaching the API. The only browser console error across the whole run was the pre-existing Google Fonts stylesheet request, unrelated to this integration and blocked by this sandbox's own network policy, not something introduced here.

The "mark as paid" toggle, separately, through the same kind of live browser run: an admin clicking it on a pending referral shows the (now provider-agnostic) confirm copy, calls the real endpoint, and the row flips to a disabled, checked "Marked paid" pill; a dealer's token gets the `403` alert and the toggle visibly reverts to unchecked rather than silently failing. With Tremendous connected but rejecting the order (stand-in configured to fail), the row still flips to "Marked paid" and a follow-up alert names the real error and says to send that reward manually — confirmed the referral is never left looking stuck just because the payment failed.

Invite email, through the dealer page itself, in the browser: submitting the form with the Postmark stand-in healthy shows "Emailed to Jordan Kim (jordan@email.com)" and a working link; with the stand-in returning an error, the same form shows "Jordan Kim created — but the email couldn't be sent" with Postmark's real error message and the link still there to copy — the dealer is never left not knowing which happened.

## Not yet built

The order-system webhook that would set `ordered` automatically instead of by hand, and per-tenant verified sending domains (every tenant currently sends invite emails through the one platform-wide verified address — separate from, and unrelated to, each tenant's own Tremendous credentials).

On the Tremendous integration specifically: a failed reward attempt is never retried automatically (see "How a reward actually gets issued" above) — recovering one today means fixing the underlying problem and handling that single reward by hand, not resubmitting through this API. There's also no "new customer" reward yet — the schema anticipates a second `gift_card_transactions` row per completed referral (`recipient_role = 'new_customer'`, for the friend who was referred, not just the referrer who shared), but nothing issues it; today's integration only pays the referrer. `src/lib/tremendous.js`'s exact request shape (the `campaign_id` requirement specifically) has been confirmed against Tremendous's real sandbox by hand; this API's own code path that calls it has only been exercised against the local stand-in, not a live account, since no live credentials exist in this environment. `supabase/README.md`'s "Staff accounts" runbook likewise hasn't been run against a real Supabase project, for the same reason.
