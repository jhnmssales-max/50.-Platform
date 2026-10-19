#!/usr/bin/env node
// Drives the Calendar tab (fifty-reps.html) and the follow-up endpoints in
// headless Chromium against the real API, a real Postgres built from every
// migration, and the Supabase Auth stand-in — as the 50. admin and as two
// different reps, because "only your own" is the whole point of the feature.
//
//   node scripts/e2e/rep-calendar-e2e.js [--headed]
//
// Same scratch Postgres as the other e2e scripts (E2E_PG_ADMIN_URL).
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
const DB = `fifty_calendar_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const PORTS = { api: 3107, auth: 9991, page: 8094, postmark: 12118 };
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
  admin: { id: 'c0000000-0000-4000-8000-0000000000a1', email: 'joseph@fifty.test', name: 'Joseph', role: 'admin', tenant: '50-platform' },
  alice: { id: 'c0000000-0000-4000-8000-0000000000a2', email: 'alice@fifty.test', name: 'Alice Rep', role: 'rep', tenant: '50-platform' },
  bob:   { id: 'c0000000-0000-4000-8000-0000000000a3', email: 'bob@fifty.test', name: 'Bob Rep', role: 'rep', tenant: '50-platform' },
};
const REPS = {
  alice: 'd0000000-0000-4000-8000-0000000000a2',
  bob:   'd0000000-0000-4000-8000-0000000000a3',
};

// Dates are built from LOCAL parts, exactly as the page does, so the test and
// the page agree about what "today" is near midnight.
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
const TODAY = isoDay(new Date());

async function main() {
  let recordAuthUser = async () => {};
  const auth = createAuthStandIn({ onUserCreated: (u) => recordAuthUser(u) });
  const authServer = auth.app.listen(PORTS.auth, '127.0.0.1');
  const postmarkSent = [];
  const postmark = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => { postmarkSent.push(JSON.parse(body || '{}')); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ MessageID: 'm1', ErrorCode: 0 })); });
  });
  postmark.listen(PORTS.postmark, '127.0.0.1');

  const admin = new Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
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
  // Two dealers that went live, one each. The timestamps are 02:00Z, which is
  // 10pm Eastern the DAY BEFORE — the case that puts a milestone on the wrong
  // day if anything treats a timestamptz as a date without converting first.
  for (const [slug, name, paid] of [['dealer-a', 'Alice Dealer', `${addDays(-8)}T02:00:00Z`], ['dealer-b', 'Bob Dealer', `${addDays(-6)}T02:00:00Z`]]) {
    const [t] = await sql(`insert into tenants (slug, name, billing_status, billing_required, activation_paid_at, activation_livemode) values ($1,$2,'active',true,$3,true) returning id, slug, name`, [slug, name, paid]);
    tenants[slug] = t;
  }
  for (const u of Object.values(USERS)) {
    await sql('insert into auth.users (id, email) values ($1,$2)', [u.id, u.email]);
    await sql('insert into users (id, tenant_id, email, name, role) values ($1,$2,$3,$4,$5)', [u.id, tenants[u.tenant].id, u.email, u.name, u.role]);
    auth.addUser({ id: u.id, email: u.email, password: PASSWORD });
  }
  await sql('insert into reps (id,name,email,user_id) values ($1,$2,$3,$4),($5,$6,$7,$8)',
    [REPS.alice, 'Alice Rep', USERS.alice.email, USERS.alice.id, REPS.bob, 'Bob Rep', USERS.bob.email, USERS.bob.id]);
  await sql(`insert into rep_leads (company_name,brought_in_by_rep_id,closed_by_rep_id,status,closed_on,tenant_id) values
      ('Alice Dealer',$1,$1,'won',$3,$5), ('Bob Dealer',$2,$2,'won',$4,$6)`,
    [REPS.alice, REPS.bob, addDays(-10), addDays(-9), tenants['dealer-a'].id, tenants['dealer-b'].id]);
  await sql(`insert into rep_leads (company_name,brought_in_by_rep_id,status) values ('Chasing Co',$1,'open')`, [REPS.alice]);
  await sql(`insert into rep_assignments (tenant_id,closer_rep_id,onboarder_rep_id,effective_from) values ($1,$2,$2,now()),($3,$4,$4,now())`,
    [tenants['dealer-a'].id, REPS.alice, tenants['dealer-b'].id, REPS.bob]);

  const apiLines = [];
  const apiChild = spawn(process.execPath, ['src/server.js'], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      DATABASE_URL: dbUrl(DB), SUPABASE_URL: AUTH_BASE, SUPABASE_JWKS_URL: '', PORT: String(PORTS.api),
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      POSTMARK_SERVER_TOKEN: 'postmark-test-token', POSTMARK_API_BASE: `http://127.0.0.1:${PORTS.postmark}`,
      EMAIL_FROM_ADDRESS: 'notifications@referwith50.test',
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

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: !headed });
  const consoleErrors = [];
  async function newPage(label, viewport = { width: 1200, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => consoleErrors.push(`${label}: pageerror ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) consoleErrors.push(`${label}: ${m.text()}`); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    return page;
  }
  async function signIn(page, u) {
    await page.goto(PAGE);
    await page.fill('#email', u.email);
    await page.fill('#password', PASSWORD);
    await page.click('#loginBtn');
    await page.waitForSelector('#app:not(.hide) nav.tabs button', { timeout: 8000 });
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  // The Calendar tab is the first tab, so signing in lands on it. Waiting for
  // the month heading rather than the section means the fetch has come back.
  // flash() smooth-scrolls the window, so a tab button is never "stable" while
  // a message is on screen and a real click times out. The click path is
  // covered by its own check below; everywhere else, go straight to the tab.
  async function onCalendar(page) {
    await page.evaluate(() => showTab('calendar'));
    await page.waitForSelector('#tab-calendar .calhead h3', { timeout: 8000 });
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  async function clickToCalendar(page) {
    await page.evaluate(() => { const el = document.getElementById('appMsg'); if (el) el.className = 'msg'; window.scrollTo(0, 0); });
    await page.click('#tabs button:has-text("Calendar")', { timeout: 8000 });
    await page.waitForSelector('#tab-calendar .calhead h3', { timeout: 8000 });
  }
  // A dialog that was closed keeps its markup, so waiting on a selector alone
  // can match the LAST dialog. Wait for the heading text that belongs to this
  // one.
  async function followupForm(page, heading) {
    await page.waitForFunction(
      (h) => { const d = document.getElementById('dlg'); return d && d.open && d.querySelector('h3') && d.querySelector('h3').textContent.includes(h); },
      heading, { timeout: 6000 }
    );
    await page.waitForSelector('#fuTitle', { state: 'visible', timeout: 4000 });
  }
  const dueTitles = (page) => page.$$eval('#tab-calendar .due .what b', (bs) => bs.map((b) => b.textContent.trim()));
  const chipTexts = (page) => page.$$eval('#tab-calendar .calgrid .chip', (cs) => cs.map((c) => c.textContent.trim()));

  async function token(u) {
    const r = await fetch(`${AUTH_BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: u.email, password: PASSWORD }),
    });
    return (await r.json()).access_token;
  }
  async function apiAs(u, path, init = {}) {
    const res = await fetch(`${API_ORIGIN}/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(u)}`, ...(init.headers || {}) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  try {
    const alice = await newPage('alice');
    await signIn(alice, USERS.alice);

    section('The tab is there, and it is the one you land on');
    await check('Calendar is a rep’s first tab, and the page still opens on Leads', async () => {
      const names = await alice.$$eval('#tabs button', (bs) => bs.map((b) => b.textContent.trim()));
      assert(names[0] === 'Calendar', `tabs are ${JSON.stringify(names)}`);
      // Adding a tab should not move anyone's furniture: the habit is Leads.
      const on = await alice.$eval('#tabs button.on', (b) => b.textContent.trim());
      assert(on === 'My leads', `the page opened on ${on}, not My leads`);
      return `tabs: ${names.join(', ')}; opened on ${on}`;
    });
    await check('clicking the Calendar tab opens it', async () => {
      await clickToCalendar(alice);
      const on = await alice.$eval('#tabs button.on', (b) => b.textContent.trim());
      assert(on === 'Calendar', `the tab bar still says ${on}`);
      const shown = await alice.$eval('#tab-calendar', (el) => !el.classList.contains('hide'));
      assert(shown, 'the section is still hidden');
      return 'clicked through from My leads';
    });
    await check('the month grid draws, with today marked once', async () => {
      await onCalendar(alice);
      const days = await alice.$$eval('#tab-calendar .calgrid .day', (d) => d.length);
      const today = await alice.$$eval('#tab-calendar .calgrid .day.today', (d) => d.length);
      assert(days >= 28, `only ${days} day cells`);
      assert(today === 1, `${today} cells marked today, expected exactly 1`);
      return `${days} cells`;
    });

    section('Adding a follow-up');
    await check('one typed on the Calendar tab lands in the list and on the grid', async () => {
      await alice.click('#calAdd');
      await followupForm(alice, 'Add a follow-up');
      await alice.fill('#fuTitle', 'Ring the Hershey job');
      await alice.fill('#fuDate', TODAY);
      await alice.fill('#fuTime', '09:30');
      await alice.fill('#fuNote', 'he asked about the ramp price');
      await alice.click('#fuSave');
      await alice.waitForFunction(() => !document.getElementById('dlg').open, null, { timeout: 6000 });
      await alice.waitForSelector('#tab-calendar .due', { timeout: 6000 });
      const titles = await dueTitles(alice);
      assert(titles.includes('Ring the Hershey job'), `list holds ${JSON.stringify(titles)}`);
      const chips = await chipTexts(alice);
      assert(chips.some((c) => /Ring the Hershey job/.test(c)), `grid holds ${JSON.stringify(chips)}`);
      return titles.join(' | ');
    });
    await check('the time she set is shown, not swallowed', async () => {
      const when = await alice.$$eval('#tab-calendar .due .when', (ws) => ws.map((w) => w.textContent.trim()));
      assert(when.some((w) => /9:30am/.test(w)), `whens are ${JSON.stringify(when)}`);
      const chips = await chipTexts(alice);
      assert(chips.some((c) => /9:30am/.test(c)), `chips are ${JSON.stringify(chips)}`);
      return when.find((w) => /9:30am/.test(w));
    });
    await check('her note is on the row', async () => {
      const notes = await alice.$$eval('#tab-calendar .due .what p', (ps) => ps.map((p) => p.textContent.trim()));
      assert(notes.includes('he asked about the ramp price'), `notes are ${JSON.stringify(notes)}`);
    });

    section('Set from a lead, without retyping the company');
    await check('the Follow up button on a lead pre-fills its name', async () => {
      await alice.click('#tabs button:has-text("My leads")');
      // Follow up moved behind the row's "More" button.
      await alice.waitForSelector('#tab-leads [data-leadmore]', { timeout: 8000 });
      await alice.click('#tab-leads [data-leadmore]');
      await alice.waitForSelector('#dlg [data-more=followup]', { timeout: 6000 });
      await alice.click('#dlg [data-more=followup]');
      await followupForm(alice, 'Add a follow-up');
      const v = await alice.inputValue('#fuTitle');
      assert(/Follow up with /.test(v), `title box reads "${v}"`);
      return v;
    });
    await check('and it saves against that lead', async () => {
      await alice.fill('#fuDate', addDays(3));
      await alice.click('#fuSave');
      await alice.waitForFunction(() => !document.getElementById('dlg').open, null, { timeout: 6000 });
      const rows = await sql('select title, lead_id from rep_followups where user_id = $1 and lead_id is not null', [USERS.alice.id]);
      assert(rows.length === 1, `${rows.length} follow-ups carry a lead_id`);
      return `${rows[0].title} -> lead ${String(rows[0].lead_id).slice(0, 8)}`;
    });

    section('Only your own — the whole point');
    const bob = await newPage('bob');
    await signIn(bob, USERS.bob);
    await check('Bob sees none of Alice’s follow-ups', async () => {
      await onCalendar(bob);
      const titles = await dueTitles(bob);
      assert(!titles.some((t) => /Hershey|Follow up with/.test(t)), `Bob can see ${JSON.stringify(titles)}`);
      const chips = await chipTexts(bob);
      assert(!chips.some((c) => /Hershey/.test(c)), `Bob’s grid shows ${JSON.stringify(chips)}`);
      return `Bob's list: ${titles.length ? titles.join(' | ') : '(empty)'}`;
    });
    await check('nor can he reach one by id over the API', async () => {
      const [row] = await sql("select id from rep_followups where title = 'Ring the Hershey job'");
      const r = await apiAs(USERS.bob, `/rep-followups/${row.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'stolen' }) });
      assert(r.status === 404, `expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
      const [after] = await sql('select title from rep_followups where id = $1', [row.id]);
      assert(after.title === 'Ring the Hershey job', `title was changed to "${after.title}"`);
      return `PATCH as Bob -> ${r.status}, title intact`;
    });
    await check('nor delete one', async () => {
      const [row] = await sql("select id from rep_followups where title = 'Ring the Hershey job'");
      const r = await apiAs(USERS.bob, `/rep-followups/${row.id}`, { method: 'DELETE' });
      assert(r.status === 404, `expected 404, got ${r.status}`);
      const [{ n }] = await sql("select count(*)::int as n from rep_followups where title = 'Ring the Hershey job'");
      assert(n === 1, 'the follow-up was deleted by someone else');
      return `DELETE as Bob -> ${r.status}`;
    });
    // rep_calendar() is security definer, so RLS does NOT apply inside it —
    // its own `f.user_id = me.user_id` is what scopes the page. That leaves a
    // second path: `authenticated` is granted select on rep_followups, so
    // anyone holding a token could query the table directly. RLS is the only
    // thing guarding that, and the page never exercises it, so check it here
    // the way a direct query would arrive.
    await check('a direct query on the table, as Bob, returns only Bob’s row', async () => {
      const probe = new Client({ connectionString: dbUrl(DB) });
      await probe.connect();
      try {
        await probe.query('begin');
        await probe.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: USERS.bob.id })]);
        await probe.query('set local role authenticated');
        const { rows } = await probe.query('select title from rep_followups');
        await probe.query('rollback');
        const titles = rows.map((r) => r.title).sort();
        const total = (await sql('select count(*)::int as n from rep_followups'))[0].n;
        assert(total > titles.length, `the table only holds ${total} rows, so this proves nothing`);
        assert(!titles.some((t) => /Hershey|Carlisle/.test(t)), `Bob can read ${JSON.stringify(titles)}`);
        return `${titles.length} of ${total} rows visible to Bob`;
      } finally { await probe.end().catch(() => {}); }
    });
    await check('a follow-up filed under someone else’s id still lands on your own', async () => {
      // The body has no user_id field, so the only thing that can set it is
      // the token. This proves a crafted body cannot redirect it.
      const r = await apiAs(USERS.bob, '/rep-followups', {
        method: 'POST',
        body: JSON.stringify({ title: 'planted', due_on: TODAY, user_id: USERS.alice.id }),
      });
      assert(r.status === 201, `expected 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const [row] = await sql("select user_id from rep_followups where title = 'planted'");
      assert(row.user_id === USERS.bob.id, `it was filed under ${row.user_id}`);
      return 'filed under Bob, as it should be';
    });

    section('Milestones: derived, scoped, and on the right day');
    await check('Alice sees her own dealer going live and not Bob’s', async () => {
      const r = await apiAs(USERS.alice, `/rep-calendar?from=${addDays(-30)}&to=${addDays(30)}`);
      const live = r.body.items.filter((i) => i.kind === 'dealer_live').map((i) => i.title);
      assert(live.includes('Alice Dealer'), `she sees ${JSON.stringify(live)}`);
      assert(!live.includes('Bob Dealer'), `she can see Bob's dealer: ${JSON.stringify(live)}`);
      return live.join(', ');
    });
    await check('Joseph sees both reps’ milestones', async () => {
      const r = await apiAs(USERS.admin, `/rep-calendar?from=${addDays(-30)}&to=${addDays(30)}`);
      const live = r.body.items.filter((i) => i.kind === 'dealer_live').map((i) => i.title).sort();
      assert(live.join(',') === 'Alice Dealer,Bob Dealer', `admin sees ${JSON.stringify(live)}`);
      return live.join(', ');
    });
    await check('but not their follow-ups', async () => {
      const r = await apiAs(USERS.admin, `/rep-calendar?from=${addDays(-30)}&to=${addDays(30)}`);
      const fu = r.body.items.filter((i) => i.kind === 'followup').map((i) => i.title);
      assert(fu.length === 0, `admin can see ${JSON.stringify(fu)}`);
      return 'admin sees 0 follow-ups';
    });
    await check('a 10pm-Eastern activation lands on that evening, not the next day', async () => {
      // dealer-a was stamped 02:00Z, i.e. 10pm Eastern the day before.
      const r = await apiAs(USERS.alice, `/rep-calendar?from=${addDays(-30)}&to=${addDays(30)}`);
      const it = r.body.items.find((i) => i.kind === 'dealer_live' && i.title === 'Alice Dealer');
      assert(it, 'the activation is missing entirely');
      const got = String(it.on_date).slice(0, 10);
      assert(got === addDays(-9), `stamped ${addDays(-8)}T02:00:00Z, which is ${addDays(-9)} Eastern, but it shows on ${got}`);
      return `02:00Z on ${addDays(-8)} -> ${got}`;
    });
    await check('a lead lands on the calendar the day it is added', async () => {
      // Joseph asked for this: entering a lead should put it on the calendar
      // by itself, without anyone writing a follow-up for it.
      await sql(
        `insert into rep_leads (company_name, brought_in_by_rep_id, status, found_on)
         values ('Brand New Prospect', $1, 'open', $2)`,
        [REPS.alice, addDays(-2)]
      );
      const hers = await apiAs(USERS.alice, `/rep-calendar?from=${addDays(-30)}&to=${addDays(30)}`);
      const added = hers.body.items.filter((i) => i.kind === 'lead_added').map((i) => i.title);
      assert(added.includes('Brand New Prospect'), `her own lead is missing: ${JSON.stringify(added)}`);
      const it = hers.body.items.find((i) => i.kind === 'lead_added' && i.title === 'Brand New Prospect');
      assert(String(it.on_date).slice(0, 10) === addDays(-2), `it landed on ${it.on_date}, not ${addDays(-2)}`);

      // An open lead, never won — the point is that it does not wait for a win.
      const [row] = await sql(`select status from rep_leads where company_name = 'Brand New Prospect'`);
      assert(row.status === 'open', `the fixture is not an open lead: ${row.status}`);

      // Bob must not see it; Joseph must.
      const his = await apiAs(USERS.bob, `/rep-calendar?from=${addDays(-30)}&to=${addDays(30)}`);
      assert(!his.body.items.some((i) => i.title === 'Brand New Prospect'), 'another rep can see it');
      const boss = await apiAs(USERS.admin, `/rep-calendar?from=${addDays(-30)}&to=${addDays(30)}`);
      assert(boss.body.items.some((i) => i.kind === 'lead_added' && i.title === 'Brand New Prospect'), 'the admin cannot see it');
      return `added ${addDays(-2)}, visible to her and the admin, not to Bob`;
    });

    await check('a lead that said yes is on the calendar', async () => {
      const r = await apiAs(USERS.alice, `/rep-calendar?from=${addDays(-30)}&to=${addDays(30)}`);
      const won = r.body.items.filter((i) => i.kind === 'lead_won').map((i) => i.title);
      assert(won.includes('Alice Dealer'), `lead_won holds ${JSON.stringify(won)}`);
      assert(!won.includes('Bob Dealer'), 'she can see Bob’s win');
      return won.join(', ');
    });

    section('Ticking off, rescheduling, deleting');
    await check('Done takes it off the list', async () => {
      await onCalendar(alice);
      await alice.click('#tab-calendar .due [data-tick]');
      await alice.waitForFunction(
        () => ![...document.querySelectorAll('#tab-calendar .due .what b')].some((b) => b.textContent.includes('Ring the Hershey job')),
        null, { timeout: 6000 }
      );
      const titles = await dueTitles(alice);
      assert(!titles.includes('Ring the Hershey job'), `still listed: ${JSON.stringify(titles)}`);
      return titles.length ? titles.join(' | ') : '(list now empty)';
    });
    await check('it is struck through on the grid, not gone', async () => {
      const done = await alice.$$eval('#tab-calendar .calgrid .chip.done', (cs) => cs.map((c) => c.textContent.trim()));
      assert(done.some((c) => /Ring the Hershey job/.test(c)), `done chips: ${JSON.stringify(done)}`);
      return done.join(' | ');
    });
    await check('rescheduling moves it', async () => {
      const [row] = await sql("select id from rep_followups where title like 'Follow up with %'");
      const r = await apiAs(USERS.alice, `/rep-followups/${row.id}`, { method: 'PATCH', body: JSON.stringify({ due_on: addDays(1) }) });
      assert(r.status === 200, `got ${r.status}`);
      assert(String(r.body.followup.due_on).slice(0, 10) === addDays(1), `moved to ${r.body.followup.due_on}`);
      return `now ${addDays(1)}`;
    });
    await check('deleting removes it for good', async () => {
      const [row] = await sql("select id from rep_followups where title = 'planted'");
      const r = await apiAs(USERS.bob, `/rep-followups/${row.id}`, { method: 'DELETE' });
      assert(r.status === 200, `got ${r.status}`);
      const [{ n }] = await sql("select count(*)::int as n from rep_followups where title = 'planted'");
      assert(n === 0, 'it is still there');
      return 'gone';
    });

    section('Overdue');
    await check('something left from last week reads as overdue, with its age', async () => {
      await apiAs(USERS.alice, '/rep-followups', { method: 'POST', body: JSON.stringify({ title: 'Chase the Carlisle quote', due_on: addDays(-4) }) });
      await onCalendar(alice);
      await alice.waitForSelector('#tab-calendar .due.overdue', { timeout: 6000 });
      const when = await alice.$eval('#tab-calendar .due.overdue .when', (w) => w.textContent.trim());
      assert(/4 days ago/.test(when), `overdue row reads "${when}"`);
      return when;
    });
    await check('and it sorts above what is due later', async () => {
      const titles = await dueTitles(alice);
      assert(titles[0] === 'Chase the Carlisle quote', `order is ${JSON.stringify(titles)}`);
      return titles.join(' -> ');
    });

    section('Layout');
    await check('no chip spills out of its day cell', async () => {
      const spills = await alice.$$eval('#tab-calendar .calgrid .day', (days) => {
        const bad = [];
        for (const d of days) {
          const box = d.getBoundingClientRect();
          for (const c of d.querySelectorAll('.chip')) {
            const r = c.getBoundingClientRect();
            if (r.right > box.right + 1 || r.left < box.left - 1) bad.push(`${c.textContent.trim()} by ${Math.round(Math.max(r.right - box.right, box.left - r.left))}px`);
          }
        }
        return bad;
      });
      assert(spills.length === 0, `chips outside their cell: ${spills.join('; ')}`);
      return 'every chip inside its cell';
    });
    await check('the page does not scroll sideways on a phone', async () => {
      const phone = await newPage('phone', { width: 390, height: 780 });
      await signIn(phone, USERS.alice);
      await onCalendar(phone);
      const over = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 1, `${over}px of sideways scroll`);
      const list = await phone.$$eval('#tab-calendar .due', (d) => d.length);
      assert(list >= 1, 'the list is missing at phone width, where it is the whole tab');
      await phone.context().close();
      return `${over}px overflow, ${list} rows still listed`;
    });

    section('The reminder email');
    await check('the morning digest carries only your own items', async () => {
      process.env.DATABASE_URL = dbUrl(DB);
      process.env.POSTMARK_API_BASE = `http://127.0.0.1:${PORTS.postmark}`;
      process.env.POSTMARK_SERVER_TOKEN = 'postmark-test-token';
      process.env.EMAIL_FROM_ADDRESS = 'notifications@referwith50.test';
      process.env.FRONTEND_BASE_URL = `http://127.0.0.1:${PORTS.page}`;
      const { runFollowupReminderCycle } = require('../../src/workers/followupReminders');
      const before = postmarkSent.length;
      await runFollowupReminderCycle({ force: true });
      const fresh = postmarkSent.slice(before);
      const toAlice = fresh.find((m) => m.To === USERS.alice.email);
      assert(toAlice, `nobody emailed Alice; got ${JSON.stringify(fresh.map((m) => m.To))}`);
      assert(/Chase the Carlisle quote/.test(toAlice.TextBody), 'her overdue item is missing from the digest');
      assert(!/Bob/.test(toAlice.TextBody), 'Bob is named in Alice’s digest');
      return `${fresh.length} digest(s); Alice's subject: ${toAlice.Subject}`;
    });
    await check('a second run the same morning sends nothing more', async () => {
      const { runFollowupReminderCycle } = require('../../src/workers/followupReminders');
      const before = postmarkSent.length;
      await runFollowupReminderCycle({ force: true });
      assert(postmarkSent.length === before, `${postmarkSent.length - before} duplicate emails`);
      return 'no duplicates';
    });

    section('Nothing broken underneath');
    await check('no JavaScript errors anywhere in the run', () => {
      assert(consoleErrors.length === 0, consoleErrors.slice(0, 5).join('\n'));
      return 'clean console';
    });
  } finally {
    await browser.close().catch(() => {});
    pageServer.close(); authServer.close(); postmark.close();
    apiChild.kill();
    // The worker opened its own pool against this database; a pool still
    // holding a connection makes the drop below fail with 55006.
    await require('../../src/db').pool.end().catch(() => {});
    await db.end().catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const drop = new Client({ connectionString: PG_ADMIN_URL });
    await drop.connect(); await drop.query(`drop database if exists ${DB}`); await drop.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('\nFailed:'); for (const f of failed) console.log(`  ${f.section} :: ${f.title}`); }
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
