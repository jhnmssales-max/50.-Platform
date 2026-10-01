// 50.'s usage fee on a rewarded referral: referral_fee_bps (30% by
// default) of the total payout — both gift cards, the referrer's and the
// referred friend's (reward_amount_cents * 2) — so a $100 payout is
// charged $30. The tenant funds the gift cards itself (its own Tremendous
// account, or by hand — the same way Good Steward Structures already
// works); this is the fee alone, charged off-session to the payment
// method the tenant saved at activation, and recorded in billing_events
// as event_type 'referral_fee'.
//
// Charged *before* the referral is marked rewarded (routes/referrals.js):
// a declined fee leaves the referral unpaid, so the paid-notification
// email ("send the gift cards") and any automatic Tremendous order only
// ever go out once 50. has been paid. Never charged for a billing-exempt
// tenant — Good Steward Structures, North Mountain Structures, 50. itself
// — which is re-checked here from a fresh, locked read rather than
// trusted from the caller, and returns before any Stripe call at all.
//
// One billing_events row per attempt. Its lifecycle, and why each rule
// exists (this moves real money with nobody watching once the admin has
// clicked):
//   - 'pending' is inserted *before* Stripe is called, and
//     billing_events_one_referral_fee_idx allows only one pending-or-
//     succeeded row per referral — so two clicks, two admins, or two
//     servers can never both be charging the same referral.
//   - Each attempt's Stripe Idempotency-Key is derived from its own row
//     id (referral_fee:<billing_events.id>). A retry of the *same*
//     attempt (a timeout, a crash) reuses that key, so Stripe returns the
//     original charge instead of making a second one. A *new* attempt
//     after a decline gets a new key — reusing the old one would only
//     replay the cached decline for 24 hours.
//   - 'failed' only when Stripe definitively said no (a 4xx such as a
//     card decline). No response, a 5xx, or Stripe still processing the
//     same key leaves the row 'pending': the money may have moved, and a
//     fresh attempt on top of it is exactly how a card gets charged
//     twice. The next attempt resumes that row instead — by looking up
//     its PaymentIntent if it has one, or by resending with the same key
//     while Stripe still remembers it (23h, inside Stripe's 24h
//     idempotency window). Past that, it stops and asks for a human.
//   - 'succeeded' only when Stripe's PaymentIntent says succeeded. A bank
//     debit (ACH) that's still processing stays 'pending' with its
//     PaymentIntent id and is resolved on the next attempt.
const { withServiceRole, assertRowsAffected } = require('../db');
const { assertRealStripeConfigured, chargeOffSession, retrievePaymentIntent } = require('./stripe');
const { activationState } = require('./activation');

const PENDING_RESEND_WINDOW_MS = 23 * 60 * 60 * 1000;
// A pending attempt this fresh with no recorded problem is almost
// certainly another request's charge still in flight — wait for it rather
// than racing it.
const IN_FLIGHT_GRACE_MS = 2 * 60 * 1000;

// payout = both cards; fee rounded half-up to the cent, in integer math
// (no floating-point cents): $100.00 at 3000 bps -> $30.00; $66.66 at
// 3000 bps -> $20.00 (19.998 rounds up).
function computeReferralFee({ rewardAmountCents, rateBps }) {
  const payoutCents = rewardAmountCents * 2;
  const feeCents = Math.floor((payoutCents * rateBps + 5000) / 10000);
  return { payoutCents, feeCents };
}

function formatCents(cents, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'USD').toUpperCase() }).format(cents / 100);
}

function httpError(status, message, publicCode) {
  const err = new Error(message);
  err.status = status;
  if (publicCode) err.publicCode = publicCode;
  return err;
}

