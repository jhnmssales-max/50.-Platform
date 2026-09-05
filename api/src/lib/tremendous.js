// Thin wrapper over Tremendous's Orders API — no SDK, just fetch, same
// pattern as src/lib/postmark.js. Each call uses the *calling tenant's own*
// API key, funding source, and campaign (never a platform-wide credential),
// so a reward is always funded by — and branded as — the company whose
// customer is earning it.
//
// Smoke-tested against Tremendous's real sandbox (testflight.tremendous.com)
// with a live test API key. That run is what surfaced campaign_id as
// effectively required — Tremendous rejects an order with neither a
// campaign_id nor a products list — which is why it's a required argument
// here, not an optional extra like it first looked from documentation
// alone.
const TREMENDOUS_API_BASE = process.env.TREMENDOUS_API_BASE || 'https://api.tremendous.com/api/v2';

// Creates a single-reward order, funded by the tenant's own funding
// source under the tenant's own campaign, delivered by email to the
// recipient. `idempotencyKey` is passed as Tremendous's own
// Idempotency-Key header (a retried request with the same key returns the
// original order rather than issuing a second one) — belt-and-suspenders
// alongside our own gift_card_transactions unique constraint on the same
// key.
async function createOrder({ apiKey, fundingSourceId, campaignId, amountCents, currency, recipientName, recipientEmail, idempotencyKey }) {
  if (!apiKey) throw new Error('No Tremendous API key provided');
  if (!fundingSourceId) throw new Error('No Tremendous funding source configured');
  if (!campaignId) throw new Error('No Tremendous campaign configured');

  const res = await fetch(`${TREMENDOUS_API_BASE}/orders`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({
      payment: { funding_source_id: fundingSourceId },
      reward: {
        value: { denomination: amountCents / 100, currency_code: currency || 'USD' },
        delivery: { method: 'EMAIL' },
        recipient: { name: recipientName, email: recipientEmail },
        campaign_id: campaignId,
      },
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (body.errors && body.errors[0] && (body.errors[0].message || body.errors[0].code)) ||
      body.message ||
      `Tremendous request failed (${res.status})`;
    const err = new Error(message);
    err.tremendousStatus = res.status;
    throw err;
  }

  const order = body.order || body;
  return { orderId: order.id, raw: order };
}

module.exports = { createOrder };
