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
//
// --- Operational safety rails (added before this worker ran unattended) ---
//
// This is real money moving with nobody watching, so four separate rails
// exist on top of the per-referral logic above, each protecting against a
// different failure mode:
//
//   - `dryRun`: previews the whole cycle — every candidate's intended
//     charge and whether it would actually be attempted — without ever
//     calling Stripe or the gift card provider, and without writing
//     anything to the database at all (not even a 'pending' claim row).
//     How to sanity-check a cycle before trusting it to run for real.
//   - REWARD_CYCLE_MAX_CENTS: a global ceiling on this cycle's total
//     intended charges, independent of any single tenant's own
//     monthly_spend_cap_cents — that per-tenant cap can't catch a bug
//     that makes *every* tenant eligible at once (a bad migration, a
//     mis-set reward_eligible_at backfill). Computed by previewCycle
//     below *before* any real work happens; exceeding it aborts the
//     entire cycle (nothing is charged) rather than partially processing
//     up to the limit. Required for a real (non-dry-run) invocation —
//     refusing to guess a safe default here is deliberate, the same
//     "fail loudly rather than silently do the risky thing" stance as
//     assertRowsAffected/assertServiceRoleConnection elsewhere in this
//     codebase.
//   - The advisory lock (see acquireCycleLock below): the actual guard
//     against two overlapping runs both claiming the same referral. The
//     `for update ... skip locked` in claimReferralCharge is real but
//     partial (see its own comment) — this makes the whole cycle
//     single-flight instead, closing that gap outright rather than
//     relying on the three idempotency layers above to catch what a lock
//     could have prevented in the first place.
//   - Structured one-line-per-referral logs (logReferralOutcome below):
//     every finalized outcome — issued, needs_refund, charge_failed,
//     skipped, or a dry-run preview line — is one grep-able JSON line
//     prefixed `REWARD_WORKER`, naming the referral id, tenant id,
//     amount, and outcome, so a cron run is auditable from a log tab
//     without attaching a debugger.
const { pool, withServiceRole, assertRowsAffected, assertServiceRoleConnection } = require('../db');
const { chargeOffSession } = require('../lib/stripe');
const { issueGiftCard } = require('../lib/giftCardProvider');

const PG_UNIQUE_VIOLATION = '23505';

// An arbitrary, fixed key dedicated to this worker within this database's
// single global advisory-lock namespace (pg_advisory_lock's keyspace is
// per-database, not per-table or per-purpose) — nothing else in this
// codebase uses pg_advisory_lock, so this must never collide with a
// future use elsewhere. Session-scoped, not transaction-scoped
// (pg_advisory_lock, not pg_advisory_xact_lock): the cycle this protects
// spans many separate withServiceRole transactions/connections, not one,
// so the lock has to be held on its own dedicated connection for the
// whole cycle instead of auto-releasing at the first commit.
const ADVISORY_LOCK_KEY = 5031982004;

function logReferralOutcome({ referralId, tenantId, amountCents, outcome, detail, dryRun }) {
  console.log(
    `REWARD_WORKER referral_outcome ${JSON.stringify({
      referralId,
      tenantId: tenantId || null,
      amountCents: amountCents == null ? null : amountCents,
      outcome,
      detail: detail || undefined,
      dryRun: dryRun || undefined,
    })}`
  );
}

// Acquires the whole-cycle advisory lock on a dedicated connection (never
// through withServiceRole, which hands back a *different* pooled
// connection on every call — the lock has to live on one connection for
// the caller to release it later). Returns null if another process
// already holds it, rather than blocking: an overlapping cron run should
// stand down immediately, not queue up behind the one already in
// progress.
async function acquireCycleLock() {
  const client = await pool.connect();
  const { rows: [row] } = await client.query('select pg_try_advisory_lock($1) as locked', [ADVISORY_LOCK_KEY]);
  if (!row.locked) {
    client.release();
    return null;
  }
  return client;
}

async function releaseCycleLock(client) {
  try {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  } finally {
    client.release();
  }
}

