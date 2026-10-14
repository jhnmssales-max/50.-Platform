#!/usr/bin/env node
// Verification of the rep pipeline (the rep_pipeline migration, the rep routes
// in src/routes/reps.js, src/lib/supabaseAdmin.js and the earnings worker's
// new per-role rates), against a real Postgres built from every migration, the
// real API run as a child process, a stand-in for Supabase Auth including its
// admin API, and a stand-in for Postmark.
//
//   node scripts/e2e/rep-pipeline-e2e.js
//
// What it is really checking: that a rep sees their OWN work and nothing else.
// Every such check is made twice over — once through the API, and once by
// querying the database as that rep, so a mistake in a handler cannot pass by
// being covered for by the UI, and RLS is proved to be the real guard.
//
// Needs the same scratch Postgres 16 as the other e2e scripts
// (E2E_PG_ADMIN_URL, default postgresql://postgres@127.0.0.1:54329/postgres).
const path = require('path');
const fs = require('fs');
const express = require('express');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { createAuthStandIn, SERVICE_ROLE_KEY } = require('./auth-stand-in');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_DIR = path.join(REPO_ROOT, 'api');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const ACTIVATION_MIGRATION = '20261001000000_activation_gate_and_referral_fee.sql';
const PIPELINE_MIGRATION = '20261016000000_rep_pipeline.sql';
const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:54329/postgres';
const DB = `fifty_pipeline_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const PORTS = { api: 3102, auth: 9994, postmark: 12113, front: 8090 };
const API = `http://127.0.0.1:${PORTS.api}`;
const AUTH_BASE = `http://127.0.0.1:${PORTS.auth}`;
const FRONTEND = `http://127.0.0.1:${PORTS.front}`;

