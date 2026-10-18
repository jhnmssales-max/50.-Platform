#!/usr/bin/env node
// Verification of the dealer billing emails (src/workers/billingEmails.js,
// src/lib/billingEmails.js, and their hooks in routes/webhooks.js and
// lib/stripe.js) against a real Postgres database built from every migration
// in supabase/migrations, the Stripe stand-in (stripe-stand-in.js), and a
// Postmark stub that records the emails it is asked to send.
//
//   node scripts/e2e/billing-emails-e2e.js
//
// Needs the same scratch Postgres 16 server as the other e2e scripts
// (E2E_PG_ADMIN_URL, default postgresql://postgres@127.0.0.1:54329/postgres).
// Creates its own throwaway database and drops it at the end.
//
// The Stripe webhook route runs in this process (mounted on a local express
// app that the stand-in delivers its events to), so "the $500 goes through
// -> the dealer is emailed" is exercised end to end. Months and years are
// driven by passing `now` to the cycle; nothing here waits for a calendar.
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Client } = require('pg');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const ACTIVATION_MIGRATION = '20261001000000_activation_gate_and_referral_fee.sql';
const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:54329/postgres';
const DB = `fifty_billing_emails_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const PORTS = {
  stripe: Number(process.env.E2E_STRIPE_PORT || 12111),
  postmark: Number(process.env.E2E_POSTMARK_PORT || 12112),
  webhook: Number(process.env.E2E_WEBHOOK_PORT || 12113),
};
const STRIPE_BASE = `http://127.0.0.1:${PORTS.stripe}`;
const WEBHOOK_SECRET = 'whsec_billingEmailsE2e0000000';

