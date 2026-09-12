// Thin wrapper over Stripe's API — no SDK, just fetch, same pattern as
// src/lib/postmark.js and src/lib/tremendous.js. The one thing Stripe's
// REST API does differently from those two: request bodies are
// form-encoded with bracket notation for nested objects/arrays
// (line_items[0][price_data][unit_amount]=50000), not JSON — see
// toFormBody() below, which mirrors what Stripe's own SDKs do
// internally so a plain fetch call doesn't need one.
const crypto = require('crypto');

const STRIPE_API_BASE = process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1';

function secretKey() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set — see .env.example');
  }
  return key;
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
// same key). createCheckoutSession/retrievePaymentIntent never need
// this (the checkout flow has its own natural one-shot shape); Stage 4's
// off-session per-referral charge does — see chargeOffSession below.
async function stripeRequest(path, body, idempotencyKey) {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${secretKey()}`,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: toFormBody(body),
  });

  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (responseBody.error && responseBody.error.message) || `Stripe request failed (${res.status})`;
    const err = new Error(message);
    err.stripeStatus = res.status;
    err.stripeCode = responseBody.error && responseBody.error.code;
    throw err;
  }
  return responseBody;
}

// Creates a Checkout Session for the one-time activation charge.
// setup_future_usage: 'off_session' on the PaymentIntent is what saves
// the payment method for Stage 4's later off-session per-referral
// charges — without it, the card/bank account used here couldn't be
// charged again without the customer present. Pricing is inline
// (price_data), not a catalog price id, since activation_fee_cents is
// per-tenant and variable.
async function createCheckoutSession({
  tenantId,
  tenantName,
  amountCents,
  currency,
  paymentMethodType,
  existingCustomerId,
  successUrl,
  cancelUrl,
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
      metadata: { tenant_id: tenantId, kind: 'activation' },
    },
    // client_reference_id is Stripe's own dedicated field for exactly
    // this — correlating a session back to our own record — read by the
    // checkout.session.completed webhook handler.
    client_reference_id: tenantId,
    customer: existingCustomerId || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
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
async function chargeOffSession({ customerId, paymentMethodId, amountCents, currency, metadata, idempotencyKey }) {
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
  const res = await fetch(`${STRIPE_API_BASE}/payment_intents/${paymentIntentId}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${secretKey()}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body.error && body.error.message) || `Stripe request failed (${res.status})`;
    const err = new Error(message);
    err.stripeStatus = res.status;
    throw err;
  }
  return body;
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

module.exports = { createCheckoutSession, chargeOffSession, retrievePaymentIntent, verifyWebhookSignature };
