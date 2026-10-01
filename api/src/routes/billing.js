const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, withServiceRole, getCallerContext, assertRowsAffected } = require('../db');
const {
  assertRealStripeConfigured,
  createCheckoutSession,
  retrieveCheckoutSession,
  retrievePaymentIntent,
  paymentIntentIdOf,
} = require('../lib/stripe');

const router = express.Router();

router.use(cors());

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

function conflict(message, publicCode) {
  const err = new Error(message);
  err.status = 409;
  if (publicCode) err.publicCode = publicCode;
  return err;
}

async function requireAdminCtx(client, userId, options) {
  const ctx = await getCallerContext(client, userId, options);
  if (!ctx) throw forbidden('No staff account found for this user');
  if (!ctx.is_admin) throw forbidden('Admin access required');
  return ctx;
}

// Where Stripe sends the browser back to. By default, this API's own two
// static pages (the request's own origin, not FRONTEND_BASE_URL — they're
// served by this same Express app, see server.js, so they need no config
// of their own; respects TRUST_PROXY the same way the rate limiter does).
//
// When the dealer page passes its own address as return_url, and that
// address is on FRONTEND_BASE_URL's origin — the same setting invite
// links are already built from — Stripe sends the admin straight back to
// the dealer page instead, with ?activation=success|cancelled. Any other
// origin is ignored (an allowlist, not an open redirect through
// Stripe). The return itself unlocks nothing: the page only waits there
// for GET /api/me to report the webhook-confirmed activation.
function resolveReturnUrls(req, returnUrl) {
  const apiBase = `${req.protocol}://${req.get('host')}`;
  const fallback = {
    successUrl: `${apiBase}/billing/activation-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${apiBase}/billing/activation-cancelled.html`,
  };
  if (!returnUrl) return fallback;

  let target;
  let allowedOrigin;
  try {
    target = new URL(returnUrl);
    allowedOrigin = new URL(process.env.FRONTEND_BASE_URL).origin;
  } catch (err) {
    console.warn(`Activation return_url ignored (unparseable, or FRONTEND_BASE_URL unset): ${returnUrl}`);
    return fallback;
  }
  if (target.origin !== allowedOrigin) {
    console.warn(`Activation return_url ignored — ${target.origin} is not FRONTEND_BASE_URL's origin (${allowedOrigin})`);
    return fallback;
  }
  // Query/fragment dropped; {CHECKOUT_SESSION_ID} is Stripe's own
  // template literal and must reach Stripe unencoded.
  const base = `${target.origin}${target.pathname}`;
  return {
    successUrl: `${base}?activation=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}?activation=cancelled`,
  };
}

// What became of the tenant's most recent activation Checkout Session:
//   - 'open'       — still payable; send the admin back to it rather
//                    than opening a second $500 checkout.
//   - 'processing' — paid (or a bank debit still settling); the
//                    webhook that actually activates the tenant hasn't
//                    landed yet. Creating another session here is how a
//                    tenant ends up paying twice.
//   - 'gone'       — expired, failed, or not visible to this key (e.g.
//                    created in the other Stripe mode); start fresh.
async function inspectLastSession(sessionId, stripeConfig) {
  let session;
  try {
    session = await retrieveCheckoutSession(sessionId);
  } catch (err) {
    if (err.stripeStatus === 404) return { kind: 'gone' };
    throw err;
  }
  if ((session.livemode === true) !== stripeConfig.livemode) return { kind: 'gone' };
  if (session.status === 'open' && session.url) return { kind: 'open', session };
  if (session.status === 'complete') {
    if (session.payment_status === 'paid') return { kind: 'processing' };
    const paymentIntentId = paymentIntentIdOf(session);
    if (paymentIntentId) {
      const paymentIntent = await retrievePaymentIntent(paymentIntentId);
      if (paymentIntent.status === 'processing' || paymentIntent.status === 'succeeded') return { kind: 'processing' };
    }
  }
  return { kind: 'gone' };
}

