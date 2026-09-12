// Stage 4 of Stripe billing: the reward-issuance worker. Not triggered by
// any request — run runRewardIssuanceCycle() on a schedule (see
// runRewardIssuance.js for the CLI entry point an external scheduler,
// e.g. a Render Cron Job, actually invokes). No logged-in user exists for
// any of this, so every write goes through db.js's withServiceRole, the
// same as every Stripe webhook handler.
//
// Per referral, in order:
//   1. Claim it: re-verify eligibility, check the tenant's billing_status
//      and monthly spend cap, snapshot its current pricing into a new
//      'pending' billing_events row.
//   2. Charge it off-session via Stripe.
//   3. Only once that charge succeeds: issue two gift cards — one to the
//      referrer, one to the referred friend (per_referral_charge_cents is
//      reward_amount_cents * 2 + platform_fee_cents specifically because
//      both sides get paid; see the billing_schema migration).
//   4. Only once *both* cards are out: mark the referral rewarded.
//      If either card fails after the charge already succeeded, the
//      billing_events row goes to 'needs_refund' instead and the charge
//      is never retried — a human resolves it from there.
//
// Idempotency has three independent layers, deliberately, since this is
// the one place in the codebase that moves money with nobody watching:
//   - Stripe's own Idempotency-Key (derived from the referral id) is the
//     authoritative guard against ever actually charging a card twice,
//     even under a genuine race between two overlapping worker runs —
//     Stripe returns the identical PaymentIntent to both.
//   - billing_events_one_referral_charge_idx (a partial unique index from
//     Stage 1) is the database-level backstop: at most one referral_charge
//     row per referral can ever reach 'succeeded'/'needs_refund'. Unlike
//     every other claim-via-unique-constraint pattern in this codebase,
//     this index deliberately does NOT cover 'pending' — see
//     claimReferralCharge's `for update ... skip locked` and
//     markChargeSucceeded's race handling for why that's still safe.
//   - gift_card_transactions.idempotency_key (no partial WHERE — unique
//     across every row, forever) makes each leg's claim a true one-time
//     claim, exactly like routes/referrals.js's existing manual-issuance
//     flow already relies on.
//
// Monthly spend cap: calendar-month, UTC, based on succeeded
// referral_charge billing_events rows only (a failed or needs_refund
// charge doesn't count against it). This is a deliberate simplification,
// not a hidden assumption — a rolling 30-day window or a
// tenant-timezone-aware month boundary would both be defensible
// alternatives; this is the cheapest correct one and the cap itself is
// described as "a calendar month" nowhere more precisely than that.
const { withServiceRole, assertRowsAffected, assertServiceRoleConnection } = require('../db');
const { chargeOffSession } = require('../lib/stripe');
const { issueGiftCard } = require('../lib/giftCardProvider');

const PG_UNIQUE_VIOLATION = '23505';

async function runRewardIssuanceCycle({ now = new Date(), batchSize = 25 } = {}) {
  const candidateIds = await withServiceRole(async (client) => {
    // This is a broad read, not a targeted write — assertRowsAffected
    // can't help here (there's no specific row to have expected back).
    // See db.js's assertServiceRoleConnection for the exact silent
    // failure this rules out instead: a misconfigured role turning every
    // cycle into a clean-looking, permanent no-op.
    await assertServiceRoleConnection(client);

    const { rows } = await client.query(
      `select r.id
       from referrals r
       where r.closed_at is not null
         and r.reward_eligible_at <= $1
         and r.reward_issued_at is null
         and not exists (
           select 1 from billing_events be
           where be.referral_id = r.id
             and be.event_type = 'referral_charge'
             and be.status in ('succeeded', 'needs_refund')
         )
       order by r.reward_eligible_at asc
       limit $2`,
      [now, batchSize]
    );
    return rows.map((r) => r.id);
  });

  const summary = { candidates: candidateIds.length, issued: 0, needsRefund: 0, chargeFailed: 0, skipped: 0, errored: 0 };

  for (const referralId of candidateIds) {
    let outcome;
    try {
      outcome = await processReferral(referralId, now);
    } catch (err) {
      // A referral-level failure (most likely assertRowsAffected firing
      // on a genuine bug) must never take down the whole cycle — every
      // other candidate still deserves its own attempt. Logged loudly;
      // this referral is simply retried on the next cycle.
      console.error(`Reward issuance worker: unexpected error processing referral ${referralId}:`, err);
      summary.errored += 1;
      continue;
    }
    summary[outcome] = (summary[outcome] || 0) + 1;
  }

  console.log(`Reward issuance cycle complete: ${JSON.stringify(summary)}`);
  return summary;
}

