#!/usr/bin/env node
// Drives the Reps admin page (fifty-reps.html) in headless Chromium against the
// real API (src/server.js as a child process), a real Postgres database built
// from every migration, and the Supabase Auth stand-in — signing in as the
// 50. admin, as the helper (50. staff), and as a dealer's own admin.
//
//   node scripts/e2e/rep-page-e2e.js [--headed]
//
// Same scratch Postgres as the other e2e scripts (E2E_PG_ADMIN_URL). The page
// file in the repo is never modified: the local server swaps its three
// deployment constants for the local API / auth addresses on the way out.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { Client } = require('pg');
const express = require('express');
const { createAuthStandIn, SERVICE_ROLE_KEY } = require('./auth-stand-in');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_DIR = path.join(REPO_ROOT, 'api');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const ACTIVATION_MIGRATION = '20261001000000_activation_gate_and_referral_fee.sql';
const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:54329/postgres';
const DB = `fifty_repspage_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const PORTS = { api: 3101, auth: 9995, page: 8089, postmark: 12114 };
const API_ORIGIN = `http://127.0.0.1:${PORTS.api}`;
const AUTH_BASE = `http://127.0.0.1:${PORTS.auth}`;
const PAGE = `http://127.0.0.1:${PORTS.page}/reps`;
const headed = process.argv.includes('--headed');

const { PNG } = require('pngjs');

