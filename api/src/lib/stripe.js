// Thin wrapper over Stripe's API — no SDK, just fetch, same pattern as
// src/lib/postmark.js and src/lib/tremendous.js. The one thing Stripe's
// REST API does differently from those two: request bodies are
// form-encoded with bracket notation for nested objects/arrays
// (line_items[0][price_data][unit_amount]=50000), not JSON — see
// toFormBody() below, which mirrors what Stripe's own SDKs do
// internally so a plain fetch call doesn't need one.
const crypto = require('crypto');

const REAL_STRIPE_API_BASE = 'https://api.stripe.com/v1';
const STRIPE_API_BASE = process.env.STRIPE_API_BASE || REAL_STRIPE_API_BASE;

// Stripe secret keys are sk_test_/sk_live_ (restricted keys rk_test_/
// rk_live_) followed by an alphanumeric body. Anything else — unset, a
// placeholder, a publishable pk_ key, a whsec_ pasted into the wrong
// variable — is not a key Stripe would ever accept.
const SECRET_KEY_PATTERN = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const WEBHOOK_SECRET_PATTERN = /^whsec_\S{10,}$/;

function secretKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set — see .env.example');
  }
  return key;
}

// 'live' or 'test', from the configured key's own prefix — or null when
// no recognizable key is configured. Never throws: the activation gate
// (lib/activation.js) calls this on every signed-in request and has to
// keep working (strictly) even when Stripe isn't configured at all.
function stripeKeyMode() {
  const match = SECRET_KEY_PATTERN.exec(process.env.STRIPE_SECRET_KEY || '');
  return match ? match[2] : null;
}

// Hard safety gate for every billing action on the activation-gate /
// usage-fee path — the Stripe counterpart of giftCardProvider.js's
// assertRealGiftCardProviderConfigured(), and the same stance: called
// before anything that would create a Checkout Session, charge a card,
// or unlock a tenant, and a throw is fatal to that action, never caught
// and downgraded to a warning.
//
// What it refuses, and why each one matters:
//   - No STRIPE_SECRET_KEY, or one that isn't shaped like a Stripe
//     secret key at all.
//   - STRIPE_API_BASE pointed anywhere other than Stripe's real API.
//     That variable exists for local stand-ins, and a stand-in answers
//     "succeeded" to everything — so a server left pointed at one would
//     record real tenants as activated, and their usage fees as
//     collected, with no money ever moving. Local tests reach their
//     stand-in below this module instead (scripts/e2e/), never through
//     configuration a real deployment could carry.
//   - With requireWebhookSecret, a STRIPE_WEBHOOK_SECRET that isn't a
//     whsec_ value — the secret is all that stands between this API and
//     a forged "payment succeeded" event.
//
// What it deliberately does *not* refuse is a test-mode key: test mode is
// how this path is verified at all. Test-mode results are flagged instead
// — Stripe stamps livemode: false on every test object, and that flag is
// recorded (tenants.activation_livemode, billing_events.livemode) and
// enforced (lib/activation.js) so nothing done in test mode can ever
// count as real once the API runs on a live key.
//
// Throws rather than returning a boolean, for the same reason the gift
// card gate does: nothing that calls this may decide to proceed anyway.
function assertRealStripeConfigured({ requireWebhookSecret = false } = {}) {
  const problems = [];
  const mode = stripeKeyMode();
  if (!process.env.STRIPE_SECRET_KEY) {
    problems.push('STRIPE_SECRET_KEY is not set');
  } else if (!mode) {
    problems.push('STRIPE_SECRET_KEY is not a Stripe secret key (expected sk_test_/sk_live_ or rk_test_/rk_live_)');
  }
  if (STRIPE_API_BASE !== REAL_STRIPE_API_BASE) {
    problems.push(`STRIPE_API_BASE is "${STRIPE_API_BASE}" — not Stripe's real API (${REAL_STRIPE_API_BASE}), i.e. a stand-in`);
  }
  if (requireWebhookSecret && !WEBHOOK_SECRET_PATTERN.test(process.env.STRIPE_WEBHOOK_SECRET || '')) {
    problems.push('STRIPE_WEBHOOK_SECRET is not set to a whsec_ signing secret');
  }
  if (problems.length) {
    throw new Error(
      `Refusing to run a Stripe billing action against a stub/fake Stripe configuration: ${problems.join('; ')}. ` +
        'Nothing was charged, created, or unlocked. Fix the configuration (see api/.env.example) — a stand-in or ' +
        'placeholder must never be able to make an activation or a usage fee look successful.'
    );
  }
  return { mode, livemode: mode === 'live' };
}

// One line for the server's startup log, so which Stripe mode the API is
// in is never something to infer from behavior. Never includes any part
// of a secret.
function describeStripeConfig() {
  try {
    const { mode } = assertRealStripeConfigured({ requireWebhookSecret: true });
    return mode === 'live'
      ? 'Stripe billing: LIVE mode — activations and usage fees are real charges.'
      : 'Stripe billing: TEST mode — activations and usage fees are Stripe test-mode only and never count once the API runs on a live key.';
  } catch (err) {
    return `Stripe billing: NOT USABLE — ${err.message} Billing-required tenants cannot activate until this is fixed; billing-exempt tenants are unaffected.`;
  }
}