async function processReferral(referralId, now) {
  const claim = await claimReferralCharge(referralId, now);
  if (claim.reason) {
    console.log(`Reward issuance: skipping referral ${referralId} — ${claim.reason}`);
    return 'skipped';
  }

  const { billingEventId, tenantId, amountCents, rewardAmountCents, currency, stripeCustomerId, stripePaymentMethodId, referrer, friend } = claim;

  let paymentIntent;
  try {
    paymentIntent = await chargeOffSession({
      customerId: stripeCustomerId,
      paymentMethodId: stripePaymentMethodId,
      amountCents,
      currency,
      metadata: { tenant_id: tenantId, referral_id: referralId, kind: 'referral_charge' },
      idempotencyKey: `referral_charge:${referralId}`,
    });
  } catch (err) {
    await recordChargeFailure(billingEventId, referralId, err);
    return 'chargeFailed';
  }

  const charged = await markChargeSucceeded(billingEventId, referralId, paymentIntent.id);
  if (!charged) {
    // Lost a bookkeeping race to a concurrent attempt on this same
    // referral — see markChargeSucceeded. The winning attempt is the one
    // that issues the reward; this one stands down.
    return 'skipped';
  }

  // Once the charge has succeeded, billing_events is just as terminal as
  // 'needs_refund' to this worker's own candidate query (both are
  // excluded from ever being selected again) — so from here on, *any*
  // failure to reach 'issued' must land this row in 'needs_refund', not
  // just a provider-reported failure inside issueLeg's own try/catch.
  // Confirmed live: without this outer try/catch, an unrelated crash
  // between the two legs (a bug, a transient DB error) left a
  // 'succeeded' row with reward_issued_at still null and no way back
  // into the candidate query at all — silently stuck forever, which is
  // exactly the outcome 'needs_refund' exists to avoid.
  let referrerResult;
  let friendResult;
  try {
    referrerResult = await issueLeg({
      referralId,
      tenantId,
      recipientRole: 'referrer',
      recipientCustomerId: referrer.customerId,
      recipientName: referrer.name,
      recipientEmail: referrer.email,
      amountCents: rewardAmountCents,
      currency,
    });

    const friendCustomerId = await findOrCreateFriendCustomer({
      tenantId,
      referralId,
      name: friend.name,
      email: friend.email,
      phone: friend.phone,
    });
    friendResult = await issueLeg({
      referralId,
      tenantId,
      recipientRole: 'new_customer',
      recipientCustomerId: friendCustomerId,
      recipientName: friend.name,
      recipientEmail: friend.email,
      amountCents: rewardAmountCents,
      currency,
    });
  } catch (err) {
    const detail = `Charge succeeded (payment_intent ${paymentIntent.id}) but reward issuance crashed before finishing: ${err.message}`;
    console.error(`NEEDS REFUND — referral ${referralId}, tenant ${tenantId}: ${detail}`);
    await markNeedsRefund(billingEventId, detail).catch((markErr) =>
      console.error(
        `MANUAL INTERVENTION REQUIRED — could not mark billing_events ${billingEventId} needs_refund after a crash; it is stuck at 'succeeded' with no reward issued:`,
        markErr
      )
    );
    return 'needsRefund';
  }

  if (referrerResult.ok && friendResult.ok) {
    await markRewardIssued(referralId, billingEventId);
    return 'issued';
  }

  const failedLegs = [];
  if (!referrerResult.ok) failedLegs.push(`referrer (${referrerResult.error})`);
  if (!friendResult.ok) failedLegs.push(`new_customer (${friendResult.error})`);
  const detail = `Charge succeeded (payment_intent ${paymentIntent.id}) but gift card issuance failed: ${failedLegs.join('; ')}`;
  console.error(`NEEDS REFUND — referral ${referralId}, tenant ${tenantId}: ${detail}`);
  await markNeedsRefund(billingEventId, detail);
  return 'needsRefund';
}

