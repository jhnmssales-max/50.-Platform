const express = require('express');
const {
  verifyWebhookSignature,
  retrievePaymentIntent,
  assertRealStripeConfigured,
  stripeKeyMode,
  paymentIntentIdOf,
} = require('../lib/stripe');
const { withServiceRole, assertRowsAffected } = require('../db');

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
        await handleCheckoutSessionCompleted(event.data.object, event.id);
        break;
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutSessionAsyncPaymentSucceeded(event.data.object, event.id);
        break;
      case 'checkout.session.async_payment_failed':
        await handleCheckoutSessionAsyncPaymentFailed(event.data.object, event.id);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentIntentPaymentFailed(event.data.object, event.id);
        break;
      case 'charge.dispute.created':
        await handleChargeDisputeCreated(event.data.object, event.id);
        break;
      default:
        // Ack anything else. Stripe retries a non-2xx response with
        // backoff; there's nothing to retry toward for an event type we
        // were never going to handle.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error(`Failed to process Stripe webhook ${event.type} (${event.id}):`, err.message);
    // 500 here, unlike the default case above, is intentional: this is
    // a genuine processing failure (e.g. a transient DB error, or the
    // assertRowsAffected below firing) on an event type we do act on,
    // and Stripe's retry-with-backoff is exactly the right recovery for
    // that — an ack would silently drop a real activation or a real
    // suspension.
    res.status(500).json({ error: 'Failed to process event' });
  }
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Every billing_events insert in this file goes through this — ON
// CONFLICT (stripe_event_id) DO NOTHING is what makes a Stripe
// redelivery of an already-processed event a true no-op rather than a
// second row or a second side effect. Returns the inserted row, or
// undefined if this exact event was already recorded.
async function recordBillingEvent(
  client,
  { tenantId, referralId, eventType, amountCents, rewardAmountCents, platformFeeCents, stripePaymentIntentId, status, errorDetail, stripeEventId, livemode }
) {
  const { rows: [inserted] } = await client.query(
    `insert into billing_events
       (tenant_id, referral_id, event_type, amount_cents, reward_amount_cents, platform_fee_cents,
        stripe_payment_intent_id, status, error_detail, stripe_event_id, livemode)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (stripe_event_id) do nothing
     returning id`,
    [
      tenantId,
      referralId || null,
      eventType,
      amountCents,
      rewardAmountCents || null,
      platformFeeCents || null,
      stripePaymentIntentId || null,
      status,
      errorDetail || null,
      stripeEventId || null,
      typeof livemode === 'boolean' ? livemode : null,
    ]
  );
  return inserted;
}