const results = [];
let currentSection = '';
function section(name) { currentSection = name; console.log(`\n=== ${name}`); }
async function check(title, fn) {
  try {
    const evidence = await fn();
    results.push({ section: currentSection, title, pass: true, evidence: evidence || '' });
    console.log(`  PASS  ${title}${evidence ? `\n        ${evidence}` : ''}`);
  } catch (err) {
    results.push({ section: currentSection, title, pass: false, evidence: err.message });
    console.log(`  FAIL  ${title}\n        ${err.message}`);
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
function eq(actual, expected, what) {
  assert(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function dbUrl(name) {
  const u = new URL(PG_ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}
async function withClient(url, fn) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function standIn(method, p, body) {
  const res = await fetch(`${STRIPE_BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function main() {
  // ----- Servers: Stripe stand-in, Postmark stub, webhook receiver ----------
  const { createStripeStandIn } = require('./stripe-stand-in');
  const emails = [];
  let postmarkFailing = false;
  const stubApp = express();
  stubApp.use(express.json());
  stubApp.post('/email', (req, res) => {
    if (postmarkFailing) return res.status(500).json({ ErrorCode: 500, Message: 'Postmark is down (test)' });
    emails.push(req.body);
    res.json({ ErrorCode: 0, MessageID: `msg-${emails.length}` });
  });
  const stubServer = stubApp.listen(PORTS.postmark, '127.0.0.1');
  const { app: stripeApp } = createStripeStandIn({
    publicBaseUrl: STRIPE_BASE,
    webhookUrl: `http://127.0.0.1:${PORTS.webhook}/api/webhooks/stripe`,
    webhookSecret: WEBHOOK_SECRET,
    webhookDelayMs: 50,
  });
  const stripeServer = stripeApp.listen(PORTS.stripe, '127.0.0.1');

  // ----- Database ---------------------------------------------------------------
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  await withClient(PG_ADMIN_URL, async (c) => {
    await c.query(`drop database if exists ${DB} with (force)`);
    await c.query(`create database ${DB}`);
  });
  const db = new Client({ connectionString: dbUrl(DB) });
  await db.connect();
  const sql = async (text, params) => (await db.query(text, params)).rows;

  // ----- The code under test, in this process ---------------------------------
  process.env.DATABASE_URL = dbUrl(DB);
  process.env.STRIPE_SECRET_KEY = 'sk_test_billingEmailsE2eKey00';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_STAND_IN_URL = `${STRIPE_BASE}/v1`;
  process.env.POSTMARK_API_BASE = `http://127.0.0.1:${PORTS.postmark}`;
  process.env.POSTMARK_SERVER_TOKEN = 'postmark-test-token';
  process.env.EMAIL_FROM_ADDRESS = 'notifications@referwith50.example';
  delete process.env.BILLING_SUPPORT_EMAIL;
  require('./stripe-stand-in-preload');
  const worker = require('../../src/workers/billingEmails');
  const stripeLib = require('../../src/lib/stripe');
  const emailLib = require('../../src/lib/billingEmails');
  const { buildRenewalEmail } = require('../../src/lib/renewalEmail');
  const { pool } = require('../../src/db');

  const webhookApp = express();
  webhookApp.use('/api', require('../../src/routes/webhooks'));
  const webhookServer = webhookApp.listen(PORTS.webhook, '127.0.0.1');

  const cycle = (opts) => worker.runBillingEmailCycle(opts);
  const sentTo = (slug) => emails.filter((e) => e.To.includes(`@${slug}.example`));
  const ledger = (tenantId, kind) => sql('select period, claimed_at, sent_at, recipients from billing_emails where tenant_id = $1 and kind = $2 order by period', [tenantId, kind]);

  let seq = 0;
  // A billing-required tenant that has paid its activation. By default its
  // activation receipt is already marked sent, so scenarios about the monthly
  // and yearly emails aren't muddied by backfilled receipts.
  async function makeTenant({ slug, paidAt = "now() - interval '200 days'", livemode = true, receiptSent = true, admins = 1, billingRequired = true } = {}) {
    seq += 1;
    slug = slug || `dealer-${seq}`;
    const saved = await standIn('POST', '/__control/payment-intent', { with_customer: true, livemode });
    const [t] = await sql(
      `insert into tenants (slug, name, billing_status, billing_required, activation_paid_at, activation_livemode, stripe_customer_id, stripe_payment_method_id)
       values ($1, $2, 'active', $3, ${paidAt}, $4, $5, $6) returning id, slug, name`,
      [slug, `Dealer ${slug}`, billingRequired, livemode, saved.customer, saved.payment_method]
    );
    for (let i = 1; i <= admins; i += 1) {
      const id = (await sql('select gen_random_uuid() as id'))[0].id;
      await sql('insert into auth.users (id, email) values ($1, $2)', [id, `admin${i}@${slug}.example`]);
      await sql(`insert into users (id, tenant_id, email, name, role) values ($1, $2, $3, $4, 'admin')`, [id, t.id, `admin${i}@${slug}.example`, `Admin${i} ${slug}`]);
    }
    if (receiptSent) {
      await sql(`insert into billing_emails (tenant_id, kind, period, sent_at, recipients) values ($1, 'activation_receipt', 'activation', now(), 'seeded')`, [t.id]);
    }
    return t;
  }
  // A referral (customer -> friend) and a charged fee for it.
  async function makeFee(tenant, { at, status = 'succeeded', rewardCents = 5000, feeCents = 3000, livemode = true, referrer = 'Pat Referrer', friend = 'Fran Friend' }) {
    seq += 1;
    const [c] = await sql(`insert into customers (tenant_id, name, email) values ($1, $2, $3) returning id`, [tenant.id, referrer, `ref${seq}@x.example`]);
    const [l] = await sql(`insert into referral_links (tenant_id, code, kind, customer_id) values ($1, $2, 'share', $3) returning id`, [tenant.id, `code-${seq}-${Math.random().toString(36).slice(2, 8)}`, c.id]);
    const [r] = await sql(`insert into referrals (tenant_id, referral_link_id, name, email, status) values ($1, $2, $3, $4, 'rewarded') returning id`, [tenant.id, l.id, friend, `friend${seq}@x.example`]);
    const [e] = await sql(
      `insert into billing_events (tenant_id, referral_id, event_type, amount_cents, reward_amount_cents, fee_rate_bps, status, livemode, created_at)
       values ($1, $2, 'referral_fee', $3, $4, 3000, $5, $6, $7) returning id`,
      [tenant.id, r.id, feeCents, rewardCents, status, livemode, at]
    );
    return e.id;
  }

  const OCT_1_8AM = '2026-10-01T12:00:00Z'; // 8:00 am EDT: before the monthly send time
  const OCT_1_10AM = '2026-10-01T14:00:00Z'; // 10:00 am EDT
  const NOV_2 = '2026-11-02T15:00:00Z';

  try {
    // ===========================================================================
    section('Migration');
    await db.query(fs.readFileSync(path.join(__dirname, 'supabase-stand-in.sql'), 'utf8'));
    for (const f of files) if (f < ACTIVATION_MIGRATION) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    await db.query(`insert into tenants (slug, name) values
      ('good-steward-structures', 'Good Steward Structures'),
      ('north-mountain-structures', 'North Mountain Structures'),
      ('50-platform', '50.');`);
    await check('Every migration applies in order, including the billing-emails one', async () => {
      const rest = files.filter((f) => f >= ACTIVATION_MIGRATION);
      for (const f of rest) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      assert(rest.includes('20261014000000_billing_emails.sql'), 'billing_emails migration not found');
      return rest.join(', ');
    });
    await check('The ledger allows one row per (tenant, kind, period); statement_period is only for referral_fee rows and must look like YYYY-MM', async () => {
      const [t] = await sql(`select id from tenants where slug = 'good-steward-structures'`);
      await sql(`insert into billing_emails (tenant_id, kind, period) values ($1, 'annual_summary', '2099')`, [t.id]);
      let dup = null;
      try { await sql(`insert into billing_emails (tenant_id, kind, period) values ($1, 'annual_summary', '2099')`, [t.id]); } catch (err) { dup = err.message; }
      assert(dup && dup.includes('billing_emails_one_per_period'), `duplicate not refused: ${dup}`);
      await sql('delete from billing_emails where tenant_id = $1', [t.id]);
      let wrongType = null;
      try { await sql(`insert into billing_events (tenant_id, event_type, amount_cents, status, statement_period) values ($1, 'activation_charge', 1, 'succeeded', '2026-09')`, [t.id]); } catch (err) { wrongType = err.message; }
      assert(wrongType && wrongType.includes('billing_events_statement_period_shape'), `statement_period on an activation row not refused: ${wrongType}`);
      const feeId = await makeFee(t, { at: '2026-09-03T16:00:00Z' });
      let badShape = null;
      try { await sql(`update billing_events set statement_period = 'September' where id = $1`, [feeId]); } catch (err) { badShape = err.message; }
      assert(badShape && badShape.includes('billing_events_statement_period_shape'), `bad shape not refused: ${badShape}`);
      await sql(`update billing_events set statement_period = '2026-09' where id = $1`, [feeId]);
      await sql('delete from billing_events where id = $1', [feeId]);
      return 'duplicate -> billing_emails_one_per_period; statement_period on a non-fee row or "September" -> billing_events_statement_period_shape';
    });
    await check('The ledger table is closed to the signed-in dealer role (RLS on, no policy)', async () => {
      const [{ relrowsecurity }] = await sql(`select relrowsecurity from pg_class where oid = 'billing_emails'::regclass`);
      const policies = await sql(`select 1 from pg_policies where tablename = 'billing_emails'`);
      assert(relrowsecurity === true, 'RLS not enabled');
      eq(policies.length, 0, 'policies');
      return 'row level security enabled, zero policies';
    });

    // ===========================================================================
    section('Checkout puts the dealer, not whoever is typing, on the Stripe customer');
    await check('createCheckoutSession passes customer_email for a new customer, never alongside an existing customer, and drops a malformed one', async () => {
      const base = { tenantId: 't-1', tenantName: 'Acme', amountCents: 50000, currency: 'usd', paymentMethodType: 'card', annualFeeCents: 10000, successUrl: 'https://x.example/ok', cancelUrl: 'https://x.example/no' };
      const logBefore = (await standIn('GET', '/__control/log')).requests.length;
      await stripeLib.createCheckoutSession({ ...base, customerEmail: ' owner@acme.example ' });
      const saved = await standIn('POST', '/__control/payment-intent', { with_customer: true });
      await stripeLib.createCheckoutSession({ ...base, existingCustomerId: saved.customer, customerEmail: 'owner@acme.example' });
      await stripeLib.createCheckoutSession({ ...base, customerEmail: 'not an email' });
      await stripeLib.createCheckoutSession({ ...base });
      const creates = (await standIn('GET', '/__control/log')).requests.slice(logBefore).filter((r) => r.method === 'POST' && r.path === '/checkout/sessions');
      eq(creates.length, 4, 'sessions created');
      eq(creates[0].body.customer_email, 'owner@acme.example', 'new customer: customer_email (trimmed)');
      eq(creates[1].body.customer_email, undefined, 'existing customer: customer_email');
      eq(creates[1].body.customer, saved.customer, 'existing customer: customer');
      eq(creates[2].body.customer_email, undefined, 'malformed email');
      eq(creates[3].body.customer_email, undefined, 'no email');
      return 'new customer -> customer_email=owner@acme.example; existing customer -> none; malformed/missing -> none, session still created';
    });

    // ===========================================================================
    section('Activation receipt — sent when the $500 goes through');
    const pay = await makeTenant({ slug: 'payer', receiptSent: false, paidAt: 'null', livemode: false });
    // Without a renewal date the annual-fee sentence never renders, and the
    // "$100.00" the check below looks for was being satisfied by the PAYOUT
    // figure in the old percentage wording instead -- an assertion labelled
    // "annual fee" passing for an unrelated reason. Set it so the sentence
    // it claims to check is actually in the email.
    await sql(`update tenants set renewal_due_at = now() + interval '1 year' where id = $1`, [pay.id]);
    await sql(`update tenants set billing_status = 'pending', activation_livemode = null, stripe_customer_id = null, stripe_payment_method_id = null where id = $1`, [pay.id]);
    let paySessionId;
    await check('Paying on the hosted page with a DIFFERENT email typed in still makes the dealer the Stripe customer; the webhook activates the tenant', async () => {
      const session = await stripeLib.createCheckoutSession({
        tenantId: pay.id, tenantName: pay.name, amountCents: 50000, currency: 'usd', paymentMethodType: 'card',
        annualFeeCents: 10000, customerEmail: 'admin1@payer.example',
        successUrl: 'https://x.example/ok?s={CHECKOUT_SESSION_ID}', cancelUrl: 'https://x.example/no',
      });
      paySessionId = session.id;
      const res = await fetch(`${STRIPE_BASE}/pay/${session.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ cardNumber: '4242 4242 4242 4242', email: 'joseph-typed-this@wrong.example' }),
        redirect: 'manual',
      });
      eq(res.status, 303, 'pay response');
      const row = await waitFor(async () => (await sql('select activation_paid_at, stripe_customer_id from tenants where id = $1', [pay.id]))[0].activation_paid_at && (await sql('select activation_paid_at, stripe_customer_id from tenants where id = $1', [pay.id]))[0], 'activation via webhook');
      const customer = (await standIn('GET', '/__control/state')).customers.find((c) => c.id === row.stripe_customer_id);
      eq(customer.email, 'admin1@payer.example', 'Stripe customer email');
      return `Stripe customer ${customer.id} email = ${customer.email} (not the address typed on the payment page)`;
    });
    await check('The dealer gets exactly one receipt, from 50., with the amount, card, Stripe receipt link, first-year coverage and the flat per-referral fee — support on cc', async () => {
      await waitFor(() => sentTo('payer').length >= 1, 'activation receipt email');
      await sleep(300);
      const mine = sentTo('payer');
      eq(mine.length, 1, 'emails to the dealer');
      const e = mine[0];
      eq(e.To, 'admin1@payer.example', 'To');
      eq(e.Cc, 'joseph@referwith50.com', 'Cc');
      eq(e.ReplyTo, 'joseph@referwith50.com', 'ReplyTo');
      assert(e.From.includes('notifications@referwith50.example'), `From: ${e.From}`);
      assert(/Receipt/.test(e.Subject) && e.Subject.includes('$500.00') && e.Subject.includes(pay.name), `Subject: ${e.Subject}`);
      assert(e.TextBody.includes('Visa ending 4242'), 'text body missing the card');
      assert(e.TextBody.includes('https://receipts.stripe-stand-in.test/'), 'text body missing the Stripe receipt link');
      assert(e.HtmlBody.includes('https://receipts.stripe-stand-in.test/'), 'html body missing the Stripe receipt link');
      assert(e.TextBody.includes('$100.00'), 'text body missing the annual fee');
      // A flat amount per rewarded referral, not a percentage. The dealer
      // sends their own cards here (charge_card_cost off), so the email must
      // say so rather than quoting a gift-card payout 50. is not funding.
      assert(/\$30\.00/.test(e.TextBody), `text body missing the flat per-referral fee: ${e.TextBody}`);
      assert(!/%/.test(e.TextBody), `the receipt still quotes a percentage: ${e.TextBody}`);
      assert(/cards themselves are yours to send/.test(e.TextBody), 'receipt does not say who sends the cards');
      assert(!/\bjust\b/i.test(e.TextBody), 'the word "just" appears');
      assert(!e.To.includes('jhnmssales'), 'went to Joseph');
      const rows = await ledger(pay.id, 'activation_receipt');
      eq(rows.length, 1, 'ledger rows');
      assert(rows[0].sent_at, 'ledger row not stamped sent');
      return `"${e.Subject}" -> ${e.To}, cc ${e.Cc}; ledger: activation/${rows[0].recipients}`;
    });
    await check('Stripe redelivering the same webhook event, and the hourly sweep, do not send a second receipt', async () => {
      const log = await standIn('GET', '/__control/log');
      const completed = log.deliveries.find((d) => d.type === 'checkout.session.completed');
      assert(completed, 'no checkout.session.completed delivery recorded');
      const replay = await standIn('POST', '/__control/replay-event', { id: completed.eventId });
      eq(replay.status, 200, 'replayed delivery status');
      await cycle({ now: new Date(OCT_1_8AM) });
      await cycle({ now: new Date(OCT_1_8AM) });
      await sleep(300);
      eq(sentTo('payer').length, 1, 'emails to the dealer after redelivery + 2 sweeps');
      return 'replay -> 200; two sweeps; still exactly 1 email';
    });
    await check('Two receipts requested at the same instant -> one email (the claim is a database row, not a variable)', async () => {
      const t = await makeTenant({ slug: 'racer', receiptSent: false });
      const outs = await Promise.all([1, 2, 3, 4, 5].map(() => worker.sendActivationReceipt(t.id, { stripeMode: 'test' })));
      eq(sentTo('racer').length, 1, 'emails');
      const sent = outs.filter((o) => o.outcome === 'sent').length;
      eq(sent, 1, 'calls that sent');
      return `5 simultaneous calls -> outcomes ${outs.map((o) => o.outcome).join(', ')}; 1 email`;
    });
    await check('Backfill: a dealer who activated before these emails existed (e.g. Silver Run) gets the receipt on the next sweep, once', async () => {
      const t = await makeTenant({ slug: 'silverish', receiptSent: false, livemode: true });
      const s1 = await cycle({ now: new Date(OCT_1_8AM) });
      eq(sentTo('silverish').length, 1, 'emails after first sweep');
      await cycle({ now: new Date(OCT_1_8AM) });
      eq(sentTo('silverish').length, 1, 'emails after second sweep');
      assert(s1.activationReceipts && s1.activationReceipts.sent >= 1, `sweep summary: ${JSON.stringify(s1.activationReceipts)}`);
      return `sweep ${JSON.stringify(s1.activationReceipts)}; second sweep sent nothing`;
    });
    await check('Never emailed: billing-exempt tenants (GSS, NMS, 50.), unpaid tenants, test-mode activations on a live key', async () => {
      const before = emails.length;
      for (const slug of ['good-steward-structures', 'north-mountain-structures', '50-platform']) {
        await sql(`update tenants set activation_paid_at = now() where slug = $1`, [slug]).catch(() => {});
        const [t] = await sql('select id from tenants where slug = $1', [slug]);
        eq((await worker.sendActivationReceipt(t.id, { stripeMode: 'test' })).outcome, 'not_eligible', `${slug} outcome`);
      }
      const unpaid = await makeTenant({ slug: 'unpaid', receiptSent: false, paidAt: 'null' });
      eq((await worker.sendActivationReceipt(unpaid.id, { stripeMode: 'test' })).outcome, 'not_eligible', 'unpaid outcome');
      const testOnly = await makeTenant({ slug: 'testmode', receiptSent: false, livemode: false });
      eq((await worker.sendActivationReceipt(testOnly.id, { stripeMode: 'live' })).outcome, 'not_eligible', 'test-mode activation on a live key');
      eq(emails.length, before, 'emails sent');
      // (On this test-keyed run such a dealer would be emailed; keep later sections quiet.)
      await sql(`insert into billing_emails (tenant_id, kind, period, sent_at, recipients) values ($1, 'activation_receipt', 'activation', now(), 'seeded')`, [testOnly.id]);
      return 'exempt x3, unpaid, and test-mode-on-live-key -> not_eligible; 0 emails';
    });
    await check('A mail outage never loses the receipt: nothing is recorded as sent, and once Postmark is back it goes out exactly once', async () => {
      const t = await makeTenant({ slug: 'outage', receiptSent: false });
      postmarkFailing = true;
      const r1 = await worker.sendActivationReceipt(t.id, { stripeMode: 'test' });
      eq(r1.outcome, 'failed', 'outcome during the outage');
      eq((await ledger(t.id, 'activation_receipt')).length, 0, 'ledger rows after the failure');
      const r2 = await worker.sendActivationReceipt(t.id, { stripeMode: 'test' });
      eq(r2.outcome, 'retry_wait', 'immediate retry is throttled (not hammered every hour)');
      postmarkFailing = false;
      worker.resetRetryThrottleForTests();
      const r3 = await worker.sendActivationReceipt(t.id, { stripeMode: 'test' });
      eq(r3.outcome, 'sent', 'outcome after recovery');
      eq(sentTo('outage').length, 1, 'emails');
      return 'failed (no ledger row) -> throttled -> sent after recovery -> 1 email';
    });
    await check('A sender that died mid-send: a fresh unsent claim blocks everyone; a 20-minute-old one is retaken', async () => {
      const t = await makeTenant({ slug: 'crashed', receiptSent: false });
      await sql(`insert into billing_emails (tenant_id, kind, period, claimed_at) values ($1, 'activation_receipt', 'activation', now())`, [t.id]);
      eq((await worker.sendActivationReceipt(t.id, { stripeMode: 'test' })).outcome, 'already_sent', 'fresh claim');
      eq(sentTo('crashed').length, 0, 'emails with a fresh claim');
      await sql(`update billing_emails set claimed_at = now() - interval '20 minutes' where tenant_id = $1`, [t.id]);
      eq((await worker.sendActivationReceipt(t.id, { stripeMode: 'test' })).outcome, 'sent', 'stale claim');
      eq(sentTo('crashed').length, 1, 'emails after retaking');
      return 'fresh claim -> held; stale (20 min) claim -> retaken and sent';
    });

    // ===========================================================================
    section('Monthly referral summary');
    const m1 = await makeTenant({ slug: 'monthly', admins: 2 });
    const quiet = await makeTenant({ slug: 'quiet' });
    const exempt = (await sql(`select id, slug, name from tenants where slug = 'good-steward-structures'`))[0];
    const feeA = await makeFee(m1, { at: '2026-09-03T16:00:00Z', referrer: 'Pat Referrer', friend: 'Fran Friend' });
    const feeB = await makeFee(m1, { at: '2026-09-28T23:30:00Z', referrer: 'Sam Sharer', friend: 'Finn Friend', rewardCents: 10000, feeCents: 6000 });
    const feeFailed = await makeFee(m1, { at: '2026-09-10T16:00:00Z', status: 'failed' });
    const feeOct = await makeFee(m1, { at: '2026-10-01T03:30:00Z' }); // 11:30 pm EDT Sept 30 -> September
    const feeOctReal = await makeFee(m1, { at: '2026-10-02T16:00:00Z', referrer: 'Olive October', friend: 'Otto October' }); // October
    await makeFee(exempt, { at: '2026-09-05T16:00:00Z' });
    await check('Before 9 am Eastern on the 1st, nothing is sent', async () => {
      const before = emails.length;
      await cycle({ now: new Date(OCT_1_8AM) });
      eq(emails.length, before, 'emails');
      return '8:00 am EDT on Oct 1 -> 0 emails';
    });
    await check('--dry-run reports the summary but sends nothing and writes nothing', async () => {
      const before = emails.length;
      const s = await cycle({ now: new Date(OCT_1_10AM), dryRun: true });
      eq(emails.length, before, 'emails during a dry run');
      eq(s.referralSummaries.would_send, 1, 'would_send');
      eq((await ledger(m1.id, 'referral_statement')).length, 0, 'ledger rows after a dry run');
      const reported = await sql('select count(*)::int as n from billing_events where statement_period is not null');
      eq(reported[0].n, 0, 'fees marked reported by a dry run');
      return 'dry run: would_send=1, 0 emails, 0 ledger rows, 0 fees marked';
    });
    await check('At 10 am on Oct 1: one September summary to every admin of the dealer who had charged fees — and nobody else', async () => {
      const before = emails.length;
      const s = await cycle({ now: new Date(OCT_1_10AM) });
      eq(s.referralSummaries.sent, 1, 'summaries sent');
      eq(emails.length - before, 1, 'emails');
      const e = emails[emails.length - 1];
      assert(e.To.includes('admin1@monthly.example') && e.To.includes('admin2@monthly.example'), `To: ${e.To}`);
      assert(!e.Cc, `Cc on a monthly summary: ${e.Cc}`);
      assert(/September 2026/.test(e.Subject), `Subject: ${e.Subject}`);
      // The subject now leads with the rewards the dealer's customers received,
      // not with what 50. charged: that is the part a dealer acts on, and the
      // charge is already taken. 3 succeeded September fees of $30 + $60 + $30
      // = $120.00 in fees, against 4 x $50 x 2 sides... see below.
      // The payout total must be in the subject and the fee total must NOT be,
      // or the reorder silently half-happened.
      const payoutTotal = '$400.00';
      assert(e.Subject.includes(payoutTotal), `Subject should name the rewards total: ${e.Subject}`);
      assert(!e.Subject.includes('$120.00'), `Subject still leads with the fee total: ${e.Subject}`);
      assert(/rewards went out/.test(e.Subject), `Subject should say what happened: ${e.Subject}`);
      assert(e.TextBody.includes('Pat Referrer') && e.TextBody.includes('Fran Friend') && e.TextBody.includes('Sam Sharer') && e.TextBody.includes('Finn Friend'), 'names missing');
      // Both totals belong in the body, and the rewards must come first in it.
      assert(e.TextBody.includes(payoutTotal), 'rewards total missing from the body');
      assert(e.TextBody.includes('$120.00'), 'fee total missing from the body');
      assert(e.TextBody.indexOf(payoutTotal) < e.TextBody.indexOf('$120.00'),
        'the fee total appears above the rewards -- the body is still money-first');
      assert(/Already charged/.test(e.TextBody), 'the body no longer says the fees were already charged');
      assert(!/\bjust\b/i.test(e.TextBody), 'the word "just" appears');
      eq(sentTo('quiet').length, 0, 'dealer with no fees was emailed');
      return `"${e.Subject}" -> ${e.To}`;
    });
    await check('The fees it listed are marked reported (and nothing else is); the failed fee and the October fee are not', async () => {
      const rows = await sql('select id, statement_period from billing_events where event_type = $1 and tenant_id = $2 order by created_at', ['referral_fee', m1.id]);
      const by = Object.fromEntries(rows.map((r) => [r.id, r.statement_period]));
      eq(by[feeA], '2026-09', 'fee A');
      eq(by[feeB], '2026-09', 'fee B');
      eq(by[feeOct], '2026-09', 'fee at 11:30 pm Sept 30 Eastern');
      eq(by[feeFailed], null, 'failed fee');
      eq(by[feeOctReal], null, 'October fee');
      const [row] = await ledger(m1.id, 'referral_statement');
      eq(row.period, '2026-09', 'ledger period');
      assert(row.sent_at, 'ledger not stamped');
      return 'A, B and the 11:30 pm Sept 30 fee -> 2026-09; failed and October fees untouched';
    });
    await check('Running again the same day sends nothing', async () => {
      const before = emails.length;
      await cycle({ now: new Date(OCT_1_10AM) });
      await cycle({ now: new Date('2026-10-15T15:00:00Z') });
      eq(emails.length, before, 'emails');
      return '0 more emails';
    });
    await check('Billing-exempt tenants (GSS) are never sent a summary, even with charged-looking fees', async () => {
      eq(emails.filter((e) => e.To.includes('good-steward')).length, 0, 'emails to GSS');
      return 'no email for good-steward-structures';
    });
    await check('A fee that clears late (dated September, confirmed after the summary went out) appears in the next summary, flagged as earlier — no fee is ever missed', async () => {
      const late = await makeFee(m1, { at: '2026-09-29T16:00:00Z', referrer: 'Late Lena', friend: 'Late Larry' });
      const before = emails.length;
      const s = await cycle({ now: new Date(NOV_2) });
      eq(s.referralSummaries.sent >= 1, true, 'sent');
      const e = emails.slice(before).find((x) => x.To.includes('@monthly.example'));
      assert(e, 'no November-1 summary for the dealer');
      assert(/October 2026/.test(e.Subject), `Subject: ${e.Subject}`);
      assert(e.TextBody.includes('Late Lena') && e.TextBody.includes('Olive October'), 'late or October fee missing');
      assert(e.TextBody.includes('Pat Referrer') === false, 'an already-reported fee was listed again');
      const [row] = await sql('select statement_period from billing_events where id = $1', [late]);
      eq(row.statement_period, '2026-10', 'late fee statement_period');
      const [oct] = await sql('select statement_period from billing_events where id = $1', [feeOctReal]);
      eq(oct.statement_period, '2026-10', 'October fee statement_period');
      assert(/earlier/i.test(e.TextBody), 'no mention that one fee is from an earlier month');
      return `"${e.Subject}": October fee + the late September one (marked 2026-10), nothing repeated`;
    });
    await check('A live-keyed API skips dealers whose activation was only test mode (dry run)', async () => {
      const keep = process.env.STRIPE_SECRET_KEY;
      process.env.STRIPE_SECRET_KEY = 'sk_live_dryRunOnly00000000000';
      try {
        const t = await makeTenant({ slug: 'testmode2', livemode: false });
        await makeFee(t, { at: '2026-10-05T16:00:00Z', livemode: false });
        const s = await cycle({ now: new Date('2026-12-02T15:00:00Z'), dryRun: true });
        eq(s.stripeMode, 'live', 'mode');
        const would = (s.referralSummaries || {}).would_send || 0;
        // monthly dealer has nothing new; testmode2 must not count
        eq(would, 0, 'would_send for a test-mode dealer on a live key');
      } finally {
        process.env.STRIPE_SECRET_KEY = keep;
      }
      return 'live key + test-mode activation -> no summary';
    });

    // ===========================================================================
    section('Yearly summary');
    const y1 = await makeTenant({ slug: 'yearly', paidAt: "'2026-03-10T15:00:00Z'" });
    await sql(`insert into billing_events (tenant_id, event_type, amount_cents, status, livemode, created_at) values ($1, 'activation_charge', 50000, 'succeeded', true, '2026-03-10T15:00:00Z')`, [y1.id]);
    await makeFee(y1, { at: '2026-04-02T16:00:00Z' });
    await makeFee(y1, { at: '2026-04-20T16:00:00Z' });
    await makeFee(y1, { at: '2026-11-11T16:00:00Z' });
    await sql(`update billing_events set statement_period = '2026-12' where tenant_id = $1 and event_type = 'referral_fee'`, [y1.id]); // monthly summaries already covered these
    await sql(`update tenants set renewal_due_at = '2027-03-10T15:00:00Z' where id = $1`, [y1.id]);
    const ynew = await makeTenant({ slug: 'newbie', paidAt: "'2027-01-03T15:00:00Z'" });
    await check('Not sent on New Year\'s Day, or before 9 am Eastern on Jan 2', async () => {
      const before = emails.length;
      await cycle({ now: new Date('2027-01-01T20:00:00Z') });
      await cycle({ now: new Date('2027-01-02T12:00:00Z') });
      eq(sentTo('yearly').filter((e) => /Your 2026/.test(e.Subject)).length, 0, 'yearly emails');
      void before;
      return 'Jan 1 and Jan 2 at 7 am EST -> no summary';
    });
    await check('On Jan 2 the dealer gets one summary for 2026: activation, fees by month, and the next renewal date', async () => {
      const before = emails.length;
      await cycle({ now: new Date('2027-01-05T15:00:00Z') });
      const mine = emails.slice(before).filter((e) => e.To.includes('@yearly.example') && /Your 2026/.test(e.Subject));
      eq(mine.length, 1, 'yearly emails');
      const e = mine[0];
      assert(e.TextBody.includes('$500.00'), 'activation missing');
      assert(e.TextBody.includes('$90.00'), 'fee total ($30 x 3) missing');
      assert(/April/.test(e.TextBody) && /November/.test(e.TextBody), 'months missing');
      assert(/March 10, 2027/.test(e.TextBody), 'next renewal date missing');
      eq(sentTo('newbie').filter((x) => /Your 2026/.test(x.Subject)).length, 0, 'a dealer that activated in 2027 got a 2026 summary');
      return `"${e.Subject}" -> ${e.To}`;
    });
    await check('Running again, and running in March, sends nothing more; after March the window is closed', async () => {
      const before = emails.length;
      await cycle({ now: new Date('2027-01-05T18:00:00Z') });
      await cycle({ now: new Date('2027-02-14T18:00:00Z') });
      eq(emails.slice(before).filter((e) => /Your 2026/.test(e.Subject)).length, 0, 'repeat yearly emails');
      const late = await makeTenant({ slug: 'lateyear', paidAt: "'2026-06-01T15:00:00Z'" });
      await sql(`insert into billing_events (tenant_id, event_type, amount_cents, status, livemode, created_at) values ($1, 'activation_charge', 50000, 'succeeded', true, '2026-06-01T15:00:00Z')`, [late.id]);
      await cycle({ now: new Date('2027-04-10T15:00:00Z') });
      eq(sentTo('lateyear').length, 0, 'emails after the window');
      return 'repeat and Feb runs -> 0; a dealer first seen in April gets nothing for last year';
    });

    // ===========================================================================
    section('Safety');
    await check('The service-role guard passes a Supabase-shaped role and still refuses one RLS applies to', async () => {
      // This exists because the guard shipped testing the wrong property and
      // nothing here caught it: on this machine `postgres` is a true
      // superuser, so is_superuser was always on and every suite passed. On
      // Supabase `postgres` is deliberately NOT a superuser but does carry
      // BYPASSRLS, so the guard refused every production cycle and told
      // whoever read the log to check a DATABASE_URL that was correct.
      // What matters is whether RLS applies, not what the role is called.
      const { assertServiceRoleConnection } = require(path.join(REPO_ROOT, 'api', 'src', 'db.js'));
      await sql(`drop role if exists e2e_bypassrls`);
      await sql(`drop role if exists e2e_rls_applies`);
      await sql(`create role e2e_bypassrls login password 'x' bypassrls`);
      await sql(`create role e2e_rls_applies login password 'x'`);
      const asRole = async (role) => {
        const u = new URL(dbUrl(DB));
        u.username = role; u.password = 'x';
        const c = new Client({ connectionString: u.toString() });
        await c.connect();
        try { await assertServiceRoleConnection(c); return null; }
        catch (err) { return err.message; }
        finally { await c.end(); }
      };

      // The production shape: not a superuser, but RLS does not apply to it.
      const bypass = await asRole('e2e_bypassrls');
      assert(bypass === null, `a BYPASSRLS role was refused: ${bypass}`);

      // The failure the guard is actually for: RLS silently empties its reads.
      const applies = await asRole('e2e_rls_applies');
      assert(applies, 'a role RLS applies to was let through — the guard is doing nothing');
      assert(/bypassrls=false/.test(applies), `the error does not name what is wrong: ${applies}`);

      // And the local superuser, which is what every other check here runs as.
      const supered = await asRole('postgres').catch(() => null);
      void supered;
      await sql(`drop role if exists e2e_bypassrls`);
      await sql(`drop role if exists e2e_rls_applies`);
      return 'BYPASSRLS non-superuser -> allowed; role RLS applies to -> refused by name';
    });
    await check('Overlapping runs: while another process holds the lock, a cycle stands down and sends nothing', async () => {
      const other = new Client({ connectionString: dbUrl(DB) });
      await other.connect();
      try {
        await other.query('select pg_advisory_lock(5031982006)');
        const t = await makeTenant({ slug: 'locked', receiptSent: false });
        const s = await cycle({ now: new Date(OCT_1_8AM) });
        eq(s.skippedForLock, true, 'skippedForLock');
        eq(sentTo('locked').length, 0, 'emails while locked');
        await other.query('select pg_advisory_unlock(5031982006)');
        void t;
      } finally {
        await other.end();
      }
      const s2 = await cycle({ now: new Date(OCT_1_8AM) });
      eq(sentTo('locked').length, 1, 'emails once the lock is free');
      void s2;
      return 'locked -> skippedForLock, 0 emails; unlocked -> 1 email';
    });
    await check('A broken sweep cannot take the webhook down: webhook still answers 200 when mail is failing', async () => {
      const t = await makeTenant({ slug: 'webhookfail', receiptSent: false, paidAt: 'null', livemode: false });
      await sql(`update tenants set billing_status = 'pending', activation_livemode = null, stripe_customer_id = null, stripe_payment_method_id = null where id = $1`, [t.id]);
      postmarkFailing = true;
      try {
        const session = await stripeLib.createCheckoutSession({
          tenantId: t.id, tenantName: t.name, amountCents: 50000, currency: 'usd', paymentMethodType: 'card', annualFeeCents: 10000,
          customerEmail: 'admin1@webhookfail.example', successUrl: 'https://x.example/ok', cancelUrl: 'https://x.example/no',
        });
        await fetch(`${STRIPE_BASE}/pay/${session.id}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ cardNumber: '4242 4242 4242 4242' }), redirect: 'manual' });
        await waitFor(async () => (await sql('select activation_paid_at from tenants where id = $1', [t.id]))[0].activation_paid_at, 'activation while mail is down');
        const log = await standIn('GET', '/__control/log');
        const last = log.deliveries.filter((d) => d.type === 'checkout.session.completed').pop();
        eq(last.status, 200, 'webhook status while mail is down');
      } finally {
        postmarkFailing = false;
      }
      worker.resetRetryThrottleForTests();
      await cycle({ now: new Date(OCT_1_8AM) });
      eq(sentTo('webhookfail').length, 1, 'receipt after mail recovered (hourly sweep)');
      return 'webhook 200 with Postmark down; the next hourly sweep sent the receipt';
    });
    await check('The $100 renewal receipt now says when it was charged and what it covers through', async () => {
      const e = buildRenewalEmail('receipt', {
        tenantName: 'Acme', adminName: 'Dana Owner', feeCents: 10000, currency: 'USD',
        paidAt: new Date('2027-03-10T15:00:00Z'), dueAt: '2028-03-10 15:00:00.123456+00', supportEmail: 'joseph@referwith50.com',
      });
      assert(e.textBody.includes('March 10, 2027'), `paid date missing: ${e.textBody}`);
      assert(e.textBody.includes('through March 10, 2028'), `next due date missing: ${e.textBody}`);
      const bare = buildRenewalEmail('receipt', { tenantName: 'Acme', adminName: 'Dana', feeCents: 10000, currency: 'USD', supportEmail: 'x@y.example' });
      assert(bare.textBody.includes('next 12 months'), 'bare receipt broke');
      return e.textBody.split('\n')[2];
    });
    await check('Dates are Eastern: 11:30 pm EDT on Oct 31 reads October 31, not November 1', async () => {
      eq(emailLib.formatDate('2026-11-01T03:30:00Z'), 'October 31, 2026', 'formatDate');
      eq(emailLib.formatMonth('2026-09'), 'September 2026', 'formatMonth');
      return 'formatDate(2026-11-01T03:30Z) = October 31, 2026';
    });

    await check('The monthly summary counts invites sent and forms filled in, and tells zero from unknown', async () => {
      const row = { at: '2026-10-03T14:12:00Z', referrerName: 'Pat', friendName: 'Fran', payoutCents: 10000, feeCents: 3000 };
      const base = {
        tenantName: 'Funnel Co', adminName: 'Dana', period: '2026-10',
        currency: 'USD', paymentMethodType: 'card', dashboardUrl: 'https://example.test/d',
      };

      const full = emailLib.buildReferralStatementEmail({ ...base, rows: [row], invitesSent: 24, formsSubmitted: 7 });
      assert(/Invites sent\D+24/.test(full.textBody), `invites missing: ${full.textBody}`);
      assert(/Referral forms filled in\D+7/.test(full.textBody), 'forms missing');
      assert(/Referrals rewarded\D+1/.test(full.textBody), 'rewarded count missing');

      // A month with no rewards is not an empty month: invites out and forms
      // in still have something to say, and this is the shape that used to
      // send nothing at all.
      const quiet = emailLib.buildReferralStatementEmail({ ...base, rows: [], invitesSent: 18, formsSubmitted: 4, pendingCount: 3 });
      assert(/Invites sent\D+18/.test(quiet.textBody), 'invites missing from a no-reward month');
      assert(/Referrals rewarded\D+0/.test(quiet.textBody), 'should say zero rewarded, plainly');
      assert(/3 referrals waiting on you/.test(quiet.subject), `subject should lead with the ask: ${quiet.subject}`);

      // Unknown is not zero. A caller that did not supply the numbers must
      // not produce an email claiming no invites went out.
      const unknown = emailLib.buildReferralStatementEmail({ ...base, rows: [row] });
      assert(!/Invites sent/.test(unknown.textBody), 'claimed a figure it was never given');
      assert(!/forms filled in/.test(unknown.textBody), 'claimed a form count it was never given');
      assert(/Referrals rewarded\D+1/.test(unknown.textBody), 'the reward count is always known');

      // And an in-house company never reads as having been charged.
      const house = emailLib.buildReferralStatementEmail({
        ...base, tenantName: 'North Mountain Structures', rows: [row],
        invitesSent: 61, formsSubmitted: 5, billingExempt: true, paymentMethodType: null,
      });
      assert(/your own companies/.test(house.textBody), 'in-house reason missing');
      assert(!/Already charged/.test(house.textBody), 'an in-house company was told it was charged');
      assert(/\$0\.00/.test(house.textBody), 'in-house fee should read $0.00');

      for (const e of [full, quiet, unknown, house]) {
        assert(!/\bjust\b/i.test(e.textBody), `the word "just" appears: ${e.subject}`);
      }
      return 'invites and forms counted; unknown stays blank; in-house never claims a charge';
    });
  } finally {
    await db.end().catch(() => {});
    await pool.end().catch(() => {});
    stripeServer.close();
    webhookServer.close();
    stubServer.close();
    await withClient(PG_ADMIN_URL, (c) => c.query(`drop database if exists ${DB} with (force)`)).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  const outPath = process.env.E2E_RESULTS || path.join(process.cwd(), 'billing-emails-results.md');
  fs.writeFileSync(
    outPath,
    `# Dealer billing emails — verification\n\n${results.map((r) => `- ${r.pass ? 'PASS' : 'FAIL'} — ${r.section}: ${r.title}${r.evidence ? `\n  - ${r.evidence}` : ''}`).join('\n')}\n`
  );
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed — ${outPath}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
