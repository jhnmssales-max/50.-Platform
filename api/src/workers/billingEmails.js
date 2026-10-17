// The money emails 50. sends a billing-required dealer (see
// lib/billingEmails.js for what each says):
//   - activation receipt: sent from the Stripe webhook the moment the $500
//     goes through (sendActivationReceipt), and swept up here every hour for
//     any activation whose receipt hasn't gone out — a failed send, a
//     webhook that died after activating, or a dealer who activated before
//     these emails existed.
//   - referral summary: one per dealer per month, on or after 9 am Eastern
//     on the 1st, listing every referral fee charged that wasn't on an
//     earlier summary. Months with no charged fees send nothing.
//   - yearly summary: one per dealer per calendar year, on or after Jan 2,
//     for the year just ended (until the end of March), when the dealer paid
//     anything or was charged anything that year.
// All go to every admin on the dealer's account, from 50., with 50.'s
// support address as Reply-To (and on copy for the activation receipt only —
// the monthly and yearly emails would otherwise bury the inbox).
//
// Nothing here moves money, and nothing here can fail a charge, a webhook
// or a request: every send is best effort, logged, and retried by the next
// hourly run (at most every RETRY_AFTER_FAILURE_MS per email).
//
// Exactly once: each email is first CLAIMED as a billing_emails row (unique
// per tenant + kind + period), sent, then stamped sent. A failed send
// deletes its claim; a sender that died mid-send leaves a claim anyone may
// retake after 15 minutes. A Postgres advisory lock keeps overlapping hourly
// runs (two servers, a restart) from doing the same work twice. Who gets
// emailed is only ever a billing-required tenant whose activation counts as
// real money (lib/activation.js), so billing-exempt tenants (Good Steward
// Structures, North Mountain Structures, 50. itself) and test-mode
// activations on a live key are never emailed.
const { pool, withServiceRole, assertRowsAffected, assertServiceRoleConnection } = require('../db');
const { sendEmail } = require('../lib/postmark');
const { activationState } = require('../lib/activation');
const { stripeKeyMode, retrievePaymentReceiptDetails } = require('../lib/stripe');
const {
  BILLING_TIME_ZONE,
  supportEmail,
  buildActivationReceiptEmail,
  buildReferralStatementEmail,
  buildAnnualSummaryEmail,
} = require('../lib/billingEmails');

// Fixed and dedicated to this worker (rewards 5031982004, renewals ...05).
const ADVISORY_LOCK_KEY = 5031982006;
const MAX_TENANTS_PER_JOB = 50;
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
const ANNUAL_SEND_WINDOW_MONTHS = 3;

// Remembered per process only: a send that just failed isn't retried every
// hour, but a restart (or a fix) tries again straight away.
const recentFailures = new Map();

function log(event, data) {
  console.log(`BILLING_EMAILS ${event} ${JSON.stringify(data)}`);
}

// ---------------------------------------------------------------------------
// Time. Month and year boundaries are America/New_York, computed by Postgres
// (which knows daylight saving) from one instant, so a test can pass any `now`.
// ---------------------------------------------------------------------------
async function clockAt(now) {
  const tz = BILLING_TIME_ZONE; // a constant of this codebase, never input
  const { rows: [c] } = await pool.query(
    `select
       to_char(date_trunc('month', c.local) - interval '1 month', 'YYYY-MM') as previous_month,
       (date_trunc('month', c.local) - interval '1 month') at time zone '${tz}' as previous_month_start,
       date_trunc('month', c.local) at time zone '${tz}' as month_start,
       (date_trunc('month', c.local) + interval '9 hours') at time zone '${tz}' as month_send_after,
       (extract(year from c.local)::int - 1) as previous_year,
       (date_trunc('year', c.local) - interval '1 year') at time zone '${tz}' as previous_year_start,
       date_trunc('year', c.local) at time zone '${tz}' as year_start,
       (date_trunc('year', c.local) + interval '1 day 9 hours') at time zone '${tz}' as year_send_after,
       (date_trunc('year', c.local) + interval '${ANNUAL_SEND_WINDOW_MONTHS} months') at time zone '${tz}' as year_send_until
     from (select ($1::timestamptz at time zone '${tz}') as local) c`,
    [now.toISOString()]
  );
  return c;
}

// ---------------------------------------------------------------------------
// The claim ledger
// ---------------------------------------------------------------------------

