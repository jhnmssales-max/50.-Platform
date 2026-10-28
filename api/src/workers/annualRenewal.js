// The yearly 50. fee. The one-time activation payment covers a dealer's
// first 12 months; 12 months after that payment, tenants.annual_fee_cents
// ($100 by default) is charged — off-session, to the card the dealer saved
// at activation — and again every 12 months after. Run hourly by a Render
// Cron Job (workers/runAnnualRenewal.js), the same way the reward-issuance
// worker is.
//
// Who is ever charged: only a billing-required tenant with a
// renewal_due_at that has passed. renewal_due_at is set by the Stripe
// webhook when a *live* activation payment is confirmed (activation + 12
// months) and is null for Good Steward Structures, North Mountain
// Structures and 50. itself (tenants_exempt_has_no_renewal), for tenants
// that haven't paid, and for test-mode activations. The exemption is
// re-checked here from a locked read anyway, before any Stripe call.
//
// It moves real money with nobody watching, so it follows the usage fee's
// rules (lib/referralFee.js) rather than inventing new ones:
//   - One billing_events row per attempt, inserted as 'pending' *before*
//     Stripe is called. billing_events_one_annual_renewal_idx allows only
//     one pending-or-succeeded row per tenant per renewal period, so two
//     runs, two servers, or a double-click on a manual run can never both
//     be charging the same year.
//   - The Stripe Idempotency-Key comes from the attempt's own row id
//     (annual_renewal:<billing_events.id>). A retry of the *same* attempt
//     reuses it, so Stripe hands back the original charge; a new attempt
//     after a decline gets a new key.
//   - 'failed' only when Stripe definitively said no (a 4xx). No answer, a
//     5xx, or Stripe still working leaves the row 'pending', and the next
//     run resumes that row — never a second charge on top of it.
//   - A successful charge marks the row 'succeeded' and moves
//     renewal_due_at forward 12 months in one transaction. If the process
//     dies between Stripe and that transaction, the next run finds the
//     pending row, asks Stripe what became of it, and finishes the job.
//
// A declined card: the dealer is emailed and the charge is retried, at
// most MAX_ATTEMPTS times in total, no sooner than RETRY_AFTER_MS apart.
// After the last one the worker stops (and says so in the log and in the
// email) — it does not shut the dealer off. A card that can't pay the
// yearly fee can't pay the 30% usage fee either, and that charge already
// holds back any payout. To start over for a tenant once its card is
// sorted out, set tenants.renewal_due_at to now(): a new period, with new
// attempts.
//
// A heads-up email goes out NOTICE_LEAD_DAYS before each charge, once per
// renewal period (tenants.renewal_notice_sent_for).
const { pool, withServiceRole, assertRowsAffected, assertServiceRoleConnection } = require('../db');
const { isQuietDay } = require('../lib/quietDay');
const { assertRealStripeConfigured, chargeOffSession, retrievePaymentIntent } = require('../lib/stripe');
const { activationState } = require('../lib/activation');
const { sendEmail } = require('../lib/postmark');
const { buildRenewalEmail } = require('../lib/renewalEmail');

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 72 * 60 * 60 * 1000;
const NOTICE_LEAD_DAYS = 14;
const MAX_TENANTS_PER_RUN = 25;
const PENDING_RESEND_WINDOW_MS = 23 * 60 * 60 * 1000;
const IN_FLIGHT_GRACE_MS = 2 * 60 * 1000;
// Fixed and dedicated to this worker (the reward worker's is 5031982004);
// held on one connection for the whole cycle, same as that one.
const ADVISORY_LOCK_KEY = 5031982005;

const DEFAULT_SUPPORT_EMAIL = 'joseph@referwith50.com';

function log(event, data) {
  console.log(`RENEWAL_WORKER ${event} ${JSON.stringify(data)}`);
}

function supportEmail() {
  return process.env.BILLING_SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL;
}

// ---------------------------------------------------------------------------
// One tenant
// ---------------------------------------------------------------------------

// The next due date after charging `dueAt`: 12 months on, and — if the
// worker was down for a long stretch — the first anniversary that is still
// in the future, so a missed year is skipped, never charged twice in a row.
// SQL does the date math (it clamps Feb 29 and month ends correctly), in
// UTC so a server's TimeZone setting can't move a due date by a day.
async function nextDueAfter(client, dueAtText) {
  await client.query("set local time zone 'UTC'");
  const { rows: [row] } = await client.query(
    `select (d.due + make_interval(months => 12 * n))::timestamptz::text as next_due
     from (select $1::timestamptz as due) d, generate_series(1, 50) n
     where d.due + make_interval(months => 12 * n) > now()
     order by n limit 1`,
    [dueAtText]
  );
  if (!row) throw new Error(`Could not compute the next renewal date after ${dueAtText}`);
  return row.next_due;
}

