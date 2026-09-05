// Thin wrapper over Tremendous's Orders API — no SDK, just fetch, same
// pattern as src/lib/postmark.js. Each call uses the *calling tenant's own*
// API key and funding source (never a platform-wide credential), so a
// reward is always funded by the company whose customer is earning it.
//
// NOTE: built from documentation knowledge as of this integration's write
// date, not verified against a live Tremendous account or their current
// API reference (this sandbox's network egress blocks reaching
// developers.tremendous.com). Before relying on this against a real
// funding source, smoke-test one order against Tremendous's own sandbox
// (TREMENDOUS_API_BASE=https://testflight.tremendous.com/api/v2) and
// confirm the request/response shape below still matches their docs.
const TREMENDOUS_API_BASE = process.env.TREMENDOUS_API_BASE || 'https://api.tremendous.com/api/v2';

// Creates a single-reward order, funded by the tenant's own funding
// source, delivered by email to the recipient. `idempotencyKey` is passed
// as Tremendous's own Idempotency-Key header (a retried request with the
// same key returns the original order rather than issuing a second one) —
// belt-and-suspenders alongside our own gift_card_transactions unique
// constraint on the same key.
async function createOrder({ apiKey, fundingSourceId, amountCents, currency, campaignId, recipientName, recipientEmail, idempotencyKey }) {
  if (!apiKey) throw new Error('No Tremendous API key provided');
  if (!fundingSourceId) throw new Error('No Tremendous funding source configured');

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
        ...(campaignId ? { campaign_id: campaignId } : {}),
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