// Takes the (tenant, kind, period) row if it doesn't exist yet, or retakes an
// unsent one whose sender evidently died. Resolves its id, or null when the
// email was already sent or another sender is working on it right now.
async function claim(tenantId, kind, period) {
  return withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      `insert into billing_emails (tenant_id, kind, period) values ($1, $2, $3)
       on conflict on constraint billing_emails_one_per_period do update set claimed_at = now()
         where billing_emails.sent_at is null and billing_emails.claimed_at < now() - interval '15 minutes'
       returning id`,
      [tenantId, kind, period]
    );
    return row ? row.id : null;
  });
}

async function release(claimId) {
  await withServiceRole((client) => client.query('delete from billing_emails where id = $1 and sent_at is null', [claimId]));
}

async function markSent(claimId, { recipients, detail }, alsoInSameTransaction) {
  await withServiceRole(async (client) => {
    const result = await client.query(
      'update billing_emails set sent_at = now(), recipients = $2, detail = $3::jsonb where id = $1',
      [claimId, recipients, JSON.stringify(detail || {})]
    );
    await assertRowsAffected(client, result, { table: 'billing_emails', id: claimId });
    if (alsoInSameTransaction) await alsoInSameTransaction(client);
  });
}

async function adminRecipients(tenantId) {
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      "select name, email from users where tenant_id = $1 and role = 'admin' and email is not null order by created_at",
      [tenantId]
    );
    return rows;
  });
}

