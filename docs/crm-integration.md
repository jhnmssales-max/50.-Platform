# Connecting a CRM to 50.

For whoever is wiring up a dealer's CRM — Velocity360, Shed Suite, ShedPro, or
a Zapier/Make step standing in for one.

Today this covers one direction: **the CRM tells 50. that a customer has
bought something, and 50. invites them to its referral program.** Pushing new
referral leads back out to the CRM is the other half and is not built yet.

---

## Getting a key

An admin on the dealer's account creates one under Settings → API keys. It is
shown **once**, at creation, and never again — only a hash of it is stored, so
nobody can recover it, us included. Lost keys are revoked and replaced, not
retrieved.

A key looks like `rw50_live_` followed by 40 characters. Send it as a bearer
token:

```
Authorization: Bearer rw50_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keep it server-side. Anyone holding it can add customers to this dealer's
referral program and cause email to go out over the dealer's name, so it does
not belong in a browser, a mobile app, or anything a customer can view source
on.

### What a key can and cannot do

A key can call exactly one endpoint: `POST /api/customers`. It cannot read the
dealer's customer list, their referrals, their billing, or their reports —
every one of those answers `401` to a key. That is deliberate: a leaked key
should be able to add somebody, and not export anything.

A key also carries no privileges of its own. It authenticates as a staff
account created for the integration, so the dealer's own access rules apply to
it unchanged — including that it can only ever see or touch that one dealer's
data, and that it is refused until the dealer has completed activation.

---

## Inviting a customer when an order closes

```
POST https://go.referwith50.com/api/customers
Authorization: Bearer rw50_live_...
Idempotency-Key: <your order or deal id>
Content-Type: application/json

{
  "name": "Dale Hostetler",
  "email": "dale@example.com",
  "phone": "402-555-0100"
}
```

`name` and `email` are required; `phone` is optional. On success 50. creates
the customer, mints their personal referral link, and emails it to them.

```json
{
  "reused": false,
  "customer": { "id": "…", "name": "Dale Hostetler", "email": "dale@example.com" },
  "invite_link": {
    "code": "dalehostetler-8T_lW4",
    "url": "https://go.referwith50.com/fifty-template-customer.html?code=dalehostetler-8T_lW4"
  },
  "email": { "sent": true, "resent": false }
}
```

`201` means the customer is new. `200` means they were already on the list.

### Idempotency-Key is required

Not optional, and the request is rejected with `400` without it. Send
something stable that identifies the event you are reacting to — the order id,
the deal id, the invoice number. Not a timestamp, not a random value, or it
defeats the purpose.

This is what makes a retry safe. If your request times out, or the response is
lost, or your queue delivers twice, send the same request with the same key:
50. replays the original answer and sends no second email. Without it, the
dealer's customer gets the same "tell your friends" email twice, which is the
one thing this integration must never do.

| Situation | What you get |
|---|---|
| First call | `201` with the customer and their link |
| Retry, original finished | `201` again, the same body, no second email |
| Retry while the original is still running | `409` — wait a moment and retry |
| Same key used for a different endpoint | `409` — use one key per request |

Keys are scoped per dealer, so two dealers can both use order number 1041
without colliding.

### Firing on more than one stage is safe

If your CRM fires on both "won" and "delivered", those are two different events
with two different keys, and the idempotency key cannot connect them. 50.
handles it a second way: **an automated caller never resends to somebody
already on the list.** The second call answers `200`, returns the customer and
their existing link, and sends nothing:

```json
{
  "reused": true,
  "customer": { "…": "…" },
  "invite_link": { "…": "…" },
  "email": { "sent": false, "reason": "already_invited", "error": "Dale Hostetler is already on the list and was invited on 2026-11-12, so nothing was sent." }
}
```

So you can fire on whichever stages you like without worrying about it. Note
this differs from a person pressing **Add** in the dashboard on a known
address — that *does* resend, because a human asking for it has decided that
is what they want.

### Customers who have unsubscribed

Somebody who asked the dealer to stop emailing them is never emailed, however
the request arrives. You still get `200` with their link, and
`email.reason` is `"unsubscribed"`. The link itself still works if the dealer
wants to pass it on another way.

---

## Errors

| Status | Meaning |
|---|---|
| `400` | Bad body, or a missing/oversized `Idempotency-Key` |
| `401` | Missing, unknown, or revoked key — or a route keys cannot call |
| `402` | The dealer has not completed activation yet |
| `409` | The same key is in flight, or was used for another endpoint |
| `503` | A dependency 50. needs is not configured — safe to retry later |

Retry `409` and `503`. Do not retry `400` or `401` — those need a person.

`email.sent: false` on an otherwise successful response is **not** a failure of
your request: the customer and their link exist. It means the email did not
go, and the reason is in `email.reason`.

---

## Testing it

Create a key, point it at a customer record you own, and check the inbox. Then
send the exact same request again — you should get the same link back and no
second email. If you get two emails, something is wrong with how your key is
being generated, and it is worth fixing before it reaches real customers.

The platform's own test suite for all of this is
`npm run e2e:crm-integration` in `api/`.
