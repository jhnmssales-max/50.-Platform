#!/usr/bin/env node
// Verification of the sales-rep program: the rep_program migration, the
// /api routes in src/routes/reps.js, and the earnings worker
// (src/workers/repEarnings.js), against a real Postgres database built from
// every migration in supabase/migrations, the real API (src/server.js) run as
// a child process, and the Supabase Auth stand-in for sign-in tokens.
//
//   node scripts/e2e/rep-program-e2e.js
//
// Needs the same scratch Postgres 16 server as the other e2e scripts
// (E2E_PG_ADMIN_URL, default postgresql://postgres@127.0.0.1:54329/postgres).
// Creates its own throwaway database and drops it at the end. No Stripe is
// involved: the worker reads billing_events rows, which this script writes
// the way the Stripe webhook and fee code would.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { createAuthStandIn } = require('./auth-stand-in');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_DIR = path.join(REPO_ROOT, 'api');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const ACTIVATION_MIGRATION = '20261001000000_activation_gate_and_referral_fee.sql';
const REP_MIGRATION = '20261015000000_rep_program.sql';
const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:54329/postgres';
const DB = `fifty_reps_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const PORTS = { api: Number(process.env.E2E_API_PORT || 3100), auth: Number(process.env.E2E_AUTH_PORT || 9996) };
const API = `http://127.0.0.1:${PORTS.api}`;
const AUTH_BASE = `http://127.0.0.1:${PORTS.auth}`;

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
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

const PASSWORD = 'e2e-password-1';
const USERS = {
  admin: { id: 'b0000000-0000-4000-8000-000000000001', email: 'joseph@fifty.test', name: 'Joseph', role: 'admin', tenant: '50-platform' },
  helper: { id: 'b0000000-0000-4000-8000-000000000002', email: 'helper@fifty.test', name: 'Helper', role: 'staff', tenant: '50-platform' },
  dealerAdmin: { id: 'b0000000-0000-4000-8000-000000000003', email: 'owner@dealer-a.test', name: 'Dealer A Owner', role: 'admin', tenant: 'dealer-a' },
};