// Re-verifies eligibility from scratch (never trusts the batch select
// that got us here — that read is already stale by the time this runs),
// checks billing_status and the spend cap, and — only if every check
// passes — claims the attempt by inserting the 'pending' referral_charge
// row with pricing snapshotted right now. `for update of r skip locked`
// means a referral already being worked by a concurrent invocation is
// silently skipped this cycle rather than waited on or double-claimed;
// it is not what makes double-charging impossible (billing_events'
// 'pending' status is deliberately outside the partial unique index, so
// two processes racing past this lock in different transactions can both
// still get this far) — see this file's top-of-file comment for what
// does.
async function claimReferralCharge(referralId, now) {
  return withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      `select
         r.id as referral_id, r.tenant_id,
         r.name as friend_name, r.email as friend_email, r.phone as friend_phone,
         c.id as referrer_customer_id, c.name as referrer_name, c.email as referrer_email,
         t.billing_status, t.stripe_customer_id, t.stripe_payment_method_id,
         t.per_referral_charge_cents, t.reward_amount_cents, t.platform_fee_cents,
         t.reward_currency, t.monthly_spend_cap_cents
       from referrals r
       join referral_links rl on rl.id = r.referral_link_id
       join customers c on c.id = rl.customer_id
       join tenants t on t.id = r.tenant_id
       where r.id = $1
         and r.closed_at is not null
         and r.reward_eligible_at <= $2
         and r.reward_issued_at is null
         and not exists (
           select 1 from billing_events be
           where be.referral_id = r.id
             and be.event_type = 'referral_charge'
             and be.status in ('succeeded', 'needs_refund')
         )
       for update of r skip locked`,
      [referralId, now]
    );

    if (!row) {
      return { reason: 'not currently eligible — already handled, reopened, reward_eligible_at moved, or locked by a concurrent run' };
    }

    if (row.billing_status !== 'active') {
      return { reason: `tenant billing_status is '${row.billing_status}', not 'active'` };
    }

    if (!row.stripe_customer_id || !row.stripe_payment_method_id) {
      // A data-integrity problem, not a normal skip: billing_status only
      // ever becomes 'active' once webhooks.js's activateTenant has
      // stored both of these. Surfaced loudly rather than silently
      // skipped, since a tenant that's billable by every other check but
      // has nothing on file to actually charge means something upstream
      // is broken.
      console.error(
        `Reward issuance: tenant ${row.tenant_id} is billing_status='active' but missing stripe_customer_id/stripe_payment_method_id — cannot charge referral ${referralId}`
      );
      return { reason: 'tenant missing saved payment method despite active billing_status — see error log' };
    }

    const { rows: [spend] } = await client.query(
      `select coalesce(sum(amount_cents), 0) as spent
       from billing_events
       where tenant_id = $1
         and event_type = 'referral_charge'
         and status = 'succeeded'
         and created_at >= date_trunc('month', $2::timestamptz)`,
      [row.tenant_id, now]
    );
    const spentCents = Number(spend.spent);
    if (spentCents + row.per_referral_charge_cents > row.monthly_spend_cap_cents) {
      return {
        reason: `monthly spend cap reached (spent ${spentCents}, cap ${row.monthly_spend_cap_cents}, this referral needs ${row.per_referral_charge_cents}) — retried automatically once the calendar month rolls over`,
      };
    }

    const { rows: [inserted] } = await client.query(
      `insert into billing_events
         (tenant_id, referral_id, event_type, amount_cents, reward_amount_cents, platform_fee_cents, status)
       values ($1, $2, 'referral_charge', $3, $4, $5, 'pending')
       returning id`,
      [row.tenant_id, referralId, row.per_referral_charge_cents, row.reward_amount_cents, row.platform_fee_cents]
    );

    return {
      billingEventId: inserted.id,
      tenantId: row.tenant_id,
      amountCents: row.per_referral_charge_cents,
      rewardAmountCents: row.reward_amount_cents,
      currency: row.reward_currency,
      stripeCustomerId: row.stripe_customer_id,
      stripePaymentMethodId: row.stripe_payment_method_id,
      referrer: { customerId: row.referrer_customer_id, name: row.referrer_name, email: row.referrer_email },
      friend: { name: row.friend_name, email: row.friend_email, phone: row.friend_phone },
    };
  });
}