async function runRewardIssuanceCycle({ now = new Date(), batchSize = 25, dryRun = false } = {}) {
  const cycleMaxCentsRaw = process.env.REWARD_CYCLE_MAX_CENTS;
  if (!dryRun && !cycleMaxCentsRaw) {
    throw new Error(
      'REWARD_CYCLE_MAX_CENTS is not set — refusing to run for real without a global per-cycle spend ceiling. ' +
        'Set it (a per-tenant cap alone cannot catch a bug that makes every tenant eligible at once), or pass ' +
        '--dry-run to preview a cycle without spending anything.'
    );
  }
  const cycleMaxCents = cycleMaxCentsRaw != null ? Number(cycleMaxCentsRaw) : null;

  const lockClient = await acquireCycleLock();
  if (!lockClient) {
    console.error(
      'REWARD_WORKER lock_not_acquired — another cycle already holds the advisory lock; exiting without processing anything.'
    );
    return { locked: false, dryRun, aborted: false, candidates: 0, issued: 0, needsRefund: 0, chargeFailed: 0, skipped: 0, errored: 0 };
  }

  try {
    // This is a broad read, not a targeted write — assertRowsAffected
    // can't help here (there's no specific row to have expected back).
    // See db.js's assertServiceRoleConnection for the exact silent
    // failure this rules out instead: a misconfigured role turning every
    // cycle into a clean-looking, permanent no-op.
    await assertServiceRoleConnection(lockClient);

    const { rows: candidateRows } = await lockClient.query(
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
    const candidateIds = candidateRows.map((r) => r.id);

    // Read-only simulation of the whole batch, in candidate order,
    // tracking each tenant's running intended spend across the batch so
    // a tenant with several eligible referrals in one cycle is capped
    // correctly against its own monthly_spend_cap_cents even though none
    // of these charges have actually happened yet. This is what both
    // dry-run reporting and the global ceiling check below are computed
    // from — neither writes anything or calls Stripe/the gift card
    // provider.
    const preview = await previewCycle(candidateIds, now);
    const totalIntendedCents = preview.reduce((sum, p) => sum + (p.wouldCharge ? p.amountCents : 0), 0);
    const wouldExceedCeiling = cycleMaxCents != null && totalIntendedCents > cycleMaxCents;

    if (dryRun) {
      for (const p of preview) {
        logReferralOutcome({
          referralId: p.referralId,
          tenantId: p.tenantId,
          amountCents: p.amountCents,
          outcome: p.wouldCharge ? 'would_charge' : 'would_skip',
          detail: p.reason,
          dryRun: true,
        });
      }
      console.log(
        `REWARD_WORKER dry_run_summary ${JSON.stringify({
          candidates: preview.length,
          totalIntendedCents,
          cycleMaxCents,
          wouldExceedCeiling,
        })}`
      );
      return {
        locked: true,
        dryRun: true,
        aborted: false,
        candidates: preview.length,
        totalIntendedCents,
        wouldExceedCeiling,
        issued: 0,
        needsRefund: 0,
        chargeFailed: 0,
        skipped: 0,
        errored: 0,
      };
    }

    if (wouldExceedCeiling) {
      console.error(
        `REWARD_WORKER cycle_aborted ${JSON.stringify({
          reason: 'cycle_max_cents_exceeded',
          totalIntendedCents,
          cycleMaxCents,
          candidates: preview.length,
        })} — processing nothing this cycle. This almost always means either REWARD_CYCLE_MAX_CENTS needs raising for genuine growth, or something upstream (a bad migration, a bulk reward_eligible_at backfill) made far more referrals eligible than expected — check before raising it.`
      );
      return {
        locked: true,
        dryRun: false,
        aborted: true,
        reason: 'cycle_max_cents_exceeded',
        totalIntendedCents,
        cycleMaxCents,
        candidates: preview.length,
        issued: 0,
        needsRefund: 0,
        chargeFailed: 0,
        skipped: 0,
        errored: 0,
      };
    }

    const summary = {
      locked: true,
      dryRun: false,
      aborted: false,
      candidates: candidateIds.length,
      issued: 0,
      needsRefund: 0,
      chargeFailed: 0,
      skipped: 0,
      errored: 0,
    };

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
        logReferralOutcome({ referralId, outcome: 'errored', detail: err.message });
        summary.errored += 1;
        continue;
      }
      summary[outcome] = (summary[outcome] || 0) + 1;
    }

    console.log(`REWARD_WORKER cycle_complete ${JSON.stringify(summary)}`);
    return summary;
  } finally {
    await releaseCycleLock(lockClient);
  }
}