// Activates a tenant: records the activation_charge billing_events row
// (idempotent on stripeEventId), then flips billing_status/
// activation_paid_at/activation_livemode/stripe_customer_id/
// stripe_payment_method_id. Shared by checkout.session.completed (when
// payment_status is already 'paid') and
// checkout.session.async_payment_succeeded (the delayed ACH-clears-later
// outcome) — same end state, two different Stripe events can lead here.
// This is the only place in the codebase that ever sets
// activation_paid_at — i.e. the only thing that lifts the activation
// gate — and it only runs on a signature-verified Stripe event saying
// the payment succeeded, never on a browser returning from Checkout.
//
// livemode is Stripe's own flag on the paid session. A live payment
// always activates, including over an earlier test-mode activation (the
// WHERE clause's second half) — otherwise a tenant that had once been
// "activated" in test mode could pay real money and stay locked, since
// lib/activation.js doesn't count test-mode activations on a live key.
async function activateTenant({ tenantId, eventId, paymentIntentId, paymentMethodId, customerId, amountCents, livemode }) {
  // Defense in depth — finishActivationFromSession, the only caller,
  // already asserted this. The one place that unlocks a tenant refuses a
  // stub/fake Stripe configuration itself rather than trusting every
  // future caller to have checked.
  assertRealStripeConfigured({ requireWebhookSecret: true });

  await withServiceRole(async (client) => {
    const inserted = await recordBillingEvent(client, {
      tenantId,
      eventType: 'activation_charge',
      amountCents,
      stripePaymentIntentId: paymentIntentId,
      status: 'succeeded',
      stripeEventId: eventId,
      livemode,
    });
    if (!inserted) {
      console.log(`Stripe event ${eventId} already processed — activation no-op for tenant ${tenantId}`);
      return;
    }

    const { rows: [tenant] } = await client.query('select billing_required from tenants where id = $1', [tenantId]);
    if (tenant && tenant.billing_required === false) {
      // Should be impossible — POST /api/billing/checkout-session never
      // creates a session for an exempt tenant — but money has moved, so
      // it's recorded (above) and shouted about rather than dropped.
      console.error(
        `BILLING-EXEMPT TENANT CHARGED — tenant ${tenantId} is billing_required = false but paid an activation charge (${paymentIntentId}, event ${eventId}). Refund it in Stripe.`
      );
    }
    if (!livemode && stripeKeyMode() === 'live') {
      console.error(
        `TEST-MODE activation received by a live-mode API — tenant ${tenantId}, event ${eventId}. Recorded, but it will not unlock the tenant (lib/activation.js). Check that STRIPE_WEBHOOK_SECRET is the live endpoint's secret.`
      );
    }
    if (!customerId || !paymentMethodId) {
      console.error(
        `ACTIVATION WITHOUT SAVED PAYMENT METHOD — tenant ${tenantId} (event ${eventId}) customer=${customerId || 'none'} payment_method=${paymentMethodId || 'none'}. The tenant is unlocked, but its referral usage fee can't be charged until a payment method is saved.`
      );
    }

    const result = await client.query(
      `update tenants
       set stripe_customer_id = $1,
           stripe_payment_method_id = $2,
           billing_status = 'active',
           activation_paid_at = now(),
           activation_livemode = $4
       where id = $3
         and (activation_paid_at is null or ($4 and activation_livemode is distinct from true))`,
      [customerId, paymentMethodId, tenantId, livemode === true]
    );

    if (result.rowCount === 0) {
      // Two different Stripe events (e.g. an immediate 'paid' completion
      // racing an async success) can both reach here for the same
      // tenant — check whether this is that benign case before treating
      // 0 rows as a real failure.
      const { rows: [current] } = await client.query('select activation_paid_at from tenants where id = $1', [tenantId]);
      if (current && current.activation_paid_at) {
        // Benign only if it's the same payment. A *different* succeeded
        // activation payment means the tenant paid twice (e.g. two admins
        // completing two checkouts at once) — both are in the ledger;
        // this makes sure a human hears about the second one.
        const { rows: earlier } = await client.query(
          `select stripe_payment_intent_id from billing_events
           where tenant_id = $1 and event_type = 'activation_charge' and status = 'succeeded'
             and stripe_payment_intent_id is distinct from $2`,
          [tenantId, paymentIntentId]
        );
        if (earlier.length) {
          console.error(
            `DUPLICATE ACTIVATION PAYMENT — tenant ${tenantId} was already activated (${earlier.map((r) => r.stripe_payment_intent_id).join(', ')}) and paid again (${paymentIntentId}, event ${eventId}). Refund the duplicate in Stripe.`
          );
        } else {
          console.log(`Tenant ${tenantId} already activated (lost a benign race to another event) — event ${eventId}`);
        }
        return;
      }
      await assertRowsAffected(client, result, { table: 'tenants', id: tenantId });
    }

    console.log(`ACTIVATION tenant ${tenantId} activated by ${paymentIntentId} (livemode=${livemode === true}, event ${eventId})`);
  });
}

// Suspends a tenant's billing: records the failure/dispute billing_events
// row (idempotent on stripeEventId), then flips billing_status to
// 'suspended' unless it's already there. Shared by
// payment_intent.payment_failed and charge.dispute.created.
async function suspendTenantBilling({ tenantId, referralId, eventType, amountCents, stripePaymentIntentId, errorDetail, eventId, livemode }) {
  await withServiceRole(async (client) => {
    const inserted = await recordBillingEvent(client, {
      tenantId,
      referralId,
      eventType,
      amountCents,
      stripePaymentIntentId,
      status: eventType === 'dispute_created' ? 'disputed' : 'failed',
      errorDetail,
      stripeEventId: eventId,
      livemode,
    });
    if (!inserted) {
      console.log(`Stripe event ${eventId} already processed — suspend no-op for tenant ${tenantId}`);
      return;
    }

    const result = await client.query(
      `update tenants set billing_status = 'suspended' where id = $1 and billing_status is distinct from 'suspended'`,
      [tenantId]
    );

    if (result.rowCount === 0) {
      // Already suspended by a different event (e.g. a second failed
      // charge, or a dispute on an already-failed tenant) is benign —
      // the desired end state already holds.
      const { rows: [current] } = await client.query('select billing_status from tenants where id = $1', [tenantId]);
      if (current && current.billing_status === 'suspended') {
        console.log(`Tenant ${tenantId} already suspended — event ${eventId} no-op`);
        return;
      }
      await assertRowsAffected(client, result, { table: 'tenants', id: tenantId });
    }

    console.error(`Billing suspended for tenant ${tenantId}: ${errorDetail} (event ${eventId})`);
  });
}