// Charges (or confirms already charged) the usage fee for one referral.
// Resolves { status: 'not_required' } for a billing-exempt tenant, or
// { status: 'succeeded', newlyCharged, feeCents, payoutCents, rateBps,
// currency, paymentIntentId, billingEventId }. Every other outcome throws
// an HTTP error the route passes straight through: 402 declined, 409
// still processing / needs review / billing not ready, 502 unconfirmed.
// tenantId must come from the caller's RLS-resolved context — this runs
// on the service-role connection (billing_events is never writable by
// the authenticated role), so the explicit tenant match below is what
// keeps it scoped.
async function collectReferralFee({ tenantId, referralId }) {
  const claim = await withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      `select r.id as referral_id, r.tenant_id,
              t.name as tenant_name, t.billing_required, t.activation_paid_at, t.activation_livemode,
              t.stripe_customer_id, t.stripe_payment_method_id,
              t.reward_amount_cents, t.reward_currency, t.referral_fee_bps
       from referrals r
       join tenants t on t.id = r.tenant_id
       where r.id = $1 and r.tenant_id = $2
       for update of r`,
      [referralId, tenantId]
    );
    if (!row) throw httpError(404, 'Referral not found');

    if (row.billing_required === false) {
      return { notRequired: true };
    }

    const { rows: [existing] } = await client.query(
      `select id, status, amount_cents, reward_amount_cents, fee_rate_bps, stripe_payment_intent_id,
              error_detail, created_at
       from billing_events
       where referral_id = $1 and event_type = 'referral_fee' and status in ('pending', 'succeeded')`,
      [referralId]
    );
    if (existing && existing.status === 'succeeded') {
      return { row, attempt: existing, alreadyCollected: true };
    }

    // From here on Stripe will be called — refuse a stub/fake config
    // before writing anything, so a misconfigured server leaves no
    // pending rows behind either.
    const stripeConfig = assertRealStripeConfigured();

    const gate = activationState(row, stripeConfig.mode);
    if (gate.required) {
      throw httpError(402, `${row.tenant_name} hasn't completed its one-time 50. activation yet.`, 'activation_required');
    }
    if (!row.stripe_customer_id || !row.stripe_payment_method_id) {
      console.error(
        `REFERRAL_FEE tenant ${tenantId} is activated but has no saved Stripe customer/payment method — cannot charge the usage fee for referral ${referralId}`
      );
      throw httpError(
        409,
        'There is no saved payment method on file for this account, so the 50. usage fee can\'t be charged. Contact 50. support. The referral was not marked paid.',
        'billing_not_ready'
      );
    }
    if (stripeConfig.mode === 'test' && row.activation_livemode === true) {
      console.error(
        `REFERRAL_FEE tenant ${tenantId}'s saved payment method is from Stripe live mode but this API is running on a test key — refusing to charge referral ${referralId}`
      );
      throw httpError(409, 'Billing is misconfigured on 50.\'s side. Contact 50. support. The referral was not marked paid.', 'billing_not_ready');
    }

    if (existing) {
      return { row, attempt: existing, resume: true };
    }

    const rateBps = row.referral_fee_bps;
    const { feeCents } = computeReferralFee({ rewardAmountCents: row.reward_amount_cents, rateBps });
    const { rows: [inserted] } = await client.query(
      `insert into billing_events
         (tenant_id, referral_id, event_type, amount_cents, reward_amount_cents, fee_rate_bps, status)
       values ($1, $2, 'referral_fee', $3, $4, $5, 'pending')
       returning id, status, amount_cents, reward_amount_cents, fee_rate_bps, stripe_payment_intent_id,
                 error_detail, created_at`,
      [tenantId, referralId, feeCents, row.reward_amount_cents, rateBps]
    );
    return { row, attempt: inserted, resume: false };
  });

  if (claim.notRequired) return { status: 'not_required' };

  const { row, attempt } = claim;
  const currency = row.reward_currency;
  const summary = {
    feeCents: attempt.amount_cents,
    payoutCents: attempt.reward_amount_cents * 2,
    rateBps: attempt.fee_rate_bps,
    currency,
    billingEventId: attempt.id,
  };

  if (claim.alreadyCollected) {
    return { status: 'succeeded', newlyCharged: false, paymentIntentId: attempt.stripe_payment_intent_id, ...summary };
  }

  let paymentIntent;
  try {
    if (claim.resume && attempt.stripe_payment_intent_id) {
      paymentIntent = await retrievePaymentIntent(attempt.stripe_payment_intent_id);
    } else {
      if (claim.resume) {
        const ageMs = Date.now() - new Date(attempt.created_at).getTime();
        if (ageMs >= PENDING_RESEND_WINDOW_MS) {
          console.error(
            `REFERRAL_FEE billing_events ${attempt.id} (referral ${referralId}) has been pending with an unknown outcome for over 23h — needs manual review in Stripe before anything is retried`
          );
          throw httpError(
            409,
            'A previous charge attempt for this referral\'s 50. usage fee never confirmed. 50. needs to review it before trying again — contact 50. support. The referral was not marked paid.',
            'referral_fee_needs_review'
          );
        }
        if (!attempt.error_detail && ageMs < IN_FLIGHT_GRACE_MS) {
          throw httpError(409, 'The 50. usage fee for this referral is already being charged. Try again in a moment.', 'referral_fee_in_progress');
        }
      }
      paymentIntent = await chargeOffSession({
        customerId: row.stripe_customer_id,
        paymentMethodId: row.stripe_payment_method_id,
        amountCents: attempt.amount_cents,
        currency,
        description: `50. usage fee — ${attempt.fee_rate_bps / 100}% of a ${formatCents(summary.payoutCents, currency)} referral payout`,
        metadata: { tenant_id: row.tenant_id, referral_id: referralId, billing_event_id: attempt.id, kind: 'referral_fee' },
        idempotencyKey: `referral_fee:${attempt.id}`,
      });
    }
  } catch (err) {
    if (err.status) throw err; // one of ours, above — nothing was sent

    if (err.stripeOutcomeUnknown) {
      await recordAttempt(attempt.id, {
        status: 'pending',
        errorDetail: `Outcome unknown, will resume with the same Idempotency-Key: ${err.message}`,
        paymentIntentId: err.stripePaymentIntentId,
      });
      console.error(`REFERRAL_FEE outcome unknown for billing_events ${attempt.id} (referral ${referralId}): ${err.message}`);
      throw httpError(
        502,
        'Couldn\'t confirm the 50. usage fee charge with Stripe. Nothing was marked paid — try again in a minute; you won\'t be charged twice.',
        'referral_fee_unconfirmed'
      );
    }

    if (err.stripeType === 'idempotency_error') {
      // The resend didn't match the original request's parameters (the
      // saved payment method changed in between), so Stripe won't say
      // what became of the original. Left pending — a human checks
      // Stripe before anything is charged again.
      await recordAttempt(attempt.id, { status: 'pending', errorDetail: `Needs manual review: ${err.message}` });
      console.error(`REFERRAL_FEE billing_events ${attempt.id} (referral ${referralId}) needs manual review: ${err.message}`);
      throw httpError(
        409,
        'A previous charge attempt for this referral\'s 50. usage fee never confirmed. 50. needs to review it before trying again — contact 50. support. The referral was not marked paid.',
        'referral_fee_needs_review'
      );
    }

    // A definite no from Stripe (4xx): nothing was charged, and a later
    // attempt starts fresh under a new key.
    await recordAttempt(attempt.id, {
      status: 'failed',
      errorDetail: err.stripeDeclineCode ? `${err.message} (${err.stripeDeclineCode})` : err.message,
      paymentIntentId: err.stripePaymentIntentId,
      livemode: err.stripePaymentIntentLivemode,
    });
    console.error(`REFERRAL_FEE charge failed for billing_events ${attempt.id} (referral ${referralId}): ${err.message}`);
    if (err.stripeType === 'card_error') {
      // Stripe writes card_error messages to be shown to the cardholder.
      throw httpError(
        402,
        `The 50. usage fee of ${formatCents(summary.feeCents, currency)} couldn't be charged to the card on file: ${err.message} The referral was not marked paid.`,
        'referral_fee_declined'
      );
    }
    // Anything else (a bad key, an invalid request) is 50.'s problem, not
    // the dealer's card — logged above in full, not shown to them.
    throw httpError(
      502,
      'The 50. usage fee couldn\'t be charged because of a problem on 50.\'s side. Nothing was charged and the referral was not marked paid. Contact 50. support if this keeps happening.',
      'referral_fee_failed'
    );
  }

  const livemode = typeof paymentIntent.livemode === 'boolean' ? paymentIntent.livemode : null;

  if (paymentIntent.status === 'succeeded') {
    await recordAttempt(attempt.id, { status: 'succeeded', paymentIntentId: paymentIntent.id, livemode });
    console.log(
      `REFERRAL_FEE succeeded ${JSON.stringify({ billingEventId: attempt.id, referralId, tenantId, amountCents: attempt.amount_cents, paymentIntentId: paymentIntent.id, livemode })}`
    );
    return { status: 'succeeded', newlyCharged: true, paymentIntentId: paymentIntent.id, ...summary };
  }

  if (paymentIntent.status === 'processing') {
    await recordAttempt(attempt.id, { status: 'pending', paymentIntentId: paymentIntent.id, livemode });
    throw httpError(
      409,
      'The 50. usage fee payment for this referral is still processing (a bank payment can take a few business days). Mark it paid again once it clears.',
      'referral_fee_processing'
    );
  }

  // requires_payment_method / requires_action / canceled: Stripe has
  // settled it, and not as paid.
  const detail = (paymentIntent.last_payment_error && paymentIntent.last_payment_error.message) || `PaymentIntent status '${paymentIntent.status}'`;
  await recordAttempt(attempt.id, { status: 'failed', errorDetail: detail, paymentIntentId: paymentIntent.id, livemode });
  throw httpError(
    402,
    `The 50. usage fee of ${formatCents(summary.feeCents, currency)} couldn't be charged to the card on file: ${detail} The referral was not marked paid.`,
    'referral_fee_declined'
  );
}