// Read-only simulation for both dry-run reporting and the global ceiling
// check: for each candidate, in order, re-derives exactly the same
// eligibility/billing_status/payment-method/spend-cap checks
// claimReferralCharge below would make — but never locks a row, never
// inserts a 'pending' billing_events row, and never calls Stripe or the
// gift card provider. `simulatedSpendByTenant` starts from each tenant's
// real current-month spend (from the database) the first time it's seen,
// then accumulates this preview's own intended charges after that — so a
// tenant with three eligible referrals correctly shows the third one
// capped if the first two would already exhaust its monthly_spend_cap_cents,
// exactly matching what sequential real processing would do.
async function previewCycle(candidateIds, now) {
  const simulatedSpendByTenant = new Map();
  const results = [];

  for (const referralId of candidateIds) {
    const info = await withServiceRole((client) => fetchReferralBillingInfo(client, referralId, now, { lockForUpdate: false }));

    if (!info.eligible) {
      results.push({ referralId, tenantId: info.tenantId || null, amountCents: info.amountCents || null, wouldCharge: false, reason: info.reason });
      continue;
    }

    const priorSpend = simulatedSpendByTenant.has(info.tenantId) ? simulatedSpendByTenant.get(info.tenantId) : info.actualSpentCents;
    if (priorSpend + info.amountCents > info.monthlySpendCapCents) {
      results.push({
        referralId,
        tenantId: info.tenantId,
        amountCents: info.amountCents,
        wouldCharge: false,
        reason: `monthly spend cap would be reached (simulated spend ${priorSpend}, cap ${info.monthlySpendCapCents})`,
      });
      continue;
    }

    simulatedSpendByTenant.set(info.tenantId, priorSpend + info.amountCents);
    results.push({ referralId, tenantId: info.tenantId, amountCents: info.amountCents, wouldCharge: true });
  }

  return results;
}

async function processReferral(referralId, now) {
  const claim = await claimReferralCharge(referralId, now);
  if (claim.reason) {
    logReferralOutcome({ referralId, tenantId: claim.tenantId, amountCents: claim.amountCents, outcome: 'skipped', detail: claim.reason });
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
    logReferralOutcome({ referralId, tenantId, amountCents, outcome: 'charge_failed', detail: err.message });
    return 'chargeFailed';
  }

  const charged = await markChargeSucceeded(billingEventId, referralId, paymentIntent.id);
  if (!charged) {
    // Lost a bookkeeping race to a concurrent attempt on this same
    // referral — see markChargeSucceeded. The winning attempt is the one
    // that issues the reward; this one stands down.
    logReferralOutcome({ referralId, tenantId, amountCents, outcome: 'skipped', detail: 'lost a concurrent-attempt race after the charge succeeded' });
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
    logReferralOutcome({ referralId, tenantId, amountCents, outcome: 'needs_refund', detail });
    return 'needsRefund';
  }

  if (referrerResult.ok && friendResult.ok) {
    await markRewardIssued(referralId, billingEventId);
    logReferralOutcome({ referralId, tenantId, amountCents, outcome: 'issued' });
    return 'issued';
  }

  const failedLegs = [];
  if (!referrerResult.ok) failedLegs.push(`referrer (${referrerResult.error})`);
  if (!friendResult.ok) failedLegs.push(`new_customer (${friendResult.error})`);
  const detail = `Charge succeeded (payment_intent ${paymentIntent.id}) but gift card issuance failed: ${failedLegs.join('; ')}`;
  console.error(`NEEDS REFUND — referral ${referralId}, tenant ${tenantId}: ${detail}`);
  await markNeedsRefund(billingEventId, detail);
  logReferralOutcome({ referralId, tenantId, amountCents, outcome: 'needs_refund', detail });
  return 'needsRefund';
}