async function recordChargeFailure(billingEventId, referralId, err) {
  const errorDetail = err.message || 'Off-session charge failed';
  console.error(`Reward issuance: charge failed for referral ${referralId} (billing_events ${billingEventId}): ${errorDetail}`);
  await withServiceRole(async (client) => {
    const result = await client.query(
      `update billing_events set status = 'failed', error_detail = $1 where id = $2 and status = 'pending'`,
      [errorDetail, billingEventId]
    );
    await assertRowsAffected(client, result, { table: 'billing_events', id: billingEventId });
  });
  // Not this worker's job to suspend billing_status here: Stripe still
  // creates a PaymentIntent even when confirm fails, so
  // payment_intent.payment_failed fires shortly after — and
  // webhooks.js's handlePaymentIntentPaymentFailed already reads
  // metadata.referral_id (anticipated back in Stage 3, before this
  // worker existed) and suspends from there. Duplicating that here would
  // just be a second, redundant path to the same state.
}

// Marks the charge succeeded. Returns false (not a thrown error) if this
// attempt lost a genuine concurrent-attempt race — see this file's
// top-of-file comment on why 'pending' isn't covered by the unique index,
// and why that's still safe.
async function markChargeSucceeded(billingEventId, referralId, paymentIntentId) {
  try {
    await withServiceRole(async (client) => {
      const result = await client.query(
        `update billing_events set status = 'succeeded', stripe_payment_intent_id = $1
         where id = $2 and status = 'pending'`,
        [paymentIntentId, billingEventId]
      );
      await assertRowsAffected(client, result, { table: 'billing_events', id: billingEventId });
    });
    return true;
  } catch (err) {
    if (err.code !== PG_UNIQUE_VIOLATION) throw err;

    // Another process's attempt at this same referral reached
    // 'succeeded' first. Stripe's own Idempotency-Key means the *charge*
    // itself was never actually duplicated — both processes hold the same
    // PaymentIntent id — only our own bookkeeping raced. Mark this row
    // 'failed' rather than leaving it dangling as 'pending' forever, and
    // stand down: the winning process's run is the one that issues the
    // reward.
    console.log(
      `Reward issuance: referral ${referralId}'s charge succeeded but lost a bookkeeping race to another attempt (billing_events ${billingEventId}) — standing down`
    );
    await withServiceRole((client) =>
      client.query(`update billing_events set status = 'failed', error_detail = $1 where id = $2`, [
        "Lost a concurrent-attempt race after the charge succeeded — another process recorded this referral's charge first",
        billingEventId,
      ])
    ).catch((cleanupErr) => console.error(`Could not mark stray billing_events row ${billingEventId} failed:`, cleanupErr.message));
    return false;
  }
}

// Finds or creates the referred friend's own customers row, claimed via
// source_referral_id (see the reward_issuance_worker migration) rather
// than an email match — a true one-time claim, not a heuristic merge
// into whatever customer row happens to share this email address.
async function findOrCreateFriendCustomer({ tenantId, referralId, name, email, phone }) {
  return withServiceRole(async (client) => {
    const { rows: [inserted] } = await client.query(
      `insert into customers (tenant_id, name, email, phone, source_referral_id)
       values ($1, $2, $3, $4, $5)
       on conflict (source_referral_id) do nothing
       returning id`,
      [tenantId, name, email, phone, referralId]
    );
    if (inserted) return inserted.id;

    const { rows: [existing] } = await client.query('select id from customers where source_referral_id = $1', [referralId]);
    if (!existing) {
      // The insert above can only hit its conflict target if a row
      // already claims this exact source_referral_id — so this means
      // that row existed a moment ago and now doesn't, which is a
      // genuine data-integrity problem (nothing in this codebase deletes
      // customers), not a benign race.
      throw new Error(`Referral ${referralId}: customers insert conflicted on source_referral_id but no row can be found for it`);
    }
    return existing.id;
  });
}

