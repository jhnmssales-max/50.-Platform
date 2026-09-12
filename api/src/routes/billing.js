const express = require('express');
const cors = require('cors');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');
const { createCheckoutSession } = require('../lib/stripe');

const router = express.Router();

router.use(cors());

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

async function requireAdminCtx(client, userId) {
  const ctx = await getCallerContext(client, userId);
  if (!ctx) throw forbidden('No staff account found for this user');
  if (!ctx.is_admin) throw forbidden('Admin access required');
  return ctx;
}

// ---------------------------------------------------------------------------
// POST /api/billing/checkout-session — starts the one-time activation
// charge. Admin-only, same as every other tenant-wide billing/payment
// setting in this API.
//
// Pricing is inline (price_data in src/lib/stripe.js), not a Stripe
// catalog price id, since activation_fee_cents is per-tenant and
// variable. setup_future_usage: 'off_session' on the PaymentIntent is
// what lets Stage 4 charge the same payment method later with nobody
// present to re-authorize it.
//
// This also computes and stores monthly_spend_cap_cents from the
// tenant's own per_referral_charge_cents (roughly 20 referrals' worth),
// rather than leaving it at the schema's flat 400000 default — a
// higher-reward tenant would otherwise hit that default cap after only
// two or three referrals, which isn't a guardrail at that point, it's
// just broken. Recomputed every time this endpoint is called (harmless
// if called more than once before the customer completes checkout — the
// tenant's pricing hasn't changed, so the result is identical).
// ---------------------------------------------------------------------------
router.post('/billing/checkout-session', requireAuth, async (req, res, next) => {
  try {
    const ctx = await withUserTransaction(req.userId, async (client) => {
      const ctx = await requireAdminCtx(client, req.userId);

      if (ctx.activation_paid_at) {
        throw conflict('This tenant has already completed activation');
      }

      const monthlySpendCapCents = ctx.per_referral_charge_cents * 20;
      await client.query('update tenants set monthly_spend_cap_cents = $1 where id = $2', [
        monthlySpendCapCents,
        ctx.tenant_id,
      ]);

      return ctx;
    });

    // The API's own origin, not FRONTEND_BASE_URL — these two redirect
    // pages are served statically by this same Express app (see
    // server.js), not by wherever the tenant-branded frontend pages
    // happen to live, so they need no config of their own to stay in
    // sync with wherever this API is actually deployed. Respects
    // TRUST_PROXY the same way the rate limiter does (server.js).
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const session = await createCheckoutSession({
      tenantId: ctx.tenant_id,
      tenantName: ctx.tenant_name,
      amountCents: ctx.activation_fee_cents,
      currency: ctx.reward_currency,
      paymentMethodType: ctx.payment_method_type,
      existingCustomerId: ctx.stripe_customer_id,
      successUrl: `${baseUrl}/billing/activation-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/billing/activation-cancelled.html`,
    });

    // Never the full session object — it can carry more than this route
    // needs to hand back, and this keeps the response shape stable
    // regardless of what Stripe's own payload happens to include.
    res.status(201).json({ url: session.url, session_id: session.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