// The shared eligibility/billing read, used by both previewCycle
// (lockForUpdate: false, read-only, no side effects at all) and
// claimReferralCharge below (lockForUpdate: true, followed by the actual
// 'pending' insert). Deliberately does *not* itself decide the spend-cap
// outcome — previewCycle simulates cumulative same-cycle spend per
// tenant, while claimReferralCharge checks live, so that decision stays
// with each caller; this only returns the raw numbers both need
// (actualSpentCents, monthlySpendCapCents, amountCents).
async function fetchReferralBillingInfo(client, referralId, now, { lockForUpdate }) {
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
     ${lockForUpdate ? 'for update of r skip locked' : ''}`,
    [referralId, now]
  );

  if (!row) {
    return {
      eligible: false,
      reason: lockForUpdate
        ? 'not currently eligible — already handled, reopened, reward_eligible_at moved, or locked by a concurrent run'
        : 'not currently eligible — already handled, reopened, or reward_eligible_at moved',
    };
  }

  if (row.billing_status !== 'active') {
    return { eligible: false, tenantId: row.tenant_id, amountCents: row.per_referral_charge_cents, reason: `tenant billing_status is '${row.billing_status}', not 'active'` };
  }

  if (!row.stripe_customer_id || !row.stripe_payment_method_id) {
    // A data-integrity problem, not a normal skip: billing_status only
    // ever becomes 'active' once webhooks.js's activateTenant has stored
    // both of these. Surfaced loudly rather than silently skipped, since
    // a tenant that's billable by every other check but has nothing on
    // file to actually charge means something upstream is broken.
    console.error(
      `Reward issuance: tenant ${row.tenant_id} is billing_status='active' but missing stripe_customer_id/stripe_payment_method_id — cannot charge referral ${referralId}`
    );
    return {
      eligible: false,
      tenantId: row.tenant_id,
      amountCents: row.per_referral_charge_cents,
      reason: 'tenant missing saved payment method despite active billing_status — see error log',
    };
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

  return {
    eligible: true,
    tenantId: row.tenant_id,
    amountCents: row.per_referral_charge_cents,
    rewardAmountCents: row.reward_amount_cents,
    platformFeeCents: row.platform_fee_cents,
    currency: row.reward_currency,
    stripeCustomerId: row.stripe_customer_id,
    stripePaymentMethodId: row.stripe_payment_method_id,
    monthlySpendCapCents: row.monthly_spend_cap_cents,
    actualSpentCents: Number(spend.spent),
    referrer: { customerId: row.referrer_customer_id, name: row.referrer_name, email: row.referrer_email },
    friend: { name: row.friend_name, email: row.friend_email, phone: row.friend_phone },
  };
}

// Re-verifies eligibility from scratch (never trusts the batch select or
// previewCycle's own read — both are already stale by the time this
// runs), checks billing_status and the live spend cap, and — only if
// every check passes — claims the attempt by inserting the 'pending'
// referral_charge row with pricing snapshotted right now. `for update of
// r skip locked` means a referral already being worked by a concurrent
// invocation is silently skipped this cycle rather than waited on or
// double-claimed; it is not what makes double-charging impossible
// (billing_events' 'pending' status is deliberately outside the partial
// unique index, so two processes racing past this lock in different
// transactions can both still get this far) — see this file's top-of-file
// comment for what does, including the advisory lock that makes this
// mostly a defense-in-depth measure rather than the primary guarantee.
async function claimReferralCharge(referralId, now) {
  return withServiceRole(async (client) => {
    const info = await fetchReferralBillingInfo(client, referralId, now, { lockForUpdate: true });
    if (!info.eligible) {
      return { reason: info.reason, tenantId: info.tenantId, amountCents: info.amountCents };
    }

    if (info.actualSpentCents + info.amountCents > info.monthlySpendCapCents) {
      return {
        reason: `monthly spend cap reached (spent ${info.actualSpentCents}, cap ${info.monthlySpendCapCents}, this referral needs ${info.amountCents}) — retried automatically once the calendar month rolls over`,
        tenantId: info.tenantId,
        amountCents: info.amountCents,
      };
    }

    const { rows: [inserted] } = await client.query(
      `insert into billing_events
         (tenant_id, referral_id, event_type, amount_cents, reward_amount_cents, platform_fee_cents, status)
       values ($1, $2, 'referral_charge', $3, $4, $5, 'pending')
       returning id`,
      [info.tenantId, referralId, info.amountCents, info.rewardAmountCents, info.platformFeeCents]
    );

    return {
      billingEventId: inserted.id,
      tenantId: info.tenantId,
      amountCents: info.amountCents,
      rewardAmountCents: info.rewardAmountCents,
      currency: info.currency,
      stripeCustomerId: info.stripeCustomerId,
      stripePaymentMethodId: info.stripePaymentMethodId,
      referrer: info.referrer,
      friend: info.friend,
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