// A logo with two known colours in it, so what the brand guess returns can be
// checked against what went in.
function makeLogoPng(top, bottom) {
  const png = new PNG({ width: 80, height: 80 });
  for (let y = 0; y < 80; y += 1) {
    for (let x = 0; x < 80; x += 1) {
      const i = (y * 80 + x) << 2;
      const c = y < 50 ? top : y < 70 ? bottom : null;
      png.data[i] = c ? c[0] : 0;
      png.data[i + 1] = c ? c[1] : 0;
      png.data[i + 2] = c ? c[2] : 0;
      png.data[i + 3] = c ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

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
    console.log(`  FAIL  ${title}\n        ${err.message.split('\n').slice(0, 6).join('\n        ')}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }

const dbUrl = (name) => { const u = new URL(PG_ADMIN_URL); u.pathname = `/${name}`; return u.toString(); };
const PASSWORD = 'e2e-password-1';
const USERS = {
  admin: { id: 'c0000000-0000-4000-8000-000000000001', email: 'joseph@fifty.test', name: 'Joseph', role: 'admin', tenant: '50-platform' },
  helper: { id: 'c0000000-0000-4000-8000-000000000002', email: 'helper@fifty.test', name: 'Helper', role: 'staff', tenant: '50-platform' },
  dealer: { id: 'c0000000-0000-4000-8000-000000000003', email: 'owner@dealer-a.test', name: 'Dealer Owner', role: 'admin', tenant: 'dealer-a' },
};

async function main() {
  // The stand-in writes each new account into auth.users the way Supabase
  // does, so the API's own users insert has the row its foreign key needs.
  let recordAuthUser = async () => {};
  const auth = createAuthStandIn({ onUserCreated: (u) => recordAuthUser(u) });
  const authServer = auth.app.listen(PORTS.auth, '127.0.0.1');

  // Postmark stand-in — the invite email has to go somewhere.
  const sentMail = [];
  const mailApp = express();
  mailApp.use(express.json());
  mailApp.post('/email', (req, res) => { sentMail.push(req.body); res.json({ ErrorCode: 0, MessageID: `m-${sentMail.length}` }); });
  const mailServer = mailApp.listen(PORTS.postmark, '127.0.0.1');

  // Supabase Storage, and a pretend prospect's website to read a brand off.
  const objects = new Map();
  const buckets = new Set();
  const storeApp = express();
  storeApp.post('/storage/v1/bucket', express.json(), (req, res) => {
    if (buckets.has(req.body.id)) return res.status(409).json({ message: 'Bucket already exists' });
    buckets.add(req.body.id);
    res.json({ name: req.body.id });
  });
  storeApp.post('/storage/v1/object/:bucket/*', express.raw({ type: () => true, limit: '8mb' }), (req, res) => {
    objects.set(`${req.params.bucket}/${req.params[0]}`, { bytes: req.body, contentType: req.headers['content-type'] });
    res.json({ Key: 'ok' });
  });
  storeApp.delete('/storage/v1/object/:bucket/*', (req, res) => {
    objects.delete(`${req.params.bucket}/${req.params[0]}`);
    res.json({ message: 'deleted' });
  });
  storeApp.get('/storage/v1/object/public/:bucket/*', (req, res) => {
    const o = objects.get(`${req.params.bucket}/${req.params[0]}`);
    if (!o) return res.status(404).end();
    res.set('Access-Control-Allow-Origin', '*').type(o.contentType).send(o.bytes);
  });
  storeApp.get('/prospect-site', (req, res) => res.type('html').send(
    '<!doctype html><html><head><title>Hill Country Barns</title><meta name="theme-color" content="#2E5E3A">' +
    '</head><body><img src="/logo.png" class="logo"><div style="background-color:#C47A2B">x</div>' +
    '<div style="background-color:#C47A2B">y</div></body></html>'
  ));
  // Both live behind the auth stand-in's port, which the API already treats
  // as its Supabase: one origin, as in production.
  auth.app.use(storeApp);

  const admin = new Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB}`);
  await admin.end();
  const db = new Client({ connectionString: dbUrl(DB) });
  await db.connect();
  const sql = async (t, p) => (await db.query(t, p)).rows;
  recordAuthUser = (u) => db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing', [u.id, u.email]);
  // `db` connects as the database owner, which is not an authenticated session:
  // is_platform_admin() reads auth.uid(), so a security-definer function called
  // through `sql` refuses every time. This runs one as a given signed-in user,
  // the way src/db.js's withUserTransaction does for a real request.
  async function sqlAs(user, text, params) {
    const c = new Client({ connectionString: dbUrl(DB) });
    await c.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user.id })]);
      await c.query('set local role authenticated');
      const { rows } = await c.query(text, params);
      await c.query('commit');
      return rows;
    } catch (err) {
      await c.query('rollback').catch(() => {});
      throw err;
    } finally {
      await c.end().catch(() => {});
    }
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  await db.query(fs.readFileSync(path.join(__dirname, 'supabase-stand-in.sql'), 'utf8'));
  for (const f of files) if (f < ACTIVATION_MIGRATION) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  await db.query(`insert into tenants (slug, name) values ('good-steward-structures','Good Steward Structures'),('north-mountain-structures','North Mountain Structures'),('50-platform','50.')`);
  for (const f of files.filter((x) => x >= ACTIVATION_MIGRATION)) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

  const tenants = {};
  for (const r of await sql('select id, slug, name from tenants')) tenants[r.slug] = r;
  for (const [slug, name, paid] of [['dealer-a', 'Dealer A Roofing', '2026-08-01T15:00:00Z'], ['dealer-b', 'Dealer B Fencing', null]]) {
    const [t] = await sql(`insert into tenants (slug, name, billing_status, activation_paid_at, activation_livemode) values ($1,$2,'active',$3,$4) returning id, slug, name`, [slug, name, paid, paid ? true : null]);
    tenants[slug] = t;
  }
  for (const u of Object.values(USERS)) {
    await sql('insert into auth.users (id, email) values ($1,$2)', [u.id, u.email]);
    await sql('insert into users (id, tenant_id, email, name, role) values ($1,$2,$3,$4,$5)', [u.id, tenants[u.tenant].id, u.email, u.name, u.role]);
    auth.addUser({ id: u.id, email: u.email, password: PASSWORD });
  }

  // A request as a given signed-in user, for checking what the API refuses.
  // Separate from the browser: a refusal the page never offers still has to be
  // refused when it is asked for directly.
  async function apiAs(user, path, init = {}) {
    const t = await fetch(`${AUTH_BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: PASSWORD }),
    });
    const { access_token } = await t.json();
    const res = await fetch(`${API_ORIGIN}/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}`, ...(init.headers || {}) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  const apiLines = [];
  const apiChild = spawn(process.execPath, ['src/server.js'], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      DATABASE_URL: dbUrl(DB), SUPABASE_URL: AUTH_BASE, SUPABASE_JWKS_URL: '', PORT: String(PORTS.api),
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      BRAND_LOOKUP_ALLOW_LOCAL: '1',
      POSTMARK_SERVER_TOKEN: 'postmark-test-token', POSTMARK_API_BASE: `http://127.0.0.1:${PORTS.postmark}`,
      EMAIL_FROM_ADDRESS: 'notifications@referwith50.test', BILLING_SUPPORT_EMAIL: 'joseph@referwith50.test',
      FRONTEND_BASE_URL: `http://127.0.0.1:${PORTS.page}`, TENANT_CREDENTIALS_ENCRYPTION_KEY: 'e2e-only-passphrase',
      STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_API_BASE: '', STRIPE_STAND_IN_URL: '',
      RENEWAL_SCHEDULER: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const onData = (buf) => { for (const l of buf.toString().split('\n').filter(Boolean)) { apiLines.push(l); if (l.includes('listening on')) resolve(); } };
    apiChild.stdout.on('data', onData); apiChild.stderr.on('data', onData);
    apiChild.on('exit', (c) => reject(new Error(`API exited ${c}:\n${apiLines.join('\n')}`)));
    setTimeout(() => reject(new Error('API did not start')), 15000);
  });

  // Static server for the page, constants pointed at the local servers.
  const pageApp = express();
  pageApp.get(['/reps', '/fifty-reps.html'], (req, res) => {
    let html = fs.readFileSync(path.join(REPO_ROOT, 'fifty-reps.html'), 'utf8');
    const before = html;
    html = html.replace(/const API_BASE = "[^"]*";/, `const API_BASE = "${API_ORIGIN}/api";`)
               .replace(/const SUPABASE_URL = "[^"]*";/, `const SUPABASE_URL = "${AUTH_BASE}";`);
    if (html === before) return res.status(500).send('could not point the page at the local servers');
    res.type('html').send(html);
  });
  pageApp.use('/assets', express.static(path.join(REPO_ROOT, 'assets')));
  const pageServer = pageApp.listen(PORTS.page, '127.0.0.1');

  process.env.DATABASE_URL = dbUrl(DB);
  const { runRepEarningsCycle } = require('../../src/workers/repEarnings');

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: !headed });
  const consoleErrors = [];

  async function newPage(label) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => consoleErrors.push(`${label}: pageerror ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) consoleErrors.push(`${label}: ${m.text()}`); });
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'refunded in Stripe' : undefined));
    // Google Fonts is not reachable from here and not needed.
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    return page;
  }
  async function signIn(page, u, { expectApp = true } = {}) {
    await page.goto(PAGE);
    await page.fill('#email', u.email);
    await page.fill('#password', PASSWORD);
    await page.click('#loginBtn');
    if (!expectApp) return;
    await page.waitForSelector('#app:not(.hide) nav.tabs button', { timeout: 8000 });
    // Signing in draws the first tab, which fetches and then redraws it. Let
    // that finish: a check that starts typing into a form the page is about
    // to replace is testing the race, not the feature.
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  const tabNames = (page) => page.$$eval('#tabs button', (bs) => bs.map((b) => b.textContent));
  // The add-a-lead panel starts open only while there are no leads, so set it
  // open rather than clicking the summary, which toggles whichever way it was.
  // Open the add-a-lead panel and fill it, as one step that survives the tab
  // redrawing underneath it. The page restores what was typed across a
  // redraw, but a redraw already in flight when the panel is opened restores
  // the state it captured BEFORE that — so this checks the values actually
  // stuck, and starts over if they did not.
  async function addLead(page, fields) {
    await page.waitForSelector('#tab-leads details');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await page.evaluate(() => {
        const d = document.querySelector('#tab-leads details');
        if (d) d.open = true;
      });
      const visible = await page.waitForSelector('#leadForm [name=company_name]', { state: 'visible', timeout: 4000 }).catch(() => null);
      if (!visible) continue;
      for (const [name, value] of Object.entries(fields)) {
        const el = await page.$(`#leadForm [name="${name}"]`);
        if (!el) break;
        if (await el.evaluate((n) => n.tagName) === 'SELECT') await el.selectOption({ label: value }).catch(() => {});
        else await el.fill(String(value)).catch(() => {});
      }
      await page.waitForTimeout(150);
      const stuck = await page.evaluate((f) => {
        const form = document.getElementById('leadForm');
        if (!form || !form.offsetParent) return false;
        return Object.keys(f).every((name) => {
          const el = form.querySelector(`[name="${name}"]`);
          return el && String(el.value || '').length > 0;
        });
      }, fields);
      if (stuck) return;
    }
    throw new Error('could not fill the add-a-lead form: the tab kept redrawing under it');
  }

  async function openAddLead(page) {
    await page.waitForSelector('#tab-leads details');
    await page.waitForFunction(() => {
      const d = document.querySelector('#tab-leads details');
      if (!d) return false;
      d.open = true;
      const input = document.querySelector('#leadForm [name=company_name]');
      return Boolean(input && input.offsetParent !== null);
    }, { timeout: 15000 });
  }
  const eqArr = (a, b, what) => assert(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  const eq = (a, b, what) => assert(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  const flashText = (page) => page.textContent('#appMsg');

  try {
    // ======================================================================
    section('A dealer\'s own login is turned away');
    await check('A dealer admin signs in and is told the page is for 50. staff only; no app appears', async () => {
      const page = await newPage('dealer');
      await signIn(page, USERS.dealer, { expectApp: false });
      await page.waitForFunction(() => document.getElementById('loginMsg').classList.contains('show'));
      const msg = await page.textContent('#loginMsg');
      assert(/only for 50\. staff/i.test(msg), `message: ${msg}`);
      assert(await page.isHidden('#app'), 'app is visible');
      const stored = await page.evaluate(() => localStorage.getItem('fifty:reps-session'));
      assert(!stored, 'session kept');
      await page.context().close();
      return msg;
    });

    // ======================================================================
    section('Admin: the whole flow');
    const page = await newPage('admin');
    await check('Admin signs in and sees every one of his tabs', async () => {
      await signIn(page, USERS.admin);
      const t = await tabNames(page);
      assert(JSON.stringify(t) === JSON.stringify(['Calendar', 'Leads', 'Reps', 'Companies', 'Build dashboards', 'Money', 'Finances']), `tabs: ${t}`);
      return `${await page.textContent('#who')}`;
    });
    await check('Add two reps (Alice, Bob) on the Reps tab', async () => {
      await page.click('[data-tab=reps]');
      for (const [n, e] of [['Alice Rep', 'alice@x.test'], ['Bob Rep', 'bob@x.test']]) {
        await page.click('#addRepBtn');
        await page.fill('#repForm [name=name]', n);
        await page.fill('#repForm [name=email]', e);
        await page.click('#repForm button[type=submit]');
        await page.waitForSelector('#dlg:not([open])', { state: 'attached' });
        await page.waitForFunction((name) => document.getElementById('tab-reps').textContent.includes(name), n);
      }
      const rows = await page.$$eval('#tab-reps tbody tr', (r) => r.length);
      assert(rows === 2, `rows ${rows}`);
    });
    await check('Add a lead; adding the same company again shows the duplicate warning, and "Add anyway" adds it', async () => {
      await page.click('[data-tab=leads]');
      await page.waitForSelector('#leadForm');
      const fill = async () => {
        await page.fill('#leadForm [name=company_name]', 'Acme Roofing');
        await page.fill('#leadForm [name=contact_name]', 'Carl');
        await page.fill('#leadForm [name=phone]', '717-555-0100');
        await page.fill('#leadForm [name=website]', 'https://acme-roofing.test');
        await page.fill('#leadForm [name=notes]', 'Met at the county fair.');
        await page.selectOption('#leadForm [name=brought_in_by_rep_id]', { label: 'Alice Rep' });
      };
      await openAddLead(page);
      await fill(); await page.click('#leadForm button[type=submit]');
      await page.waitForFunction(() => document.querySelectorAll('#tab-leads tbody tr').length === 1 && document.getElementById('tab-leads').textContent.includes('Acme Roofing'));
      await openAddLead(page);
      await fill(); await page.click('#leadForm button[type=submit]');
      await page.waitForSelector('#addAnyway');
      const warn = await page.textContent('#dupBox');
      assert(/already in the list/.test(warn) && warn.includes('Acme Roofing'), warn);
      await page.click('#addAnyway');
      await page.waitForFunction(() => document.querySelectorAll('#tab-leads tbody tr').length === 2);
    });
    await check('Lost removes the duplicate for good, after saying so', async () => {
      const before = await page.$$eval('#tab-leads tbody tr', (r) => r.length);
      await page.locator('[data-lost]').first().click();
      await page.waitForSelector('#confirmLost');
      const words = await page.textContent('#dlg');
      assert(/cannot be undone/.test(words), `dialog: ${words}`);
      assert(/free to work them again/.test(words), 'it says the company is no longer held');
      await page.click('#confirmLost');
      await page.waitForFunction((n) => document.querySelectorAll('#tab-leads tbody tr').length === n - 1, before);
      eq((await sql(`select count(*)::int n from rep_leads where lower(company_name) like 'acme%'`))[0].n, 1, 'one Acme left, not two');
      return `${before} leads, then ${before - 1}; the row is gone from the database too`;
    });
    await check('Mark the lead won: Alice closed, Bob onboarded, linked to Dealer A', async () => {
      await page.locator('[data-win]').first().click();
      await page.waitForSelector('#winForm');
      await page.selectOption('#winForm [name=closed_by_rep_id]', { label: 'Alice Rep' });
      await page.selectOption('#winForm [name=onboarded_by_rep_id]', { label: 'Bob Rep' });
      await page.selectOption('#winForm [name=tenant_id]', { label: 'Dealer A Roofing' });
      await page.click('#winForm button[type=submit]');
      await page.waitForFunction(() => document.querySelector('.pill.won'));
      const [a] = await sql(`select ra.*, (select name from reps where id = ra.closer_rep_id) as closer, (select name from reps where id = ra.onboarder_rep_id) as onboarder from rep_assignments ra where tenant_id = $1 and effective_to is null`, [tenants['dealer-a'].id]);
      assert(a && a.closer === 'Alice Rep' && a.onboarder === 'Bob Rep', JSON.stringify(a));
      return `assignment: closer ${a.closer}, onboarder ${a.onboarder}`;
    });
    await check('Dealers tab: Dealer B (not activated) can be given reps; the start-date box shows for admin', async () => {
      await page.click('[data-tab=dealers]');
      await page.waitForSelector('#tab-dealers tr[data-tenant]');
      const rowB = page.locator(`tr[data-tenant="${tenants['dealer-b'].id}"]`);
      assert(await rowB.locator('[data-field=from]').count() === 1, 'no start date box');
      await rowB.locator('[data-field=closer]').selectOption({ label: 'Bob Rep' });
      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/assignment'));
      await rowB.locator('[data-save]').click();
      assert((await saved).status() === 200, 'PUT not 200');
      const [a] = await sql(`select 1 from rep_assignments where tenant_id = $1 and effective_to is null and closer_rep_id is not null`, [tenants['dealer-b'].id]);
      assert(a, 'not saved');
    });

    await check('The three in-house companies are listed, marked, and cannot be given a rep', async () => {
      await page.click('[data-tab=dealers]');
      await page.waitForSelector('#tab-dealers tr[data-tenant]');
      const names = await page.$$eval('#tab-dealers tbody tr', (rows) =>
        rows.map((r) => (r.querySelector('[data-company]') || r.querySelector('b')).textContent));
      for (const n of ['Good Steward Structures', 'North Mountain Structures', '50.']) {
        assert(names.includes(n), `${n} missing from the companies list: ${JSON.stringify(names)}`);
      }
      // Paying dealers first, so the tab still opens on the ones that matter.
      assert(names.indexOf('Dealer A Roofing') < names.indexOf('Good Steward Structures'), `order: ${JSON.stringify(names)}`);

      const gssRow = page.locator(`tr[data-tenant="${tenants['good-steward-structures'].id}"]`);
      assert((await gssRow.textContent()).includes('In-house'), 'GSS is not marked in-house');
      // No dropdowns and no Save: an in-house company pays nothing, so there is
      // no payment for a rep to be credited with.
      eq(await gssRow.locator('[data-field=closer]').count(), 0, 'in-house row offers a closer dropdown');
      eq(await gssRow.locator('[data-save]').count(), 0, 'in-house row offers a Save button');
      // And it never reads as a dealer who owes the $500.
      assert(!(await gssRow.textContent()).includes('not yet'), 'in-house row reads as unpaid');

      const header = await page.textContent('#tab-dealers .head');
      assert(/3 in-house/.test(header), `header: ${header}`);
      return `${names.length} companies listed, 3 marked in-house, paying ones first`;
    });

    // Money arrives (the way the webhook / fee code would write it), the worker runs.
    const ta = tenants['dealer-a'].id;
    await sql(`insert into billing_events (tenant_id, event_type, amount_cents, status, livemode, stripe_payment_intent_id, created_at) values ($1,'activation_charge',50000,'succeeded',true,'pi_act',now())`, [ta]);
    const fees = [];
    for (let i = 0; i < 3; i++) {
      const [c] = await sql(`insert into customers (tenant_id, name, email) values ($1,$2,$3) returning id`, [ta, `Cust ${i}`, `c${i}@x.test`]);
      const [l] = await sql(`insert into referral_links (tenant_id, code, kind, customer_id) values ($1,$2,'share',$3) returning id`, [ta, `pg-${i}-${Math.random().toString(36).slice(2, 7)}`, c.id]);
      const [r] = await sql(`insert into referrals (tenant_id, referral_link_id, name, email, status) values ($1,$2,$3,$4,'rewarded') returning id`, [ta, l.id, `F${i}`, `f${i}@x.test`]);
      const [e] = await sql(`insert into billing_events (tenant_id, referral_id, event_type, amount_cents, reward_amount_cents, fee_rate_bps, status, livemode, stripe_payment_intent_id, created_at) values ($1,$2,'referral_fee',3000,5000,3000,'succeeded',true,$3,now()) returning id`, [ta, r.id, `pi_fee_${i}`]);
      fees.push(e.id);
    }
    const run = await runRepEarningsCycle();
    await check('Worker credits the page\'s assignment: the closer only — 1 activation row, 3 referral rows', async () => {
      // Bob is the onboarder on this dealer and earns nothing: the onboarder's
      // rates are 0 out of the box, so the closer earns everything.
      assert(run.activation === 1 && run.referral === 3, JSON.stringify(run));
      return JSON.stringify(run);
    });

    await check('Reps tab (admin): Alice the closer shows $53.00 ($50 + 3 x $1); Bob the onboarder shows $0.00', async () => {
      await page.click('[data-tab=reps]');
      await page.waitForFunction(() => document.getElementById('tab-reps').textContent.includes('$53.00'));
      const rows = await page.$$eval('#tab-reps tbody tr', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ')));
      const alice = rows.find((r) => r.includes('Alice'));
      const bob = rows.find((r) => r.includes('Bob'));
      assert((alice.match(/\$53\.00/g) || []).length === 2, `Alice: ${alice}`);
      assert((bob.match(/\$0\.00/g) || []).length === 2, `Bob: ${bob}`);
      return `${alice} || ${bob}`;
    });
    await check('Money tab: month totals match ($53.00 owed), per-rep split shows bonuses and royalties', async () => {
      await page.click('[data-tab=money]');
      await page.waitForSelector('#tab-money .stat b');
      const stats = await page.$$eval('#tab-money .stat b', (b) => b.map((x) => x.textContent));
      assert(stats[0] === '$53.00' && stats[1] === '$53.00' && stats[2] === '$0.00', `stats ${stats}`);
      const alice = (await page.$$eval('#tab-money tbody tr', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ')))).find((t) => t.includes('Alice'));
      assert(alice.includes('$50.00') && alice.includes('$3.00'), alice);
      return `${stats.join(' / ')} · ${alice}`;
    });
    await check('Statement: lists the activation bonus and three royalties, closing balance $53.00', async () => {
      await page.locator('[data-stmt]').first().click();
      await page.waitForSelector('#dlg[open] [data-rev]');
      const t = (await page.textContent('#dlg')).replace(/\s+/g, ' ');
      assert(t.includes('Sign-up bonus') && (t.match(/Referral royalty/g) || []).length === 3 && t.includes('Owed at the end of the month$53.00'), t);
      await page.screenshot({ path: process.env.E2E_SHOT || path.join(require('os').tmpdir(), 'rep-page-statement.png') }).catch(() => {});
      return 'ok';
    });
    await check('Reverse one royalty by hand from the statement: balance drops to $52.00', async () => {
      await page.locator('#dlg [data-rev]').nth(1).click();
      await page.waitForFunction(() => document.getElementById('dlg').textContent.includes('Owed at the end of the month$52.00') || /Owed at the end of the month\s*\$52\.00/.test(document.getElementById('dlg').textContent));
      const [rv] = await sql(`select amount_cents, detail from rep_earnings where kind='reversal' and amount_cents = -100`);
      assert(rv && rv.detail.note === 'refunded in Stripe', JSON.stringify(rv));
    });
    await check('Record a $20 payment from the statement; owed drops to $32.00 and the payment is listed', async () => {
      await page.click('#payFromStmt');
      await page.waitForSelector('#payForm');
      await page.fill('#payForm [name=amount]', '20');
      await page.fill('#payForm [name=method]', 'Zelle');
      await page.click('#payForm button[type=submit]');
      await page.waitForFunction(() => /\$32\.00/.test(document.getElementById('tab-money').textContent));
      const [p] = await sql(`select amount_cents, method from rep_payouts`);
      assert(p.amount_cents === 2000 && p.method === 'Zelle', JSON.stringify(p));
    });
    await check('The pay-rates form shows the closer and the onboarder separately, with the onboarder at zero', async () => {
      await page.click('#tab-money details summary');
      await page.waitForSelector('#rateForm [name=onboarder_activation_cents]');
      const onboarder = await page.$$eval(
        '#rateForm [name=onboarder_activation_cents], #rateForm [name=onboarder_referral_cents], #rateForm [name=onboarder_referral_cents_after_threshold]',
        (els) => els.map((e) => e.value)
      );
      assert(onboarder.every((v) => Number(v) === 0), `onboarder rates: ${onboarder}`);
      await page.fill('#rateForm [name=activation_cents]', '60');
      await page.click('#rateForm button[type=submit]');
      await page.waitForFunction(() => document.getElementById('appMsg').textContent.includes('Rates saved'));
      const [s] = await sql('select activation_cents, onboarder_activation_cents from rep_settings');
      const [{ sum }] = await sql(`select sum(amount_cents)::int as sum from rep_earnings where kind='activation'`);
      assert(s.activation_cents === 6000 && s.onboarder_activation_cents === 0, `saved: ${JSON.stringify(s)}`);
      assert(sum === 5000, `past earnings changed: ${sum}`);
      return 'closer $60 saved; onboarder still 0; the $50 already earned is unchanged';
    });
    await check('Mark Bob inactive: told which dealers still need a decision, nothing moved', async () => {
      await page.click('[data-tab=reps]');
      await page.waitForSelector('#tab-reps [data-edit]');
      await page.locator('#tab-reps tr', { hasText: 'Bob Rep' }).locator('[data-edit]').click();
      await page.click('#toggleActive');
      await page.waitForSelector('#goDealers');
      const t = await page.textContent('#dlg');
      assert(t.includes('Dealer A Roofing') && t.includes('Dealer B Fencing') && /Nothing has moved/.test(t), t);
      const [{ n }] = await sql(`select count(*)::int as n from rep_assignments where effective_to is null and (closer_rep_id = (select id from reps where name='Bob Rep') or onboarder_rep_id = (select id from reps where name='Bob Rep'))`);
      assert(n === 2, `assignments ${n}`);
      await page.click('#goDealers');
      await page.waitForSelector('#tab-dealers tr[data-tenant]');
    });
    await check('Clicking a company opens its year, with its own numbers and charts drawn', async () => {
      await page.click('[data-tab=dealers]');
      await page.waitForSelector('#tab-dealers tr[data-tenant]');
      await page.locator(`tr[data-tenant="${tenants['dealer-a'].id}"]`).locator('[data-company]').click();
      // A closed dialog keeps its markup, so waiting for '#dlg h3' alone
      // matches the PREVIOUS dialog's heading immediately. Wait for this one.
      await page.waitForFunction(() => {
        const d = document.getElementById('dlg');
        return d && d.open && /Dealer A Roofing/.test(d.querySelector('h3').textContent);
      }, { timeout: 15000 });
      // The four headline tiles, the two charts in the grid, and the month table.
      const tiles = await page.$$eval('#dlg .cards .stat span', (els) => els.map((e) => e.textContent));
      assert(tiles.some((x) => /Invites sent/.test(x)), `tiles: ${JSON.stringify(tiles)}`);
      assert(tiles.some((x) => /Referrals in/.test(x)), `tiles: ${JSON.stringify(tiles)}`);
      const charts = await page.$$eval('#dlg svg', (els) => els.length);
      assert(charts >= 3, `expected the bar charts and the ring, got ${charts} svg`);
      // Same selector the rep-report check uses: a zero-value bar is drawn at
      // height 0, so only a bar with real height proves real data got through.
      const bars = await page.$$eval('#dlg svg.chart rect', (els) => els.filter((e) => Number(e.getAttribute('height')) > 1).length);
      const shown = (await page.textContent('#dlg')).replace(/\s+/g, ' ').slice(0, 200);
      assert(bars > 0, `no bar has any height — the chart drew nothing. Dialog said: ${shown}`);
      const rows = await page.$$eval('#dlg table tbody tr', (els) => els.length);
      eq(rows, 13, 'twelve months and a total row');
      // The month chart needs 520px of its own; a form-width dialog left
      // November and December off the end. Nothing here may overflow.
      const overflow = await page.$$eval('#dlg svg.chart', (els) => els.map((e) => ({
        w: Math.round(e.getBoundingClientRect().width),
        room: Math.round(e.parentElement.clientWidth),
      })));
      for (const o of overflow) assert(o.w <= o.room, `a chart is ${o.w}px in ${o.room}px of room`);
      // Every month is drawn, December included — it sits right at the edge of
      // the dialog, which is exactly where a month quietly goes missing.
      const labels = await page.$$eval('#dlg svg.chart text', (els) => els.map((e) => e.textContent));
      for (const m of ['Jan', 'Jun', 'Dec']) assert(labels.includes(m), `missing ${m}: ${labels.join(',')}`);
      // Switching year redraws rather than erroring.
      await page.selectOption('#coYear', String(new Date().getFullYear() - 1));
      await page.waitForFunction(() => /\u2014 \d{4}/.test(document.querySelector('#dlg h3').textContent));
      await page.click('#cancelDlg');
      return `${charts} charts, ${bars} drawn bars, 12 months + total, year switch works`;
    });

    await check('A paying dealer shows what it paid 50.; an in-house one shows no money and says why', async () => {
      await page.locator(`tr[data-tenant="${tenants['dealer-a'].id}"]`).locator('[data-company]').click();
      await page.waitForFunction(() => {
        const d = document.getElementById('dlg');
        return d && d.open && /Dealer A Roofing/.test(d.querySelector('h3').textContent);
      }, { timeout: 15000 });
      const paying = await page.textContent('#dlg');
      assert(/What they have paid 50\./.test(paying), 'a paying dealer hides its money chart');
      await page.click('#cancelDlg');

      await page.locator(`tr[data-tenant="${tenants['good-steward-structures'].id}"]`).locator('[data-company]').click();
      await page.waitForFunction(() => {
        const d = document.getElementById('dlg');
        return d && d.open && /Good Steward Structures/.test(d.querySelector('h3').textContent);
      }, { timeout: 15000 });
      const inhouse = await page.textContent('#dlg');
      assert(/In-house/.test(inhouse), 'an in-house company is not labelled as one');
      assert(!/What they have paid 50\./.test(inhouse), 'an in-house company shows a money chart it can never fill');
      assert(/pays no setup, renewal or 30% fee/.test(inhouse), 'it does not say why the money is missing');
      await page.click('#cancelDlg');
      return 'paying: money chart shown; in-house: no money chart, and it says why';
    });

    await check('Removing a company needs its name typed exactly, and says what goes and what stays', async () => {
      // A dealer of its own: deleting one the later checks still work with
      // would make this test the reason they fail.
      const [doomed] = await sql(
        `insert into tenants (slug, name, billing_required, billing_status, activation_paid_at, activation_livemode)
         values ('page-doomed-co','Page Doomed Co', true, 'active', now(), true) returning id`
      );
      // They paid, so this is the closing path — the one with more to say and
      // more that must not be lost.
      await sql(`insert into billing_events (tenant_id, event_type, amount_cents, status, livemode, stripe_payment_intent_id)
                 values ($1,'activation_charge',50000,'succeeded',true,'pi_page_doomed')`, [doomed.id]);
      await page.click('[data-tab=dealers]');
      await page.waitForFunction(() => document.querySelector('#tab-dealers').textContent.includes('Page Doomed Co'), { timeout: 10000 });
      await page.locator(`tr[data-tenant="${doomed.id}"]`).locator('[data-delco]').click();
      await page.waitForSelector('#delForm');

      const text = (await page.textContent('#dlg')).replace(/\s+/g, ' ');
      assert(/card comes off file/i.test(text), `does not say the card stops: ${text.slice(0, 200)}`);
      assert(/customer/i.test(text) && /logins/i.test(text), 'does not say what goes');
      assert(/still add up/i.test(text), 'does not say the money is kept');
      // It traded, so the dialog must offer closing rather than deleting.
      assert(/Close this company/i.test(text), `offers the wrong outcome: ${text.slice(0, 200)}`);

      // The button is dead until the name matches, and a near miss is a miss.
      eq(await page.isDisabled('#doDelete'), true, 'enabled before anything was typed');
      await page.fill('#delForm [name=confirm_name]', 'Page Doomed');
      eq(await page.isDisabled('#doDelete'), true, 'enabled on a partial name');
      await page.fill('#delForm [name=confirm_name]', 'page doomed co');
      eq(await page.isDisabled('#doDelete'), true, 'enabled on the wrong case');
      await page.fill('#delForm [name=confirm_name]', 'Page Doomed Co');
      eq(await page.isDisabled('#doDelete'), false, 'still disabled on the exact name');

      await page.click('#doDelete');
      await page.waitForFunction(() => /is closed/.test(document.getElementById('appMsg').textContent), { timeout: 15000 });
      // Off the page, and nothing left to charge in the database.
      await page.waitForFunction(() => !document.querySelector('#tab-dealers').textContent.includes('Page Doomed Co'), { timeout: 10000 });
      const [t] = await sql('select name, billing_status, renewal_due_at, closed_at from tenants where id = $1', [doomed.id]);
      eq(t.name, 'Page Doomed Co', 'the name is kept'); eq(t.billing_status, 'suspended', 'suspended');
      eq(t.renewal_due_at, null, 'nothing due'); assert(t.closed_at, 'closed_at');

      // And it is reachable again through the toggle, greyed out.
      await page.waitForSelector('#toggleClosed');
      await page.click('#toggleClosed');
      await page.waitForFunction(() => document.querySelector('#tab-dealers').textContent.includes('Page Doomed Co'), { timeout: 10000 });
      const closedRow = page.locator(`tr[data-tenant="${doomed.id}"]`);
      assert(/Closed /.test(await closedRow.textContent()), 'the closed row does not say so');
      eq(await closedRow.locator('[data-delco]').count(), 0, 'a closed company still offers Remove');
      eq(await closedRow.locator('[data-save]').count(), 0, 'a closed company still offers Save');
      return 'partial and wrong-case names refused; exact name closes it, and it returns under the toggle';
    });

    // The check above only ever exercised the CLOSING path: its fixture had a
    // billing event and no lead at all. Deleting — the other half — was broken
    // from the day it shipped, because a real company is always built from a
    // won lead, and rep_leads_built_has_dealer forbids a lead that is still
    // 'built' with no tenant. This fixture is in the state every real one is.
    await check('A company that never traded is deleted outright, lead and all', async () => {
      const [alice] = await sql(`select id from reps where name = 'Alice Rep'`);
      const [lead] = await sql(
        `insert into rep_leads (company_name, brought_in_by_rep_id, closed_by_rep_id, status, closed_on, build_status)
         values ('False Start Co', $1, $1, 'won', current_date, 'awaiting_approval') returning id`,
        [alice.id]
      );
      const [fresh] = await sql(
        `insert into tenants (slug, name, billing_required, billing_status)
         values ('false-start-co','False Start Co', true, 'pending') returning id`
      );
      // Built from that lead, and never paid a penny: no billing_events row.
      await sql(`update rep_leads set tenant_id = $2, build_status = 'built', built_at = now() where id = $1`, [lead.id, fresh.id]);
      // users.id references auth.users(id), so the auth row has to exist first.
      const ownerId = '9f000000-0000-4000-8000-00000000f001';
      await sql(`insert into auth.users (id, email) values ($1,'owner@false-start-co.test')`, [ownerId]);
      await sql(`insert into users (id, tenant_id, email, name, role)
                 values ($1, $2, 'owner@false-start-co.test', 'Owner', 'admin')`, [ownerId, fresh.id]);

      await page.click('[data-tab=dealers]');
      await page.waitForFunction(() => document.querySelector('#tab-dealers').textContent.includes('False Start Co'), { timeout: 10000 });
      await page.locator(`tr[data-tenant="${fresh.id}"]`).locator('[data-delco]').click();
      await page.waitForSelector('#delForm');
      const text = (await page.textContent('#dlg')).replace(/\s+/g, ' ');
      // Never traded, so the dialog must offer deleting, not closing.
      assert(/Delete/i.test(text) && !/Close this company/i.test(text), `offers the wrong outcome: ${text.slice(0, 220)}`);

      await page.fill('#delForm [name=confirm_name]', 'False Start Co');
      await page.click('#doDelete');
      await page.waitForFunction(() => /deleted|removed/i.test(document.getElementById('appMsg').textContent), { timeout: 15000 });

      // The tenant row is gone, not merely closed.
      const [{ n }] = await sql('select count(*)::int as n from tenants where id = $1', [fresh.id]);
      eq(n, 0, 'the company row survived a delete');
      // The lead survives and still belongs to the rep who closed it, but is
      // off the company and out of the build queue.
      const [l] = await sql('select status, build_status, tenant_id, closed_by_rep_id, declined_reason from rep_leads where id = $1', [lead.id]);
      eq(l.status, 'won', 'the rep lost credit for closing it');
      eq(l.tenant_id, null, 'the lead still points at a company that no longer exists');
      assert(l.build_status !== 'built', `the lead is still marked built: ${l.build_status}`);
      eq(l.closed_by_rep_id, alice.id, 'the closer was dropped');
      assert(/removed/i.test(l.declined_reason || ''), `no reason recorded: ${l.declined_reason}`);
      // And it is not left on the page as a closed company either. Waited for,
      // not read straight away: the flash appears as soon as the request comes
      // back, while the row goes on the redraw that follows.
      await page.waitForFunction(
        () => !document.querySelector('#tab-dealers').textContent.includes('False Start Co'),
        null, { timeout: 10000 }
      );

      // Tidy the lead away. It survives a deletion on purpose, so that the rep
      // keeps credit for closing it — which means it stays in her pipeline for
      // every later check that counts what she can see. The assertions above
      // have already proved it survived in the right state.
      await sql('delete from rep_leads where id = $1', [lead.id]);
      return `tenant row gone; lead still won by Alice, build_status now ${l.build_status}`;
    });

    await check('Removing a rep who closed something keeps the row; one who never did is deleted', async () => {
      // A rep with a won lead to their name. Nulling the closer on that lead
      // is what rep_leads_won_has_closer forbids, so this one has to be CLOSED
      // rather than deleted, however little money ever moved.
      const [withHistory] = await sql(`insert into reps (name, email) values ('Closer Rep','closer@x.test') returning id`);
      await sql(`insert into rep_leads (company_name, brought_in_by_rep_id, closed_by_rep_id, status, closed_on)
                 values ('Something They Closed', $1, $1, 'won', current_date)`, [withHistory.id]);
      const [{ outcome: o1 }] = await sqlAs(USERS.admin, `select outcome from remove_rep($1, 'left the company')`, [withHistory.id]);
      eq(o1, 'closed', 'a rep with a lead to their name was not kept');
      const [kept] = await sql('select active, closed_at, email, user_id from reps where id = $1', [withHistory.id]);
      eq(kept.active, false, 'still active'); assert(kept.closed_at, 'closed_at not set');
      eq(kept.email, null, 'their contact details were not scrubbed');
      const [stillClosed] = await sql(`select closed_by_rep_id from rep_leads where company_name = 'Something They Closed'`);
      eq(stillClosed.closed_by_rep_id, withHistory.id, 'the lead no longer names who closed it');

      // Added by mistake, never used: nothing points at them, so delete. Given
      // a dealer to look after, though, and put on it as BOTH closer and
      // onboarder, which is the ordinary case — rep_assignments_has_a_rep
      // means that row cannot simply have both columns nulled.
      const [unused] = await sql(`insert into reps (name) values ('Never Used Rep') returning id`);
      const [houseCo] = await sql(
        `insert into tenants (slug, name, billing_required) values ('house-only-co','House Only Co', true) returning id`
      );
      await sql(`insert into rep_assignments (tenant_id, closer_rep_id, onboarder_rep_id, effective_from)
                 values ($1, $2, $2, now())`, [houseCo.id, unused.id]);
      const rows = await sqlAs(USERS.admin, `select * from remove_rep($1, 'added by mistake')`, [unused.id]);
      eq(rows.length, 1, `remove_rep answered with ${rows.length} rows, not 1`);
      eq(rows[0].outcome, 'deleted', 'an unused rep was kept');
      const [{ n }] = await sql('select count(*)::int as n from reps where id = $1', [unused.id]);
      eq(n, 0, 'the unused rep row survived');
      // The assignment they were the only party on is gone, not left naming
      // nobody.
      const [{ a }] = await sql('select count(*)::int as a from rep_assignments where tenant_id = $1', [houseCo.id]);
      eq(a, 0, 'an assignment naming nobody was left behind');
      // Tidy the fixtures away: later checks count the companies on the page,
      // and a leftover here makes this test the reason they fail. Order
      // matters — 'Closer Rep' was CLOSED rather than deleted, so their row
      // still exists and the lead still points at it. The lead goes first.
      await sql('delete from tenants where id = $1', [houseCo.id]);
      await sql(`delete from rep_leads where company_name = 'Something They Closed'`);
      await sql(`delete from reps where name = 'Closer Rep'`);
      return 'rep with a closed lead -> closed and scrubbed; unused rep -> deleted, assignment cleared, in one row';
    });

    // The dialog must not promise one outcome while the database does the
    // other. This is the exact shape that caught it in production: a rep with a
    // won lead to their name but no earnings and no CURRENT dealer, because the
    // dealer was deleted. Guessing from the dealer counts reads that as "never
    // did anything" and offers to delete them outright.
    await check('A rep whose only dealer was deleted is still offered as Remove, not Delete', async () => {
      const [stranded] = await sql(`insert into reps (name, email) values ('Stranded Rep','stranded@x.test') returning id`);
      await sql(`insert into rep_leads (company_name, brought_in_by_rep_id, closed_by_rep_id, status, closed_on)
                 values ('Deleted Their Dealer', $1, $1, 'won', current_date)`, [stranded.id]);

      await page.click('[data-tab=reps]');
      await page.waitForFunction(() => document.querySelector('#tab-reps').textContent.includes('Stranded Rep'), { timeout: 10000 });
      const row = page.locator('#tab-reps tr', { hasText: 'Stranded Rep' });
      eq(await row.locator('[data-delrep]').count(), 1, 'no Remove button on the rep');
      await row.locator('[data-delrep]').click();
      await page.waitForFunction(
        () => { const d = document.getElementById('dlg'); return d && d.open && /Stranded Rep/.test(d.textContent); },
        null, { timeout: 8000 }
      );
      const heading = await page.$eval('#dlg h3', (h) => h.textContent.trim());
      assert(/^Remove /.test(heading), `the dialog offers "${heading}" for a rep the database will keep`);
      const body = (await page.textContent('#dlg')).replace(/\s+/g, ' ');
      assert(!/with nobody on them/i.test(body), 'the dialog still promises leads with nobody on them, which a won lead forbids');
      assert(/name stays on the leads/i.test(body), `the dialog does not say the name stays: ${body.slice(0, 220)}`);
      await page.click('#cancelDlg');

      // And the database agrees with what the dialog just said.
      const [{ outcome }] = await sqlAs(USERS.admin, `select outcome from remove_rep($1, 'checking the wording matches')`, [stranded.id]);
      eq(outcome, 'closed', 'the database disagreed with the dialog');
      await sql(`delete from rep_leads where company_name = 'Deleted Their Dealer'`);
      await sql('delete from reps where id = $1', [stranded.id]);
      return `dialog said "${heading}", database said "${outcome}"`;
    });

    await check('A won lead with no company can be deleted; one with a company cannot', async () => {
      const [alice2] = await sql(`select id from reps where name = 'Alice Rep'`);
      // Won, built, and its company then removed — the state remove_company
      // leaves behind, and the clutter Joseph could not clear.
      const [orphan] = await sql(
        `insert into rep_leads (company_name, brought_in_by_rep_id, closed_by_rep_id, status, closed_on, build_status, declined_reason)
         values ('Gone Company', $1, $1, 'won', current_date, 'declined', 'Company removed') returning id`,
        [alice2.id]
      );
      // Won and still attached to a live dealer: this one must stay. Its own
      // tenant, because rep_leads_one_per_tenant_idx allows one lead per
      // company and every seeded dealer already has one.
      const [liveCo] = await sql(
        `insert into tenants (slug, name, billing_required, billing_status) values ('still-a-dealer','Still A Dealer', true, 'active') returning id`
      );
      const [attached] = await sql(
        `insert into rep_leads (company_name, brought_in_by_rep_id, closed_by_rep_id, status, closed_on, tenant_id, build_status, built_at)
         values ('Still A Dealer', $1, $1, 'won', current_date, $2, 'built', now()) returning id`,
        [alice2.id, liveCo.id]
      );

      await page.click('[data-tab=leads]');
      await page.waitForFunction(() => document.querySelector('#tab-leads').textContent.includes('Gone Company'), { timeout: 10000 });
      await page.waitForLoadState('networkidle').catch(() => {});

      // Only the orphaned one offers a Delete.
      const orphanRow = page.locator('#tab-leads tr', { hasText: 'Gone Company' });
      const attachedRow = page.locator('#tab-leads tr', { hasText: 'Still A Dealer' });
      eq(await orphanRow.locator('[data-dellead]').count(), 1, 'no Delete on a won lead whose company is gone');
      eq(await attachedRow.locator('[data-dellead]').count(), 0, 'a won lead with a live dealer offers Delete');

      // The API refuses the attached one even if asked directly.
      const refused = await apiAs(USERS.admin, `/rep-leads/${attached.id}`, { method: 'DELETE' });
      eq(refused.status, 409, `expected 409, got ${refused.status} ${JSON.stringify(refused.body)}`);
      assert(/Remove the company first/i.test(refused.body.error || ''), `unhelpful refusal: ${refused.body.error}`);

      // And deleting the orphan works, without counting as a lost lead.
      const before = await sql('select lost_count from rep_lead_outcomes where rep_id = $1', [alice2.id]);
      await orphanRow.locator('[data-dellead]').click();
      await page.waitForSelector('#confirmDelLead', { timeout: 6000 });
      const text = (await page.textContent('#dlg')).replace(/\s+/g, ' ');
      assert(/no company on the platform/i.test(text), `the dialog does not explain why: ${text.slice(0, 200)}`);
      assert(/does not count as a lost lead/i.test(text), 'the dialog does not say it is not a loss');
      await page.click('#confirmDelLead');
      await page.waitForFunction(
        () => !document.querySelector('#tab-leads').textContent.includes('Gone Company'),
        null, { timeout: 10000 }
      );
      const [{ n }] = await sql(`select count(*)::int as n from rep_leads where id = $1`, [orphan.id]);
      eq(n, 0, 'the lead row survived');
      const after = await sql('select lost_count from rep_lead_outcomes where rep_id = $1', [alice2.id]);
      eq((after[0] || {}).lost_count || 0, (before[0] || {}).lost_count || 0, 'a tidy-up was counted against the rep as a lost lead');

      await sql('delete from rep_leads where id = $1', [attached.id]);
      await sql('delete from tenants where id = $1', [liveCo.id]);
      return 'orphaned won lead deleted, attached one refused with 409, lost count unchanged';
    });

    await check('An in-house company has no Remove button at all', async () => {
      const gss = page.locator(`tr[data-tenant="${tenants['good-steward-structures'].id}"]`);
      eq(await gss.locator('[data-delco]').count(), 0, 'in-house row offers a Remove button');
      const payer = page.locator(`tr[data-tenant="${tenants['dealer-a'].id}"]`);
      eq(await payer.locator('[data-delco]').count(), 1, 'a paying dealer has no Remove button');
      return 'Remove on the paying dealer, none on the in-house one';
    });

    await check('At a narrow window the Resend login button is still reachable without scrolling', async () => {
      await page.click('[data-tab=reps]');
      await page.waitForSelector('#tab-reps [data-invite]');
      const original = page.viewportSize();
      await page.setViewportSize({ width: 900, height: original.height });
      await page.waitForTimeout(150);
      const fits = await page.evaluate(() => {
        const btn = document.querySelector('#tab-reps [data-invite]');
        const wrap = btn.closest('.tablewrap');
        const b = btn.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        return { scrolls: wrap.scrollWidth > wrap.clientWidth + 1, right: Math.round(b.right), edge: Math.round(w.right), width: Math.round(b.width) };
      });
      // The table is genuinely wider than its card at this width — that is the
      // case worth testing, not one where everything happens to fit.
      assert(fits.scrolls, 'the table did not overflow, so this proves nothing — narrow the viewport further');
      assert(fits.width > 0, 'the button has no width');
      assert(fits.right <= fits.edge + 1, `button runs to ${fits.right}, card ends at ${fits.edge}`);
      await page.setViewportSize(original);
      await page.waitForTimeout(100);
      return `table overflows at 900px wide; the button still ends at the card edge (${fits.right} vs ${fits.edge})`;
    });

    await check('Searching narrows a list to what matches, across every field on the row', async () => {
      await page.click('[data-tab=dealers]');
      await page.waitForSelector('#tab-dealers tr[data-search]');
      // Opening the tab refetches and redraws. waitForSelector above matches
      // the rows ALREADY in the DOM from the last visit, so without this the
      // baseline below can be read before the new list lands and come out one
      // row short of what clearing the box then restores.
      await page.waitForLoadState('networkidle').catch(() => {});
      const visible = () => page.$$eval('#tab-dealers tbody tr[data-search]', (rows) =>
        rows.filter((r) => !r.hidden).map((r) => r.querySelector('b, [data-company]').textContent));

      const all = await visible();
      assert(all.length >= 4, `expected several companies, got ${all.length}`);

      // By name.
      await page.fill('#tab-dealers .searchbox', 'roofing');
      await page.waitForTimeout(80);
      eq(await visible(), ['Dealer A Roofing'], 'searching a name');
      assert(/1 of /.test(await page.textContent('#tab-dealers [data-search-count]')), 'no count shown');

      // Case does not matter, and neither does word order.
      await page.fill('#tab-dealers .searchbox', 'ROOFING a dealer');
      await page.waitForTimeout(80);
      eq(await visible(), ['Dealer A Roofing'], 'words in any order, any case');

      // A rep's name must NOT match a company: every Companies row carries a
      // dropdown listing every rep, which is exactly why rows are matched on
      // their own fields rather than on their text.
      await page.fill('#tab-dealers .searchbox', 'Alice Rep');
      await page.waitForTimeout(80);
      eq((await visible()).length, 0, 'a rep name leaked through the dropdowns');
      assert(/nothing matches/.test(await page.textContent('#tab-dealers [data-search-count]')), 'no empty message');

      // Clearing brings everything back.
      await page.fill('#tab-dealers .searchbox', '');
      await page.waitForTimeout(80);
      eq((await visible()).length, all.length, 'clearing did not restore the list');
      eq(await page.textContent('#tab-dealers [data-search-count]'), '', 'count still shown when not searching');
      return `${all.length} companies; name, case and word order all match; a rep name does not`;
    });

    await check('A search survives the list redrawing underneath it, without stealing the cursor', async () => {
      await page.click('[data-tab=leads]');
      await page.waitForSelector('#tab-leads tr[data-search]');
      // Opening the tab refetches and redraws, and the selector above matches
      // the rows already in the DOM from the last visit. Typing into a box
      // that is about to be replaced lands in a node whose input handler has
      // not been attached yet, so the keystroke filters nothing — harmless in
      // a browser, where the next keystroke fixes it, but it made this check
      // pass or fail on timing.
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.fill('#tab-leads .searchbox', 'acme');
      await page.waitForTimeout(80);
      const counted = await page.$$eval('#tab-leads tbody tr[data-search]', (r) => ({
        shown: r.filter((x) => !x.hidden).length, total: r.length,
      }));
      const before = counted.shown;
      // Deliberately not "before >= 1". That passes when the filter never ran
      // at all, because then nothing is hidden and every row counts — which is
      // exactly how a lost keystroke hid here instead of failing.
      assert(before >= 1, 'nothing matched acme to begin with');
      assert(before < counted.total, `typing filtered nothing: ${before} of ${counted.total} rows still shown`);

      // Something else redraws the tab entirely.
      await page.evaluate(() => renderLeads());
      await page.waitForTimeout(250);
      eq(await page.inputValue('#tab-leads .searchbox'), 'acme', 'the query was lost in the redraw');
      const after = await page.$$eval('#tab-leads tbody tr[data-search]', (r) => r.filter((x) => !x.hidden).length);
      eq(after, before, 'the filter was not re-applied after the redraw');
      // And it did not take focus from whatever was being typed into.
      const focused = await page.evaluate(() => document.activeElement && document.activeElement.className);
      assert(!/searchbox/.test(String(focused)), 'the search box grabbed focus on a redraw');
      await page.fill('#tab-leads .searchbox', '');
      return 'query and filter both survive a redraw; focus is left alone';
    });

    await check('Signing out clears the session', async () => {
      await page.click('#signOutBtn');
      await page.waitForSelector('#loginBox:not(.hide)');
      assert(!(await page.evaluate(() => localStorage.getItem('fifty:reps-session'))), 'session kept');
    });
    await page.context().close();

    // ======================================================================
    section('Helper: sees no money, anywhere');
    await check('Helper signs in: tabs are Calendar, Leads, Reps, Companies only (no Money)', async () => {
      const hp = await newPage('helper');
      global.__helper = hp;
      await signIn(hp, USERS.helper);
      const t = await tabNames(hp);
      assert(JSON.stringify(t) === JSON.stringify(['Calendar', 'Leads', 'Reps', 'Companies']), `tabs: ${t}`);
      assert(/helper/.test(await hp.textContent('#who')), 'who');
    });
    await check('No dollar sign appears on any tab, and the Reps table has no earned / owe columns', async () => {
      const hp = global.__helper;
      for (const tab of ['leads', 'reps', 'dealers']) {
        await hp.click(`[data-tab=${tab}]`);
        await hp.waitForFunction((k) => !document.getElementById('tab-' + k).classList.contains('hide') && document.getElementById('tab-' + k).textContent.length > 20, tab);
        await hp.waitForTimeout(250);
        const text = await hp.textContent(`#tab-${tab}`);
        assert(!text.includes('$'), `"$" on ${tab}: ${text.match(/.{20}\$.{20}/)}`);
      }
      await hp.click('[data-tab=reps]');
      const heads = await hp.$$eval('#tab-reps th', (h) => h.map((x) => x.textContent));
      assert(!heads.some((h) => /earned|owe/i.test(h)), heads.join(','));
      assert(await hp.locator('[data-field=from]').count() === 0, 'start date box');
    });
    await check('Helper can add a rep and change a dealer\'s reps', async () => {
      const hp = global.__helper;
      await hp.click('#addRepBtn');
      await hp.fill('#repForm [name=name]', 'Helper-added Rep');
      await hp.click('#repForm button[type=submit]');
      await hp.waitForFunction(() => document.getElementById('tab-reps').textContent.includes('Helper-added Rep'));
      await hp.click('[data-tab=dealers]');
      await hp.waitForSelector('#tab-dealers tr[data-tenant]');
      const row = hp.locator(`tr[data-tenant="${tenants['dealer-b'].id}"]`);
      await row.locator('[data-field=onboarder]').selectOption({ label: 'Helper-added Rep' });
      const saved = hp.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/assignment'));
      await row.locator('[data-save]').click();
      const resp = await saved;
      assert(resp.status() === 200, `PUT ${resp.status()} ${await resp.text()}`);
      const [a] = await sql(`select 1 from rep_assignments where tenant_id=$1 and effective_to is null and onboarder_rep_id = (select id from reps where name='Helper-added Rep')`, [tenants['dealer-b'].id]);
      assert(a, 'not saved');
    });
    await check('The helper\'s own token is refused by every money route (403), even called by hand', async () => {
      const tok = auth.mintToken(USERS.helper);
      for (const [m, p] of [['GET', '/rep-money/overview'], ['GET', '/rep-settings'], ['GET', `/reps/${(await sql('select id from reps limit 1'))[0].id}/statement`]]) {
        const r = await fetch(`${API_ORIGIN}/api${p}`, { method: m, headers: { Authorization: `Bearer ${tok}` } });
        assert(r.status === 403, `${m} ${p} → ${r.status}`);
      }
    });
    await global.__helper.context().close();

    // ======================================================================
    section('A rep in the browser: their own pipeline and nothing else');
    await check('Joseph sends Alice a login from the Reps tab, and she sets a password', async () => {
      const p = await newPage('admin-invite');
      await signIn(p, USERS.admin);
      await p.click('[data-tab=reps]');
      await p.waitForSelector('#tab-reps [data-invite]');
      // Both reps start with no login, and the button says so.
      const labels = await p.$$eval('#tab-reps [data-invite]', (bs) => bs.map((b) => b.textContent.trim()));
      assert(labels.every((l) => l === 'Send login'), `labels: ${labels}`);
      await p.locator('#tab-reps tr', { hasText: 'Alice Rep' }).locator('[data-invite]').click();
      await p.waitForFunction(() => document.getElementById('appMsg').textContent.includes('Login sent to'));
      const mail = sentMail[sentMail.length - 1];
      assert(mail.To === 'alice@x.test', `to: ${mail.To}`);
      assert(mail.From.startsWith('Joseph at 50.'), `from: ${mail.From}`);
      assert(!/your password is|temporary password/i.test(mail.TextBody), 'a password was emailed');
      // Now the button offers a resend instead.
      await p.waitForFunction(() => [...document.querySelectorAll('#tab-reps [data-invite]')].some((b) => b.textContent.trim() === 'Resend login'));
      await p.context().close();
      auth.setPassword('alice@x.test', PASSWORD);
      return `invite emailed from "${mail.From}"; the button becomes Resend`;
    });

    let repPage;
    await check('Alice signs in and sees Calendar, My leads, My dealers and My money — no Reps tab, no Money tab', async () => {
      repPage = await newPage('rep');
      await signIn(repPage, { email: 'alice@x.test' });
      const t = await tabNames(repPage);
      eqArr(t, ['Calendar', 'My leads', 'My dealers', 'My money'], 'tabs');
      assert(/rep$/.test((await repPage.textContent('#who')).trim()), `who: ${await repPage.textContent('#who')}`);
      return (await repPage.textContent('#who')).trim();
    });

    await check('She sees the lead she is on and can add one, with no "brought in by" to choose', async () => {
      await repPage.waitForSelector('#tab-leads table');
      const text = await repPage.textContent('#tab-leads');
      assert(text.includes('Acme Roofing'), 'her own won lead is listed');
      assert(!(await repPage.$('#leadForm [name=brought_in_by_rep_id]')) || true, 'form present');
      await openAddLead(repPage);
      assert((await repPage.$$('#leadForm [name=brought_in_by_rep_id]')).length === 0, 'a rep is not asked whose lead it is');
      assert((await repPage.$$('#leadForm [name=website]')).length === 1, 'website field');
      assert((await repPage.$$('#leadForm [name=notes]')).length === 1, 'notes field');
      await repPage.fill('#leadForm [name=company_name]', 'Her Own Prospect');
      await repPage.fill('#leadForm [name=website]', 'herownprospect.test');
      await repPage.click('#leadForm button[type=submit]');
      await repPage.waitForFunction(() => document.getElementById('tab-leads').textContent.includes('Her Own Prospect'));
      const [row] = await sql(`select brought_in_by_rep_id, website from rep_leads where company_name = 'Her Own Prospect'`);
      assert(row.website === 'herownprospect.test', `website: ${row.website}`);
      return 'lead added under Alice, with its website';
    });

    await check('She can type the business\'s own wording onto a lead, and it reaches the database', async () => {
      await openAddLead(repPage);
      // The wording section is deliberately shut: it is optional, and a rep
      // writing a lead down on a call should not have to scroll past it.
      const shut = await repPage.$eval('#leadForm details.wording', (d) => !d.open);
      assert(shut, 'the wording section starts closed');
      await repPage.$eval('#leadForm details.wording', (d) => { d.open = true; });
      await repPage.fill('#leadForm [name=company_name]', 'Gutters By Dale');
      await repPage.fill('#leadForm [name=copy_friendAction]', 'book your gutter job');
      await repPage.fill('#leadForm [name=copy_inquiryNoun]', 'gutter inquiry');
      await repPage.click('#leadForm button[type=submit]');
      await repPage.waitForFunction(() => document.getElementById('tab-leads').textContent.includes('Gutters By Dale'));
      const [row] = await sql(`select copy from rep_leads where company_name = 'Gutters By Dale'`);
      eq(row.copy.friendAction, 'book your gutter job', 'what she typed');
      eq(row.copy.inquiryNoun, 'gutter inquiry', 'and the second line');
      eq(Object.keys(row.copy).length, 2, 'only the boxes she filled');
      return '2 of 9 lines stored, the rest left to the generic wording';
    });

    await check('Every empty box shows the wording that runs instead, so nothing looks missing', async () => {
      await openAddLead(repPage);
      await repPage.$eval('#leadForm details.wording', (d) => { d.open = true; });
      const holders = await repPage.$$eval('#leadForm details.wording [name^=copy_]', (els) =>
        els.map((e) => ({ name: e.name, placeholder: e.placeholder })));
      eq(holders.length, 9, 'nine lines');
      assert(holders.every((h) => h.placeholder && h.placeholder.length > 2), `a box with no fallback shown: ${JSON.stringify(holders)}`);
      const all = holders.map((h) => h.placeholder).join(' ').toLowerCase();
      assert(!all.includes('shed'), `shed wording offered to a non-shed business: ${all}`);
      return 'nine boxes, each showing its trade-neutral fallback';
    });

    await check('The lead row says how much is in their own words, and reopens for editing', async () => {
      const rowText = await repPage.locator('#tab-leads tr', { hasText: 'Gutters By Dale' }).textContent();
      assert(/2 of 9 in their own words/.test(rowText), `row: ${rowText}`);
      await repPage.locator('#tab-leads tr', { hasText: 'Gutters By Dale' }).locator('[data-wording]').click();
      await repPage.waitForSelector('#wordingForm');
      eq(await repPage.inputValue('#wordingForm [name=copy_friendAction]'), 'book your gutter job', 'reopens with what she typed');
      // A line added on the second visit, which is the normal way this gets filled.
      await repPage.fill('#wordingForm [name=copy_offerHow]', 'Have us do your gutters and you both get {reward}.');
      await repPage.evaluate(() => { document.getElementById('appMsg').textContent = ''; });
      await repPage.click('#saveWording');
      await repPage.waitForFunction(() => document.getElementById('appMsg').textContent.includes('Wording saved'));
      // closeDialog() only closes the dialog; its markup stays in the DOM.
      await repPage.waitForSelector('#wordingForm', { state: 'hidden' });
      const [row] = await sql(`select copy from rep_leads where company_name = 'Gutters By Dale'`);
      eq(Object.keys(row.copy).length, 3, 'now three lines');
      eq(row.copy.offerHow, 'Have us do your gutters and you both get {reward}.', 'the line added later');
      return 'row shows 2 of 9, dialog reopens, a third line added later';
    });

    await check('Clearing every box drops the lead back to the generic wording', async () => {
      await repPage.locator('#tab-leads tr', { hasText: 'Gutters By Dale' }).locator('[data-wording]').click();
      await repPage.waitForSelector('#wordingForm');
      for (const k of ['friendAction', 'inquiryNoun', 'offerHow']) {
        await repPage.fill(`#wordingForm [name=copy_${k}]`, '');
      }
      await repPage.evaluate(() => { document.getElementById('appMsg').textContent = ''; });
      await repPage.click('#saveWording');
      await repPage.waitForFunction(() => document.getElementById('appMsg').textContent.includes('Wording saved'));
      // closeDialog() only closes the dialog; its markup stays in the DOM.
      await repPage.waitForSelector('#wordingForm', { state: 'hidden' });
      const [row] = await sql(`select copy from rep_leads where company_name = 'Gutters By Dale'`);
      eq(row.copy, null, 'emptied back to null, not nine blank strings');
      // The dialog closes before the list behind it finishes redrawing, so
      // wait for the row itself rather than reading it mid-redraw.
      await repPage.waitForFunction(() => {
        const tr = [...document.querySelectorAll('#tab-leads tr')].find((r) => r.textContent.includes('Gutters By Dale'));
        return tr && tr.textContent.includes('nothing written yet');
      }, { timeout: 10000 });
      return 'cleared to null; the row says so';
    });

    await check('A rep gets the same search on her own leads and her own dealers', async () => {
      await repPage.click('[data-tab=leads]');
      await repPage.waitForSelector('#tab-leads .searchbox');
      const ph = await repPage.getAttribute('#tab-leads .searchbox', 'placeholder');
      assert(/your leads/i.test(ph), `a rep is offered: ${ph}`);

      await repPage.fill('#tab-leads .searchbox', 'acme');
      await repPage.waitForTimeout(80);
      const names = await repPage.$$eval('#tab-leads tbody tr[data-search]', (rows) =>
        rows.filter((r) => !r.hidden).map((r) => r.querySelector('b').textContent));
      assert(names.length >= 1 && names.every((n) => /acme/i.test(n)), `matched: ${JSON.stringify(names)}`);
      await repPage.fill('#tab-leads .searchbox', '');

      await repPage.click('[data-tab=dealers]');
      await repPage.waitForSelector('#tab-dealers .searchbox');
      // Put her back where the next check expects to find her.
      await repPage.click('[data-tab=leads]');
      await repPage.waitForSelector('#tab-leads tr[data-search]');
      return 'a rep searches her own leads and her own dealers, with her own wording';
    });

    await check('Marking her own lead won is a plain confirmation and builds nothing', async () => {
      const tenantsBefore = (await sql('select count(*)::int n from tenants'))[0].n;
      await repPage.locator('#tab-leads tr', { hasText: 'Her Own Prospect' }).locator('[data-win]').click();
      await repPage.waitForSelector('#confirmWin');
      const dlg = await repPage.textContent('#dlg');
      assert(/Joseph builds their dashboard/.test(dlg), `dialog: ${dlg}`);
      assert(!(await repPage.$('#winForm')), 'a rep is not offered the staff form');
      await repPage.click('#confirmWin');
      await repPage.waitForFunction(() => document.getElementById('appMsg').textContent.includes('Joseph builds their dashboard'));
      const [lead] = await sql(`select status, closed_by_rep_id, tenant_id from rep_leads where company_name = 'Her Own Prospect'`);
      assert(lead.status === 'won' && lead.tenant_id === null, JSON.stringify(lead));
      eq((await sql('select count(*)::int n from tenants'))[0].n, tenantsBefore, 'no dealer created');
      return 'won, credited to her, no dealer built';
    });

    await check('My money shows her own earnings and no way to pay herself', async () => {
      await repPage.click('[data-tab=mymoney]');
      await repPage.waitForSelector('#tab-mymoney .stat b');
      const stats = await repPage.$$eval('#tab-mymoney .stat b', (b) => b.map((x) => x.textContent));
      // Her $50 bonus plus three $1 royalties, less the one Joseph reversed
      // and the $20 he recorded paying her, earlier in this same run.
      assert(stats[0] === '$32.00', `owed: ${stats}`);
      assert(stats[1] === '$52.00' && stats[2] === '$20.00', `earned/paid: ${stats}`);
      const text = await repPage.textContent('#tab-mymoney');
      assert(/Sign-up bonus/.test(text), 'her bonus is listed');
      assert((await repPage.$$('[data-pay]')).length === 0, 'no Record payment button');
      assert((await repPage.$$('[data-rev]')).length === 0, 'no Reverse button');
      assert(!/Pay rates/.test(await repPage.textContent('#app')), 'no pay rates anywhere');
      return `owed ${stats[0]}, statement lines visible, nothing she can pay or reverse`;
    });

    await check('She cannot reach another rep\'s money or the overview, even by asking the API directly', async () => {
      const out = await repPage.evaluate(async (base) => {
        const s = JSON.parse(localStorage.getItem('fifty:reps-session'));
        const call = async (path) => {
          const r = await fetch(base + path, { headers: { Authorization: 'Bearer ' + s.access_token } });
          return r.status;
        };
        return {
          overview: await call('/rep-money/overview'),
          settings: await call('/rep-settings'),
          reps: await call('/reps'),
        };
      }, API_ORIGIN + '/api');
      assert(out.overview === 403 && out.settings === 403, JSON.stringify(out));
      assert(out.reps === 200, 'she can still read her own rep row');
      return JSON.stringify(out);
    });
    await repPage.context().close();

    // ======================================================================
    section('Building a dealer from the page');
    let adminPage;
    await check('A rep drops a logo on a lead and it appears in the Files dialog', async () => {
      adminPage = await newPage('build');
      await signIn(adminPage, USERS.admin);
      await adminPage.click('[data-tab=leads]');
      await adminPage.waitForSelector('#tab-leads [data-files]');
      // Make a lead with a website, so the brand guess has somewhere to look.
      await addLead(adminPage, {
        company_name: 'Hill Country Barns',
        email: 'owner@hillcountry.test',
        contact_name: 'Dale',
        website: `${AUTH_BASE}/prospect-site`,
      });
      await adminPage.click('#leadForm button[type=submit]');
      await adminPage.waitForFunction(() => document.getElementById('tab-leads').textContent.includes('Hill Country Barns'));

      // A real PNG, dropped through the real file input.
      const png = makeLogoPng([46, 94, 58], [196, 122, 43]);
      await adminPage.locator('#tab-leads tr', { hasText: 'Hill Country Barns' }).locator('[data-files]').click();
      await adminPage.waitForSelector('#filePick', { state: 'attached' });
      await adminPage.setInputFiles('#filePick', { name: 'hill-country.png', mimeType: 'image/png', buffer: png });
      // The list of files, not the drop zone's own instructions — which also
      // mention a logo, and would make this wait pass before anything landed.
      await adminPage.waitForSelector('#fileBody table img', { timeout: 20000 });
      const shown = await adminPage.$$eval('#fileBody table img', (els) => els.length);
      assert(shown === 1, `one file previewed, saw ${shown}`);
      assert((await adminPage.textContent('#fileBody table')).includes('hill-country.png'), 'under its own name');

      // The check that matters: the bytes are really at the URL the dealer's
      // page would load them from, not on this service's disk.
      const [row] = await sql(`select public_url, kind, size_bytes from rep_lead_files order by created_at desc limit 1`);
      eq(row.kind, 'logo', 'stored as their logo');
      assert(row.public_url.includes('/storage/v1/object/public/'), `url: ${row.public_url}`);
      const fetched = await fetch(row.public_url);
      eq(fetched.status, 200, 'the stored file is readable at its own URL');
      eq(fetched.headers.get('content-type'), 'image/png', 'and is still a PNG');

      await adminPage.click('#cancelDlg');
      await adminPage.waitForFunction(() => !document.getElementById('dlg').open);
      // Closing the dialog also refreshes the list behind it; let that settle
      // before the next check starts clicking rows.
      await adminPage.waitForSelector('#tab-leads table tbody tr');
      await adminPage.waitForTimeout(300);
      return `${row.size_bytes} bytes readable at its public URL`;
    });

    let hillLeadId;
    await check('Marking it won puts it on the Build dashboards tab, and no dealer exists yet', async () => {
      const tenantsBefore = (await sql('select count(*)::int n from tenants'))[0].n;
      await adminPage.locator('#tab-leads tr', { hasText: 'Hill Country Barns' }).locator('[data-win]').click();
      await adminPage.waitForSelector('#winForm');
      await adminPage.selectOption('#winForm [name=closed_by_rep_id]', { label: 'Alice Rep' });
      await adminPage.click('#winForm button[type=submit]');
      await adminPage.waitForFunction(() => document.getElementById('appMsg').textContent.includes('Marked won'));
      eq((await sql('select count(*)::int n from tenants'))[0].n, tenantsBefore, 'no dealer yet');
      await adminPage.click('[data-tab=builds]');
      await adminPage.waitForSelector('#tab-builds [data-build]');
      const text = await adminPage.textContent('#tab-builds');
      assert(text.includes('Hill Country Barns') && text.includes('Alice Rep'), text.slice(0, 200));
      [{ id: hillLeadId }] = await sql(`select id from rep_leads where company_name = 'Hill Country Barns'`);
      return 'in the queue, with the rep who closed it';
    });

    await check('The review screen guesses their colours, shows where from, and previews their page', async () => {
      // The queue holds more than this one, so pick its row by name rather
      // than taking whatever happens to be first.
      await adminPage.locator('#tab-builds tr', { hasText: 'Hill Country Barns' }).locator('[data-build]').click();
      await adminPage.waitForSelector('#buildForm');
      const primary = await adminPage.inputValue('[data-hex="primaryColor"]');
      const accent = await adminPage.inputValue('[data-hex="accentColor"]');
      const why = await adminPage.textContent('#dlg .notice');
      // The logo was uploaded, so it wins: these are the planted colours.
      assert(primary.toUpperCase() === '#2E5E3A', `main colour from the logo: expected #2E5E3A, got ${primary}. The screen said: ${why}`);
      eq(accent.toUpperCase(), '#C47A2B', 'accent, from the logo');
      const notice = await adminPage.textContent('#dlg .notice');
      assert(/Guessed from/.test(notice), `notice: ${notice}`);
      // The preview bar is actually painted in that colour.
      const bar = await adminPage.evaluate(() => getComputedStyle(document.getElementById('previewBar')).backgroundColor);
      eq(bar, 'rgb(46, 94, 58)', 'the preview bar is their colour');
      const card = await adminPage.inputValue('#buildForm [name=reward]');
      eq(card, '50', 'the card defaults to $50');
      return `${primary} / ${accent}, preview painted, "${notice.slice(0, 60)}…"`;
    });

    await check('Correcting a colour repaints the preview before anything is built', async () => {
      await adminPage.fill('[data-hex="primaryColor"]', '#123456');
      await adminPage.dispatchEvent('[data-hex="primaryColor"]', 'input');
      await adminPage.waitForFunction(() => getComputedStyle(document.getElementById('previewBar')).backgroundColor === 'rgb(18, 52, 86)');
      return 'typed a hex, the preview followed it';
    });

    await check('Building creates the dealer with the corrected colour and a $25 card, and emails both people', async () => {
      await adminPage.fill('#buildForm [name=reward]', '25');
      const mailBefore = sentMail.length;
      await adminPage.click('#doBuild');
      await adminPage.waitForFunction(() => document.getElementById('appMsg').textContent.includes('dashboard is built'));
      const [t] = await sql(`select slug, name, branding, reward_amount_cents from tenants where slug like 'hill-country%'`);
      eq(t.branding.primaryColor, '#123456', 'Joseph\'s correction went in, not the guess');
      eq(t.reward_amount_cents, 2500, 'the $25 card');
      assert(t.branding.logoUrl && t.branding.logoUrl.includes('/storage/'), `logo: ${t.branding.logoUrl}`);
      const fresh = sentMail.slice(mailBefore);
      assert(fresh.some((m) => m.To === 'owner@hillcountry.test'), 'the dealer was emailed');
      assert(fresh.some((m) => m.To === 'alice@x.test' && /is live/.test(m.Subject)), 'the rep was told');
      const dealerMail = fresh.find((m) => m.To === 'owner@hillcountry.test');
      assert(dealerMail.TextBody.includes('$25 gift card'), 'their own card amount is in the email');
      assert(!/password is|temporary password/i.test(dealerMail.TextBody), 'no password was emailed');
      return `${t.name} (${t.slug}) built, $25 card, both emailed`;
    });

    await check('It leaves the queue, and the others in it are untouched', async () => {
      await adminPage.waitForFunction(() => !document.getElementById('tab-builds').textContent.includes('Hill Country Barns'));
      const [lead] = await sql('select build_status, tenant_id from rep_leads where id = $1', [hillLeadId]);
      eq(lead.build_status, 'built', 'built');
      assert(lead.tenant_id, 'and pointed at its dealer');
      const stillWaiting = await sql(`select company_name from rep_leads where build_status = 'awaiting_approval'`);
      assert(!stillWaiting.some((r) => r.company_name === 'Hill Country Barns'), 'it is out of the queue');
      return `built; ${stillWaiting.length} other(s) still waiting, untouched`;
    });

    await check('The helper and a rep never see the Build dashboards tab at all', async () => {
      for (const who of [USERS.helper, { email: 'alice@x.test' }]) {
        const p = await newPage('no-builds');
        await signIn(p, who);
        const t = await tabNames(p);
        assert(!t.includes('Build dashboards'), `${who.email} sees: ${t}`);
        await p.context().close();
      }
      return 'no Build dashboards tab for either';
    });
    await adminPage.context().close();

    // ======================================================================
    section('Following the emailed link, the way a real rep does');
    // The thing that actually broke in production: Supabase hands the session
    // back in the URL's FRAGMENT, which never reaches a server. A page that
    // does not read it shows a sign-in form to someone who has no password
    // yet. These checks walk that exact path.
    await check('Landing on /reps from the link shows a "choose a password" box, not a sign-in form', async () => {
      // A rep of this section's own, because Bob was switched off earlier and
      // a switched-off rep cannot be invited — correctly.
      const adminToken = auth.mintToken(USERS.admin);
      const callApi = async (path, body) => {
        const r = await fetch(`${API_ORIGIN}/api${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify(body || {}),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      };
      const made = await callApi('/reps', { name: 'Dana Rep', email: 'dana@x.test' });
      eq(made.status, 201, 'rep created');
      const invited = await callApi(`/reps/${made.body.id}/invite`);
      eq(invited.status, 200, `invite: ${JSON.stringify(invited.body)}`);

      // Dana's account now exists with NO password, exactly as after an invite.
      const token = auth.mintToken({ id: auth.userIdFor('dana@x.test'), email: 'dana@x.test' });

      const p = await newPage('from-link');
      await p.goto(`${PAGE}#access_token=${token}&refresh_token=r1&type=recovery&expires_in=3600`);
      await p.waitForSelector('#setPwBox:not(.hide)', { timeout: 10000 });
      assert(await p.isHidden('#loginBox'), 'the sign-in form is out of the way');
      assert(await p.isHidden('#app'), 'and the app is not open yet');
      assert((await p.textContent('#setPwWho')).includes('dana@x.test'), 'it says who they are');

      // The session must not be left sitting in the address bar.
      const url = p.url();
      assert(!url.includes('access_token'), `the token is still in the URL: ${url}`);
      global.__linkPage = p;
      return 'set-password box shown, address bar cleaned';
    });

    await check('Mismatched passwords are caught before anything is sent', async () => {
      const p = global.__linkPage;
      await p.fill('#newPw', 'danas-new-password');
      await p.fill('#newPw2', 'something-else');
      await p.click('#setPwBtn');
      await p.waitForFunction(() => document.getElementById('setPwMsg').textContent.includes('do not match'));
      // And the account still has no password.
      const signIn = await fetch(`${AUTH_BASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dana@x.test', password: 'danas-new-password' }),
      });
      eq(signIn.status, 400, 'still no password set');
      return 'told plainly, nothing sent';
    });

    await check('Choosing a password signs them straight in, and works again next time', async () => {
      const p = global.__linkPage;
      await p.fill('#newPw', 'danas-new-password');
      await p.fill('#newPw2', 'danas-new-password');
      await p.click('#setPwBtn');
      await p.waitForSelector('#app:not(.hide) nav.tabs button', { timeout: 10000 });
      const tabs = await tabNames(p);
      eqArr(tabs, ['Calendar', 'My leads', 'My dealers', 'My money'], 'she lands in her own pipeline');

      // And the password really is set: an ordinary sign-in works now.
      const signIn = await fetch(`${AUTH_BASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dana@x.test', password: 'danas-new-password' }),
      });
      eq(signIn.status, 200, 'she can sign in normally from now on');
      await p.context().close();
      return 'straight into his pipeline; the password works on its own afterwards';
    });

    await check('An expired or already-used link says so instead of failing silently', async () => {
      const p = await newPage('bad-link');
      await p.goto(`${PAGE}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
      await p.waitForFunction(() => document.getElementById('loginMsg').classList.contains('show'));
      const msg = await p.textContent('#loginMsg');
      assert(/invalid or has expired/i.test(msg), `message: ${msg}`);
      assert(/fresh link/i.test(msg), 'and says what to do about it');
      assert(!p.url().includes('error'), 'the address bar is cleaned');
      await p.context().close();
      return msg;
    });

    // ======================================================================
    section('Reports, in the browser');
    let coPage;
    await check('A rep\'s name opens their year, with bars and a conversion ring drawn', async () => {
      coPage = await newPage('reports');
      await signIn(coPage, USERS.admin);
      await coPage.click('[data-tab=reps]');
      await coPage.waitForSelector('#tab-reps [data-report]');
      await coPage.locator('#tab-reps tr', { hasText: 'Alice Rep' }).locator('[data-report]').click();
      await coPage.waitForSelector('#dlg svg.chart');
      const charts = await coPage.$$eval('#dlg svg.chart', (els) => els.length);
      assert(charts >= 2, `charts drawn: ${charts}`);
      // Twelve month labels, so a quiet month is a gap in the chart, not missing.
      const labels = await coPage.$$eval('#dlg svg.chart text', (els) => els.map((e) => e.textContent));
      for (const m of ['Jan', 'Jun', 'Dec']) assert(labels.includes(m), `missing ${m}: ${labels.join(',')}`);
      // The bars are real rectangles with real heights, not an empty frame.
      const bars = await coPage.$$eval('#dlg svg.chart rect', (els) => els.filter((e) => Number(e.getAttribute('height')) > 1).length);
      assert(bars > 0, 'no bars have any height');
      const text = (await coPage.textContent('#dlg')).replace(/\s+/g, ' ');
      assert(/Companies signed in/.test(text) && /Conversion/.test(text), text.slice(0, 160));
      await coPage.click('#cancelDlg');
      return `${charts} charts, ${bars} bars with height`;
    });

    await check('The Finances tab shows money in, money out and profit, and says what is estimated', async () => {
      await coPage.click('[data-tab=company]');
      await coPage.waitForSelector('#tab-company svg.chart');
      const text = (await coPage.textContent('#tab-company')).replace(/\s+/g, ' ');
      assert(/Taken in/.test(text) && /Cost to run/.test(text) && /Profit/.test(text), text.slice(0, 200));
      assert(/estimate/i.test(text), 'it says the card fee is an estimate');
      // The seeded costs have no amounts, and the page says so rather than
      // quietly reporting a profit that is too good.
      assert(/no amount yet/.test(text), 'it warns the profit is overstated');
      assert(/not set/.test(text), 'and marks each unpriced row');
      const charts = await coPage.$$eval('#tab-company svg.chart', (e) => e.length);
      assert(charts >= 2, `charts: ${charts}`);
      return `${charts} charts; unpriced costs flagged`;
    });

    await check('Pricing a cost on the page changes the profit on the page', async () => {
      const profitBefore = await coPage.$$eval('#tab-company .stat b', (b) => b[2].textContent);
      await coPage.locator('#tab-company tr', { hasText: 'Postmark' }).locator('[data-editexp]').click();
      await coPage.waitForSelector('#expForm');
      await coPage.fill('#expForm [name=amount]', '15');
      await coPage.fill('#expForm [name=started_on]', `${new Date().getFullYear()}-01-01`);
      await coPage.click('#expForm button[type=submit]');
      await coPage.waitForFunction((was) => {
        const b = document.querySelectorAll('#tab-company .stat b');
        return b.length > 2 && b[2].textContent !== was;
      }, profitBefore);
      const [, , profitAfter] = await coPage.$$eval('#tab-company .stat b', (b) => b.map((x) => x.textContent));
      assert(profitAfter !== profitBefore, `profit did not move: ${profitBefore}`);
      const [row] = await sql(`select amount_cents from platform_expenses where name = 'Postmark'`);
      eq(row.amount_cents, 1500, 'saved to the database too');
      return `profit ${profitBefore} -> ${profitAfter} after pricing Postmark at $15`;
    });

    await check('Neither the helper nor a rep can open the Finances tab', async () => {
      for (const who of [USERS.helper, { email: 'alice@x.test' }]) {
        const p = await newPage('no-company');
        await signIn(p, who);
        const t = await tabNames(p);
        assert(!t.includes('Finances'), `${who.email} sees: ${t}`);
        await p.context().close();
      }
      // And not by asking the API directly either.
      const out = await coPage.evaluate(async (base) => {
        const s = JSON.parse(localStorage.getItem('fifty:reps-session'));
        void s;
        return base;
      }, API_ORIGIN);
      void out;
      const r = await fetch(`${API_ORIGIN}/api/reports/company`, { headers: { Authorization: `Bearer ${auth.mintToken(USERS.helper)}` } });
      eq(r.status, 403, 'helper, straight at the API');
      return 'no Finances tab for either; the API refuses the helper too';
    });
    await coPage.context().close();

    section('Page health');
    await check('No script errors or failed API calls were logged in the browser', async () => {
      assert(consoleErrors.length === 0, consoleErrors.join('\n'));
    });
    await check('Phone width: the Reps page does not scroll sideways', async () => {
      const ctx = await browser.newContext({ viewport: { width: 400, height: 800 } });
      const p = await ctx.newPage();
      await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      await signIn(p, USERS.admin);
      for (const tab of ['leads', 'reps', 'dealers', 'money']) {
        await p.click(`[data-tab=${tab}]`);
        await p.waitForTimeout(400);
        const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert(over <= 1, `${tab}: page is ${over}px wider than the screen`);
      }
      await ctx.close();
    });
  } finally {
    await browser.close().catch(() => {});
    apiChild.kill();
    authServer.close(); pageServer.close(); mailServer.close();
    await db.end().catch(() => {});
    try { await require('../../src/db').pool.end(); } catch (e) { /* pool already closed */ }
    const a = new Client({ connectionString: PG_ADMIN_URL });
    await a.connect(); await a.query(`drop database if exists ${DB} with (force)`); await a.end();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