// Recursively flattens a nested JS object/array into Stripe's bracket-
// notation form fields: { a: { b: 1 } } -> "a[b]=1"; { a: [1, 2] } ->
// "a[0]=1&a[1]=2" (Stripe uses indexed notation for arrays, including
// plain string arrays like payment_method_types). `undefined` values are
// skipped entirely (so callers can pass optional fields without an
// `...(x ? {...} : {})` spread at every call site); `null` is sent as
// the literal string "null" only if a caller explicitly needs to clear a
// field — none of the calls below do that.
function flatten(value, prefix, out) {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      flatten(v, prefix ? `${prefix}[${key}]` : key, out);
    }
  } else {
    out.push([prefix, String(value)]);
  }
}

function toFormBody(obj) {
  const pairs = [];
  for (const [key, value] of Object.entries(obj)) {
    flatten(value, key, pairs);
  }
  const params = new URLSearchParams();
  pairs.forEach(([k, v]) => params.append(k, v));
  return params.toString();
}

// `idempotencyKey`, when passed, is sent as Stripe's own Idempotency-Key
// header — a retried request with the same key returns the original
// result rather than creating a second object, per Stripe's documented
// guarantee (including for two genuinely concurrent requests with the
// same key). Every off-session charge passes one — Stage 4's
// per-referral charge and the referral usage fee (lib/referralFee.js),
// see chargeOffSession below — and so does the activation Checkout
// Session (routes/billing.js), so two tabs or two admins starting
// activation at the same moment get one $500 session between them,
// not one each.
async function stripeRequest(path, body, idempotencyKey) {
  let res;
  try {
    res = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${secretKey()}`,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: toFormBody(body),
    });
  } catch (cause) {
    throw outcomeUnknownError(path, cause);
  }

  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw stripeHttpError(res.status, responseBody);
  }
  return responseBody;
}

// A request that never got an HTTP response back (DNS, connection reset,
// timeout). Stripe may or may not have acted on it — a money-moving
// caller must treat the outcome as unknown and retry with the *same*
// Idempotency-Key, never mark it failed and start over.
function outcomeUnknownError(path, cause) {
  const err = new Error(`No response from Stripe for ${path}: ${cause.message}`);
  err.stripeOutcomeUnknown = true;
  return err;
}

// Stripe's own error body, kept intact enough for a caller to act on:
// the decline code a dealer can understand, and — for a declined
// PaymentIntent confirmation — the PaymentIntent Stripe still created,
// so the ledger can point at it. A 5xx (or a 409 for an idempotent
// request still in flight) means Stripe may have processed the request
// anyway, so it's flagged outcome-unknown, same as no response at all.
function stripeHttpError(status, responseBody) {
  const stripeError = responseBody.error || {};
  const err = new Error(stripeError.message || `Stripe request failed (${status})`);
  err.stripeStatus = status;
  err.stripeCode = stripeError.code;
  err.stripeType = stripeError.type;
  err.stripeDeclineCode = stripeError.decline_code;
  err.stripePaymentIntentId = stripeError.payment_intent && stripeError.payment_intent.id;
  err.stripePaymentIntentLivemode = stripeError.payment_intent && stripeError.payment_intent.livemode;
  err.stripeOutcomeUnknown = status >= 500 || status === 409;
  return err;
}

async function stripeGet(path) {
  let res;
  try {
    res = await fetch(`${STRIPE_API_BASE}${path}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${secretKey()}` },
    });
  } catch (cause) {
    throw outcomeUnknownError(path, cause);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw stripeHttpError(res.status, body);
  }
  return body;
}

// Creates a Checkout Session for the one-time activation charge.
// mode: 'payment' (a real charge, not 'setup'). setup_future_usage:
// 'off_session' on the PaymentIntent is what saves the payment method
// for the later off-session charges (the per-referral usage fee) —
// without it, the card/bank account used here couldn't be charged again
// without the customer present. Pricing is inline (price_data), not a
// catalog price id, since activation_fee_cents is per-tenant and
// variable.
//
// customer_creation: 'always' when there's no Customer yet, so the
// completed session is guaranteed to carry a Customer id for the webhook
// to store alongside the saved payment method — the usage fee can't be
// charged without both. (Stripe rejects customer and customer_creation
// together, hence one or the other.)
//
// metadata.kind = 'activation' on the session itself (and on its
// PaymentIntent) is what the webhook checks before treating a paid
// session as an activation: anything else on this Stripe account that
// happens to carry a tenant's id in client_reference_id — a Payment Link
// lets a buyer set that field from the URL — is never mistaken for one.
async function createCheckoutSession({
  tenantId,
  tenantName,
  amountCents,
  currency,
  paymentMethodType,
  existingCustomerId,
  successUrl,
  cancelUrl,
  idempotencyKey,
}) {
  return stripeRequest('/checkout/sessions', {
    mode: 'payment',
    payment_method_types: [paymentMethodType],
    line_items: [
      {
        price_data: {
          currency: (currency || 'usd').toLowerCase(),
          product_data: { name: `${tenantName} — 50. Platform activation` },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      setup_future_usage: 'off_session',
      description: `50. Platform activation — ${tenantName}`,
      metadata: { tenant_id: tenantId, kind: 'activation' },
    },
    metadata: { tenant_id: tenantId, kind: 'activation' },
    // client_reference_id is Stripe's own dedicated field for exactly
    // this — correlating a session back to our own record — read by the
    // checkout.session.completed webhook handler.
    client_reference_id: tenantId,
    customer: existingCustomerId || undefined,
    customer_creation: existingCustomerId ? undefined : 'always',
    success_url: successUrl,
    cancel_url: cancelUrl,
  }, idempotencyKey);
}

// Reads back a Checkout Session — used to reuse a tenant's still-open
// activation session instead of creating a second one, and to see that
// one has already been paid while its webhook is still on the way.
async function retrieveCheckoutSession(sessionId) {
  return stripeGet(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

// A Checkout Session's payment_intent is a string id unless the request
// asked Stripe to expand it into the full object — either way, the id.
function paymentIntentIdOf(session) {
  const pi = session && session.payment_intent;
  return typeof pi === 'string' ? pi : (pi && pi.id) || null;
}

// Stage 4's per-referral reward charge: creates and confirms a
// PaymentIntent against a tenant's already-saved payment method, with
// nobody present to authorize it (off_session: true — this is what tells
// Stripe not to attempt any interactive authentication and instead fail
// outright, synchronously, if the payment method needs it). confirm:
// true does the "create and confirm" in one call rather than two.
//
// idempotencyKey is required, not optional — every caller of this
// function is charging real money with nobody watching, so it must
// always be safe to retry (a crashed process, a network timeout after
// Stripe already received the request) without risking a double charge.
// Derived by the caller from the referral id, so the exact same
// PaymentIntent is returned no matter how many times (or how many
// concurrent processes) attempt this same referral's charge — this is
// the authoritative guard against a double charge, not any locking on
// our own side (see workers/rewardIssuance.js for why).
//
// On a synchronous decline, Stripe responds with a non-2xx status and an
// error body — stripeRequest's existing !res.ok handling already throws
// for that, with err.stripeCode set (e.g. 'card_declined'), so callers
// use the same try/catch shape as every other Stripe call in this file.
async function chargeOffSession({ customerId, paymentMethodId, amountCents, currency, metadata, description, idempotencyKey }) {
  if (!idempotencyKey) {
    throw new Error('chargeOffSession requires an idempotencyKey — refusing to charge without one');
  }
  return stripeRequest(
    '/payment_intents',
    {
      amount: amountCents,
      currency: (currency || 'usd').toLowerCase(),
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description,
      metadata,
    },
    idempotencyKey
  );
}

// checkout.session.completed's payload only gives payment_intent as a
// string id, not the expanded object — this is the follow-up call to
// read its .payment_method (also a string id) so the tenant's saved
// payment method can be stored. GET, not POST: no form body.
async function retrievePaymentIntent(paymentIntentId) {
  return stripeGet(`/payment_intents/${encodeURIComponent(paymentIntentId)}`);
}

// Verifies a webhook request's Stripe-Signature header against the raw
// request body, per Stripe's publicly documented scheme: the header is
// `t=<unix seconds>,v1=<hex hmac>[,v0=...]`; the signed payload is
// `${t}.${rawBody}`; the expected signature is
// HMAC-SHA256(webhookSecret, signedPayload). Pure local computation, no
// network call — this is why webhook verification can be fully tested
// without live Stripe connectivity, unlike createCheckoutSession above.
// Returns the parsed event on success; throws on a missing/malformed
// header, a signature mismatch, or a timestamp outside the tolerance
// window (replay protection, same 5-minute default Stripe's own SDKs use).
function verifyWebhookSignature(rawBody, signatureHeader, webhookSecret, toleranceSeconds = 300) {
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set — see .env.example');
  }
  if (!signatureHeader) {
    throw new Error('Missing Stripe-Signature header');
  }

  const parts = {};
  for (const kv of signatureHeader.split(',')) {
    const idx = kv.indexOf('=');
    if (idx === -1) continue;
    parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  }
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) {
    throw new Error('Malformed Stripe-Signature header');
  }

  const rawBodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBodyBuffer]);
  const expected = crypto.createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(v1, 'hex');
  if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
    throw new Error('Webhook signature verification failed');
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (ageSeconds > toleranceSeconds) {
    throw new Error('Webhook timestamp outside tolerance — possible replay');
  }

  return JSON.parse(rawBodyBuffer.toString('utf8'));
}

module.exports = {
  REAL_STRIPE_API_BASE,
  assertRealStripeConfigured,
  stripeKeyMode,
  describeStripeConfig,
  createCheckoutSession,
  retrieveCheckoutSession,
  paymentIntentIdOf,
  chargeOffSession,
  retrievePaymentIntent,
  verifyWebhookSignature,
};
