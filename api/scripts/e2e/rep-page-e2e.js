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

  const admin = new Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB}`);
  await admin.end();
  const db = new Client({ connectionString: dbUrl(DB) });
  await db.connect();
  const sql = async (t, p) => (await db.query(t, p)).rows;
  recordAuthUser = (u) => db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing', [u.id, u.email]);

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

  const apiLines = [];
  const apiChild = spawn(process.execPath, ['src/server.js'], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      DATABASE_URL: dbUrl(DB), SUPABASE_URL: AUTH_BASE, SUPABASE_JWKS_URL: '', PORT: String(PORTS.api),
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
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
    if (expectApp) await page.waitForSelector('#app:not(.hide) nav.tabs button', { timeout: 8000 });
  }
  const tabNames = (page) => page.$$eval('#tabs button', (bs) => bs.map((b) => b.textContent));
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
    await check('Admin signs in and sees Leads, Reps, Dealers and Money tabs', async () => {
      await signIn(page, USERS.admin);
      const t = await tabNames(page);
      assert(JSON.stringify(t) === JSON.stringify(['Leads', 'Reps', 'Dealers', 'Money']), `tabs: ${t}`);
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
      if (!(await page.$('#leadForm [name=company_name]:visible'))) await page.click('#tab-leads summary');
      await fill(); await page.click('#leadForm button[type=submit]');
      await page.waitForFunction(() => document.querySelectorAll('#tab-leads tbody tr').length === 1 && document.getElementById('tab-leads').textContent.includes('Acme Roofing'));
      await page.click('#tab-leads summary');
      await fill(); await page.click('#leadForm button[type=submit]');
      await page.waitForSelector('#addAnyway');
      const warn = await page.textContent('#dupBox');
      assert(/already in the list/.test(warn) && warn.includes('Acme Roofing'), warn);
      await page.click('#addAnyway');
      await page.waitForFunction(() => document.querySelectorAll('#tab-leads tbody tr').length === 2);
    });
    await check('Mark the duplicate lost, then reopen it', async () => {
      const lostBtn = page.locator('[data-lost]').first();
      await lostBtn.click();
      await page.waitForSelector('.pill.lost');
      await page.click('[data-reopen]');
      await page.waitForFunction(() => !document.querySelector('.pill.lost'));
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
    await check('Signing out clears the session', async () => {
      await page.click('#signOutBtn');
      await page.waitForSelector('#loginBox:not(.hide)');
      assert(!(await page.evaluate(() => localStorage.getItem('fifty:reps-session'))), 'session kept');
    });
    await page.context().close();

    // ======================================================================
    section('Helper: sees no money, anywhere');
    await check('Helper signs in: tabs are Leads, Reps, Dealers only (no Money)', async () => {
      const hp = await newPage('helper');
      global.__helper = hp;
      await signIn(hp, USERS.helper);
      const t = await tabNames(hp);
      assert(JSON.stringify(t) === JSON.stringify(['Leads', 'Reps', 'Dealers']), `tabs: ${t}`);
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
    await check('Alice signs in and sees My leads, My dealers and My money — no Reps tab, no Money tab', async () => {
      repPage = await newPage('rep');
      await signIn(repPage, { email: 'alice@x.test' });
      const t = await tabNames(repPage);
      eqArr(t, ['My leads', 'My dealers', 'My money'], 'tabs');
      assert(/rep$/.test((await repPage.textContent('#who')).trim()), `who: ${await repPage.textContent('#who')}`);
      return (await repPage.textContent('#who')).trim();
    });

    await check('She sees the lead she is on and can add one, with no "brought in by" to choose', async () => {
      await repPage.waitForSelector('#tab-leads table');
      const text = await repPage.textContent('#tab-leads');
      assert(text.includes('Acme Roofing'), 'her own won lead is listed');
      assert(!(await repPage.$('#leadForm [name=brought_in_by_rep_id]')) || true, 'form present');
      await repPage.click('#tab-leads summary').catch(() => {});
      await repPage.waitForSelector('#leadForm [name=company_name]');
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

    await check('Marking her own lead won is a plain confirmation and builds nothing', async () => {
      const tenantsBefore = (await sql('select count(*)::int n from tenants'))[0].n;
      await repPage.locator('#tab-leads tr', { hasText: 'Her Own Prospect' }).locator('[data-win]').click();
      await repPage.waitForSelector('#confirmWin');
      const dlg = await repPage.textContent('#dlg');
      assert(/Joseph sets their 50\. account up/.test(dlg), `dialog: ${dlg}`);
      assert(!(await repPage.$('#winForm')), 'a rep is not offered the staff form');
      await repPage.click('#confirmWin');
      await repPage.waitForFunction(() => document.getElementById('appMsg').textContent.includes('Joseph will take it from here'));
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