// Timestamps that are matched for equality travel as Postgres's own text
// (`renewal_due_at::text`, microseconds included) and are cast back with
// ::timestamptz — never as a JS Date, which keeps only milliseconds and
// would no longer equal the stored value.
async function advanceRenewal(client, tenantId, dueAtText) {
  const nextDue = await nextDueAfter(client, dueAtText);
  // "and renewal_due_at = $3" — only ever moves the exact period that was
  // just settled; a concurrent change to the date wins instead of being
  // overwritten.
  const result = await client.query(
    'update tenants set renewal_due_at = $2::timestamptz where id = $1 and renewal_due_at = $3::timestamptz',
    [tenantId, nextDue, dueAtText]
  );
  await assertRowsAffected(client, result, { table: 'tenants', id: tenantId });
  return nextDue;
}

async function recordAttempt(billingEventId, { status, errorDetail, paymentIntentId, livemode, advance }) {
  return withServiceRole(async (client) => {
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
      // Benign only if a concurrent resume already recorded this exact
      // outcome for this exact PaymentIntent.
      const { rows: [current] } = await client.query(
        'select status, stripe_payment_intent_id from billing_events where id = $1',
        [billingEventId]
      );
      if (current && current.status === status && paymentIntentId && current.stripe_payment_intent_id === paymentIntentId) {
        return null;
      }
      await assertRowsAffected(client, result, { table: 'billing_events', id: billingEventId });
    }
    if (advance) return advanceRenewal(client, advance.tenantId, advance.dueText);
    return null;
  });
}

// Everything decided under the tenant's row lock, before any Stripe call.
// Returns one of:
//   { outcome, ...detail }                       — nothing to charge
//   { charge: { row, attempt, resume } }         — go charge `attempt`
async function claimRenewal(tenantId, { dryRun, stripeMode }) {
  return withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      `select t.id, t.slug, t.name, t.billing_required, t.billing_status,
              t.activation_paid_at, t.activation_livemode,
              t.stripe_customer_id, t.stripe_payment_method_id,
              t.annual_fee_cents, t.renewal_due_at, t.reward_currency,
              t.renewal_due_at::text as due_text,
              (t.renewal_due_at is not null and t.renewal_due_at <= now()) as is_due
       from tenants t
       where t.id = $1
       for update`,
      [tenantId]
    );
    if (!row) return { outcome: 'not_found' };

    // Exempt tenants (Good Steward Structures, North Mountain Structures,
    // 50. itself) are never charged — checked first, before anything else
    // is even read. Only an explicit true makes a tenant billable.
    if (row.billing_required !== true) return { outcome: 'not_billable', row };
    if (!row.renewal_due_at) return { outcome: 'not_billable', row };
    if (!row.is_due) return { outcome: 'not_due', row };

    const gate = activationState(row, stripeMode);
    if (gate.required) return { outcome: 'skipped', reason: `activation not valid in ${stripeMode} mode (${gate.reason})`, row };
    if (stripeMode === 'test' && row.activation_livemode === true) {
      return { outcome: 'skipped', reason: 'saved payment method is from Stripe live mode but this worker is on a test key', row };
    }
    if (row.billing_status !== 'active') {
      return { outcome: 'skipped', reason: `billing_status is '${row.billing_status}', not 'active'`, row };
    }

    // A waived renewal ($0): nothing to charge, just start the next year.
    if (row.annual_fee_cents === 0) {
      if (dryRun) return { outcome: 'would_waive', row };
      const nextDue = await advanceRenewal(client, tenantId, row.due_text);
      return { outcome: 'waived', row, nextDue };
    }

    const { rows: attempts } = await client.query(
      `select id, status, amount_cents, stripe_payment_intent_id, error_detail, created_at
       from billing_events
       where tenant_id = $1 and event_type = 'annual_renewal' and renews_from = $2::timestamptz
       order by created_at`,
      [tenantId, row.due_text]
    );

    // A charge that went through but whose bookkeeping didn't finish:
    // finish it, never charge again.
    const succeeded = attempts.find((a) => a.status === 'succeeded');
    if (succeeded) {
      if (dryRun) return { outcome: 'would_finish_bookkeeping', row };
      const nextDue = await advanceRenewal(client, tenantId, row.due_text);
      return { outcome: 'already_succeeded', row, attempt: succeeded, nextDue };
    }

    const pending = attempts.find((a) => a.status === 'pending');
    if (!pending) {
      const failed = attempts.filter((a) => a.status === 'failed');
      if (failed.length >= MAX_ATTEMPTS) return { outcome: 'attempts_exhausted', row, failedCount: failed.length };
      const last = failed[failed.length - 1];
      if (last && Date.now() - new Date(last.created_at).getTime() < RETRY_AFTER_MS) {
        return { outcome: 'retry_wait', row, failedCount: failed.length };
      }
    }

    if (!row.stripe_customer_id || !row.stripe_payment_method_id) {
      console.error(`RENEWAL_WORKER tenant ${tenantId} (${row.slug}) is due for its annual fee but has no saved Stripe customer/payment method — cannot charge.`);
      return { outcome: 'skipped', reason: 'no saved payment method', row };
    }

    if (dryRun) return { outcome: 'would_charge', row, amountCents: row.annual_fee_cents, resume: !!pending };

    if (pending) return { charge: { row, attempt: pending, resume: true, failedCount: attempts.filter((a) => a.status === 'failed').length } };

    const { rows: [inserted] } = await client.query(
      `insert into billing_events (tenant_id, event_type, amount_cents, renews_from, status)
       values ($1, 'annual_renewal', $2, $3::timestamptz, 'pending')
       returning id, status, amount_cents, stripe_payment_intent_id, error_detail, created_at`,
      [tenantId, row.annual_fee_cents, row.due_text]
    );
    return { charge: { row, attempt: inserted, resume: false, failedCount: attempts.filter((a) => a.status === 'failed').length } };
  });
}