// Claim -> build -> send -> stamp. `build(admins)` returns
// { email: { subject, htmlBody, textBody }, detail, markReported } or
// { nothing: true } when there turns out to be nothing to say (no claim is
// kept). Never throws: a failed send must not break whatever called it.
async function claimAndSend({ tenant, kind, period, copySupport, dryRun, build }) {
  const key = `${tenant.id}:${kind}:${period}`;
  try {
    const failedAt = recentFailures.get(key);
    if (failedAt && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return { outcome: 'retry_wait' };

    const admins = await adminRecipients(tenant.id);
    if (!admins.length) {
      console.error(`BILLING_EMAILS no admin to email for tenant ${tenant.id} (${tenant.slug}) — ${kind} ${period}`);
      return { outcome: 'no_admin' };
    }
    if (dryRun) {
      const built = await build(admins);
      return built.nothing ? { outcome: 'nothing_to_send' } : { outcome: 'would_send', subject: built.email.subject, to: admins.map((a) => a.email) };
    }

    const claimId = await claim(tenant.id, kind, period);
    if (!claimId) return { outcome: 'already_sent' };

    let built;
    try {
      built = await build(admins);
      if (built.nothing) {
        await release(claimId);
        return { outcome: 'nothing_to_send' };
      }
      const from = process.env.EMAIL_FROM_ADDRESS;
      if (!from) throw new Error('EMAIL_FROM_ADDRESS is not set');
      const support = supportEmail();
      await sendEmail({
        from: `50. <${from}>`,
        to: admins.map((a) => a.email).join(', '),
        ...(copySupport ? { cc: support } : {}),
        replyTo: support,
        subject: built.email.subject,
        htmlBody: built.email.htmlBody,
        textBody: built.email.textBody,
      });
    } catch (err) {
      await release(claimId).catch(() => {});
      recentFailures.set(key, Date.now());
      console.error(`BILLING_EMAILS failed to send ${kind} ${period} for tenant ${tenant.id} (${tenant.slug}): ${err.message}`);
      return { outcome: 'failed', error: err.message };
    }

    recentFailures.delete(key);
    try {
      await markSent(claimId, { recipients: admins.map((a) => a.email).join(', '), detail: built.detail }, built.markReported);
    } catch (err) {
      // The email is out; only the bookkeeping failed. The claim stays
      // unsent and is retaken after 15 minutes, so the dealer may see a
      // duplicate — never a gap.
      console.error(`BILLING_EMAILS sent ${kind} ${period} for tenant ${tenant.id} (${tenant.slug}) but could not record it: ${err.message}`);
      return { outcome: 'sent_unrecorded' };
    }
    log('email_sent', { tenantId: tenant.id, slug: tenant.slug, kind, period, subject: built.email.subject });
    return { outcome: 'sent', subject: built.email.subject };
  } catch (err) {
    console.error(`BILLING_EMAILS error on ${kind} ${period} for tenant ${tenant.id} (${tenant.slug}): ${err.message}`);
    return { outcome: 'failed', error: err.message };
  }
}

// True when a row's Stripe-reported mode is acceptable for this API's key:
// on a live key a test-mode (livemode = false) row is not real money.
function liveModeFilterParam(stripeMode) {
  return stripeMode === 'test';
}

// ---------------------------------------------------------------------------
// Activation receipt
// ---------------------------------------------------------------------------
const TENANT_COLUMNS = `t.id, t.slug, t.name, t.billing_required, t.billing_status, t.activation_paid_at, t.activation_livemode,
       t.annual_fee_cents, t.renewal_due_at, t.reward_amount_cents,
       t.referral_fee_cents, t.charge_card_cost, t.reward_currency, t.payment_method_type`;

async function buildActivationReceipt(tenant, admins, stripeMode) {
  const { rows: [payment] } = await pool.query(
    `select amount_cents, stripe_payment_intent_id
     from billing_events
     where tenant_id = $1 and event_type = 'activation_charge' and status = 'succeeded'
       and ($2::boolean or livemode is distinct from false)
     order by created_at, id
     limit 1`,
    [tenant.id, liveModeFilterParam(stripeMode)]
  );
  const details = payment ? await retrievePaymentReceiptDetails(payment.stripe_payment_intent_id) : {};
  return {
    email: buildActivationReceiptEmail({
      tenantName: tenant.name,
      adminName: admins[0].name,
      amountCents: payment ? payment.amount_cents : tenant.activation_fee_cents,
      currency: tenant.reward_currency,
      paidAt: tenant.activation_paid_at,
      methodLabel: details.methodLabel,
      receiptUrl: details.receiptUrl,
      annualFeeCents: tenant.annual_fee_cents,
      renewalDueAt: tenant.renewal_due_at,
      rewardAmountCents: tenant.reward_amount_cents,
      referralFeeCents: tenant.referral_fee_cents,
      chargeCardCost: tenant.charge_card_cost,
      paymentMethodType: tenant.payment_method_type,
    }),
    detail: { amountCents: payment ? payment.amount_cents : null, paymentIntentId: payment ? payment.stripe_payment_intent_id : null },
  };
}

// Sends one tenant's activation receipt if it hasn't gone out. Safe to call
// any number of times and from anywhere (the webhook calls it right after
// activating); resolves an { outcome } and never throws.
async function sendActivationReceipt(tenantId, { stripeMode = stripeKeyMode(), dryRun = false } = {}) {
  try {
    const { rows: [tenant] } = await pool.query(
      `select ${TENANT_COLUMNS}, t.activation_fee_cents from tenants t where t.id = $1`,
      [tenantId]
    );
    if (!tenant || tenant.billing_required !== true || !tenant.activation_paid_at) return { outcome: 'not_eligible' };
    if (activationState(tenant, stripeMode).required) return { outcome: 'not_eligible' };
    return await claimAndSend({
      tenant,
      kind: 'activation_receipt',
      period: 'activation',
      copySupport: true,
      dryRun,
      build: async (admins) => buildActivationReceipt(tenant, admins, stripeMode),
    });
  } catch (err) {
    console.error(`BILLING_EMAILS activation receipt for tenant ${tenantId} failed: ${err.message}`);
    return { outcome: 'failed', error: err.message };
  }
}

async function sweepActivationReceipts({ dryRun, stripeMode }) {
  const { rows } = await pool.query(
    `select t.id from tenants t
     where t.billing_required and t.activation_paid_at is not null
       and not exists (
         select 1 from billing_emails e
         where e.tenant_id = t.id and e.kind = 'activation_receipt' and e.period = 'activation' and e.sent_at is not null)
     order by t.activation_paid_at
     limit $1`,
    [MAX_TENANTS_PER_JOB]
  );
  const outcomes = {};
  for (const { id } of rows) {
    const r = await sendActivationReceipt(id, { stripeMode, dryRun });
    outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Monthly referral summary
// ---------------------------------------------------------------------------
async function buildReferralStatement(tenant, admins, clock, stripeMode) {
  const { rows } = await pool.query(
    `select be.id, be.created_at as at, be.amount_cents as fee_cents, be.reward_amount_cents,
            r.name as friend_name, c.name as referrer_name
     from billing_events be
     left join referrals r on r.id = be.referral_id
     left join referral_links rl on rl.id = r.referral_link_id
     left join customers c on c.id = rl.customer_id
     where be.tenant_id = $1 and be.event_type = 'referral_fee' and be.status = 'succeeded'
       and be.statement_period is null and be.created_at < $2::timestamptz
       and ($3::boolean or be.livemode is distinct from false)
     order by be.created_at, be.id`,
    [tenant.id, clock.month_start.toISOString(), liveModeFilterParam(stripeMode)]
  );
  if (!rows.length) return { nothing: true };

  const lines = rows.map((r) => ({
    at: r.at,
    referrerName: r.referrer_name,
    friendName: r.friend_name,
    payoutCents: (r.reward_amount_cents || 0) * 2,
    feeCents: r.fee_cents,
  }));
  const ids = rows.map((r) => r.id);
  const period = clock.previous_month;
  return {
    email: buildReferralStatementEmail({
      tenantName: tenant.name,
      adminName: admins[0].name,
      period,
      rows: lines,
      earlierCount: rows.filter((r) => new Date(r.at) < clock.previous_month_start).length,
      currency: tenant.reward_currency,
      paymentMethodType: tenant.payment_method_type,
    }),
    detail: { billingEventIds: ids, totalFeeCents: lines.reduce((s, l) => s + l.feeCents, 0) },
    // In the same transaction that stamps the email sent, so a fee is
    // never both listed and still "unreported".
    markReported: async (client) => {
      await client.query('update billing_events set statement_period = $1 where id = any($2::uuid[]) and statement_period is null', [period, ids]);
    },
  };
}

async function sweepReferralStatements({ now, dryRun, stripeMode, clock }) {
  const outcomes = {};
  if (now < clock.month_send_after) return outcomes; // before 9 am Eastern on the 1st
  const { rows } = await pool.query(
    `select ${TENANT_COLUMNS}
     from tenants t
     where t.billing_required and t.activation_paid_at is not null
       and exists (
         select 1 from billing_events be
         where be.tenant_id = t.id and be.event_type = 'referral_fee' and be.status = 'succeeded'
           and be.statement_period is null and be.created_at < $1::timestamptz)
       and not exists (
         select 1 from billing_emails e
         where e.tenant_id = t.id and e.kind = 'referral_statement' and e.period = $2 and e.sent_at is not null)
     order by t.activation_paid_at
     limit $3`,
    [clock.month_start.toISOString(), clock.previous_month, MAX_TENANTS_PER_JOB]
  );
  for (const tenant of rows) {
    if (activationState(tenant, stripeMode).required) continue;
    const r = await claimAndSend({
      tenant,
      kind: 'referral_statement',
      period: clock.previous_month,
      copySupport: false,
      dryRun,
      build: (admins) => buildReferralStatement(tenant, admins, clock, stripeMode),
    });
    outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Yearly summary
// ---------------------------------------------------------------------------
async function buildAnnualSummary(tenant, admins, clock, stripeMode) {
  const { rows } = await pool.query(
    `select be.event_type, be.amount_cents, be.reward_amount_cents, be.created_at as at
     from billing_events be
     where be.tenant_id = $1 and be.status = 'succeeded'
       and be.event_type in ('activation_charge', 'annual_renewal', 'referral_fee')
       and be.created_at >= $2::timestamptz and be.created_at < $3::timestamptz
       and ($4::boolean or be.livemode is distinct from false)
     order by be.created_at, be.id`,
    [tenant.id, clock.previous_year_start.toISOString(), clock.year_start.toISOString(), liveModeFilterParam(stripeMode)]
  );
  if (!rows.length) return { nothing: true };

  const activationRow = rows.find((r) => r.event_type === 'activation_charge');
  const renewals = rows.filter((r) => r.event_type === 'annual_renewal').map((r) => ({ amountCents: r.amount_cents, at: r.at }));
  const feeRows = rows.filter((r) => r.event_type === 'referral_fee');
  const fees = {
    count: feeRows.length,
    totalCents: feeRows.reduce((s, r) => s + r.amount_cents, 0),
    payoutCents: feeRows.reduce((s, r) => s + (r.reward_amount_cents || 0) * 2, 0),
  };

  // Month by month, in Eastern time, from the same instants the summary
  // emails use — asked of Postgres so the grouping can't drift from them.
  const { rows: monthRows } = await pool.query(
    `select to_char(be.created_at at time zone '${BILLING_TIME_ZONE}', 'YYYY-MM') as period,
            count(*)::int as count, sum(be.amount_cents)::int as fee_cents
     from billing_events be
     where be.tenant_id = $1 and be.status = 'succeeded' and be.event_type = 'referral_fee'
       and be.created_at >= $2::timestamptz and be.created_at < $3::timestamptz
       and ($4::boolean or be.livemode is distinct from false)
     group by 1 order by 1`,
    [tenant.id, clock.previous_year_start.toISOString(), clock.year_start.toISOString(), liveModeFilterParam(stripeMode)]
  );

  const nextRenewalAt = tenant.renewal_due_at && new Date(tenant.renewal_due_at) > new Date(clock.year_start) ? tenant.renewal_due_at : null;
  return {
    email: buildAnnualSummaryEmail({
      tenantName: tenant.name,
      adminName: admins[0].name,
      year: clock.previous_year,
      activation: activationRow ? { amountCents: activationRow.amount_cents, at: activationRow.at } : null,
      renewals,
      fees,
      months: monthRows.map((m) => ({ period: m.period, count: m.count, feeCents: m.fee_cents })),
      currency: tenant.reward_currency,
      nextRenewalAt,
      referralFeeCents: tenant.referral_fee_cents,
      chargeCardCost: tenant.charge_card_cost,
    }),
    detail: { year: clock.previous_year, feeCount: fees.count, feeTotalCents: fees.totalCents, renewalCount: renewals.length, activation: !!activationRow },
  };
}

async function sweepAnnualSummaries({ now, dryRun, stripeMode, clock }) {
  const outcomes = {};
  if (now < clock.year_send_after || now >= clock.year_send_until) return outcomes; // Jan 2 through March
  const { rows } = await pool.query(
    `select ${TENANT_COLUMNS}
     from tenants t
     where t.billing_required and t.activation_paid_at is not null
       and t.activation_paid_at < $1::timestamptz
       and not exists (
         select 1 from billing_emails e
         where e.tenant_id = t.id and e.kind = 'annual_summary' and e.period = $2 and e.sent_at is not null)
     order by t.activation_paid_at
     limit $3`,
    [clock.year_start.toISOString(), String(clock.previous_year), MAX_TENANTS_PER_JOB]
  );
  for (const tenant of rows) {
    if (activationState(tenant, stripeMode).required) continue;
    const r = await claimAndSend({
      tenant,
      kind: 'annual_summary',
      period: String(clock.previous_year),
      copySupport: false,
      dryRun,
      build: (admins) => buildAnnualSummary(tenant, admins, clock, stripeMode),
    });
    outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------
async function runBillingEmailCycle({ dryRun = false, now = new Date() } = {}) {
  const stripeMode = stripeKeyMode(); // live, test, or null: only decides which activations count as real money

  const lockClient = await pool.connect();
  try {
    // A broad read run as the wrong database role returns nothing and looks
    // like "no emails due" forever — refuse that loudly (see db.js).
    await assertServiceRoleConnection(lockClient);
    const { rows: [lock] } = await lockClient.query('select pg_try_advisory_lock($1) as locked', [ADVISORY_LOCK_KEY]);
    if (!lock.locked) {
      log('lock_not_acquired', { note: 'another billing-email cycle is already running; exiting' });
      return { skippedForLock: true, errored: 0 };
    }
    try {
      const clock = await clockAt(now);
      const summary = { dryRun, stripeMode, errored: 0 };
      const jobs = [
        ['activationReceipts', () => sweepActivationReceipts({ dryRun, stripeMode })],
        ['referralSummaries', () => sweepReferralStatements({ now, dryRun, stripeMode, clock })],
        ['yearlySummaries', () => sweepAnnualSummaries({ now, dryRun, stripeMode, clock })],
      ];
      for (const [name, job] of jobs) {
        try {
          summary[name] = await job();
        } catch (err) {
          summary.errored += 1;
          console.error(`BILLING_EMAILS error in ${name}:`, err);
        }
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

// For the e2e script only: forgets which sends failed recently, so a test can
// simulate "the hourly run after the outage" without waiting six hours.
function resetRetryThrottleForTests() {
  recentFailures.clear();
}

module.exports = { runBillingEmailCycle, sendActivationReceipt, resetRetryThrottleForTests };