// ---------------------------------------------------------------------------
// checkout.session.completed / async_payment_succeeded / async_payment_failed
//
// mode: 'payment' Checkout Sessions can complete before the payment has
// actually cleared for a delayed-notification payment method — ACH debit
// (payment_method_type: 'us_bank_account') is exactly that: Checkout
// completes as soon as the customer submits their bank details, but the
// debit itself takes days to settle and can still fail. This is why
// there are three handlers here, not one: `completed` fires immediately
// regardless of how the payment method eventually resolves; the async_*
// events are what carry the actual outcome for a delayed method.
//
// All three first confirm the session is one this API created for
// activation (isActivationSession below) before touching any tenant.
// ---------------------------------------------------------------------------

// Only a Checkout Session created by POST /api/billing/checkout-session —
// metadata.kind 'activation' naming this same tenant — can activate a
// tenant. Anything else on this Stripe account that happens to carry a
// tenant's id in client_reference_id (a Payment Link lets a buyer set
// that field from the URL, at whatever price that link charges) is
// ignored. Sessions created before session-level metadata existed carry
// the same marker on their PaymentIntent instead, so that's checked for
// them.
async function isActivationSession(session, tenantId) {
  const metadata = session.metadata || {};
  if (metadata.kind) {
    return metadata.kind === 'activation' && metadata.tenant_id === tenantId;
  }
  const paymentIntentId = paymentIntentIdOf(session);
  if (!paymentIntentId) return false;
  const paymentIntent = await retrievePaymentIntent(paymentIntentId);
  const piMetadata = paymentIntent.metadata || {};
  return piMetadata.kind === 'activation' && piMetadata.tenant_id === tenantId;
}

async function handleCheckoutSessionCompleted(session, eventId) {
  if (session.mode !== 'payment') return; // not our activation checkout

  const tenantId = session.client_reference_id;
  if (!tenantId) {
    throw new Error(`checkout.session.completed with no client_reference_id (session ${session.id})`);
  }
  if (!(await isActivationSession(session, tenantId))) {
    console.error(
      `checkout.session.completed for session ${session.id} names tenant ${tenantId} but is not an activation session this API created — ignored, nothing activated (event ${eventId})`
    );
    return;
  }

  // Recorded regardless of payment_status — this is what makes a
  // stalled ACH activation (completed, still unpaid, however long ago)
  // queryable via tenants_stalled_activation_idx instead of invisible.
  // COALESCE means a redelivery of this same event (or a later
  // async_payment_* event touching the same tenant) never overwrites the
  // original timestamp. Unlike the writes in activateTenant/
  // suspendTenantBilling, a 0-row result here has no legitimate benign
  // cause — id is either a real tenant or it isn't — so this asserts
  // directly, no re-check needed.
  await withServiceRole(async (client) => {
    const result = await client.query(
      `update tenants set activation_checkout_completed_at = coalesce(activation_checkout_completed_at, now())
       where id = $1`,
      [tenantId]
    );
    await assertRowsAffected(client, result, { table: 'tenants', id: tenantId });
  });

  if (session.payment_status !== 'paid') return; // still processing (ACH) — the async_payment_* events resolve it

  await finishActivationFromSession(session, eventId);
}

async function handleCheckoutSessionAsyncPaymentSucceeded(session, eventId) {
  if (session.mode !== 'payment') return;
  if (!session.client_reference_id) {
    throw new Error(`checkout.session.async_payment_succeeded with no client_reference_id (session ${session.id})`);
  }
  if (!(await isActivationSession(session, session.client_reference_id))) {
    console.error(
      `checkout.session.async_payment_succeeded for session ${session.id} is not an activation session this API created — ignored, nothing activated (event ${eventId})`
    );
    return;
  }
  await finishActivationFromSession(session, eventId);
}