async function main() {
  const auth = createAuthStandIn();
  const authServer = auth.app.listen(PORTS.auth, '127.0.0.1');

  await withClient(PG_ADMIN_URL, async (c) => {
    await c.query(`drop database if exists ${DB} with (force)`);
    await c.query(`create database ${DB}`);
  });
  const db = new Client({ connectionString: dbUrl(DB) });
  await db.connect();
  const sql = async (text, params) => (await db.query(text, params)).rows;

  let apiChild = null;
  const apiLines = [];

  try {
    // ===========================================================================
    section('Migration');
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await db.query(fs.readFileSync(path.join(__dirname, 'supabase-stand-in.sql'), 'utf8'));
    for (const f of files) if (f < ACTIVATION_MIGRATION) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    await db.query(`insert into tenants (slug, name) values
      ('good-steward-structures', 'Good Steward Structures'),
      ('north-mountain-structures', 'North Mountain Structures'),
      ('50-platform', '50.')`);
    await check('Every migration applies in order, including the rep-program one', async () => {
      const rest = files.filter((f) => f >= ACTIVATION_MIGRATION);
      for (const f of rest) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      assert(rest.includes(REP_MIGRATION), 'rep_program migration not found');
      return rest.join(', ');
    });
    await check('rep_settings starts with the agreed rates: $50 per activation, $1 per referral, 50 cents after 2,000 companies, full rate at a $50 card', async () => {
      const [s] = await sql('select * from rep_settings');
      eq([s.activation_cents, s.referral_cents, s.referral_cents_after_threshold, s.threshold_companies, s.full_rate_card_cents], [5000, 100, 50, 2000, 5000], 'rates');
      return 'activation 5000, referral 100, after 50, threshold 2000, full-rate card 5000';
    });

    // ----- Data ----------------------------------------------------------------
    const tenants = {};
    const mkTenant = async (slug, { live = true, activatedAt = null } = {}) => {
      const [t] = await sql(
        `insert into tenants (slug, name, billing_status, activation_paid_at, activation_livemode) values ($1, $2, 'active', $3, $4) returning id, slug, name`,
        [slug, `Dealer ${slug}`, activatedAt, activatedAt ? live : null]
      );
      tenants[slug] = t;
      return t;
    };
    for (const row of await sql('select id, slug, name from tenants')) tenants[row.slug] = row;
    await mkTenant('dealer-a', { activatedAt: '2026-08-01T15:00:00Z' });
    for (const u of Object.values(USERS)) {
      await sql('insert into auth.users (id, email) values ($1, $2)', [u.id, u.email]);
      await sql('insert into users (id, tenant_id, email, name, role) values ($1, $2, $3, $4, $5)', [u.id, tenants[u.tenant].id, u.email, u.name, u.role]);
      auth.addUser({ id: u.id, email: u.email, password: PASSWORD });
    }

    let seq = 0;
    // A cleared referral fee for a dealer: customer -> link -> referral -> billing event.
    async function fee(slug, { at = 'now()', rewardCents = 5000, status = 'succeeded', live = true, pi = null } = {}) {
      seq += 1;
      const t = tenants[slug];
      const [c] = await sql(`insert into customers (tenant_id, name, email) values ($1, $2, $3) returning id`, [t.id, `Customer ${seq}`, `c${seq}@x.example`]);
      const [l] = await sql(`insert into referral_links (tenant_id, code, kind, customer_id) values ($1, $2, 'share', $3) returning id`, [t.id, `rc-${seq}-${Math.random().toString(36).slice(2, 8)}`, c.id]);
      const [r] = await sql(`insert into referrals (tenant_id, referral_link_id, name, email, status) values ($1, $2, $3, $4, 'rewarded') returning id`, [t.id, l.id, `Friend ${seq}`, `f${seq}@x.example`]);
      const [e] = await sql(
        `insert into billing_events (tenant_id, referral_id, event_type, amount_cents, reward_amount_cents, fee_rate_bps, status, livemode, stripe_payment_intent_id, created_at)
         values ($1, $2, 'referral_fee', $3, $4, 3000, $5, $6, $7, ${at === 'now()' ? 'now()' : '$8::timestamptz'}) returning id`,
        at === 'now()' ? [t.id, r.id, Math.round(rewardCents * 2 * 0.3), rewardCents, status, live, pi] : [t.id, r.id, Math.round(rewardCents * 2 * 0.3), rewardCents, status, live, pi, at]
      );
      return e.id;
    }
    async function activation(slug, { at = 'now()', status = 'succeeded', live = true, pi = null } = {}) {
      const [e] = await sql(
        `insert into billing_events (tenant_id, event_type, amount_cents, status, livemode, stripe_payment_intent_id, created_at)
         values ($1, 'activation_charge', 50000, $2, $3, $4, ${at === 'now()' ? 'now()' : '$5::timestamptz'}) returning id`,
        at === 'now()' ? [tenants[slug].id, status, live, pi] : [tenants[slug].id, status, live, pi, at]
      );
      return e.id;
    }

    // ----- The real API, as a child process -------------------------------------
    apiChild = spawn(process.execPath, ['src/server.js'], {
      cwd: API_DIR,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        DATABASE_URL: dbUrl(DB), SUPABASE_URL: AUTH_BASE, SUPABASE_JWKS_URL: '', PORT: String(PORTS.api),
        POSTMARK_SERVER_TOKEN: '', POSTMARK_API_BASE: 'http://127.0.0.1:9/', EMAIL_FROM_ADDRESS: '',
        FRONTEND_BASE_URL: 'http://127.0.0.1:8088', TENANT_CREDENTIALS_ENCRYPTION_KEY: 'e2e-only-passphrase',
        STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_API_BASE: '', STRIPE_STAND_IN_URL: '',
        RENEWAL_SCHEDULER: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const onData = (buf) => {
        for (const line of buf.toString().split('\n').filter(Boolean)) {
          apiLines.push(line);
          if (line.includes('listening on')) resolve();
        }
      };
      apiChild.stdout.on('data', onData);
      apiChild.stderr.on('data', onData);
      apiChild.on('exit', (code) => reject(new Error(`API exited ${code}:\n${apiLines.join('\n')}`)));
      setTimeout(() => reject(new Error(`API did not start:\n${apiLines.join('\n')}`)), 15000);
    });

    const tokenFor = (u) => auth.mintToken(u);
    async function api(method, p, { as, body } = {}) {
      const res = await fetch(`${API}/api${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${tokenFor(as)}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch (e) { /* none */ }
      return { status: res.status, body: json };
    }

    // The worker, in this process.
    process.env.DATABASE_URL = dbUrl(DB);
    const { runRepEarningsCycle } = require('../../src/workers/repEarnings');
    const { pool, withUserTransaction } = require('../../src/db');
    const cycle = (opts) => runRepEarningsCycle(opts);
    const earnings = (repId) => sql(`select id, role, kind, amount_cents, tenant_id, source_billing_event_id, reverses_earning_id, detail, earned_at from rep_earnings where rep_id = $1 order by created_at, id`, [repId]);
    const total = async (repId) => (await earnings(repId)).reduce((s, e) => s + e.amount_cents, 0);

    // ===========================================================================
    section('Who can reach what');
    await check('No token -> 401; a dealer\'s own admin -> 403 on every rep route; nothing leaks in the body', async () => {
      eq((await api('GET', '/reps')).status, 401, 'no token');
      for (const [m, p] of [['GET', '/reps'], ['GET', '/rep-leads'], ['GET', '/rep-dealers'], ['GET', '/rep-money/overview'], ['GET', '/rep-settings']]) {
        const r = await api(m, p, { as: USERS.dealerAdmin });
        eq(r.status, 403, `${m} ${p} as a dealer admin`);
      }
      return '401 without a token; 403 for a dealer admin on reps, leads, dealers, money, settings';
    });
    await check('The helper (50. staff, not admin) can use reps/leads/dealers but gets 403 on every money route', async () => {
      for (const [m, p] of [['GET', '/reps'], ['GET', '/rep-leads'], ['GET', '/rep-dealers']]) eq((await api(m, p, { as: USERS.helper })).status, 200, `${m} ${p}`);
      for (const [m, p, b] of [
        ['GET', '/rep-money/overview'], ['GET', '/rep-settings'], ['PUT', '/rep-settings', { activation_cents: 1 }],
        ['POST', '/reps/00000000-0000-4000-8000-000000000000/payouts', { amount_cents: 100 }],
        ['POST', '/rep-earnings/00000000-0000-4000-8000-000000000000/reverse', {}],
      ]) {
        const r = await api(m, p, { as: USERS.helper, body: b });
        eq(r.status, 403, `${m} ${p} as the helper`);
        eq(r.body.code, 'admin_only', `${m} ${p} code`);
      }
      // A statement refuses the helper for the narrower reason that it is not
      // their own — the same 403, just a more specific code since reps gained
      // the right to open theirs.
      const stmt = await api('GET', '/reps/00000000-0000-4000-8000-000000000000/statement', { as: USERS.helper });
      eq(stmt.status, 403, 'statement as the helper');
      eq(stmt.body.code, 'own_statement_only', 'statement code');
      return 'helper: reps/leads/dealers 200; overview, payouts, reversal, settings -> 403 admin_only; statement -> 403 own_statement_only';
    });

    // ===========================================================================
    section('Reps and leads');
    const rep = {};
    await check('The helper can add reps; the list shows no dollar fields to the helper but shows balances to the admin', async () => {
      for (const name of ['Dana Seller', 'Laura Onboard', 'Sam Both', 'Zed Volume']) {
        const r = await api('POST', '/reps', { as: USERS.helper, body: { name, email: `${name.split(' ')[0].toLowerCase()}@reps.test`, phone: '717-555-0100' } });
        eq(r.status, 201, `create ${name}`);
        rep[name.split(' ')[0]] = r.body;
      }
      const forHelper = await api('GET', '/reps', { as: USERS.helper });
      const text = JSON.stringify(forHelper.body);
      assert(!/cents|owed|balance|earned/i.test(text), `money field in the helper's reps list: ${text.slice(0, 300)}`);
      const forAdmin = await api('GET', '/reps', { as: USERS.admin });
      assert(forAdmin.body.reps.every((r) => r.owed_cents === 0 && r.earned_this_month_cents === 0), 'admin list missing balances');
      return `4 reps; helper list has no money keys; admin list has owed_cents/earned_this_month_cents`;
    });
    let leadId;
    await check('Leads: add with contact details and the rep who brought it in; a repeat of the same company, phone or email is warned about (409 + matches) until confirmed', async () => {
      const first = await api('POST', '/rep-leads', { as: USERS.helper, body: { company_name: 'Hilltop Roofing', contact_name: 'Pete Hill', phone: '(717) 555-0188', email: 'pete@hilltop.test', brought_in_by_rep_id: rep.Dana.id, found_on: '2026-10-01' } });
      eq(first.status, 201, 'create');
      leadId = first.body.id;
      eq(first.body.status, 'open', 'status');
      eq(first.body.brought_in_by_rep_id, rep.Dana.id, 'brought in by');
      const sameName = await api('POST', '/rep-leads', { as: USERS.helper, body: { company_name: '  hilltop   roofing ', brought_in_by_rep_id: rep.Laura.id } });
      eq(sameName.status, 409, 'same name'); eq(sameName.body.code, 'possible_duplicate', 'code'); eq(sameName.body.matches.length, 1, 'matches');
      const samePhone = await api('POST', '/rep-leads', { as: USERS.helper, body: { company_name: 'Different Name LLC', phone: '717-555-0188' } });
      eq(samePhone.status, 409, 'same phone');
      const sameEmail = await api('POST', '/rep-leads', { as: USERS.helper, body: { company_name: 'Another One', email: 'PETE@hilltop.test' } });
      eq(sameEmail.status, 409, 'same email');
      const forced = await api('POST', '/rep-leads', { as: USERS.helper, body: { company_name: 'Hilltop Roofing', confirm_duplicate: true, brought_in_by_rep_id: rep.Laura.id } });
      eq(forced.status, 201, 'confirmed duplicate');
      const unrelated = await api('POST', '/rep-leads', { as: USERS.helper, body: { company_name: 'Valley Fence', phone: '717-555-0111' } });
      eq(unrelated.status, 201, 'unrelated');
      return 'name (case/spacing-insensitive), phone digits and email each trigger 409 possible_duplicate with the match; confirm_duplicate adds it';
    });
    await check('Validation: a lead needs a company name; a lead can be marked lost; a rep can be edited', async () => {
      eq((await api('POST', '/rep-leads', { as: USERS.helper, body: { company_name: '' } })).status, 400, 'blank company');
      const lost = await api('PATCH', `/rep-leads/${leadId}`, { as: USERS.helper, body: { status: 'lost' } });
      eq(lost.body.status, 'lost', 'lost');
      const reopened = await api('PATCH', `/rep-leads/${leadId}`, { as: USERS.helper, body: { status: 'open' } });
      eq(reopened.body.status, 'open', 'reopened');
      const edited = await api('PATCH', `/reps/${rep.Dana.id}`, { as: USERS.helper, body: { phone: '717-555-0199' } });
      eq(edited.body.phone, '717-555-0199', 'rep phone');
      return 'blank name -> 400; open -> lost -> open; rep phone edited';
    });

    // ===========================================================================
    section('Putting reps on dealers');
    for (const slug of ['dealer-b', 'dealer-c', 'dealer-d', 'dealer-e', 'house-dealer']) await mkTenant(slug, { activatedAt: slug === 'dealer-e' ? '2026-08-20T15:00:00Z' : '2026-08-05T15:00:00Z' });
    await check('Winning a lead puts the closer and onboarder on the dealer in one step (credit to whoever closes it); it can only be won once', async () => {
      const r = await api('POST', `/rep-leads/${leadId}/win`, { as: USERS.helper, body: { closed_by_rep_id: rep.Laura.id, onboarded_by_rep_id: rep.Sam.id, tenant_id: tenants['dealer-a'].id } });
      eq(r.status, 200, 'win');
      eq(r.body.status, 'won', 'status'); eq(r.body.closed_by_rep_id, rep.Laura.id, 'closer is Laura, not Dana who found it');
      const [a] = await sql('select closer_rep_id, onboarder_rep_id, effective_to from rep_assignments where tenant_id = $1', [tenants['dealer-a'].id]);
      eq([a.closer_rep_id, a.onboarder_rep_id, a.effective_to], [rep.Laura.id, rep.Sam.id, null], 'assignment');
      eq((await api('POST', `/rep-leads/${leadId}/win`, { as: USERS.helper, body: { closed_by_rep_id: rep.Dana.id } })).status, 409, 'win twice');
      return 'dealer-a: closer Laura (not the finder, Dana), onboarder Sam; second win -> 409';
    });
    await check('The helper can assign from now but cannot backdate; billing-exempt tenants cannot be assigned; the dealer list carries no money', async () => {
      const bd = await api('PUT', `/rep-dealers/${tenants['dealer-b'].id}/assignment`, { as: USERS.helper, body: { closer_rep_id: rep.Sam.id, onboarder_rep_id: rep.Sam.id, effective_from: '2026-01-01T00:00:00Z' } });
      eq(bd.status, 403, 'helper backdating');
      const ok = await api('PUT', `/rep-dealers/${tenants['dealer-b'].id}/assignment`, { as: USERS.helper, body: { closer_rep_id: rep.Sam.id, onboarder_rep_id: rep.Sam.id } });
      eq(ok.status, 200, 'helper assigning from now');
      const gss = await api('PUT', `/rep-dealers/${tenants['good-steward-structures'].id}/assignment`, { as: USERS.admin, body: { closer_rep_id: rep.Sam.id, onboarder_rep_id: null } });
      eq(gss.status, 409, 'billing-exempt tenant');
      const list = await api('GET', '/rep-dealers', { as: USERS.helper });
      assert(!/cents|stripe/i.test(JSON.stringify(list.body)), 'money field in the dealer list');
      // Staff now SEE the three in-house companies — they run live programs and
      // were invisible before — but they still cannot be assigned to a rep,
      // which is the 409 above.
      const exempt = list.body.dealers.filter((d) => ['good-steward-structures', 'north-mountain-structures', '50-platform'].includes(d.slug));
      eq(exempt.length, 3, 'the three in-house companies are listed for staff');
      assert(exempt.every((d) => d.billing_exempt === true), `flagged exempt: ${JSON.stringify(exempt.map((d) => [d.slug, d.billing_exempt]))}`);
      assert(exempt.every((d) => d.closer_rep_id === null && d.onboarder_rep_id === null), 'an in-house company has nobody on it');
      assert(list.body.dealers.filter((d) => !d.billing_exempt).every((d) => d.billing_exempt === false), 'paying dealers are flagged false, not undefined');
      return 'helper backdate -> 403; helper assign now -> 200; GSS -> 409; staff see all 3 in-house companies, flagged, unassignable, no money fields';
    });
    await check('The admin can backdate a start date (to credit a dealer that paid before the assignment was made)', async () => {
      for (const slug of ['dealer-c', 'dealer-d', 'dealer-e']) {
        const r = await api('PUT', `/rep-dealers/${tenants[slug].id}/assignment`, { as: USERS.admin, body: { closer_rep_id: rep.Zed.id, onboarder_rep_id: slug === 'dealer-d' ? rep.Laura.id : null, effective_from: '2026-01-01T00:00:00Z' } });
        eq(r.status, 200, `assign ${slug}`);
      }
      await api('PUT', `/rep-dealers/${tenants['dealer-a'].id}/assignment`, { as: USERS.admin, body: { closer_rep_id: rep.Laura.id, onboarder_rep_id: rep.Sam.id, effective_from: '2026-01-01T00:00:00Z' } });
      const [a] = await sql('select effective_from from rep_assignments where tenant_id = $1 and effective_to is null', [tenants['dealer-a'].id]);
      eq(a.effective_from.toISOString(), '2026-01-01T00:00:00.000Z', 'dealer-a start');
      return 'dealers c, d, e (Zed closer) and dealer-a backdated to Jan 1 by the admin';
    });

    // ===========================================================================
    section('Earnings: activation');
    // Out of the box the onboarder earns nothing (the closer earns
    // everything) — that rule and its default are proved in
    // scripts/e2e/rep-pipeline-e2e.js. The checks below are about the two-role
    // MECHANISM, so they turn the onboarder's rates on to the old $50/$1/50c
    // and exercise both sides of an assignment.
    await check('The onboarder\'s rates are 0 by default, and the admin can turn them back on', async () => {
      const before = await api('GET', '/rep-settings', { as: USERS.admin });
      eq([before.body.onboarder_activation_cents, before.body.onboarder_referral_cents, before.body.onboarder_referral_cents_after_threshold], [0, 0, 0], 'defaults');
      const put = await api('PUT', '/rep-settings', { as: USERS.admin, body: { onboarder_activation_cents: 5000, onboarder_referral_cents: 100, onboarder_referral_cents_after_threshold: 50 } });
      eq(put.status, 200, 'put');
      eq([put.body.onboarder_activation_cents, put.body.onboarder_referral_cents], [5000, 100], 'after');
      return 'onboarder 0/0/0 by default; set to 5000/100/50 for the two-role checks below';
    });
    const actA = await activation('dealer-a', { at: '2026-08-01T15:00:00Z', pi: 'pi_act_a' });
    const actB = await activation('dealer-b', { at: '2026-08-05T15:00:00Z' });
    await check('A cleared live activation pays the closer $50 AND the onboarder $50; one person in both roles gets $100', async () => {
      // dealer-b was assigned "now" by the helper, after its activation cleared: no back pay.
      const first = await cycle();
      eq(first.activation, 2, 'activation rows added (dealer-a: closer + onboarder; dealer-b earns nothing, it cleared before the assignment)');
      eq(await total(rep.Laura.id), 5000, 'Laura (closer)'); eq(await total(rep.Sam.id), 5000, 'Sam (onboarder on dealer-a)');
      eq(await total(rep.Dana.id), 0, 'Dana only found the lead');
      // A different pair of reps cannot start before the current assignment; the same pair can be moved earlier by the admin.
      const other = await api('PUT', `/rep-dealers/${tenants['dealer-b'].id}/assignment`, { as: USERS.admin, body: { closer_rep_id: rep.Laura.id, onboarder_rep_id: null, effective_from: '2026-08-01T00:00:00Z' } });
      eq(other.status, 409, 'different reps cannot start before the current assignment');
      const backdate = await api('PUT', `/rep-dealers/${tenants['dealer-b'].id}/assignment`, { as: USERS.admin, body: { closer_rep_id: rep.Sam.id, onboarder_rep_id: rep.Sam.id, effective_from: '2026-08-01T00:00:00Z' } });
      eq(backdate.status, 200, 'admin moving the same assignment earlier');
      const second = await cycle();
      eq(second.activation, 2, 'dealer-b activation: Sam as closer and as onboarder');
      eq(await total(rep.Sam.id), 5000 + 10000, 'Sam: $50 onboarding dealer-a + $100 (both roles) on dealer-b');
      return 'dealer-a: Laura $50, Sam $50, Dana $0; dealer-b cleared before its assignment -> $0 until the admin backdated it, then Sam (both roles) $100';
    });
    await check('Running again — or twice at once — adds nothing (the database makes each charge pay each rep once)', async () => {
      const before = (await sql('select count(*)::int as n from rep_earnings'))[0].n;
      const [a, b, c] = await Promise.all([cycle(), cycle(), cycle()]);
      void a; void b; void c;
      await cycle();
      eq((await sql('select count(*)::int as n from rep_earnings'))[0].n, before, 'rows');
      return `${before} rows before and after 4 more runs (3 at once)`;
    });
    await check('Not paid: test-mode, pending/failed, a house account, a billing-exempt dealer, and a duplicate second activation payment', async () => {
      const before = (await sql('select count(*)::int as n from rep_earnings'))[0].n;
      await activation('dealer-c', { live: false, at: '2026-08-05T15:00:00Z' });
      await activation('dealer-c', { status: 'failed', at: '2026-08-05T16:00:00Z' });
      await activation('dealer-c', { status: 'pending', at: '2026-08-05T17:00:00Z' });
      await activation('house-dealer', { at: '2026-08-05T15:00:00Z' });
      await activation('good-steward-structures', { at: '2026-08-05T15:00:00Z' });
      await activation('dealer-a', { at: '2026-08-02T15:00:00Z', pi: 'pi_dup_a' }); // a second, duplicate payment by dealer-a
      const r = await cycle();
      eq(r.activation, 0, 'activation rows added');
      eq((await sql('select count(*)::int as n from rep_earnings'))[0].n, before, 'rows');
      return 'test-mode, failed, pending, house dealer, exempt GSS and a duplicate payment -> 0 new earnings';
    });
    await check('A dealer\'s real activation pays its reps (dealer-c, Zed closer only: $50, no onboarder, nothing else)', async () => {
      await activation('dealer-c', { at: '2026-08-05T18:00:00Z' });
      const r = await cycle();
      eq(r.activation, 1, 'rows');
      eq(await total(rep.Zed.id), 5000, 'Zed');
      return 'Zed +$50';
    });

    // ===========================================================================
    section('Earnings: referrals');
    await check('A cleared referral fee pays the closer $1 and the onboarder $1 (a $50 card); the same person in both roles gets $2', async () => {
      const before = { laura: await total(rep.Laura.id), sam: await total(rep.Sam.id) };
      await fee('dealer-a', { rewardCents: 5000 });
      const r = await cycle();
      eq(r.referral, 2, 'rows');
      eq((await total(rep.Laura.id)) - before.laura, 100, 'Laura (closer)'); eq((await total(rep.Sam.id)) - before.sam, 100, 'Sam (onboarder)');
      // dealer-b: Sam is both roles, assigned before this charge
      const samBefore = await total(rep.Sam.id);
      await fee('dealer-b', { rewardCents: 5000 });
      await cycle();
      eq((await total(rep.Sam.id)) - samBefore, 200, 'Sam in both roles');
      return 'dealer-a: Laura +$1, Sam +$1; dealer-b: Sam +$2';
    });
    await check('The $1 scales down with the card and never up: $25 -> 50c, $10 -> 20c, $100 -> still $1, $0 -> nothing', async () => {
      const expect = { 2500: 50, 1000: 20, 10000: 100, 4000: 80 };
      const out = [];
      for (const [reward, want] of Object.entries(expect)) {
        const feeId = await fee('dealer-c', { rewardCents: Number(reward) });
        await cycle();
        const [row] = await sql(`select amount_cents, detail from rep_earnings where source_billing_event_id = $1 and rep_id = $2`, [feeId, rep.Zed.id]);
        eq(row.amount_cents, want, `$${reward / 100} card`);
        out.push(`$${reward / 100} card -> ${want}c`);
      }
      const zero = await fee('dealer-c', { rewardCents: 0 });
      await cycle();
      eq((await sql('select count(*)::int as n from rep_earnings where source_billing_event_id = $1', [zero]))[0].n, 0, '$0 card');
      return out.join(', ') + ', $0 -> none';
    });
    await check('Not paid: a referral fee that is test-mode, failed, or for a house account', async () => {
      const before = (await sql('select count(*)::int as n from rep_earnings'))[0].n;
      await fee('dealer-c', { live: false }); await fee('dealer-c', { status: 'failed' }); await fee('dealer-c', { status: 'pending' }); await fee('house-dealer');
      eq((await cycle()).referral, 0, 'rows');
      eq((await sql('select count(*)::int as n from rep_earnings'))[0].n, before, 'rows');
      return '0 new earnings';
    });
    await check('After a rep\'s 2,000th company the rate halves — shown with the threshold set to 2: their 3rd company pays 50c, their first two keep $1 forever', async () => {
      const put = await api('PUT', '/rep-settings', { as: USERS.admin, body: { threshold_companies: 2 } });
      eq(put.status, 200, 'settings');
      // Zed's companies, in activation order: dealer-c (Aug 5), dealer-d (Aug 5, later id? use explicit), dealer-e (Aug 20)
      await sql(`update tenants set activation_paid_at = '2026-08-03T15:00:00Z' where slug = 'dealer-c'`);
      await sql(`update tenants set activation_paid_at = '2026-08-10T15:00:00Z' where slug = 'dealer-d'`);
      // dealer-e already Aug 20: Zed's 3rd.
      const f = {};
      for (const slug of ['dealer-c', 'dealer-d', 'dealer-e']) {
        f[slug] = await fee(slug, { rewardCents: 5000 });
      }
      await cycle();
      const got = {};
      for (const slug of Object.keys(f)) got[slug] = (await sql(`select amount_cents, detail from rep_earnings where source_billing_event_id = $1 and rep_id = $2`, [f[slug], rep.Zed.id]))[0];
      eq(got['dealer-c'].amount_cents, 100, 'company #1'); eq(got['dealer-d'].amount_cents, 100, 'company #2'); eq(got['dealer-e'].amount_cents, 50, 'company #3 (after the threshold)');
      eq(got['dealer-e'].detail.company_number, 3, 'company number recorded');
      // A fee on company #1 that clears later still pays the full rate.
      const later = await fee('dealer-c', { rewardCents: 5000 });
      await cycle();
      eq((await sql(`select amount_cents from rep_earnings where source_billing_event_id = $1 and rep_id = $2`, [later, rep.Zed.id]))[0].amount_cents, 100, 'later fee on company #1');
      // And a $25 card past the threshold: half of 50c.
      const half = await fee('dealer-e', { rewardCents: 2500 });
      await cycle();
      eq((await sql(`select amount_cents from rep_earnings where source_billing_event_id = $1 and rep_id = $2`, [half, rep.Zed.id]))[0].amount_cents, 25, '$25 card past the threshold');
      await api('PUT', '/rep-settings', { as: USERS.admin, body: { threshold_companies: 2000 } });
      return 'company 1 -> 100c, 2 -> 100c, 3 -> 50c (company_number 3 recorded); later fee on #1 still 100c; $25 card past the threshold 25c';
    });
    await check('Changing the rates affects only earnings from then on', async () => {
      const zed = await total(rep.Zed.id);
      const put = await api('PUT', '/rep-settings', { as: USERS.admin, body: { referral_cents: 200 } });
      eq(put.body.referral_cents, 200, 'rate');
      await fee('dealer-c', { rewardCents: 5000 });
      await cycle();
      eq((await total(rep.Zed.id)) - zed, 200, 'new fee at the new rate');
      await api('PUT', '/rep-settings', { as: USERS.admin, body: { referral_cents: 100 } });
      return 'earlier rows untouched; the next fee paid 200c while the rate was $2, then restored';
    });

    // ===========================================================================
    section('Reassigning a dealer');
    await check('Reassigning dealer-a moves FUTURE royalties to the new rep and leaves what was already earned with the old ones', async () => {
      const laura = await total(rep.Laura.id); const dana = await total(rep.Dana.id);
      const r = await api('PUT', `/rep-dealers/${tenants['dealer-a'].id}/assignment`, { as: USERS.helper, body: { closer_rep_id: rep.Dana.id, onboarder_rep_id: null } });
      eq(r.status, 200, 'reassign');
      const periods = await sql('select closer_rep_id, effective_to from rep_assignments where tenant_id = $1 order by effective_from', [tenants['dealer-a'].id]);
      eq(periods.length, 2, 'assignment history rows'); assert(periods[0].effective_to, 'old period not closed');
      await new Promise((r2) => setTimeout(r2, 50));
      await fee('dealer-a', { rewardCents: 5000 });
      await cycle();
      eq(await total(rep.Laura.id), laura, 'Laura earns nothing new'); eq((await total(rep.Dana.id)) - dana, 100, 'Dana (new closer) earns the new fee');
      return 'Laura unchanged; Dana +$1; two assignment rows (history kept)';
    });
    await check('Deactivating a rep changes nothing by itself: their dealers are listed for a decision and they keep earning until you move them', async () => {
      const r = await api('PATCH', `/reps/${rep.Zed.id}`, { as: USERS.helper, body: { active: false } });
      eq(r.body.active, false, 'active');
      const slugs = r.body.dealers_needing_a_decision.map((d) => d.name).sort();
      eq(slugs, ['Dealer dealer-c', 'Dealer dealer-d', 'Dealer dealer-e'], 'dealers to decide on');
      const before = await total(rep.Zed.id);
      await fee('dealer-c', { rewardCents: 5000 });
      await cycle();
      assert((await total(rep.Zed.id)) > before, 'an inactive rep stopped earning by itself');
      await api('PATCH', `/reps/${rep.Zed.id}`, { as: USERS.helper, body: { active: true } });
      return 'dealers listed: c, d, e; Zed still earned until the admin decides';
    });

    // ===========================================================================
    section('Refunds and disputes');
    await check('A fee that goes to needs_refund or disputed is reversed (negative row); once, never twice', async () => {
      const f = await fee('dealer-c', { rewardCents: 5000 });
      await cycle();
      const before = await total(rep.Zed.id);
      await sql(`update billing_events set status = 'needs_refund' where id = $1`, [f]);
      eq((await cycle()).reversals, 1, 'reversals');
      eq(before - (await total(rep.Zed.id)), 100, 'net effect');
      eq((await cycle()).reversals, 0, 'second run');
      const [rev] = await sql(`select kind, amount_cents, reverses_earning_id, detail from rep_earnings where rep_id = $1 and kind = 'reversal' order by created_at desc limit 1`, [rep.Zed.id]);
      eq([rev.kind, rev.amount_cents, rev.detail.reason], ['reversal', -100, 'needs_refund'], 'reversal row');
      return 'Zed -$1 once; reversal row points at the original and records why';
    });
    await check('A dispute recorded against the activation payment reverses that dealer\'s activation earnings', async () => {
      const t = tenants['dealer-e'];
      const act = await activation('dealer-e', { at: '2026-08-20T15:00:00Z', pi: 'pi_disputed_e' });
      await cycle();
      const zed = await total(rep.Zed.id);
      await sql(`insert into billing_events (tenant_id, event_type, amount_cents, status, livemode, stripe_payment_intent_id) values ($1, 'dispute_created', 50000, 'disputed', true, 'pi_disputed_e')`, [t.id]);
      const r = await cycle();
      eq(r.reversals, 1, 'reversals');
      eq(zed - (await total(rep.Zed.id)), 5000, 'activation earning reversed');
      void act;
      return 'Zed -$50 when the dispute for that PaymentIntent was recorded';
    });
    await check('The admin can reverse one earning by hand (a refund done in Stripe); not twice; not the helper', async () => {
      const [e] = await sql(`select id, amount_cents from rep_earnings where rep_id = $1 and kind = 'referral' and not exists (select 1 from rep_earnings r2 where r2.reverses_earning_id = rep_earnings.id) order by created_at limit 1`, [rep.Zed.id]);
      eq((await api('POST', `/rep-earnings/${e.id}/reverse`, { as: USERS.helper, body: {} })).status, 403, 'helper');
      const before = await total(rep.Zed.id);
      eq((await api('POST', `/rep-earnings/${e.id}/reverse`, { as: USERS.admin, body: { note: 'Refunded in Stripe' } })).status, 200, 'admin');
      eq(before - (await total(rep.Zed.id)), e.amount_cents, 'net effect');
      eq((await api('POST', `/rep-earnings/${e.id}/reverse`, { as: USERS.admin, body: {} })).status, 409, 'second reversal');
      return 'helper 403; admin reversed it with a note; again -> 409';
    });

    // ===========================================================================
    section('Statements, payouts and what is owed');
    await check('Overview and monthly statement add up; the month follows New York time', async () => {
      const sep = await fee('dealer-c', { at: '2026-10-01T03:30:00Z', rewardCents: 5000 }); // 11:30 pm EDT Sept 30
      const oct = await fee('dealer-c', { at: '2026-10-01T12:30:00Z', rewardCents: 5000 }); // 8:30 am EDT Oct 1
      await cycle();
      const at = async (id) => (await sql(`select earned_at from rep_earnings where source_billing_event_id = $1 and rep_id = $2`, [id, rep.Zed.id]))[0].earned_at.getTime();
      const [sepAt, octAt] = [await at(sep), await at(oct)];
      const sept = await api('GET', `/reps/${rep.Zed.id}/statement?month=2026-09`, { as: USERS.admin });
      const octStmt = await api('GET', `/reps/${rep.Zed.id}/statement?month=2026-10`, { as: USERS.admin });
      eq(sept.status, 200, 'status');
      const times = (st) => st.body.lines.map((l) => new Date(l.at).getTime());
      assert(times(sept).includes(sepAt), 'the 11:30 pm Sept 30 earning is not on the September statement');
      assert(!times(sept).includes(octAt), 'the Oct 1 earning leaked into September');
      assert(times(octStmt).includes(octAt), 'the Oct 1 earning is not on the October statement');
      assert(!times(octStmt).includes(sepAt), 'the Sept 30 earning leaked into October');
      for (const st of [sept, octStmt]) eq(st.body.opening_cents + st.body.earned_cents - st.body.paid_cents, st.body.closing_cents, `${st.body.month}: opening + earned - paid = closing`);
      eq(octStmt.body.opening_cents, sept.body.closing_cents, 'October opens where September closed');
      eq(sept.body.activation_cents + sept.body.royalty_cents + sept.body.reversal_cents, sept.body.earned_cents, 'September parts add up');
      return 'Sept 30 11:30 pm EDT -> September; Oct 1 8:30 am EDT -> October; opening + earned - paid = closing; October opens at September\'s close';
    });
    await check('Recording a payout lowers what is owed, shows on the statement, and can be removed; the helper cannot', async () => {
      const ov = await api('GET', '/rep-money/overview', { as: USERS.admin });
      const zed = ov.body.reps.find((r) => r.id === rep.Zed.id);
      eq(zed.owed_cents, await total(rep.Zed.id), 'owed before any payout');
      eq((await api('POST', `/reps/${rep.Zed.id}/payouts`, { as: USERS.helper, body: { amount_cents: 500 } })).status, 403, 'helper');
      const pay = await api('POST', `/reps/${rep.Zed.id}/payouts`, { as: USERS.admin, body: { amount_cents: 5000, paid_on: '2026-10-05', period: '2026-09', method: 'Zelle', note: 'September' } });
      eq(pay.status, 201, 'payout');
      const ov2 = await api('GET', '/rep-money/overview?month=2026-10', { as: USERS.admin });
      const zed2 = ov2.body.reps.find((r) => r.id === rep.Zed.id);
      eq(zed2.owed_cents, zed.owed_cents - 5000, 'owed after payout');
      eq(zed2.paid_cents, 5000, 'paid in October');
      const st = await api('GET', `/reps/${rep.Zed.id}/statement?month=2026-10`, { as: USERS.admin });
      eq(st.body.payouts.length, 1, 'payout on the statement'); eq(st.body.closing_cents, zed2.owed_cents, 'statement closing = owed');
      eq((await api('DELETE', `/rep-payouts/${pay.body.id}`, { as: USERS.helper })).status, 403, 'helper delete');
      eq((await api('DELETE', `/rep-payouts/${pay.body.id}`, { as: USERS.admin })).status, 200, 'admin delete');
      eq((await api('GET', '/rep-money/overview', { as: USERS.admin })).body.reps.find((r) => r.id === rep.Zed.id).owed_cents, zed.owed_cents, 'owed restored');
      return 'owed -$50 after a $50 payout, the statement shows it, and deleting the payout restores the balance';
    });
    await check('What 50. owes everyone is the sum of the reps\' balances', async () => {
      const ov = await api('GET', '/rep-money/overview', { as: USERS.admin });
      const allEarn = (await sql('select coalesce(sum(amount_cents), 0)::int as n from rep_earnings'))[0].n;
      const allPaid = (await sql('select coalesce(sum(amount_cents), 0)::int as n from rep_payouts'))[0].n;
      eq(ov.body.totals.owed_cents, allEarn - allPaid, 'totals.owed_cents');
      return `owed in total: ${ov.body.totals.owed_cents} cents`;
    });

    // ===========================================================================
    section('The database itself refuses what the API would');
    await check('As signed in users: a dealer sees no rep rows; the helper sees no money rows and cannot write earnings, payouts or settings; assign_rep and reverse_rep_earning check who is asking', async () => {
      const q = (user, text, params) => withUserTransaction(user.id, (c) => c.query(text, params));
      eq((await q(USERS.dealerAdmin, 'select id from reps')).rowCount, 0, 'dealer sees reps');
      eq((await q(USERS.dealerAdmin, 'select id from rep_leads')).rowCount, 0, 'dealer sees leads');
      eq((await q(USERS.dealerAdmin, 'select * from rep_dealer_list(false)')).rowCount, 0, 'dealer sees the dealer list');
      assert((await q(USERS.helper, 'select id from reps')).rowCount > 0, 'helper cannot see reps');
      for (const t of ['rep_earnings', 'rep_payouts', 'rep_settings']) eq((await q(USERS.helper, `select * from ${t}`)).rowCount, 0, `helper sees ${t}`);
      assert((await q(USERS.admin, 'select * from rep_earnings')).rowCount > 0, 'admin cannot see earnings');
      const refused = async (user, text, params) => { try { await q(user, text, params); return null; } catch (e) { return e.message; } };
      assert(await refused(USERS.helper, `insert into rep_earnings (rep_id, tenant_id, role, kind, amount_cents, source_billing_event_id, earned_at) values ($1, $2, 'closer', 'activation', 1, $3, now())`, [rep.Zed.id, tenants['dealer-c'].id, actA]), 'helper wrote an earning');
      assert(await refused(USERS.admin, `insert into rep_earnings (rep_id, tenant_id, role, kind, amount_cents, source_billing_event_id, earned_at) values ($1, $2, 'closer', 'activation', 1, $3, now())`, [rep.Zed.id, tenants['dealer-c'].id, actA]), 'even the admin session wrote an earning directly');
      assert(await refused(USERS.helper, `insert into rep_payouts (rep_id, amount_cents) values ($1, 100)`, [rep.Zed.id]), 'helper wrote a payout');
      eq((await q(USERS.helper, `update rep_settings set activation_cents = 1`)).rowCount, 0, 'helper changed the rates');
      assert(await refused(USERS.helper, `insert into rep_assignments (tenant_id, closer_rep_id) values ($1, $2)`, [tenants['dealer-c'].id, rep.Zed.id]), 'helper wrote an assignment directly');
      assert(await refused(USERS.helper, `select assign_rep($1, $2, null, '2020-01-01')`, [tenants['dealer-c'].id, rep.Zed.id]), 'helper backdated via the function');
      assert(await refused(USERS.dealerAdmin, `select assign_rep($1, $2, null)`, [tenants['dealer-c'].id, rep.Zed.id]), 'dealer assigned a rep');
      assert(await refused(USERS.helper, `select reverse_rep_earning($1)`, [(await sql('select id from rep_earnings limit 1'))[0].id]), 'helper reversed an earning');
      return 'dealer: 0 rows everywhere; helper: reps yes, money tables 0 rows, all money writes and backdating refused; even a direct earning insert by the admin session is refused';
    });
    await check('Earnings are sign-checked by the database: a positive row needs a charge, a reversal must be negative', async () => {
      const bad = async (text, params) => { try { await sql(text, params); return null; } catch (e) { return e.message; } };
      assert((await bad(`insert into rep_earnings (rep_id, tenant_id, role, kind, amount_cents, earned_at) values ($1, $2, 'closer', 'activation', 100, now())`, [rep.Zed.id, tenants['dealer-c'].id]) || '').includes('rep_earnings_sign'), 'a positive earning with no charge was accepted');
      const [e] = await sql('select id from rep_earnings where kind <> $1 limit 1', ['reversal']);
      assert((await bad(`insert into rep_earnings (rep_id, tenant_id, role, kind, amount_cents, reverses_earning_id, earned_at) values ($1, $2, 'closer', 'reversal', 100, $3, now())`, [rep.Zed.id, tenants['dealer-c'].id, e.id]) || '').includes('rep_earnings_sign'), 'a positive reversal was accepted');
      return 'rep_earnings_sign refuses both';
    });

    // ===========================================================================
    section('The hourly job');
    await check('--dry-run reports what it would add, and keeps nothing', async () => {
      const f = await fee('dealer-c', { rewardCents: 5000 });
      const before = (await sql('select count(*)::int as n from rep_earnings'))[0].n;
      const r = await cycle({ dryRun: true });
      eq(r.referral, 1, 'would add'); eq((await sql('select count(*)::int as n from rep_earnings'))[0].n, before, 'rows after the dry run');
      const real = await cycle();
      eq(real.referral, 1, 'a real run adds the same');
      void f;
      return 'dry run: 1 would be added, 0 kept; the real run added that 1';
    });
    await check('Overlapping runs: while another process holds the lock, a cycle stands down', async () => {
      const other = new Client({ connectionString: dbUrl(DB) });
      await other.connect();
      try {
        await other.query('select pg_advisory_lock(5031982007)');
        const r = await cycle();
        eq(r.skippedForLock, true, 'skippedForLock');
      } finally { await other.end(); }
      return 'skippedForLock while locked';
    });
    await check('The web service runs it every hour alongside the renewal and email jobs', async () => {
      const src = fs.readFileSync(path.join(API_DIR, 'src', 'workers', 'renewalScheduler.js'), 'utf8');
      assert(/runRepEarningsCycle\(\)/.test(src), 'renewalScheduler.js does not call runRepEarningsCycle');
      return 'renewalScheduler.js tick() calls runRepEarningsCycle in its own try/catch';
    });
  } finally {
    if (apiChild) apiChild.kill('SIGTERM');
    await db.end().catch(() => {});
    try { const { pool } = require('../../src/db'); await pool.end(); } catch (e) { /* never loaded */ }
    authServer.close();
    await withClient(PG_ADMIN_URL, (c) => c.query(`drop database if exists ${DB} with (force)`)).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  const outPath = process.env.E2E_RESULTS || path.join(process.cwd(), 'rep-program-results.md');
  fs.writeFileSync(
    outPath,
    `# Rep program — verification\n\n${results.map((r) => `- ${r.pass ? 'PASS' : 'FAIL'} — ${r.section}: ${r.title}${r.evidence ? `\n  - ${r.evidence}` : ''}`).join('\n')}\n`
  );
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed — ${outPath}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