const results = [];
let currentSection = '';
function section(name) { currentSection = name; console.log(`\n=== ${name}`); }
async function check(title, fn) {
  try {
    const evidence = await fn();
    results.push({ section: currentSection, title, pass: true });
    console.log(`  PASS  ${title}${evidence ? `\n        ${evidence}` : ''}`);
  } catch (err) {
    results.push({ section: currentSection, title, pass: false });
    console.log(`  FAIL  ${title}\n        ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, what) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const dbUrl = (name) => { const u = new URL(PG_ADMIN_URL); u.pathname = `/${name}`; return u.toString(); };

const PASSWORD = 'e2e-password-1';
const USERS = {
  admin: { id: 'd0000000-0000-4000-8000-000000000001', email: 'joseph@fifty.test', name: 'Joseph', role: 'admin', tenant: '50-platform' },
  helper: { id: 'd0000000-0000-4000-8000-000000000002', email: 'helper@fifty.test', name: 'Helper', role: 'staff', tenant: '50-platform' },
  dealer: { id: 'd0000000-0000-4000-8000-000000000003', email: 'owner@dealer-a.test', name: 'Dealer Owner', role: 'admin', tenant: 'dealer-a' },
};

async function main() {
  // Filled in once the database exists: the stand-in writes each new account
  // into auth.users exactly as Supabase Auth does, so the API's own insert
  // into public.users has the row its foreign key needs.
  let recordAuthUser = async () => {};
  const auth = createAuthStandIn({ onUserCreated: (u) => recordAuthUser(u) });
  const authServer = auth.app.listen(PORTS.auth, '127.0.0.1');

  // Postmark stand-in: every message the API sends lands here.
  const sent = [];
  let postmarkFailing = false;
  const stub = express();
  stub.use(express.json());
  stub.post('/email', (req, res) => {
    if (postmarkFailing) return res.status(500).json({ ErrorCode: 500, Message: 'Postmark is down (test)' });
    sent.push(req.body);
    res.json({ ErrorCode: 0, MessageID: `m-${sent.length}` });
  });
  const stubServer = stub.listen(PORTS.postmark, '127.0.0.1');

  const admin0 = new Client({ connectionString: PG_ADMIN_URL });
  await admin0.connect();
  await admin0.query(`drop database if exists ${DB} with (force)`);
  await admin0.query(`create database ${DB}`);
  await admin0.end();
  const db = new Client({ connectionString: dbUrl(DB) });
  await db.connect();
  const sql = async (t, p) => (await db.query(t, p)).rows;
  recordAuthUser = (u) => db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing', [u.id, u.email]);

  let apiChild = null;
  const apiLines = [];

  try {
    section('Migration');
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await db.query(fs.readFileSync(path.join(__dirname, 'supabase-stand-in.sql'), 'utf8'));
    for (const f of files) if (f < ACTIVATION_MIGRATION) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    await db.query(`insert into tenants (slug, name) values
      ('good-steward-structures','Good Steward Structures'),('north-mountain-structures','North Mountain Structures'),('50-platform','50.')`);
    await check('Every migration applies in order, including the rep-pipeline one', async () => {
      const rest = files.filter((f) => f >= ACTIVATION_MIGRATION);
      for (const f of rest) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      assert(rest.includes(PIPELINE_MIGRATION), 'rep_pipeline migration not found');
      return rest.join(', ');
    });
    await check('Out of the box the closer earns everything and the onboarder nothing', async () => {
      const [s] = await sql('select * from rep_settings');
      eq([s.activation_cents, s.referral_cents, s.referral_cents_after_threshold], [5000, 100, 50], 'closer');
      eq([s.onboarder_activation_cents, s.onboarder_referral_cents, s.onboarder_referral_cents_after_threshold], [0, 0, 0], 'onboarder');
      return 'closer $50 / $1 / 50c; onboarder 0 / 0 / 0';
    });

    const tenants = {};
    for (const r of await sql('select id, slug, name from tenants')) tenants[r.slug] = r;
    const mkTenant = async (slug, name, paidAt) => {
      const [t] = await sql(
        `insert into tenants (slug, name, billing_status, activation_paid_at, activation_livemode)
         values ($1,$2,'active',$3,$4) returning id, slug, name`,
        [slug, name, paidAt, paidAt ? true : null]
      );
      tenants[slug] = t;
      return t;
    };
    await mkTenant('dealer-a', 'Dealer A Roofing', '2026-08-01T15:00:00Z');
    await mkTenant('dealer-b', 'Dealer B Fencing', '2026-08-02T15:00:00Z');

    for (const u of Object.values(USERS)) {
      await sql('insert into auth.users (id, email) values ($1,$2)', [u.id, u.email]);
      await sql('insert into users (id, tenant_id, email, name, role) values ($1,$2,$3,$4,$5)', [u.id, tenants[u.tenant].id, u.email, u.name, u.role]);
      auth.addUser({ id: u.id, email: u.email, password: PASSWORD });
    }

    // ----- the real API -------------------------------------------------------
    apiChild = spawn(process.execPath, ['src/server.js'], {
      cwd: API_DIR,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        DATABASE_URL: dbUrl(DB), SUPABASE_URL: AUTH_BASE, SUPABASE_JWKS_URL: '', PORT: String(PORTS.api),
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
        POSTMARK_SERVER_TOKEN: 'postmark-test-token', POSTMARK_API_BASE: `http://127.0.0.1:${PORTS.postmark}`,
        EMAIL_FROM_ADDRESS: 'notifications@referwith50.test', BILLING_SUPPORT_EMAIL: 'joseph@referwith50.test',
        FRONTEND_BASE_URL: FRONTEND, TENANT_CREDENTIALS_ENCRYPTION_KEY: 'e2e-only-passphrase',
        STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_API_BASE: '', STRIPE_STAND_IN_URL: '',
        RENEWAL_SCHEDULER: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const onData = (buf) => { for (const l of buf.toString().split('\n').filter(Boolean)) { apiLines.push(l); if (l.includes('listening on')) resolve(); } };
      apiChild.stdout.on('data', onData); apiChild.stderr.on('data', onData);
      apiChild.on('exit', (c) => reject(new Error(`API exited ${c}:\n${apiLines.join('\n')}`)));
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

    process.env.DATABASE_URL = dbUrl(DB);
    const { runRepEarningsCycle } = require('../../src/workers/repEarnings');
    const { withUserTransaction } = require('../../src/db');
    // What this person can actually read from the database itself, RLS and all.
    const asUser = (userId, text, params) => withUserTransaction(userId, async (c) => (await c.query(text, params)).rows);

    // ===========================================================================
    section('Giving a rep their own login');
    const rep = {};
    for (const [name, email] of [['Alice Rep', 'alice@reps.test'], ['Bob Rep', 'bob@reps.test'], ['Carol Rep', 'carol@reps.test']]) {
      const r = await api('POST', '/reps', { as: USERS.admin, body: { name, email } });
      rep[name.split(' ')[0]] = r.body;
    }

    await check('A rep with no email, or one switched off, cannot be invited; the helper cannot invite at all', async () => {
      const noEmail = await api('POST', '/reps', { as: USERS.admin, body: { name: 'No Email Rep' } });
      const a = await api('POST', `/reps/${noEmail.body.id}/invite`, { as: USERS.admin });
      eq(a.status, 400, 'no email');
      assert(/email address/i.test(a.body.error), a.body.error);
      await api('PATCH', `/reps/${rep.Carol.id}`, { as: USERS.admin, body: { active: false } });
      const b = await api('POST', `/reps/${rep.Carol.id}/invite`, { as: USERS.admin });
      eq(b.status, 409, 'switched off');
      await api('PATCH', `/reps/${rep.Carol.id}`, { as: USERS.admin, body: { active: true } });
      const c = await api('POST', `/reps/${rep.Alice.id}/invite`, { as: USERS.helper });
      eq(c.status, 403, 'helper'); eq(c.body.code, 'admin_only', 'helper code');
      return 'no email -> 400; inactive -> 409; helper -> 403 admin_only';
    });

    await check('Inviting Alice creates a login with NO password, emails a one-time link, and never sends a password', async () => {
      const before = auth.links().length;
      const r = await api('POST', `/reps/${rep.Alice.id}/invite`, { as: USERS.admin });
      assert(r.status === 200, `invite: expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
      eq(r.body.resent, false, 'first invite is not a resend');
      eq(r.body.emailed_to, 'alice@reps.test', 'emailed_to');

      const links = auth.links();
      eq(links.length, before + 1, 'one link minted');
      eq(links[links.length - 1].type, 'recovery', 'link type');

      const mail = sent[sent.length - 1];
      eq(mail.To, 'alice@reps.test', 'To');
      assert(mail.From === 'Joseph at 50. <notifications@referwith50.test>', `From: ${mail.From}`);
      eq(mail.ReplyTo, 'joseph@referwith50.test', 'ReplyTo');
      assert(mail.TextBody.includes('/auth/v1/verify?token='), 'the link is in the email');
      assert(!/password is|temporary password|your password:/i.test(mail.TextBody), 'no password in the email');

      // The account exists but cannot be signed in to until a password is set.
      const sign = await fetch(`${AUTH_BASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@reps.test', password: PASSWORD }),
      });
      eq(sign.status, 400, 'cannot sign in before setting a password');

      const [row] = await sql(`select u.role, r.user_id from reps r join users u on u.id = r.user_id where r.id = $1`, [rep.Alice.id]);
      eq(row.role, 'rep', 'the login is a rep on the 50. tenant');
      return `login created, recovery link emailed from "${mail.From}", sign-in refused until a password is set`;
    });

    await check('Inviting the same rep again is a resend, not an error, and does not make a second account', async () => {
      const usersBefore = (await sql(`select count(*)::int n from users where role = 'rep'`))[0].n;
      const r = await api('POST', `/reps/${rep.Alice.id}/invite`, { as: USERS.admin });
      eq(r.status, 200, 'resend'); eq(r.body.resent, true, 'resent');
      const usersAfter = (await sql(`select count(*)::int n from users where role = 'rep'`))[0].n;
      eq(usersAfter, usersBefore, 'no second account');
      assert(/new link/i.test(sent[sent.length - 1].Subject), `subject: ${sent[sent.length - 1].Subject}`);
      return 'second invite resends one fresh link to the same account';
    });

    // Alice and Bob set their passwords, the way the emailed link would.
    auth.setPassword('alice@reps.test', PASSWORD);
    await api('POST', `/reps/${rep.Bob.id}/invite`, { as: USERS.admin });
    auth.setPassword('bob@reps.test', PASSWORD);
    const ALICE = { id: auth.userIdFor('alice@reps.test'), email: 'alice@reps.test' };
    const BOB = { id: auth.userIdFor('bob@reps.test'), email: 'bob@reps.test' };

    await check('Once the password is set the rep can sign in and the page knows who they are', async () => {
      const sign = await fetch(`${AUTH_BASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@reps.test', password: PASSWORD }),
      });
      eq(sign.status, 200, 'sign in');
      const me = await api('GET', '/me', { as: ALICE });
      eq(me.status, 200, 'me'); eq(me.body.role, 'rep', 'role');
      const mine = await api('GET', '/reps', { as: ALICE });
      eq(mine.status, 200, 'reps'); eq(mine.body.reps.length, 1, 'a rep sees exactly one rep: themselves');
      eq(mine.body.reps[0].id, rep.Alice.id, 'and it is them');
      return `Alice signs in, /me says role=rep, /reps returns only her own row`;
    });

    await check('A switched-off rep is locked out with a reason, not an empty page', async () => {
      await api('PATCH', `/reps/${rep.Alice.id}`, { as: USERS.admin, body: { active: false } });
      const r = await api('GET', '/reps', { as: ALICE });
      eq(r.status, 403, 'status'); eq(r.body.code, 'rep_inactive', 'code');
      await api('PATCH', `/reps/${rep.Alice.id}`, { as: USERS.admin, body: { active: true } });
      eq((await api('GET', '/reps', { as: ALICE })).status, 200, 'back on');
      return 'inactive -> 403 rep_inactive; switched back on -> 200';
    });

    // ===========================================================================
    section('A rep sees their own leads and nobody else\'s');
    let aliceLead;
    await check('A rep adds a lead with a website and notes; it is filed under them whatever the form says', async () => {
      const r = await api('POST', '/rep-leads', {
        as: ALICE,
        body: {
          company_name: 'Acme Roofing', contact_name: 'Carl', phone: '717-555-0100', email: 'carl@acme.test',
          website: 'https://acme-roofing.test', notes: 'Met at the county fair. Wants it before spring.',
          // Deliberately claiming it for Bob: it must still be filed under Alice.
          brought_in_by_rep_id: rep.Bob.id,
        },
      });
      eq(r.status, 201, 'create');
      eq(r.body.brought_in_by_rep_id, rep.Alice.id, 'filed under Alice, not Bob');
      eq(r.body.website, 'https://acme-roofing.test', 'website');
      eq(r.body.status, 'open', 'status');
      assert(r.body.notes.includes('county fair'), 'notes');
      aliceLead = r.body;
      return 'website and notes stored; the rep_id in the request body is ignored';
    });

    await check('Bob cannot see, read or edit Alice\'s lead — through the API or the database', async () => {
      const list = await api('GET', '/rep-leads', { as: BOB });
      eq(list.status, 200, 'list'); eq(list.body.leads.length, 0, 'Bob sees no leads');
      const edit = await api('PATCH', `/rep-leads/${aliceLead.id}`, { as: BOB, body: { contact_name: 'Taken' } });
      assert(edit.status === 404 || edit.status === 403, `edit: ${edit.status}`);
      const win = await api('POST', `/rep-leads/${aliceLead.id}/win`, { as: BOB, body: {} });
      assert(win.status === 404 || win.status === 403, `win: ${win.status}`);
      // And straight at the database as Bob, with RLS doing the refusing.
      const rows = await asUser(BOB.id, 'select id from rep_leads');
      eq(rows.length, 0, 'RLS: Bob reads no leads at all');
      const [{ name }] = await sql('select contact_name as name from rep_leads where id = $1', [aliceLead.id]);
      eq(name, 'Carl', 'the lead is untouched');
      return 'API 404/403 and RLS returns zero rows; the lead is unchanged';
    });

    await check('Joseph and the helper see every rep\'s leads', async () => {
      for (const who of [USERS.admin, USERS.helper]) {
        const r = await api('GET', '/rep-leads', { as: who });
        eq(r.status, 200, 'list'); eq(r.body.leads.length, 1, `${who.name} sees the lead`);
        eq(r.body.leads[0].company_name, 'Acme Roofing', 'company');
      }
      return 'admin and helper both see Acme Roofing';
    });

    // ===========================================================================
    section('Two reps, one company');
    await check('Bob is warned off Alice\'s company and told nothing about it — not the contact, not whose it is', async () => {
      const r = await api('POST', '/rep-leads', { as: BOB, body: { company_name: '  acme   roofing ', contact_name: 'Someone' } });
      eq(r.status, 409, 'status');
      eq(r.body.code, 'possible_duplicate', 'code');
      assert(/already being worked/i.test(r.body.error), `message: ${r.body.error}`);
      eq(r.body.can_add_anyway, false, 'Bob may not confirm past it');
      const m = r.body.matches[0];
      eq(m.visible, false, 'not visible to Bob');
      eq(m.mine, false, 'not his');
      assert(m.contact_name === undefined && m.phone === undefined && m.email === undefined, `leaked contact: ${JSON.stringify(m)}`);
      assert(m.brought_in_by_rep_id === undefined, 'leaked whose it is');
      assert(m.status === undefined && m.found_on === undefined, 'leaked status or date');
      return 'name-only match, nothing about the contact, the rep or the dates';
    });

    await check('And "add anyway" does not get Bob past it, even sent straight to the API', async () => {
      const r = await api('POST', '/rep-leads', { as: BOB, body: { company_name: 'Acme Roofing', confirm_duplicate: true } });
      eq(r.status, 409, 'still refused');
      eq((await sql(`select count(*)::int n from rep_leads where lower(company_name) like 'acme%'`))[0].n, 1, 'still one Acme');
      return 'confirm_duplicate is ignored for another rep\'s company';
    });

    await check('Alice CAN add anyway past her own near-duplicate, and sees it in full', async () => {
      const warn = await api('POST', '/rep-leads', { as: ALICE, body: { company_name: 'Acme Roofing', contact_name: 'Carl again' } });
      eq(warn.status, 409, 'warned');
      eq(warn.body.can_add_anyway, true, 'she may confirm');
      const m = warn.body.matches[0];
      eq([m.visible, m.mine, m.contact_name], [true, true, 'Carl'], 'her own match, in full');
      const ok = await api('POST', '/rep-leads', { as: ALICE, body: { company_name: 'Acme Roofing', contact_name: 'Carl again', confirm_duplicate: true } });
      eq(ok.status, 201, 'added anyway');
      await sql('delete from rep_leads where id = $1', [ok.body.id]);
      return 'her own duplicate is shown in full and she may confirm past it';
    });

    await check('A different company with the same phone still warns, and the helper sees the whole row', async () => {
      const r = await api('POST', '/rep-leads', { as: USERS.helper, body: { company_name: 'Totally Different Co', phone: '(717) 555 0100' } });
      eq(r.status, 409, 'warned on the phone number');
      eq(r.body.matches[0].visible, true, 'staff see everything');
      eq(r.body.matches[0].contact_name, 'Carl', 'including the contact');
      return 'same phone digits -> warning; staff see the full match';
    });

    // ===========================================================================
    section('Winning a lead');
    await check('A rep marks their own lead Won; it is credited to them and no dealer is created', async () => {
      const tenantsBefore = (await sql('select count(*)::int n from tenants'))[0].n;
      const r = await api('POST', `/rep-leads/${aliceLead.id}/win`, { as: ALICE, body: {} });
      eq(r.status, 200, 'win');
      eq(r.body.status, 'won', 'status');
      eq(r.body.closed_by_rep_id, rep.Alice.id, 'credited to Alice');
      assert(r.body.closed_on, 'closed_on is set');
      eq(r.body.tenant_id, null, 'no dealer attached yet');
      eq((await sql('select count(*)::int n from tenants'))[0].n, tenantsBefore, 'no tenant created');
      eq((await sql('select count(*)::int n from rep_assignments'))[0].n, 0, 'and nobody assigned to anything');
      return 'won, credited to Alice, nothing built and nothing earned yet';
    });

    await check('A rep cannot attach a dealer, name another closer, or backdate', async () => {
      const lead = (await api('POST', '/rep-leads', { as: ALICE, body: { company_name: 'Second Co' } })).body;
      const a = await api('POST', `/rep-leads/${lead.id}/win`, { as: ALICE, body: { tenant_id: tenants['dealer-a'].id } });
      eq(a.status, 403, 'tenant_id'); eq(a.body.code, 'staff_only', 'code');
      const b = await api('POST', `/rep-leads/${lead.id}/win`, { as: ALICE, body: { effective_from: '2026-01-01T00:00:00Z' } });
      eq(b.status, 403, 'backdate');
      const c = await api('POST', `/rep-leads/${lead.id}/win`, { as: ALICE, body: { closed_by_rep_id: rep.Bob.id } });
      eq(c.status, 200, 'naming Bob is accepted but ignored');
      eq(c.body.closed_by_rep_id, rep.Alice.id, 'still credited to Alice');
      return 'dealer and backdating refused 403 staff_only; a named closer is overridden with the rep themselves';
    });

    await check('A won lead stays won', async () => {
      const again = await api('POST', `/rep-leads/${aliceLead.id}/win`, { as: ALICE, body: {} });
      eq(again.status, 409, 'win twice');
      const patch = await api('PATCH', `/rep-leads/${aliceLead.id}`, { as: ALICE, body: { status: 'lost' } });
      eq(patch.status, 409, 'cannot be marked lost afterwards');
      return 'second win -> 409; flipping it to lost -> 409';
    });

    await check('Staff winning a lead can attach the dealer, which is what puts a rep on it', async () => {
      const lead = (await api('POST', '/rep-leads', { as: USERS.helper, body: { company_name: 'Dealer A Roofing', brought_in_by_rep_id: rep.Bob.id } })).body;
      const r = await api('POST', `/rep-leads/${lead.id}/win`, {
        as: USERS.helper, body: { closed_by_rep_id: rep.Alice.id, tenant_id: tenants['dealer-a'].id },
      });
      eq(r.status, 200, 'win');
      const [a] = await sql('select closer_rep_id, onboarder_rep_id from rep_assignments where tenant_id = $1 and effective_to is null', [tenants['dealer-a'].id]);
      eq([a.closer_rep_id, a.onboarder_rep_id], [rep.Alice.id, null], 'Alice is the closer; no onboarder');
      return 'the helper attached dealer-a and put Alice on it as closer';
    });

    // ===========================================================================
    section('Money: the closer earns everything, the onboarder nothing');
    await check('A cleared activation pays the closer $50 and nobody else, even with an onboarder named', async () => {
      // Put Bob on as onboarder, so there IS an onboarder to not pay.
      await api('PUT', `/rep-dealers/${tenants['dealer-a'].id}/assignment`, {
        as: USERS.admin, body: { closer_rep_id: rep.Alice.id, onboarder_rep_id: rep.Bob.id },
      });
      await sql(
        `insert into billing_events (tenant_id, event_type, amount_cents, status, livemode, stripe_payment_intent_id, created_at)
         values ($1,'activation_charge',50000,'succeeded',true,'pi_act_a',now())`,
        [tenants['dealer-a'].id]
      );
      const out = await runRepEarningsCycle();
      eq(out.activation, 1, 'exactly one activation row');
      const [alice] = await sql('select coalesce(sum(amount_cents),0)::int t from rep_earnings where rep_id = $1', [rep.Alice.id]);
      const [bob] = await sql('select coalesce(sum(amount_cents),0)::int t from rep_earnings where rep_id = $1', [rep.Bob.id]);
      eq([alice.t, bob.t], [5000, 0], 'Alice $50, Bob (onboarder) nothing');
      return 'one row: the closer. The onboarder earns no row at all, not a row worth zero.';
    });

    await check('A cleared referral fee pays the closer $1 and the onboarder nothing; a small card scales the closer down', async () => {
      const fee = async (rewardCents, pi) => {
        const [c] = await sql('insert into customers (tenant_id, name, email) values ($1,$2,$3) returning id', [tenants['dealer-a'].id, `C${pi}`, `${pi}@x.test`]);
        const [l] = await sql(`insert into referral_links (tenant_id, code, kind, customer_id) values ($1,$2,'share',$3) returning id`, [tenants['dealer-a'].id, `pl-${pi}`, c.id]);
        const [r] = await sql(`insert into referrals (tenant_id, referral_link_id, name, email, status) values ($1,$2,$3,$4,'rewarded') returning id`, [tenants['dealer-a'].id, l.id, `F${pi}`, `f${pi}@x.test`]);
        await sql(
          `insert into billing_events (tenant_id, referral_id, event_type, amount_cents, reward_amount_cents, fee_rate_bps, status, livemode, stripe_payment_intent_id, created_at)
           values ($1,$2,'referral_fee',$3,$4,3000,'succeeded',true,$5,now())`,
          [tenants['dealer-a'].id, r.id, Math.round(rewardCents * 2 * 0.3), rewardCents, pi]
        );
      };
      await fee(5000, 'pi_f50');
      await fee(2500, 'pi_f25');
      await fee(1000, 'pi_f10');
      const out = await runRepEarningsCycle();
      eq(out.referral, 3, 'three rows — one per fee, for the closer only');
      const rows = await sql(`select amount_cents from rep_earnings where rep_id = $1 and kind = 'referral' order by amount_cents desc`, [rep.Alice.id]);
      eq(rows.map((r) => r.amount_cents), [100, 50, 20], '$50 card -> $1, $25 -> 50c, $10 -> 20c');
      const [bob] = await sql(`select coalesce(sum(amount_cents),0)::int t from rep_earnings where rep_id = $1`, [rep.Bob.id]);
      eq(bob.t, 0, 'the onboarder still earns nothing');
      return 'closer 100 / 50 / 20 cents by card size; onboarder 0';
    });

    await check('Turning the onboarder\'s rates back on pays them — including on charges that already cleared', async () => {
      // Worth being explicit about, because it is the one surprising thing
      // here: a rate is not stamped onto history. Each (charge, rep, role) can
      // only ever earn once, and the onboarder side has never earned, so
      // raising its rate above 0 pays it on every charge still unpaid — the
      // ones that cleared last week included. What is ALREADY earned never
      // changes; what was never earned becomes earnable.
      const aliceBefore = (await sql('select coalesce(sum(amount_cents),0)::int t from rep_earnings where rep_id = $1', [rep.Alice.id]))[0].t;
      await api('PUT', '/rep-settings', { as: USERS.admin, body: { onboarder_activation_cents: 2500, onboarder_referral_cents: 50 } });
      await sql(
        `insert into billing_events (tenant_id, event_type, amount_cents, status, livemode, stripe_payment_intent_id, created_at)
         values ($1,'activation_charge',50000,'succeeded',true,'pi_act_b',now())`,
        [tenants['dealer-b'].id]
      );
      await api('PUT', `/rep-dealers/${tenants['dealer-b'].id}/assignment`, {
        as: USERS.admin, body: { closer_rep_id: rep.Alice.id, onboarder_rep_id: rep.Bob.id, effective_from: '2026-08-01T00:00:00Z' },
      });
      const out = await runRepEarningsCycle();
      eq(out.activation, 3, 'dealer-a onboarder (back-paid) plus both sides of dealer-b');
      eq(out.referral, 3, 'and the onboarder side of the three dealer-a fees');

      const [bob] = await sql('select coalesce(sum(amount_cents),0)::int t from rep_earnings where rep_id = $1', [rep.Bob.id]);
      // $25 on each activation, then 50c scaled by card: 50 + 25 + 10.
      eq(bob.t, 2500 + 2500 + 50 + 25 + 10, 'Bob earns the onboarder rate on every charge that had not paid it');

      const [aliceAct] = await sql(
        `select coalesce(sum(amount_cents),0)::int t from rep_earnings
         where rep_id = $1 and source_billing_event_id in (select id from billing_events where stripe_payment_intent_id in ('pi_act_a','pi_f50','pi_f25','pi_f10'))`,
        [rep.Alice.id]
      );
      eq(aliceAct.t, 5000 + 100 + 50 + 20, 'what Alice already earned is untouched by the rate change');
      assert(aliceBefore === 5000 + 100 + 50 + 20, `sanity: ${aliceBefore}`);

      // Back to closer-only for the checks that follow.
      await api('PUT', '/rep-settings', { as: USERS.admin, body: { onboarder_activation_cents: 0, onboarder_referral_cents: 0 } });
      return 'raising a 0 rate pays that role on every charge it had not yet earned on; rows already earned never change';
    });

    // ===========================================================================
    section('A rep sees their own money and no one else\'s');
    await check('A rep\'s own figures come back on their own row, and only theirs', async () => {
      const r = await api('GET', '/reps', { as: ALICE });
      eq(r.status, 200, 'status');
      eq(r.body.reps.length, 1, 'one row');
      const me = r.body.reps[0];
      eq(me.id, rep.Alice.id, 'it is her');
      eq(me.owed_cents, 5000 + 100 + 50 + 20 + 5000, 'what she is owed: dealer-a $50 + three royalties + dealer-b $50');
      assert(typeof me.earned_this_month_cents === 'number', 'earned this month');
      return `Alice is owed ${me.owed_cents} cents and sees no other rep`;
    });

    await check('A rep can open their own statement and nobody else\'s', async () => {
      const mine = await api('GET', `/reps/${rep.Alice.id}/statement`, { as: ALICE });
      eq(mine.status, 200, 'own statement');
      assert(mine.body.lines.length > 0, 'it has lines');
      const theirs = await api('GET', `/reps/${rep.Bob.id}/statement`, { as: ALICE });
      eq(theirs.status, 403, 'another rep\'s statement');
      eq(theirs.body.code, 'own_statement_only', 'code');
      // And at the database: Alice can read no earning row that is not hers.
      const rows = await asUser(ALICE.id, 'select rep_id from rep_earnings');
      assert(rows.length > 0 && rows.every((x) => x.rep_id === rep.Alice.id), `RLS leaked: ${JSON.stringify(rows.map((x) => x.rep_id))}`);
      return 'own statement 200, another rep\'s 403, and RLS returns only her own earnings';
    });

    await check('A rep cannot reach the overview, the pay rates, payouts, reversals, or another rep\'s dealer', async () => {
      for (const [m, p, b] of [
        ['GET', '/rep-money/overview'],
        ['GET', '/rep-settings'],
        ['PUT', '/rep-settings', { activation_cents: 1 }],
        ['POST', `/reps/${rep.Alice.id}/payouts`, { amount_cents: 100, paid_on: '2026-10-01' }],
        ['POST', `/reps/${rep.Alice.id}/invite`, {}],
        ['PUT', `/rep-dealers/${tenants['dealer-a'].id}/assignment`, { closer_rep_id: null, onboarder_rep_id: null }],
        ['POST', '/reps', { name: 'Sneaky Rep' }],
      ]) {
        const r = await api(m, p, { as: ALICE, body: b });
        eq(r.status, 403, `${m} ${p}`);
      }
      // Nor write herself a payout straight at the database.
      let refused = false;
      try {
        await asUser(ALICE.id, `insert into rep_payouts (rep_id, amount_cents, paid_on) values ($1, 100000, current_date)`, [rep.Alice.id]);
      } catch (e) { refused = true; }
      assert(refused, 'RLS let a rep pay themselves');
      eq((await sql('select count(*)::int n from rep_payouts'))[0].n, 0, 'no payouts exist');
      return 'every money and admin route 403; RLS refuses a self-payout outright';
    });

    await check('A rep sees the dealers they are on — as closer OR as onboarder — and no others', async () => {
      // Bob is the onboarder on dealer-a (from the money checks above); now
      // make him the closer on dealer-b and take Alice off it, so each rep is
      // on dealer-a and dealer-b through a different role.
      await api('PUT', `/rep-dealers/${tenants['dealer-b'].id}/assignment`, {
        as: USERS.admin, body: { closer_rep_id: rep.Bob.id, onboarder_rep_id: null },
      });
      const hers = await api('GET', '/rep-dealers', { as: ALICE });
      eq(hers.status, 200, 'status');
      eq(hers.body.dealers.map((d) => d.name), ['Dealer A Roofing'], 'Alice: closer on dealer-a, and off dealer-b now');
      const his = await api('GET', '/rep-dealers', { as: BOB });
      eq(his.body.dealers.map((d) => d.name).sort(), ['Dealer A Roofing', 'Dealer B Fencing'], 'Bob: onboarder on one, closer on the other');
      const all = await api('GET', '/rep-dealers', { as: USERS.admin });
      eq(all.body.dealers.length, 2, 'the admin sees both');
      // Carol is on nothing at all, so she sees nothing.
      await api('POST', `/reps/${rep.Carol.id}/invite`, { as: USERS.admin });
      auth.setPassword('carol@reps.test', PASSWORD);
      const carol = { id: auth.userIdFor('carol@reps.test'), email: 'carol@reps.test' };
      const none = await api('GET', '/rep-dealers', { as: carol });
      eq(none.status, 200, 'Carol'); eq(none.body.dealers.length, 0, 'a rep on no dealers sees an empty list, not an error');
      return 'Alice: dealer-a. Bob: both (one as onboarder). Carol: none. Admin: both.';
    });

    // ===========================================================================
    section('Everyone else is still shut out');
    await check('A dealer\'s own admin gets 403 on every rep route, reps included', async () => {
      for (const [m, p] of [['GET', '/reps'], ['GET', '/rep-leads'], ['GET', '/rep-dealers'], ['GET', '/rep-money/overview'], ['GET', '/rep-settings']]) {
        const r = await api(m, p, { as: USERS.dealer });
        eq(r.status, 403, `${m} ${p}`);
      }
      const rows = await asUser(USERS.dealer.id, 'select id from rep_leads');
      eq(rows.length, 0, 'RLS: a dealer reads no leads');
      return 'dealer admin: 403 everywhere, zero rows from the database';
    });

    await check('The helper still runs the pipeline and still sees no dollar amount', async () => {
      const reps = await api('GET', '/reps', { as: USERS.helper });
      eq(reps.status, 200, 'reps');
      assert(reps.body.reps.length >= 3, 'sees every rep');
      const text = JSON.stringify(reps.body);
      assert(!/owed_cents|earned_this_month_cents/.test(text), `money leaked to the helper: ${text.slice(0, 200)}`);
      eq((await api('GET', '/rep-leads', { as: USERS.helper })).status, 200, 'leads');
      eq((await api('GET', '/rep-money/overview', { as: USERS.helper })).status, 403, 'overview');
      const rows = await asUser(USERS.helper.id, 'select amount_cents from rep_earnings');
      eq(rows.length, 0, 'RLS: the helper reads no earnings');
      return 'helper: reps and leads yes, no money field anywhere, no earnings rows at all';
    });

    await check('Without the Supabase key the platform says so plainly instead of half-making a login', async () => {
      const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      const admin = require('../../src/lib/supabaseAdmin');
      eq(admin.isConfigured(), false, 'isConfigured');
      let message = '';
      try { await admin.createPasswordlessUser('x@y.test'); } catch (e) { message = e.message; }
      assert(/SUPABASE_SERVICE_ROLE_KEY is not set/.test(message), `message: ${message}`);
      assert(/service_role/.test(message), 'the message says where to get it');
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
      return 'a missing key fails loudly, naming the setting and where it comes from';
    });
  } catch (err) {
    // The API runs as a child: if it died, its own output is the only thing
    // that says why, so never swallow it behind a bare connection refusal.
    console.error(`\nThe suite stopped: ${err.message}`);
    if (apiLines.length) console.error(`\n--- API output ---\n${apiLines.slice(-40).join('\n')}`);
    results.push({ section: currentSection, title: `suite stopped: ${err.message}`, pass: false });
  } finally {
    if (apiChild) apiChild.kill();
    authServer.close(); stubServer.close();
    await db.end().catch(() => {});
    try { await require('../../src/db').pool.end(); } catch (e) { /* already closed */ }
    const a = new Client({ connectionString: PG_ADMIN_URL });
    await a.connect(); await a.query(`drop database if exists ${DB} with (force)`); await a.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