async function processRenewal(tenantId, { dryRun = false, stripeMode } = {}) {
  const claim = await claimRenewal(tenantId, { dryRun, stripeMode });
  if (!claim.charge) {
    if (claim.outcome === 'waived' || claim.outcome === 'already_succeeded') {
      log(claim.outcome, { tenantId, slug: claim.row.slug, nextDue: claim.nextDue });
    }
    return claim;
  }

  const { row, attempt, resume, failedCount } = claim.charge;
  const base = { tenantId, slug: row.slug, billingEventId: attempt.id, amountCents: attempt.amount_cents };
  const currency = row.reward_currency;
  const dueText = row.due_text;

  let paymentIntent;
  try {
    if (resume && attempt.stripe_payment_intent_id) {
      paymentIntent = await retrievePaymentIntent(attempt.stripe_payment_intent_id);
    } else {
      if (resume) {
        const ageMs = Date.now() - new Date(attempt.created_at).getTime();
        if (ageMs >= PENDING_RESEND_WINDOW_MS) {
          console.error(`RENEWAL_WORKER billing_events ${attempt.id} (tenant ${tenantId}) has been pending with an unknown outcome for over 23h — needs manual review in Stripe before anything is retried`);
          return { outcome: 'needs_review', ...base };
        }
        if (!attempt.error_detail && ageMs < IN_FLIGHT_GRACE_MS) {
          return { outcome: 'in_flight', ...base };
        }
      }
      paymentIntent = await chargeOffSession({
        customerId: row.stripe_customer_id,
        paymentMethodId: row.stripe_payment_method_id,
        amountCents: attempt.amount_cents,
        currency,
        description: `50. Platform annual fee — ${row.name}`,
        metadata: { tenant_id: row.id, billing_event_id: attempt.id, kind: 'annual_renewal' },
        idempotencyKey: `annual_renewal:${attempt.id}`,
      });
    }
  } catch (err) {
    if (err.stripeOutcomeUnknown) {
      await recordAttempt(attempt.id, {
        status: 'pending',
        errorDetail: `Outcome unknown, will resume with the same Idempotency-Key: ${err.message}`,
        paymentIntentId: err.stripePaymentIntentId,
      });
      console.error(`RENEWAL_WORKER outcome unknown for billing_events ${attempt.id} (tenant ${tenantId}): ${err.message}`);
      return { outcome: 'pending_unknown', ...base };
    }
    if (err.stripeType === 'idempotency_error') {
      await recordAttempt(attempt.id, { status: 'pending', errorDetail: `Needs manual review: ${err.message}` });
      console.error(`RENEWAL_WORKER billing_events ${attempt.id} (tenant ${tenantId}) needs manual review: ${err.message}`);
      return { outcome: 'needs_review', ...base };
    }
    // A definite no from Stripe (4xx): nothing was charged.
    await recordAttempt(attempt.id, {
      status: 'failed',
      errorDetail: err.stripeDeclineCode ? `${err.message} (${err.stripeDeclineCode})` : err.message,
      paymentIntentId: err.stripePaymentIntentId,
      livemode: err.stripePaymentIntentLivemode,
    });
    console.error(`RENEWAL_WORKER charge failed for billing_events ${attempt.id} (tenant ${tenantId}): ${err.message}`);
    // Only a card problem is the dealer's to hear about; anything else
    // (a bad key, an invalid request) is 50.'s, logged above in full.
    const finalAttempt = failedCount + 1 >= MAX_ATTEMPTS;
    if (err.stripeType === 'card_error') {
      await notifyAdmins(row.id, 'failed', {
        tenantName: row.name, feeCents: attempt.amount_cents, currency, finalAttempt,
        nextRetryAt: new Date(Date.now() + RETRY_AFTER_MS),
      });
    }
    return { outcome: 'failed', ...base, finalAttempt, error: err.message };
  }

  const livemode = typeof paymentIntent.livemode === 'boolean' ? paymentIntent.livemode : null;

  if (paymentIntent.status === 'succeeded') {
    const nextDue = await recordAttempt(attempt.id, {
      status: 'succeeded',
      paymentIntentId: paymentIntent.id,
      livemode,
      advance: { tenantId: row.id, dueText },
    });
    log('succeeded', { ...base, paymentIntentId: paymentIntent.id, livemode, nextDue });
    await notifyAdmins(row.id, 'receipt', { tenantName: row.name, feeCents: attempt.amount_cents, currency, paidAt: new Date(), dueAt: nextDue });
    return { outcome: 'succeeded', ...base, paymentIntentId: paymentIntent.id, nextDue };
  }

  if (paymentIntent.status === 'processing') {
    await recordAttempt(attempt.id, { status: 'pending', paymentIntentId: paymentIntent.id, livemode });
    return { outcome: 'processing', ...base };
  }

  const detail = (paymentIntent.last_payment_error && paymentIntent.last_payment_error.message) || `PaymentIntent status '${paymentIntent.status}'`;
  await recordAttempt(attempt.id, { status: 'failed', errorDetail: detail, paymentIntentId: paymentIntent.id, livemode });
  const finalAttempt = failedCount + 1 >= MAX_ATTEMPTS;
  await notifyAdmins(row.id, 'failed', {
    tenantName: row.name, feeCents: attempt.amount_cents, currency, finalAttempt,
    nextRetryAt: new Date(Date.now() + RETRY_AFTER_MS),
  });
  return { outcome: 'failed', ...base, finalAttempt, error: detail };
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

async function adminRecipients(tenantId) {
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      "select name, email from users where tenant_id = $1 and role = 'admin' and email is not null order by created_at",
      [tenantId]
    );
    return rows;
  });
}

