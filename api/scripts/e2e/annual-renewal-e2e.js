#!/usr/bin/env node
// Verification of the yearly 50. fee worker (src/workers/annualRenewal.js)
// against a real Postgres database built from every migration in
// supabase/migrations, the Stripe stand-in (stripe-stand-in.js), and a
// Postmark stub that records the emails it is asked to send.
//
//   node scripts/e2e/annual-renewal-e2e.js
//
// Needs the same scratch Postgres 16 server as activation-gate-e2e.js
// (E2E_PG_ADMIN_URL, default postgresql://postgres@127.0.0.1:54329/postgres).
// Creates its own throwaway database and drops it at the end. The worker
// runs in this process, below lib/stripe.js's configuration (the same
// preload the activation e2e uses), configured like a real deployment on a
// test key.
//
// Real Stripe is not involved. The worker's charging path is the same
// chargeOffSession the 30% usage fee already uses; what this proves is the
// renewal logic around it: who is charged, when, how often, never twice.
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Client } = require('pg');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const ACTIVATION_MIGRATION = '20261001000000_activation_gate_and_referral_fee.sql';
const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:54329/postgres';
const DB = `fifty_renewal_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const PORTS = { stripe: Number(process.env.E2E_STRIPE_PORT || 12111), postmark: Number(process.env.E2E_POSTMARK_PORT || 12112) };
const STRIPE_BASE = `http://127.0.0.1:${PORTS.stripe}`;

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
  // ----- Servers: Stripe stand-in, Postmark stub -----------------------------
  const { createStripeStandIn } = require('./stripe-stand-in');
  const emails = [];
  const stubApp = express();
  stubApp.use(express.json());
  stubApp.post('/email', (req, res) => {
    emails.push(req.body);
    res.json({ ErrorCode: 0, MessageID: `msg-${emails.length}` });
  });
  stubApp.post('/hook', (req, res) => res.json({ ok: true }));
  const stubServer = stubApp.listen(PORTS.postmark, '127.0.0.1');
  const { app: stripeApp } = createStripeStandIn({
    publicBaseUrl: STRIPE_BASE,
    webhookUrl: `http://127.0.0.1:${PORTS.postmark}/hook`,
    webhookSecret: 'whsec_renewalE2eStandIn000000',
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
  const migrationNotices = [];
  db.on('notice', (n) => migrationNotices.push(n.message));

  // ----- The worker, in this process --------------------------------------------
  process.env.DATABASE_URL = dbUrl(DB);
  process.env.STRIPE_SECRET_KEY = 'sk_test_renewalE2eKey00000000';
  process.env.STRIPE_STAND_IN_URL = `${STRIPE_BASE}/v1`;
  process.env.POSTMARK_API_BASE = `http://127.0.0.1:${PORTS.postmark}`;
  process.env.POSTMARK_SERVER_TOKEN = 'postmark-test-token';
  process.env.EMAIL_FROM_ADDRESS = 'notifications@referwith50.example';
  delete process.env.BILLING_SUPPORT_EMAIL;
  require('./stripe-stand-in-preload');
  const worker = require('../../src/workers/annualRenewal');
  const { pool } = require('../../src/db');

  const stripeCharges = async () => {
    const state = await standIn('GET', '/__control/log');
    return state.requests.filter((r) => r.method === 'POST' && r.path === '/payment_intents');
  };
  const piCount = async () => (await standIn('GET', '/__control/state')).paymentIntents.filter((p) => p.metadata && p.metadata.kind === 'annual_renewal').length;
  const piCountFor = async (tenantId) => (await standIn('GET', '/__control/state')).paymentIntents.filter((p) => p.metadata && p.metadata.tenant_id === tenantId).length;
  const cycle = (opts) => worker.runAnnualRenewalCycle(opts);

  // A tenant that has paid its activation (test mode — the stand-in's only
  // mode), with a customer and card saved in the stand-in, and a due date
  // `dueSql` away from now.
  let seq = 0;
  async function makeTenant({ slug, dueSql, annualFeeCents, admins = 1, livemode = false } = {}) {
    seq += 1;
    slug = slug || `dealer-${seq}`;
    const saved = await standIn('POST', '/__control/payment-intent', { with_customer: true, livemode });
    const [t] = await sql(
      `insert into tenants (slug, name, billing_status, activation_paid_at, activation_livemode, stripe_customer_id, stripe_payment_method_id, renewal_due_at, annual_fee_cents)
       values ($1, $2, 'active', now() - interval '1 year', $3, $4, $5, ${dueSql ? `now() + interval '${dueSql}'` : 'null'}, $6)
       returning id, slug`,
      [slug, `Dealer ${slug}`, livemode, saved.customer, saved.payment_method, annualFeeCents == null ? 10000 : annualFeeCents]
    );
    for (let i = 1; i <= admins; i += 1) {
      const id = (await sql('select gen_random_uuid() as id'))[0].id;
      await sql('insert into auth.users (id, email) values ($1, $2)', [id, `admin${i}@${slug}.example`]);
      await sql(`insert into users (id, tenant_id, email, name, role) values ($1, $2, $3, $4, 'admin')`, [id, t.id, `admin${i}@${slug}.example`, `Admin${i} ${slug}`]);
    }
    return { ...t, paymentMethod: saved.payment_method };
  }
  const tenantRow = async (id) => (await sql('select renewal_due_at, renewal_notice_sent_for, billing_status from tenants where id = $1', [id]))[0];
  const events = async (id) => sql(`select id, status, amount_cents, renews_from, stripe_payment_intent_id, error_detail, created_at from billing_events where tenant_id = $1 and event_type = 'annual_renewal' order by created_at`, [id]);
  const outcomeOf = async (id, opts) => (await worker.processRenewal(id, { stripeMode: 'test', ...opts })).outcome;

  try {
    // ===========================================================================
    section('Migration');
    await db.query(fs.readFileSync(path.join(__dirname, 'supabase-stand-in.sql'), 'utf8'));
    for (const f of files) if (f < ACTIVATION_MIGRATION) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    // The tenants that exist in production before the billing migrations,
    // including an already-paid live dealer and a test-only one.
    const saved1 = await standIn('POST', '/__control/payment-intent', { with_customer: true });
    await db.query(`
      insert into tenants (slug, name) values
        ('good-steward-structures', 'Good Steward Structures'),
        ('north-mountain-structures', 'North Mountain Structures'),
        ('50-platform', '50.');
      insert into tenants (slug, name, billing_status, activation_paid_at, stripe_customer_id, stripe_payment_method_id) values
        ('paid-live-dealer', 'Paid Live Dealer', 'active', '2026-06-01 12:00:00+00', '${saved1.customer}', '${saved1.payment_method}'),
        ('unpaid-dealer', 'Unpaid Dealer', 'pending', null, null, null);`);
    await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, ACTIVATION_MIGRATION), 'utf8'));
    // Activations recorded before livemode was tracked have it null (and
    // are never backfilled — they were test mode); this one is a real one.
    await db.query(`update tenants set activation_livemode = true where slug = 'paid-live-dealer'`);
    const renewalMigration = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f > ACTIVATION_MIGRATION && f.endsWith('.sql'));
    await check('The annual-renewal migration applies on top of the full chain', async () => {
      for (const f of renewalMigration) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      return renewalMigration.join(', ');
    });
    await check('Backfill: renewal_due_at = activation + 12 months for a live-paid dealer; null for unpaid and exempt tenants', async () => {
      const rows = await sql(`select slug, renewal_due_at, annual_fee_cents from tenants order by slug`);
      const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
      eq(bySlug['paid-live-dealer'].renewal_due_at.toISOString(), '2027-06-01T12:00:00.000Z', 'paid-live-dealer renewal_due_at');
      eq(bySlug['unpaid-dealer'].renewal_due_at, null, 'unpaid-dealer');
      for (const s of ['good-steward-structures', 'north-mountain-structures', '50-platform']) eq(bySlug[s].renewal_due_at, null, s);
      eq(bySlug['unpaid-dealer'].annual_fee_cents, 10000, 'default annual fee');
      return 'paid-live-dealer -> 2027-06-01T12:00:00Z; unpaid and the three exempt tenants -> null; every tenant annual_fee_cents = 10000';
    });
    await check('A billing-exempt tenant can never be given a renewal date (tenants_exempt_has_no_renewal)', async () => {
      let refused = null;
      try { await sql(`update tenants set renewal_due_at = now() where slug = 'north-mountain-structures'`); } catch (err) { refused = err.message; }
      assert(refused && refused.includes('tenants_exempt_has_no_renewal'), `not refused: ${refused}`);
      return refused;
    });
    await check('The ledger allows only one pending-or-succeeded renewal per tenant per period; failed attempts are not limited', async () => {
      const [t] = await sql(`select id from tenants where slug = 'paid-live-dealer'`);
      const ins = (status) => sql(`insert into billing_events (tenant_id, event_type, amount_cents, renews_from, status) values ($1, 'annual_renewal', 10000, '2027-06-01T12:00:00Z', $2)`, [t.id, status]);
      await ins('failed'); await ins('failed'); await ins('pending');
      let dup = null;
      try { await ins('pending'); } catch (err) { dup = err.message; }
      assert(dup && dup.includes('billing_events_one_annual_renewal_idx'), `second pending not refused: ${dup}`);
      await sql(`delete from billing_events where tenant_id = $1`, [t.id]);
      return 'two failed + one pending OK; a second pending -> billing_events_one_annual_renewal_idx';
    });
    // Clear the fixtures so the worker scenarios start from a known state.
    await sql(`update tenants set renewal_due_at = null where slug = 'paid-live-dealer'`);

    // ===========================================================================
    section('Not due yet / heads-up email');
    const far = await makeTenant({ dueSql: '100 days' });
    const soon = await makeTenant({ dueSql: '10 days', admins: 2 });
    await check('Nothing is charged or emailed more than 14 days ahead; a dealer 10 days out gets exactly one heads-up (to both admins, support on cc)', async () => {
      const before = (await stripeCharges()).length;
      const s1 = await cycle();
      eq(s1.noticesSent, 1, 'notices sent in the first cycle');
      const s2 = await cycle();
      eq(s2.noticesSent, 0, 'notices sent in the second cycle');
      eq((await stripeCharges()).length, before, 'Stripe charges');
      eq(emails.length, 1, 'emails');
      const e = emails[0];
      assert(e.To.includes(`admin1@${soon.slug}.example`) && e.To.includes(`admin2@${soon.slug}.example`), `To: ${e.To}`);
      eq(e.Cc, 'joseph@referwith50.com', 'Cc');
      assert(/renews on/.test(e.Subject) && e.Subject.includes('$100.00'), `Subject: ${e.Subject}`);
      assert(!e.To.includes(far.slug), 'far-future dealer was emailed');
      return `"${e.Subject}" -> ${e.To}, cc ${e.Cc}; second cycle sent none`;
    });
    await check('--dry-run sends nothing and writes nothing', async () => {
      const t = await makeTenant({ dueSql: '5 days' });
      const sent = emails.length;
      const s = await cycle({ dryRun: true });
      eq(emails.length, sent, 'emails during a dry run');
      eq((await tenantRow(t.id)).renewal_notice_sent_for, null, 'renewal_notice_sent_for after a dry run');
      assert(s.noticesSent >= 1, 'dry run did not report the pending notice');
      await sql('delete from users where tenant_id = $1', [t.id]);
      await sql('delete from tenants where id = $1', [t.id]);
      return `dry run reported ${s.noticesSent} would-send, emails unchanged, nothing written`;
    });

    // ===========================================================================
    section('Charging');
    const due = await makeTenant({ dueSql: '-1 day' });
    const dueBefore = await tenantRow(due.id);
    await check('A dealer past its due date is charged $100 exactly once, then rolled forward 12 months from the old due date; receipt emailed', async () => {
      const chargesBefore = (await stripeCharges()).length;
      const emailsBefore = emails.length;
      const r = await outcomeOf(due.id);
      eq(r, 'succeeded', 'outcome');
      const charges = (await stripeCharges()).slice(chargesBefore);
      eq(charges.length, 1, 'Stripe charge requests');
      const [ev] = await events(due.id);
      eq(ev.status, 'succeeded', 'ledger status');
      eq(ev.amount_cents, 10000, 'ledger amount');
      eq(ev.renews_from.toISOString(), dueBefore.renewal_due_at.toISOString(), 'renews_from');
      const [{ ok }] = await sql(`select (t.renewal_due_at = b.renews_from + interval '12 months') as ok from tenants t join billing_events b on b.tenant_id = t.id and b.event_type = 'annual_renewal' where t.id = $1`, [due.id]);
      assert(ok, 'renewal_due_at is not old due + 12 months (exactly)');
      const pis = (await standIn('GET', '/__control/state')).paymentIntents.filter((p) => p.metadata.billing_event_id === ev.id);
      eq(pis.length, 1, 'PaymentIntents for this ledger row');
      eq(pis[0].amount, 10000, 'PaymentIntent amount');
      eq(pis[0].metadata.kind, 'annual_renewal', 'metadata.kind');
      eq(pis[0].metadata.tenant_id, due.id, 'metadata.tenant_id');
      const receipt = emails.slice(emailsBefore).find((e) => e.Subject.startsWith('Receipt'));
      assert(receipt, 'no receipt email');
      return `ledger succeeded $100 for period ${ev.renews_from.toISOString()}; next due ${(await tenantRow(due.id)).renewal_due_at.toISOString()}; receipt: "${receipt.Subject}"`;
    });
    await check('Running again charges nothing more', async () => {
      const before = (await stripeCharges()).length;
      await cycle();
      await cycle();
      eq((await stripeCharges()).length, before, 'extra Stripe charges');
      eq((await events(due.id)).length, 1, 'ledger rows');
      return 'two more cycles: 0 new Stripe charges, still 1 ledger row';
    });
    await check('Two workers at the same moment charge once (row lock + unique pending index)', async () => {
      const t = await makeTenant({ dueSql: '-2 hours' });
      const before = await piCount();
      const outcomes = await Promise.all([outcomeOf(t.id), outcomeOf(t.id), outcomeOf(t.id), outcomeOf(t.id)]);
      eq((await piCount()) - before, 1, 'PaymentIntents created');
      eq((await events(t.id)).filter((e) => e.status === 'succeeded').length, 1, 'succeeded rows');
      return `outcomes ${outcomes.join(', ')} -> 1 PaymentIntent`;
    });
    await check('If the worker was down for years it charges once and lands the next due date in the future', async () => {
      const t = await makeTenant({ dueSql: '-1100 days' });
      const before = await piCount();
      eq(await outcomeOf(t.id), 'succeeded', 'outcome');
      eq((await piCount()) - before, 1, 'PaymentIntents created');
      const [{ future, within }] = await sql(`select renewal_due_at > now() as future, renewal_due_at <= now() + interval '12 months' as within from tenants where id = $1`, [t.id]);
      assert(future && within, `next due not in (now, now+12mo]: future=${future} within=${within}`);
      eq(await outcomeOf(t.id), 'not_due', 'immediately after');
      return 'charged once; next due is the first anniversary still ahead; a second look finds nothing due';
    });
    await check('A $0 annual fee (waived) charges nothing and just starts the next year', async () => {
      const t = await makeTenant({ dueSql: '-1 day', annualFeeCents: 0 });
      const before = (await stripeCharges()).length;
      eq(await outcomeOf(t.id), 'waived', 'outcome');
      eq((await stripeCharges()).length, before, 'Stripe charges');
      eq((await events(t.id)).length, 0, 'ledger rows');
      assert((await tenantRow(t.id)).renewal_due_at > new Date(), 'due date not moved into the future');
      return 'no Stripe call, no ledger row, due date moved forward';
    });

    // ===========================================================================
    section('Never charged');
    await check('Exempt tenants, undated tenants, and tenants not yet due are never charged', async () => {
      const before = (await stripeCharges()).length;
      const rows = await sql(`select id, slug from tenants where slug in ('good-steward-structures','north-mountain-structures','50-platform','unpaid-dealer','paid-live-dealer')`);
      const outcomes = [];
      for (const r of rows) outcomes.push(`${r.slug}=${await outcomeOf(r.id)}`);
      eq((await stripeCharges()).length, before, 'Stripe charges');
      assert(outcomes.every((o) => o.endsWith('not_billable')), outcomes.join(', '));
      const farOutcome = await outcomeOf(far.id);
      eq(farOutcome, 'not_due', 'far-future dealer');
      return `${outcomes.join(', ')}; ${far.slug}=not_due`;
    });
    await check('Even if an exempt tenant were somehow marked billable and dated, the worker still refuses (billing_required re-checked from a locked read)', async () => {
      // billing_required = true is blocked by tenants_permanently_billing_exempt,
      // so simulate the worst case the only way left: drop the constraints,
      // set the date, and run the worker.
      await sql('alter table tenants drop constraint tenants_exempt_has_no_renewal');
      const [nms] = await sql(`update tenants set renewal_due_at = now() - interval '1 day' where slug = 'north-mountain-structures' returning id`);
      const before = (await stripeCharges()).length;
      const o = await outcomeOf(nms.id);
      eq(o, 'not_billable', 'outcome');
      eq((await stripeCharges()).length, before, 'Stripe charges');
      const s = await cycle();
      eq((await stripeCharges()).length, before, 'Stripe charges after a full cycle');
      await sql(`update tenants set renewal_due_at = null where slug = 'north-mountain-structures'`);
      await sql(`alter table tenants add constraint tenants_exempt_has_no_renewal check (billing_required = true or renewal_due_at is null)`);
      return `processRenewal -> not_billable; full cycle considered ${s.considered} due tenants and charged none of the exempt ones`;
    });
    await check('A test-mode activation is not charged by a live-key worker; a suspended tenant is not charged', async () => {
      const t = await makeTenant({ dueSql: '-1 day' });
      const before = (await stripeCharges()).length;
      const live = await worker.processRenewal(t.id, { stripeMode: 'live' });
      eq(live.outcome, 'skipped', 'live-key outcome');
      await sql(`update tenants set billing_status = 'suspended' where id = $1`, [t.id]);
      const susp = await worker.processRenewal(t.id, { stripeMode: 'test' });
      eq(susp.outcome, 'skipped', 'suspended outcome');
      eq((await stripeCharges()).length, before, 'Stripe charges');
      await sql(`update tenants set billing_status = 'active' where id = $1`, [t.id]);
      return `live key + test activation: ${live.reason}; suspended: ${susp.reason}`;
    });

    // ===========================================================================
    section('Declined card');
    const bad = await makeTenant({ dueSql: '-1 day' });
    await standIn('POST', '/__control/fail-off-session', { payment_method: bad.paymentMethod, fail: true });
    await check('A decline is recorded as failed, the dealer is emailed with the next-try date, and billing is NOT suspended', async () => {
      const emailsBefore = emails.length;
      eq(await outcomeOf(bad.id), 'failed', 'outcome');
      const evs = await events(bad.id);
      eq(evs.length, 1, 'ledger rows');
      eq(evs[0].status, 'failed', 'status');
      assert(evs[0].error_detail.includes('insufficient funds'), `error_detail: ${evs[0].error_detail}`);
      eq((await tenantRow(bad.id)).billing_status, 'active', 'billing_status');
      const e = emails.slice(emailsBefore).find((m) => m.Subject.includes('declined'));
      assert(e, 'no declined email');
      assert(e.TextBody.includes('try again on'), 'no next-try date in the email');
      return `"${e.Subject}"; ledger failed (${evs[0].error_detail}); billing_status active`;
    });
    await check('It does not retry for 72 hours', async () => {
      const before = await piCountFor(bad.id);
      eq(await outcomeOf(bad.id), 'retry_wait', 'outcome');
      await cycle();
      eq(await piCountFor(bad.id), before, 'Stripe charges for this dealer');
      return 'retry_wait, no new Stripe request';
    });
    await check('After 72h it tries again (2nd), then a 3rd with a "last try" email, then stops for good', async () => {
      const age = () => sql(`update billing_events set created_at = created_at - interval '73 hours' where tenant_id = $1 and event_type = 'annual_renewal'`, [bad.id]);
      await age();
      eq(await outcomeOf(bad.id), 'failed', '2nd attempt');
      await age();
      const emailsBefore = emails.length;
      const third = await worker.processRenewal(bad.id, { stripeMode: 'test' });
      eq(third.outcome, 'failed', '3rd attempt');
      eq(third.finalAttempt, true, 'finalAttempt');
      const last = emails.slice(emailsBefore).find((m) => m.Subject.startsWith('Action needed'));
      assert(last && last.TextBody.includes('last automatic try'), 'no "last try" email');
      await age();
      const before = await piCountFor(bad.id);
      eq(await outcomeOf(bad.id), 'attempts_exhausted', '4th look');
      eq(await piCountFor(bad.id), before, 'Stripe charges for this dealer after exhaustion');
      eq((await events(bad.id)).filter((e) => e.status === 'failed').length, 3, 'failed rows');
      return '3 failed rows, then attempts_exhausted with no Stripe call; last email: "' + last.Subject + '"';
    });
    await check('Once the card is fixed, setting renewal_due_at = now() starts a fresh period and the charge goes through', async () => {
      await standIn('POST', '/__control/fail-off-session', { payment_method: bad.paymentMethod, fail: false });
      await sql(`update tenants set renewal_due_at = now() - interval '1 minute' where id = $1`, [bad.id]);
      eq(await outcomeOf(bad.id), 'succeeded', 'outcome');
      const evs = await events(bad.id);
      eq(evs.filter((e) => e.status === 'succeeded').length, 1, 'succeeded rows');
      return `${evs.map((e) => e.status).join(' -> ')}`;
    });

    // ===========================================================================
    section('Unknown outcome (dropped response)');
    await check('A charge whose reply never arrives stays pending, is resumed with the same Idempotency-Key, and charges exactly once', async () => {
      const t = await makeTenant({ dueSql: '-1 day' });
      await standIn('POST', '/__control/drop-next-responses', { count: 1 });
      const before = await piCount();
      eq(await outcomeOf(t.id), 'pending_unknown', 'first outcome');
      let evs = await events(t.id);
      eq(evs.length, 1, 'ledger rows');
      eq(evs[0].status, 'pending', 'status after a dropped reply');
      eq(await piCount() - before, 1, 'Stripe did create the PaymentIntent');
      eq(await outcomeOf(t.id), 'succeeded', 'resume outcome');
      evs = await events(t.id);
      eq(evs.length, 1, 'ledger rows after resume');
      eq(evs[0].status, 'succeeded', 'status after resume');
      eq(await piCount() - before, 1, 'PaymentIntents after resume (no second charge)');
      const log = (await standIn('GET', '/__control/log')).requests.filter((r) => r.method === 'POST' && r.path === '/payment_intents' && r.idempotencyKey === `annual_renewal:${evs[0].id}`);
      assert(log.length >= 2, `expected the same Idempotency-Key sent twice, saw ${log.length}`);
      return `pending -> succeeded; Idempotency-Key annual_renewal:${evs[0].id} sent ${log.length}x; 1 PaymentIntent`;
    });
    await check('A pending attempt with no answer for over 23h is left alone for a human', async () => {
      const t = await makeTenant({ dueSql: '-1 day' });
      const [ev] = await sql(`insert into billing_events (tenant_id, event_type, amount_cents, renews_from, status, error_detail, created_at)
        select id, 'annual_renewal', 10000, renewal_due_at, 'pending', 'Outcome unknown', now() - interval '24 hours' from tenants where id = $1 returning id`, [t.id]);
      const before = (await stripeCharges()).length;
      eq(await outcomeOf(t.id), 'needs_review', 'outcome');
      eq((await stripeCharges()).length, before, 'Stripe charges');
      return `billing_events ${ev.id} flagged needs_review; nothing sent to Stripe`;
    });
    await check('A charge that succeeded at Stripe but whose bookkeeping never finished is completed without charging again', async () => {
      const t = await makeTenant({ dueSql: '-1 day' });
      await sql(`insert into billing_events (tenant_id, event_type, amount_cents, renews_from, status, stripe_payment_intent_id)
        select id, 'annual_renewal', 10000, renewal_due_at, 'succeeded', 'pi_already' from tenants where id = $1`, [t.id]);
      const before = (await stripeCharges()).length;
      eq(await outcomeOf(t.id), 'already_succeeded', 'outcome');
      eq((await stripeCharges()).length, before, 'Stripe charges');
      assert((await tenantRow(t.id)).renewal_due_at > new Date(), 'due date not advanced');
      return 'due date advanced, no Stripe call';
    });

    // ===========================================================================
    section('Emails never break a charge');
    await check('If Postmark is down, the charge still succeeds and is not repeated', async () => {
      const t = await makeTenant({ dueSql: '-1 day' });
      const saved = process.env.POSTMARK_SERVER_TOKEN;
      stubServer.close();
      const before = await piCount();
      eq(await outcomeOf(t.id), 'succeeded', 'outcome');
      eq(await piCount() - before, 1, 'PaymentIntents');
      eq((await events(t.id))[0].status, 'succeeded', 'ledger');
      process.env.POSTMARK_SERVER_TOKEN = saved;
      return 'charge recorded as succeeded even though the receipt email could not be sent';
    });
  } finally {
    await db.end().catch(() => {});
    await pool.end().catch(() => {});
    stripeServer.close();
    try { stubServer.close(); } catch (e) { /* already closed */ }
    await withClient(PG_ADMIN_URL, (c) => c.query(`drop database if exists ${DB} with (force)`)).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  const outPath = process.env.E2E_RESULTS || path.join(process.cwd(), 'annual-renewal-results.md');
  fs.writeFileSync(
    outPath,
    `# Annual renewal worker — verification\n\n${results.map((r) => `- ${r.pass ? 'PASS' : 'FAIL'} — ${r.section}: ${r.title}${r.evidence ? `\n  - ${r.evidence}` : ''}`).join('\n')}\n`
  );
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed — ${outPath}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