async function handleCheckoutSessionAsyncPaymentFailed(session, eventId) {
  if (session.mode !== 'payment') return;
  const tenantId = session.client_reference_id;
  if (!tenantId) {
    throw new Error(`checkout.session.async_payment_failed with no client_reference_id (session ${session.id})`);
  }
  if (!(await isActivationSession(session, tenantId))) {
    console.error(`checkout.session.async_payment_failed for session ${session.id} is not an activation session — ignored (event ${eventId})`);
    return;
  }

  let errorDetail = 'Bank debit failed';
  if (session.payment_intent) {
    try {
      const paymentIntent = await retrievePaymentIntent(session.payment_intent);
      if (paymentIntent.last_payment_error && paymentIntent.last_payment_error.message) {
        errorDetail = paymentIntent.last_payment_error.message;
      }
    } catch (err) {
      console.error(`Could not retrieve PaymentIntent ${session.payment_intent} for failure detail:`, err.message);
    }
  }

  await withServiceRole(async (client) => {
    const inserted = await recordBillingEvent(client, {
      tenantId,
      eventType: 'payment_failed',
      amountCents: session.amount_total || 0,
      stripePaymentIntentId: session.payment_intent,
      status: 'failed',
      errorDetail,
      stripeEventId: eventId,
      livemode: session.livemode,
    });
    if (!inserted) {
      console.log(`Stripe event ${eventId} already processed — async payment failure no-op for tenant ${tenantId}`);
      return;
    }
    // billing_status is deliberately left alone (still 'pending') — the
    // tenant was never active, so there's nothing to suspend. A fresh
    // POST /api/billing/checkout-session call is how they retry.
    console.error(`Activation payment failed for tenant ${tenantId} (session ${session.id}): ${errorDetail}`);
  });
}

async function finishActivationFromSession(session, eventId) {
  // Refuses a stub/fake Stripe configuration before anything that could
  // unlock a tenant — the same gate as the checkout endpoint and the usage
  // fee (lib/stripe.js). Thrown, so the webhook answers 500 and Stripe
  // keeps retrying until the configuration is fixed, rather than the
  // activation being acknowledged and lost.
  assertRealStripeConfigured({ requireWebhookSecret: true });

  let paymentMethodId = null;
  if (session.payment_intent) {
    const paymentIntent = await retrievePaymentIntent(session.payment_intent);
    paymentMethodId = paymentIntent.payment_method || null;
  }

  await activateTenant({
    tenantId: session.client_reference_id,
    eventId,
    paymentIntentId: session.payment_intent,
    paymentMethodId,
    customerId: session.customer,
    amountCents: session.amount_total,
    livemode: session.livemode === true,
  });
}

// ---------------------------------------------------------------------------
// payment_intent.payment_failed / charge.dispute.created — Stage 3.
// Both suspend billing_status; both are idempotent against redelivery
// (see suspendTenantBilling's stripe_event_id dedup).
// ---------------------------------------------------------------------------
async function handlePaymentIntentPaymentFailed(paymentIntent, eventId) {
  const tenantId = paymentIntent.metadata && paymentIntent.metadata.tenant_id;
  if (!tenantId) {
    // Not one of ours (or missing metadata) — nothing to act on. Not an
    // error: once this is a real Stripe account, PaymentIntents unrelated
    // to this integration could exist on it for other reasons.
    console.log(`payment_intent.payment_failed with no tenant_id metadata (${paymentIntent.id}) — ignored`);
    return;
  }
  // Stage 4's per-referral reward PaymentIntents and the referral usage
  // fee's (lib/referralFee.js) both set metadata.referral_id. A declined
  // usage fee is already recorded on its own 'referral_fee' row at the
  // moment it's declined; this adds the suspension and a payment_failed
  // row, same as for any other declined charge.
  const referralId = (paymentIntent.metadata && paymentIntent.metadata.referral_id) || null;
  const errorDetail = (paymentIntent.last_payment_error && paymentIntent.last_payment_error.message) || 'Payment failed';

  await suspendTenantBilling({
    tenantId,
    referralId,
    eventType: 'payment_failed',
    amountCents: paymentIntent.amount,
    stripePaymentIntentId: paymentIntent.id,
    errorDetail,
    eventId,
    livemode: paymentIntent.livemode,
  });
}

async function handleChargeDisputeCreated(dispute, eventId) {
  let tenantId = null;
  if (dispute.payment_intent) {
    try {
      const paymentIntent = await retrievePaymentIntent(dispute.payment_intent);
      tenantId = (paymentIntent.metadata && paymentIntent.metadata.tenant_id) || null;
    } catch (err) {
      console.error(`Could not retrieve PaymentIntent ${dispute.payment_intent} for dispute ${dispute.id}:`, err.message);
    }
  }
  if (!tenantId) {
    // Nothing to suspend automatically without knowing whose tenant this
    // is — logged loudly since a dispute is real money at risk and this
    // needs a human regardless.
    console.error(`charge.dispute.created with no resolvable tenant_id (dispute ${dispute.id}) — needs manual review`);
    return;
  }

  await suspendTenantBilling({
    tenantId,
    referralId: null,
    eventType: 'dispute_created',
    amountCents: dispute.amount,
    stripePaymentIntentId: dispute.payment_intent,
    errorDetail: `Dispute: ${dispute.reason || 'unknown reason'}`,
    eventId,
    livemode: dispute.livemode,
  });
}

module.exports = router;
