const express = require('express');
const { verifyWebhookSignature, retrievePaymentIntent } = require('../lib/stripe');
const { withServiceRole } = require('../db');

const router = express.Router();

// No cors() here, deliberately — Stripe calls this server-to-server,
// never from a browser, and there's no bearer token or cookie for CORS
// to be a meaningful gate around in the first place.
//
// express.raw() on this route only: the signature Stripe sends covers
// the *exact bytes* of the request body, so this must never pass
// through express.json() first — see server.js, where this router is
// mounted before the app-wide express.json() specifically so that
// ordering can't accidentally regress.
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = verifyWebhookSignature(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // Deliberately not next(err)/the app's JSON error handler — Stripe
    // doesn't read a response body on failure, and logging here is what
    // actually matters (a bad signature means either a misconfigured
    // secret or someone probing this endpoint, both worth seeing).
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send('Invalid signature');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      // Stage 3 adds payment_intent.payment_failed and
      // charge.dispute.created as cases here — same handler, same
      // signature-verified entry point, not a new route.
      default:
        // Ack anything this stage doesn't act on. Stripe retries a
        // non-2xx response with backoff; there's nothing to retry
        // toward for an event type we were never going to handle.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error(`Failed to process Stripe webhook ${event.type} (${event.id}):`, err.message);
    // 500 here, unlike the default case above, is intentional: this is
    // a genuine processing failure (e.g. a transient DB error) on an
    // event type we do act on, and Stripe's retry-with-backoff is
    // exactly the right recovery for that — an ack would silently drop
    // a real activation.
    res.status(500).json({ error: 'Failed to process event' });
  }
});

// mode: 'payment' Checkout Sessions can complete before the payment has
// actually cleared for a delayed-notification payment method — ACH debit
// (payment_method_type: 'us_bank_account') is exactly that: Checkout
// completes as soon as the customer submits their bank details, but the
// debit itself takes days to settle and can still fail. Stripe's own
// guidance is to gate on payment_status ('paid' vs 'unpaid') rather than
// treat completion itself as success, and to also listen for
// checkout.session.async_payment_succeeded/async_payment_failed for the
// delayed-payment-method outcome.
//
// This handler correctly refuses to activate on anything but
// payment_status === 'paid' — but does NOT yet handle the async_payment_*
// events, so a us_bank_account tenant's activation currently has no
// terminal outcome recorded here if it completes with payment_status
// still 'unpaid' (the debit is still processing) and later succeeds or
// fails asynchronously. That's a real gap for bank-account tenants
// specifically, not silently papered over — worth its own follow-up,
// likely alongside Stage 3's webhook work since it's the same handler.
async function handleCheckoutSessionCompleted(session) {
  if (session.mode !== 'payment') return; // not our activation checkout
  if (session.payment_status !== 'paid') return; // see comment above — not yet a terminal outcome

  const tenantId = session.client_reference_id;
  if (!tenantId) {
    throw new Error(`checkout.session.completed with no client_reference_id (session ${session.id})`);
  }

  let paymentMethodId = null;
  if (session.payment_intent) {
    const paymentIntent = await retrievePaymentIntent(session.payment_intent);
    paymentMethodId = paymentIntent.payment_method || null;
  }

  await withServiceRole(async (client) => {
    // Idempotent on activation_paid_at IS NULL: Stripe redelivers events
    // (at-least-once delivery is the norm, not an edge case), and this
    // must be a no-op on a redelivery of an event we've already acted
    // on — never a second write, and never an error either, since
    // Stripe expects a 2xx for an event it considers already delivered
    // successfully just as much as for a genuinely new one.
    await client.query(
      `update tenants
       set stripe_customer_id = $1,
           stripe_payment_method_id = coalesce($2, stripe_payment_method_id),
           billing_status = 'active',
           activation_paid_at = now()
       where id = $3 and activation_paid_at is null`,
      [session.customer, paymentMethodId, tenantId]
    );
  });
}

module.exports = router;