// One leg of the two-sided reward: claims a gift_card_transactions row
// (idempotency_key has no partial WHERE — a true one-time claim, ever,
// same as routes/referrals.js's existing manual-issuance flow), calls the
// gift card provider outside any open transaction (never hold a
// transaction across a slow external call — same discipline as every
// other provider call in this codebase), then records the outcome.
async function issueLeg({ referralId, tenantId, recipientRole, recipientCustomerId, recipientName, recipientEmail, amountCents, currency }) {
  const idempotencyKey = `${referralId}:${recipientRole}`;
  const provider = process.env.GIFT_CARD_PROVIDER || 'stub';

  const claimed = await withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      `insert into gift_card_transactions
         (tenant_id, referral_id, recipient_customer_id, recipient_role, amount_cents, currency, provider, status, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       on conflict (idempotency_key) do nothing
       returning id`,
      [tenantId, referralId, recipientCustomerId, recipientRole, amountCents, currency, provider, idempotencyKey]
    );
    return row;
  });

  let transactionId;
  if (claimed) {
    transactionId = claimed.id;
  } else {
    // Already claimed by an earlier attempt at this exact leg (a
    // previous cycle that reached this point before failing later this
    // referral's charge, or a concurrent run). Check what happened to it
    // rather than blindly re-attempting or blindly reporting success.
    const existing = await withServiceRole(async (client) => {
      const { rows: [row] } = await client.query(
        'select id, status, provider_transaction_id from gift_card_transactions where idempotency_key = $1',
        [idempotencyKey]
      );
      return row;
    });
    if (existing && existing.status === 'issued') {
      return { ok: true, providerTransactionId: existing.provider_transaction_id };
    }
    console.error(
      `Reward issuance: gift_card_transactions leg "${idempotencyKey}" already exists in unexpected status '${existing && existing.status}' — not re-attempting automatically, needs manual review`
    );
    return { ok: false, error: `leg already exists in status '${existing && existing.status}' — see error log` };
  }

  try {
    const order = await issueGiftCard({
      amountCents,
      currency,
      recipientName,
      recipientEmail,
      idempotencyKey,
      referralId,
      recipientRole,
    });
    await withServiceRole(async (client) => {
      const result = await client.query(
        `update gift_card_transactions
         set status = 'issued', provider_transaction_id = $1, issued_at = now()
         where id = $2 and status = 'pending'`,
        [order.providerTransactionId, transactionId]
      );
      await assertRowsAffected(client, result, { table: 'gift_card_transactions', id: transactionId });
    });
    return { ok: true, providerTransactionId: order.providerTransactionId };
  } catch (err) {
    await withServiceRole(async (client) => {
      const result = await client.query(`update gift_card_transactions set status = 'failed' where id = $1 and status = 'pending'`, [
        transactionId,
      ]);
      await assertRowsAffected(client, result, { table: 'gift_card_transactions', id: transactionId });
    });
    return { ok: false, error: err.message };
  }
}

async function markRewardIssued(referralId, billingEventId) {
  await withServiceRole(async (client) => {
    const result = await client.query(
      `update referrals
       set status = 'rewarded', rewarded_at = coalesce(rewarded_at, now()), reward_issued_at = now(), billing_event_id = $1
       where id = $2 and reward_issued_at is null`,
      [billingEventId, referralId]
    );
    await assertRowsAffected(client, result, { table: 'referrals', id: referralId });
  });
  console.log(`Reward issuance: referral ${referralId} fully rewarded (billing_events ${billingEventId})`);
}

async function markNeedsRefund(billingEventId, detail) {
  await withServiceRole(async (client) => {
    const result = await client.query(
      `update billing_events set status = 'needs_refund', error_detail = $1 where id = $2 and status = 'succeeded'`,
      [detail, billingEventId]
    );
    await assertRowsAffected(client, result, { table: 'billing_events', id: billingEventId });
  });
}

module.exports = { runRewardIssuanceCycle };