// Never throws: a failed email must not undo, block, or re-run a charge.
async function notifyAdmins(tenantId, kind, details) {
  try {
    const from = process.env.EMAIL_FROM_ADDRESS;
    if (!from) throw new Error('EMAIL_FROM_ADDRESS is not set');
    const admins = await adminRecipients(tenantId);
    if (!admins.length) {
      console.error(`RENEWAL_WORKER no admin to email for tenant ${tenantId} (${kind})`);
      return false;
    }
    const support = supportEmail();
    const { subject, htmlBody, textBody } = buildRenewalEmail(kind, {
      ...details,
      adminName: admins[0].name,
      supportEmail: support,
    });
    await sendEmail({
      from: `50. <${from}>`,
      to: admins.map((a) => a.email).join(', '),
      cc: support,
      replyTo: support,
      subject,
      htmlBody,
      textBody,
    });
    log('email_sent', { tenantId, kind });
    return true;
  } catch (err) {
    console.error(`RENEWAL_WORKER failed to send ${kind} email for tenant ${tenantId}: ${err.message}`);
    return false;
  }
}

// The two-weeks-ahead heads-up. Claims the send first (so two overlapping
// runs can't both send it), and releases the claim if the send fails so the
// next hourly run tries again.
async function sendUpcomingNotices({ dryRun, stripeMode, now = new Date() }) {
  // Sunday holds the advance notice and nothing else in this worker. The
  // charge itself, the receipt for it, and a failed-payment alert all still
  // run today: one is money and the other two are a dealer needing to know
  // now. The notice goes out NOTICE_LEAD_DAYS ahead, so a day later is still
  // days of warning, and it is claimed per renewal date -- Monday sends it.
  if (isQuietDay(now)) {
    log('quiet_day', { note: 'Sunday: renewal notices held until Monday; charges and receipts unaffected' });
    return 0;
  }
  const { rows: candidates } = await pool.query(
    `select t.id, t.name, t.slug, t.renewal_due_at, t.renewal_due_at::text as due_text, t.annual_fee_cents, t.reward_currency,
            t.billing_required, t.billing_status, t.activation_paid_at, t.activation_livemode
     from tenants t
     where t.billing_required
       and t.annual_fee_cents > 0
       and t.renewal_due_at is not null
       and t.renewal_due_at > now()
       and t.renewal_due_at <= now() + make_interval(days => $1)
       and t.renewal_notice_sent_for is distinct from t.renewal_due_at
       and t.billing_status = 'active'
     order by t.renewal_due_at
     limit 100`,
    [NOTICE_LEAD_DAYS]
  );

  let sent = 0;
  for (const t of candidates) {
    if (activationState(t, stripeMode).required) continue; // not real money in this mode
    if (dryRun) {
      log('would_send_notice', { tenantId: t.id, slug: t.slug, dueAt: t.renewal_due_at });
      sent += 1;
      continue;
    }
    const claimed = await withServiceRole(async (client) => {
      const r = await client.query(
        `update tenants set renewal_notice_sent_for = renewal_due_at
         where id = $1 and renewal_due_at = $2::timestamptz and renewal_notice_sent_for is distinct from renewal_due_at`,
        [t.id, t.due_text]
      );
      return r.rowCount === 1;
    });
    if (!claimed) continue;
    const ok = await notifyAdmins(t.id, 'notice', {
      tenantName: t.name, feeCents: t.annual_fee_cents, currency: t.reward_currency, dueAt: t.renewal_due_at,
    });
    if (ok) {
      sent += 1;
    } else {
      await withServiceRole((client) =>
        client.query('update tenants set renewal_notice_sent_for = null where id = $1 and renewal_due_at = $2::timestamptz', [t.id, t.due_text])
      );
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

async function runAnnualRenewalCycle({ dryRun = false, now = new Date() } = {}) {
  // Same hard gate as every other money-moving path: a stand-in or
  // placeholder Stripe configuration can't make a renewal look paid.
  const { mode: stripeMode } = assertRealStripeConfigured();

  const lockClient = await pool.connect();
  try {
    const { rows: [lock] } = await lockClient.query('select pg_try_advisory_lock($1) as locked', [ADVISORY_LOCK_KEY]);
    if (!lock.locked) {
      log('lock_not_acquired', { note: 'another renewal cycle is already running; exiting' });
      return { aborted: false, skippedForLock: true, errored: 0 };
    }
    // The other three hourly workers each do this and this one did not. Its
    // first meaningful step is a broad read of `tenants`, so a DATABASE_URL
    // role that RLS applies to would return zero rows due -- and the cycle
    // would log a healthy "considered: 0" every hour while no dealer was ever
    // charged their yearly fee. The guard turns that silence into an error.
    await assertServiceRoleConnection(lockClient);
    try {
      const { rows: due } = await pool.query(
        `select id, slug from tenants
         where billing_required and renewal_due_at is not null and renewal_due_at <= now()
         order by renewal_due_at
         limit $1`,
        [MAX_TENANTS_PER_RUN]
      );

      const summary = { dryRun, stripeMode, considered: due.length, outcomes: {}, errored: 0, noticesSent: 0 };
      for (const t of due) {
        try {
          const result = await processRenewal(t.id, { dryRun, stripeMode });
          summary.outcomes[result.outcome] = (summary.outcomes[result.outcome] || 0) + 1;
          log('tenant_outcome', {
            tenantId: t.id,
            slug: t.slug,
            outcome: result.outcome,
            reason: result.reason,
            amountCents: result.amountCents,
            dryRun: dryRun || undefined,
          });
        } catch (err) {
          summary.errored += 1;
          console.error(`RENEWAL_WORKER error processing tenant ${t.id} (${t.slug}):`, err);
        }
      }

      try {
        summary.noticesSent = await sendUpcomingNotices({ dryRun, stripeMode, now });
      } catch (err) {
        summary.errored += 1;
        console.error('RENEWAL_WORKER error sending renewal notices:', err);
      }

      log('cycle_complete', summary);
      return summary;
    } finally {
      await lockClient.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

module.exports = {
  runAnnualRenewalCycle,
  processRenewal,
  MAX_ATTEMPTS,
  RETRY_AFTER_MS,
  NOTICE_LEAD_DAYS,
};