// ---------------------------------------------------------------------------
// POST /api/billing/checkout-session — the one-time activation charge, and
// the page a billing-required tenant's admin is sent to on sign-in until
// it's paid (see fifty-template-dealer.html). Admin-only, same as every
// other tenant-wide billing/payment setting in this API: the card used
// here becomes the tenant's saved payment method for every later usage
// fee, so it can't be whichever staff member happened to sign in first.
// Reachable while the tenant is still unactivated (allowUnactivatedTenant
// — see db.js's getCallerContext); every other staff route is not.
//
// Never creates a session for a billing-exempt tenant (Good Steward
// Structures, North Mountain Structures, 50. itself), checked before any
// Stripe configuration is even consulted — those tenants are never
// charged, regardless of any other setting.
//
// Pricing is inline (price_data in src/lib/stripe.js), not a Stripe
// catalog price id, since activation_fee_cents is per-tenant and
// variable (default $500). setup_future_usage: 'off_session' on the
// PaymentIntent is what lets the usage fee charge the same payment
// method later with nobody present to re-authorize it.
//
// This also computes and stores monthly_spend_cap_cents from the
// tenant's own per_referral_charge_cents (roughly 20 referrals' worth),
// rather than leaving it at the schema's flat 400000 default — a
// higher-reward tenant would otherwise hit that default cap after only
// two or three referrals, which isn't a guardrail at that point, it's
// just broken. Recomputed every time this endpoint is called (harmless
// if called more than once before the customer completes checkout — the
// tenant's pricing hasn't changed, so the result is identical).
//
// Nothing here marks the tenant activated. Only Stripe's webhook does
// (routes/webhooks.js), once Stripe itself confirms the payment
// succeeded — never this endpoint, and never the browser returning from
// Checkout.
// ---------------------------------------------------------------------------
const checkoutSessionSchema = z.object({
  return_url: z.string().trim().url().max(2000).optional(),
});

router.post('/billing/checkout-session', requireAuth, async (req, res, next) => {
  const parsed = checkoutSessionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  try {
    const ctx = await withUserTransaction(req.userId, async (client) => {
      const ctx = await requireAdminCtx(client, req.userId, { allowUnactivatedTenant: true });

      if (ctx.billing_required === false) {
        throw conflict('This account isn\'t billed by 50., so there\'s no activation to pay.', 'billing_not_required');
      }
      if (!ctx.activation.required) {
        throw conflict('This tenant has already completed activation', 'already_activated');
      }

      const monthlySpendCapCents = ctx.per_referral_charge_cents * 20;
      await client.query('update tenants set monthly_spend_cap_cents = $1 where id = $2', [
        monthlySpendCapCents,
        ctx.tenant_id,
      ]);

      return ctx;
    });

    // Refuses a stub/fake Stripe configuration before any Stripe call —
    // see lib/stripe.js. A 500 to the caller (logged in full here), not a
    // fake checkout page.
    const stripeConfig = assertRealStripeConfigured();

    if (ctx.activation_checkout_session_id) {
      const last = await inspectLastSession(ctx.activation_checkout_session_id, stripeConfig);
      if (last.kind === 'open') {
        return res.status(200).json({ url: last.session.url, session_id: last.session.id, reused: true });
      }
      if (last.kind === 'processing') {
        return res.status(202).json({ status: 'processing' });
      }
    }

    // A saved Customer only exists in the Stripe mode it was created in —
    // a test-mode cus_ is "No such customer" to a live key, and vice
    // versa — and activation_livemode is the one record of which mode
    // that was. So it's reused only when the modes match; otherwise (a
    // dealer activated in test mode, re-paying for real once the API runs
    // on a live key) Checkout creates a fresh Customer instead of failing.
    const existingCustomerId = ctx.activation_livemode === stripeConfig.livemode ? ctx.stripe_customer_id : null;

    const { successUrl, cancelUrl } = resolveReturnUrls(req, parsed.data.return_url);
    const sessionParams = {
      tenantId: ctx.tenant_id,
      tenantName: ctx.tenant_name,
      amountCents: ctx.activation_fee_cents,
      currency: ctx.reward_currency,
      paymentMethodType: ctx.payment_method_type,
      existingCustomerId,
      successUrl,
      cancelUrl,
    };
    // The reuse check above is check-then-act: two requests at the same
    // moment (two tabs, two admins) can both find nothing to reuse. This
    // key makes Stripe itself collapse them into one session — same
    // tenant, same previous session, same parameters -> the same
    // Checkout Session back, never a second $500 one. A new key whenever
    // the previous session changes (expired, paid-but-failed) or the
    // parameters differ (Stripe would reject reusing a key with different
    // ones).
    const paramsHash = crypto.createHash('sha256').update(JSON.stringify(sessionParams)).digest('hex').slice(0, 16);
    const idempotencyKey = `activation_checkout:${ctx.tenant_id}:${ctx.activation_checkout_session_id || 'none'}:${paramsHash}`;

    let session;
    for (let attempt = 1; ; attempt += 1) {
      try {
        session = await createCheckoutSession({ ...sessionParams, idempotencyKey });
        break;
      } catch (err) {
        // 409: the identical request from the other tab is still in
        // flight at Stripe. Wait for it and get its session back.
        if (err.stripeStatus !== 409 || attempt >= 3) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }

    // Service role, not the admin's own transaction: tenants'
    // billing columns are deliberately not writable by the authenticated
    // role at all (see the activation-gate migration). Scoped to the
    // tenant id this same request already resolved through RLS above.
    await withServiceRole(async (client) => {
      const result = await client.query('update tenants set activation_checkout_session_id = $1 where id = $2', [
        session.id,
        ctx.tenant_id,
      ]);
      await assertRowsAffected(client, result, { table: 'tenants', id: ctx.tenant_id });
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