// Moves one pending attempt to its outcome. Only ever from 'pending', and
// it must hit exactly that row (assertRowsAffected) — this is the ledger
// of real charges, a silent 0-row update here would lose one. The single
// benign exception: a concurrent resume of the same attempt already
// recorded this exact outcome for this exact PaymentIntent.
async function recordAttempt(billingEventId, { status, errorDetail, paymentIntentId, livemode }) {
  await withServiceRole(async (client) => {
    const result = await client.query(
      `update billing_events
       set status = $1,
           error_detail = $2,
           stripe_payment_intent_id = coalesce($3, stripe_payment_intent_id),
           livemode = coalesce($4, livemode)
       where id = $5 and status = 'pending'`,
      [status, errorDetail || null, paymentIntentId || null, typeof livemode === 'boolean' ? livemode : null, billingEventId]
    );
    if (result.rowCount === 0) {
      const { rows: [current] } = await client.query(
        'select status, stripe_payment_intent_id from billing_events where id = $1',
        [billingEventId]
      );
      if (current && current.status === status && paymentIntentId && current.stripe_payment_intent_id === paymentIntentId) {
        return;
      }
    }
    await assertRowsAffected(client, result, { table: 'billing_events', id: billingEventId });
  });
}

module.exports = { computeReferralFee, collectReferralFee, formatCents };
