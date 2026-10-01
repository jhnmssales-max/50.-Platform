#!/usr/bin/env node
// End-to-end verification of the new-dealer activation gate and the
// referral usage fee — the whole path, through the real API process, the
// real dealer page in a real browser (Playwright/Chromium), and a real
// Postgres database built from every migration in supabase/migrations.
//
//   node scripts/e2e/activation-gate-e2e.js                  # Stripe stand-in (default)
//   node scripts/e2e/activation-gate-e2e.js --stripe=test    # real Stripe TEST mode
//
// Options: --out=<dir> (results: results.md, results.json, api.log),
// --keep-db (leave the throwaway databases behind), --headed.
//
// Needs: a scratch Postgres 16 server you can create databases on
// (E2E_PG_ADMIN_URL, default postgresql://postgres@127.0.0.1:54329/postgres)
// and Playwright (`npm i --no-save playwright` if it isn't already
// resolvable). It creates its own databases (fifty_e2e_<timestamp>_*),
// bootstraps Supabase's auth schema/roles into them
// (supabase-stand-in.sql), and drops them at the end. It refuses to run
// against anything that looks like a Supabase project.
//
// --stripe=stand-in: Stripe is the local stand-in (stripe-stand-in.js),
// reached through stripe-stand-in-preload.js — the API itself is
// configured exactly like a real deployment on a test key. Everything
// runs unattended, including failure paths real Stripe can't easily
// produce on demand (a dropped response after a charge, a held webhook).
//
// --stripe=test: real Stripe test mode. Requires STRIPE_SECRET_KEY=sk_test_…
// (anything else is refused), and STRIPE_WEBHOOK_SECRET=whsec_… from
//   stripe listen --all-snapshot --forward-to http://127.0.0.1:${E2E_API_PORT:-3100}/api/webhooks/stripe
// running alongside, so Stripe's own signed webhooks reach this API. The
// Checkout payment is completed on Stripe's real hosted page with test
// card 4242 4242 4242 4242 — automatically when possible, otherwise the
// runner prints the URL and waits for it to be paid by hand. Runs the
// checks real Stripe can back; stand-in-only failure injection is
// skipped and reported as such.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const express = require('express');
const { Client } = require('pg');
const { createStripeStandIn } = require('./stripe-stand-in');
const { createAuthStandIn } = require('./auth-stand-in');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_DIR = path.join(REPO_ROOT, 'api');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const NEW_MIGRATION = '20261001000000_activation_gate_and_referral_fee.sql';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const MODE = args.stripe || 'stand-in';
if (!['stand-in', 'test'].includes(MODE)) throw new Error('--stripe must be stand-in or test');
const STAND_IN = MODE === 'stand-in';
const OUT_DIR = path.resolve(args.out || path.join(os.tmpdir(), `fifty-e2e-${MODE}`));
const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:54329/postgres';
const PORTS = {
  api: Number(process.env.E2E_API_PORT || 3100),
  alt: Number(process.env.E2E_ALT_API_PORT || 3101),
  stripe: Number(process.env.E2E_STRIPE_PORT || 12111),
  auth: Number(process.env.E2E_AUTH_PORT || 9996),
  static: Number(process.env.E2E_STATIC_PORT || 8088),
};
const RUN_ID = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const DB_MAIN = `fifty_e2e_${RUN_ID}_main`;
const DB_NEG = `fifty_e2e_${RUN_ID}_slugcheck`;

const STATIC_BASE = `http://127.0.0.1:${PORTS.static}`;
const DEALER_URL = `${STATIC_BASE}/fifty-template-dealer.html`;
const API_BASE = `http://127.0.0.1:${PORTS.api}`;
const STRIPE_BASE = `http://127.0.0.1:${PORTS.stripe}`;
const AUTH_BASE = `http://127.0.0.1:${PORTS.auth}`;

const STRIPE_KEY = STAND_IN ? 'sk_test_e2eStandInKey0000000000' : process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = STAND_IN ? 'whsec_e2eStandInSecret0000000000' : process.env.STRIPE_WEBHOOK_SECRET;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
const results = [];
let currentSection = '';
function section(name) {
  currentSection = name;
  console.log(`\n=== ${name}`);
}
async function check(title, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    results.push({ section: currentSection, title, pass: true, evidence: evidence || '', ms: Date.now() - started });
    console.log(`  PASS  ${title}${evidence ? `\n        ${evidence}` : ''}`);
  } catch (err) {
    results.push({ section: currentSection, title, pass: false, evidence: err.message, ms: Date.now() - started });
    console.log(`  FAIL  ${title}\n        ${err.message}`);
  }
}
function skip(title, why) {
  results.push({ section: currentSection, title, pass: null, evidence: `skipped: ${why}` });
  console.log(`  SKIP  ${title} — ${why}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function eq(actual, expected, what) {
  assert(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
function dbUrl(name) {
  const u = new URL(PG_ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

async function withClient(url, fn) {
  const client = new Client({ connectionString: url });
  const notices = [];
  client.on('notice', (n) => notices.push(n.message));
  await client.connect();
  try {
    return await fn(client, notices);
  } finally {
    await client.end();
  }
}

async function createDatabase(name) {
  await withClient(PG_ADMIN_URL, async (c) => {
    await c.query(`drop database if exists ${name}`);
    await c.query(`create database ${name}`);
  });
}

async function dropDatabase(name) {
  await withClient(PG_ADMIN_URL, (c) => c.query(`drop database if exists ${name} with (force)`)).catch(() => {});
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

// Supabase stand-in + every migration *before* the new one, then seedSql
// (the tenants that exist in production before this change).
async function bootstrapDatabase(name, seedSql) {
  await createDatabase(name);
  await withClient(dbUrl(name), async (c) => {
    await c.query(fs.readFileSync(path.join(__dirname, 'supabase-stand-in.sql'), 'utf8'));
    for (const file of migrationFiles()) {
      if (file === NEW_MIGRATION) continue;
      await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }
    if (seedSql) await c.query(seedSql);
  });
}

async function applyNewMigration(name) {
  return withClient(dbUrl(name), async (c, notices) => {
    try {
      await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, NEW_MIGRATION), 'utf8'));
      return { ok: true, notices };
    } catch (err) {
      await c.query('rollback').catch(() => {});
      return { ok: false, notices, error: err };
    }
  });
}

let mainDb;
async function sql(text, params) {
  const { rows } = await mainDb.query(text, params);
  return rows;
}

// Runs SQL exactly the way Supabase's REST API would for a signed-in
// user: role authenticated, with that user's JWT claims — what a tenant
// admin could send directly with the same login token the dealer page
// holds.
async function sqlAsUser(userId, text) {
  await mainDb.query('begin');
  try {
    await mainDb.query('set local role authenticated');
    await mainDb.query(
      `select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
      [userId, JSON.stringify({ sub: userId, role: 'authenticated' })]
    );
    const res = await mainDb.query(text);
    return { ok: true, rowCount: res.rowCount };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await mainDb.query('rollback');
  }
}

// ---------------------------------------------------------------------------
// Processes and servers
// ---------------------------------------------------------------------------
const apiProcesses = [];

function apiEnv(overrides) {
  // Every variable the API reads is set explicitly, so nothing is ever
  // picked up from a developer's own api/.env (dotenv never overrides a
  // variable that's already set, empty or not) — no real database, real
  // Postmark, or real Stripe key can leak into a test run.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || '',
    NODE_USE_ENV_PROXY: STAND_IN ? '' : process.env.NODE_USE_ENV_PROXY || '',
    HTTPS_PROXY: STAND_IN ? '' : process.env.HTTPS_PROXY || '',
    https_proxy: STAND_IN ? '' : process.env.https_proxy || '',
    NO_PROXY: process.env.NO_PROXY || '',
    no_proxy: process.env.no_proxy || '',
    DATABASE_URL: dbUrl(DB_MAIN),
    SUPABASE_URL: AUTH_BASE,
    SUPABASE_JWKS_URL: '',
    TRUST_PROXY: '1',
    POSTMARK_SERVER_TOKEN: '',
    POSTMARK_API_BASE: 'http://127.0.0.1:9/',
    EMAIL_FROM_ADDRESS: '',
    FRONTEND_BASE_URL: STATIC_BASE,
    TENANT_CREDENTIALS_ENCRYPTION_KEY: 'e2e-only-passphrase',
    TREMENDOUS_API_BASE: 'http://127.0.0.1:9/',
    STRIPE_SECRET_KEY: STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_API_BASE: '',
    STRIPE_STAND_IN_URL: STAND_IN ? `${STRIPE_BASE}/v1` : '',
    GIFT_CARD_PROVIDER: '',
    GIFT_CARD_STUB_FAIL_KEYS: '',
    REWARD_CYCLE_MAX_CENTS: '',
    ...overrides,
  };
}

function startApi({ port, env = {}, preload = STAND_IN, label = 'api', expectExit = false }) {
  return new Promise((resolve, reject) => {
    const nodeArgs = preload ? ['-r', path.join(__dirname, 'stripe-stand-in-preload.js'), 'src/server.js'] : ['src/server.js'];
    const child = spawn(process.execPath, nodeArgs, { cwd: API_DIR, env: apiEnv({ PORT: String(port), ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    const proc = { child, lines, label, port, exitCode: null };
    let settled = false;
    const onData = (stream) => (buf) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        lines.push(`[${label}:${stream}] ${line}`);
        if (!settled && line.includes('listening on')) {
          settled = true;
          setTimeout(() => resolve(proc), 50);
        }
      }
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));
    // 'close', not 'exit': it fires only once stdout/stderr are drained,
    // so a process that refuses to start has its whole message captured.
    child.on('close', (code, signal) => {
      proc.exitCode = code === null ? signal : code;
      if (!settled) {
        settled = true;
        if (expectExit) resolve(proc);
        else reject(new Error(`${label} exited with ${proc.exitCode} before listening:\n${lines.join('\n')}`));
      }
    });
    apiProcesses.push(proc);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`${label} did not start within 15s:\n${lines.join('\n')}`));
      }
    }, 15000);
  });
}

// A process killed by a signal reports exitCode null (and signalCode
// set), so "has it exited" is either one, never exitCode alone.
async function stopApi(proc) {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return;
  const exited = new Promise((r) => proc.child.once('exit', r));
  proc.child.kill('SIGTERM');
  await exited;
}

async function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function listen(app, port) {
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Serves the repo's static pages. The dealer page is served with its two
// deployment constants (API_BASE, SUPABASE_URL) pointed at this run's
// local servers — the file in the repo is never modified, and every
// request it makes is a genuine cross-origin call, as in production.
function staticApp() {
  const app = express();
  app.get(['/fifty-template-dealer.html', '/login'], (req, res) => {
    let html = fs.readFileSync(path.join(REPO_ROOT, 'fifty-template-dealer.html'), 'utf8');
    const before = html;
    html = html.replace(/const API_BASE = "[^"]*";/, `const API_BASE = "${API_BASE}/api";`);
    html = html.replace(/const SUPABASE_URL = "[^"]*";/, `const SUPABASE_URL = "${AUTH_BASE}";`);
    if (html === before || !html.includes(`${API_BASE}/api`) || !html.includes(AUTH_BASE)) {
      return res.status(500).send('e2e: could not point the dealer page at the local servers — did its constants change?');
    }
    res.type('html').send(html);
  });
  app.use(express.static(REPO_ROOT, { index: false }));
  return app;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
let xffCounter = 0;
async function api(method, urlPath, { token, body, base = API_BASE } = {}) {
  xffCounter += 1;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // A distinct client address per request, so the public routes'
      // per-IP rate limits (TRUST_PROXY=1 above) don't throttle a run
      // that submits more referrals than one visitor would.
      'X-Forwarded-For': `10.77.${Math.floor(xffCounter / 250)}.${xffCounter % 250}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    /* no body */
  }
  return { status: res.status, body: json };
}

async function standIn(method, urlPath, body) {
  const res = await fetch(`${STRIPE_BASE}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

async function stripeRequestLog() {
  return (await standIn('GET', '/__control/log')).requests;
}

// Real Stripe, test mode only — used by --stripe=test to read back what
// was actually charged.
async function realStripeGet(urlPath) {
  const res = await fetch(`https://api.stripe.com/v1${urlPath}`, { headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
  return res.json();
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------
const PASSWORD = 'e2e-password-1';
const USERS = {
  newAdmin: { id: 'a0000000-0000-4000-8000-000000000001', email: 'owner@e2e-new-dealer.test', name: 'Dana Owner', role: 'admin', tenant: 'e2e-new-dealer' },
  newStaff: { id: 'a0000000-0000-4000-8000-000000000002', email: 'rep@e2e-new-dealer.test', name: 'Sam Rep', role: 'staff', tenant: 'e2e-new-dealer' },
  gssAdmin: { id: 'a0000000-0000-4000-8000-000000000003', email: 'admin@gss.test', name: 'GSS Admin', role: 'admin', tenant: 'good-steward-structures' },
  nmsAdmin: { id: 'a0000000-0000-4000-8000-000000000004', email: 'admin@nms.test', name: 'NMS Admin', role: 'admin', tenant: 'north-mountain-structures' },
  fiftyAdmin: { id: 'a0000000-0000-4000-8000-000000000005', email: 'admin@fifty.test', name: '50. Admin', role: 'admin', tenant: '50-platform' },
  acmeAdmin: { id: 'a0000000-0000-4000-8000-000000000006', email: 'admin@acme.test', name: 'Acme Admin', role: 'admin', tenant: 'acme-sheds' },
  legacyAdmin: { id: 'a0000000-0000-4000-8000-000000000007', email: 'admin@legacy.test', name: 'Legacy Admin', role: 'admin', tenant: 'e2e-legacy-session-dealer' },
};

// The tenants that already exist when the migration runs: the three that
// must end up exempt, plus a pre-existing ordinary dealer that must not.
const PRE_MIGRATION_TENANTS = `
  insert into tenants (slug, name) values
    ('good-steward-structures', 'Good Steward Structures'),
    ('north-mountain-structures', 'North Mountain Structures'),
    ('50-platform', '50.'),
    ('acme-sheds', 'Acme Sheds (pre-existing dealer)');`;

let auth;
let stripe;
const tenants = {};

async function seedUsersAndTenants() {
  // New tenants created after the migration — no billing_required given,
  // so they get the column default, exactly as a real new dealer would.
  await sql(`insert into tenants (slug, name) values ('e2e-new-dealer', 'E2E New Dealer Sheds'), ('e2e-legacy-session-dealer', 'E2E Legacy-Session Dealer')`);
  for (const row of await sql('select id, slug, name, billing_required from tenants')) tenants[row.slug] = row;
  for (const u of Object.values(USERS)) {
    await sql('insert into auth.users (id, email) values ($1, $2)', [u.id, u.email]);
    await sql('insert into users (id, tenant_id, email, name, role) values ($1, $2, $3, $4, $5)', [u.id, tenants[u.tenant].id, u.email, u.name, u.role]);
    auth.addUser({ id: u.id, email: u.email, password: PASSWORD });
  }
}

function tokenFor(user) {
  return auth.mintToken(user);
}

async function tenantRow(slug) {
  const [row] = await sql(
    `select id, billing_required, billing_status, activation_paid_at, activation_livemode, stripe_customer_id,
            stripe_payment_method_id, activation_checkout_session_id, referral_fee_bps, reward_amount_cents
     from tenants where slug = $1`,
    [slug]
  );
  return row;
}

// A real referral through the real public flow: the staff member's
// invite link -> the customer's share link -> a friend's submission.
async function createReferral(user, n) {
  const created = await api('POST', '/api/customers', {
    token: tokenFor(user),
    body: { name: `E2E Customer ${n}`, email: `customer${n}.${user.tenant}@example.test` },
  });
  eq(created.status, 201, 'POST /api/customers');
  return submitFriend(created.body.invite_link.code, n);
}

let friendCounter = 0;
async function submitFriend(inviteCode, n) {
  const share = await api('POST', `/api/links/${inviteCode}/share`);
  eq(share.status, 201, 'POST /api/links/:code/share');
  friendCounter += 1;
  const submitted = await api('POST', `/api/links/${share.body.code}/referrals`, {
    body: { name: `E2E Friend ${n}`, email: `friend${n}@example.test`, phone: `717555${String(friendCounter).padStart(4, '0')}` },
  });
  eq(submitted.status, 201, 'POST /api/links/:code/referrals');
  return submitted.body.id;
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------
let browser;
async function openPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    await d.accept();
  });
  return { context, page, dialogs };
}

async function signInOnPage(page, user) {
  await page.goto(DEALER_URL);
  await page.waitForSelector('#loginBox', { state: 'visible' });
  await page.fill('#loginEmail', user.email);
  await page.fill('#loginPassword', PASSWORD);
  await page.click('#loginBtn');
}

async function visible(page, selector) {
  return page.locator(selector).isVisible();
}

async function waitForDialog(pageInfo, afterIndex, type, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = pageInfo.dialogs.slice(afterIndex).find((d) => d.type === type);
    if (found) return found.message;
    await sleep(100);
  }
  throw new Error(`no ${type} dialog within ${timeoutMs}ms`);
}

// "Marked paid" is only rendered after the list is re-fetched following a
// successful PATCH — unlike the checkbox itself, which the page checks and
// disables the moment it's clicked, while the request is still in flight.
async function waitForMarkedPaid(page, referralId, timeout) {
  await page.waitForSelector(`.refrow:has(input[data-referral-id="${referralId}"]) .rstate.paid`, { timeout });
}

async function markPaidOnPage(page, referralId) {
  await page.fill('#searchBox', '');
  await page.fill('#searchBox', 'E2E Friend');
  const toggle = page.locator(`label.toggle:has(input[data-referral-id="${referralId}"]) .slider`);
  await toggle.waitFor({ state: 'visible', timeout: 10000 });
  await toggle.click();
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
async function main() {
  if (/supabase\.(co|com)/.test(PG_ADMIN_URL)) {
    throw new Error('E2E_PG_ADMIN_URL points at a Supabase project — this runner only ever runs against a throwaway Postgres server.');
  }
  if (!STAND_IN) {
    if (!/^sk_test_/.test(STRIPE_KEY || '')) throw new Error('--stripe=test requires STRIPE_SECRET_KEY=sk_test_… — refusing to run against anything else, live keys especially.');
    if (!/^whsec_/.test(WEBHOOK_SECRET || '')) throw new Error('--stripe=test requires STRIPE_WEBHOOK_SECRET=whsec_… from `stripe listen --all-snapshot --forward-to http://127.0.0.1:' + PORTS.api + '/api/webhooks/stripe`.');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Activation gate e2e — Stripe: ${STAND_IN ? 'local stand-in' : 'REAL Stripe TEST mode'} — results in ${OUT_DIR}`);

  // ----- Migration ---------------------------------------------------------
  section('Migration: billing_required + exemptions by slug');
  await bootstrapDatabase(DB_MAIN, PRE_MIGRATION_TENANTS);
  const applied = await applyNewMigration(DB_MAIN);
  mainDb = new Client({ connectionString: dbUrl(DB_MAIN) });
  await mainDb.connect();

  await check('Migration applies on top of the full existing chain', async () => {
    assert(applied.ok, `migration failed: ${applied.error && applied.error.message}`);
    return applied.notices.join(' | ');
  });
  await check('Exactly GSS, NMS and 50. are billing_required = false; the pre-existing dealer is true', async () => {
    const rows = await sql('select slug, billing_required from tenants order by slug');
    const exempt = rows.filter((r) => !r.billing_required).map((r) => r.slug);
    eq(JSON.stringify(exempt), JSON.stringify(['50-platform', 'good-steward-structures', 'north-mountain-structures']), 'exempt slugs');
    eq(rows.find((r) => r.slug === 'acme-sheds').billing_required, true, 'acme-sheds billing_required');
    return rows.map((r) => `${r.slug}=${r.billing_required}`).join(', ');
  });
  await check('A new tenant defaults to billing_required = true; the three exempt tenants cannot be made billable', async () => {
    const [row] = await sql(`insert into tenants (slug, name) values ('e2e-default-check', 'Default Check') returning billing_required`);
    eq(row.billing_required, true, 'new tenant default');
    await sql(`delete from tenants where slug = 'e2e-default-check'`);
    let refused = null;
    try {
      await sql(`update tenants set billing_required = true where slug = 'north-mountain-structures'`);
    } catch (err) {
      refused = err.message;
    }
    assert(refused && refused.includes('tenants_permanently_billing_exempt'), `flipping NMS to billable was not refused (${refused})`);
    return `new tenant -> true; NMS -> true refused: "${refused}"`;
  });
  await check('Migration aborts (and changes nothing) when an exempt slug matches no tenant', async () => {
    await bootstrapDatabase(DB_NEG, `insert into tenants (slug, name) values ('good-steward-structures','Good Steward Structures'), ('nms','North Mountain Structures'), ('50-platform','50.')`);
    const neg = await applyNewMigration(DB_NEG);
    assert(!neg.ok, 'migration unexpectedly succeeded with NMS under a different slug');
    const leftover = await withClient(dbUrl(DB_NEG), (c) =>
      c.query(`select count(*)::int as n from information_schema.columns where table_name = 'tenants' and column_name = 'billing_required'`)
    );
    eq(leftover.rows[0].n, 0, 'billing_required column left behind after the failed migration');
    return `${neg.error.message} DETAIL: ${neg.error.detail}`;
  });

  // ----- Servers -------------------------------------------------------------
  const authStandIn = createAuthStandIn();
  auth = authStandIn;
  const servers = [await listen(authStandIn.app, PORTS.auth), await listen(staticApp(), PORTS.static)];
  if (STAND_IN) {
    stripe = createStripeStandIn({ publicBaseUrl: STRIPE_BASE, webhookUrl: `${API_BASE}/api/webhooks/stripe`, webhookSecret: WEBHOOK_SECRET });
    servers.push(await listen(stripe.app, PORTS.stripe));
  }
  await seedUsersAndTenants();
  const apiProc = await startApi({ port: PORTS.api, label: 'api' });

  const { chromium } = require('playwright');
  // Real mode: the browser has to reach Stripe's hosted Checkout page, so
  // it goes through the environment's HTTPS proxy when there is one —
  // never for this run's own local servers.
  const proxyServer = !STAND_IN && (process.env.HTTPS_PROXY || process.env.https_proxy);
  // Playwright appends Chromium's <-loopback> rule after `bypass`, and the
  // later rule wins: without this, 127.0.0.1 is proxied anyway, and an
  // HTTPS-only proxy answers the dealer page with a 405.
  if (proxyServer) process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  browser = await chromium.launch({
    headless: !args.headed,
    ...(proxyServer ? { proxy: { server: proxyServer, bypass: '127.0.0.1,localhost' } } : {}),
  });

  const newTenantId = tenants['e2e-new-dealer'].id;

  try {
    // ----- Gate, API level ---------------------------------------------------
    section('Activation gate — enforced by the API, for every user of the tenant');
    await check('Startup log states the Stripe mode', async () => {
      const line = apiProc.lines.find((l) => l.includes('Stripe billing:'));
      assert(line && line.includes('TEST mode'), `no TEST-mode startup line: ${line}`);
      return line;
    });
    await check('New dealer admin: GET /api/me reports activation required ($500)', async () => {
      const me = await api('GET', '/api/me', { token: tokenFor(USERS.newAdmin) });
      eq(me.status, 200, 'status');
      eq(me.body.activation.required, true, 'activation.required');
      eq(me.body.activation.fee_cents, 50000, 'activation.fee_cents');
      return `activation=${JSON.stringify(me.body.activation)} referral_fee=${JSON.stringify(me.body.referral_fee)}`;
    });
    await check('New dealer admin AND staff: every other staff endpoint answers 402 activation_required', async () => {
      const out = [];
      for (const user of [USERS.newAdmin, USERS.newStaff]) {
        for (const [method, p, body] of [
          ['GET', '/api/referrals'],
          ['POST', '/api/customers', { name: 'Blocked', email: 'blocked@example.test' }],
          ['GET', '/api/tenant/tremendous-credentials'],
          ['PATCH', '/api/referrals/00000000-0000-4000-8000-000000000000/status', { status: 'rewarded' }],
          ['POST', '/api/referrals/00000000-0000-4000-8000-000000000000/close'],
        ]) {
          const r = await api(method, p, { token: tokenFor(user), body });
          eq(r.status, 402, `${user.role} ${method} ${p}`);
          eq(r.body.code, 'activation_required', `${user.role} ${method} ${p} code`);
          out.push(`${user.role} ${method} ${p} -> 402`);
        }
      }
      return out.join('; ');
    });
    await check('Pre-existing non-exempt dealer (acme-sheds) is gated after the migration', async () => {
      const me = await api('GET', '/api/me', { token: tokenFor(USERS.acmeAdmin) });
      eq(me.body.activation.required, true, 'acme activation.required');
      const r = await api('POST', '/api/customers', { token: tokenFor(USERS.acmeAdmin), body: { name: 'X', email: 'x@example.test' } });
      eq(r.status, 402, 'acme POST /api/customers');
      return 'acme-sheds: /me required=true, POST /api/customers -> 402';
    });
    await check('Staff (non-admin) cannot start the activation checkout (403)', async () => {
      const r = await api('POST', '/api/billing/checkout-session', { token: tokenFor(USERS.newStaff), body: {} });
      eq(r.status, 403, 'status');
      return `403 ${r.body.error}`;
    });

    // ----- Exempt tenants ---------------------------------------------------
    section('Billing-exempt tenants — GSS, NMS, 50. — work exactly as before, never touch Stripe');
    const stripeCallsBeforeExempt = STAND_IN ? (await stripeRequestLog()).length : 0;
    for (const user of [USERS.gssAdmin, USERS.nmsAdmin, USERS.fiftyAdmin]) {
      await check(`${user.tenant}: not gated, no usage fee, checkout refused, mark-paid charges nothing`, async () => {
        const token = tokenFor(user);
        const me = await api('GET', '/api/me', { token });
        eq(me.body.activation.required, false, 'activation.required');
        eq(me.body.referral_fee, null, 'referral_fee');
        const list = await api('GET', '/api/referrals', { token });
        eq(list.status, 200, 'GET /api/referrals');
        const checkout = await api('POST', '/api/billing/checkout-session', { token, body: {} });
        eq(checkout.status, 409, 'checkout-session status');
        eq(checkout.body.code, 'billing_not_required', 'checkout-session code');
        const referralId = await createReferral(user, `x${user.tenant.length}${user.id.slice(-1)}`);
        const paid = await api('PATCH', `/api/referrals/${referralId}/status`, { token, body: { status: 'rewarded' } });
        eq(paid.status, 200, 'mark paid');
        eq(paid.body.status, 'rewarded', 'status after mark paid');
        assert(!paid.body.fee, `a fee was reported for an exempt tenant: ${JSON.stringify(paid.body.fee)}`);
        const [{ n }] = await sql('select count(*)::int as n from billing_events where tenant_id = $1', [tenants[user.tenant].id]);
        eq(n, 0, 'billing_events rows for this tenant');
        return `me: required=false, referral_fee=null; checkout -> 409 billing_not_required; mark-paid -> 200 rewarded, no fee, 0 billing_events`;
      });
    }
    if (STAND_IN) {
      await check('Zero Stripe API requests were made for any exempt tenant', async () => {
        const delta = (await stripeRequestLog()).length - stripeCallsBeforeExempt;
        eq(delta, 0, 'Stripe requests during the exempt checks');
        return '0 requests reached the Stripe stand-in';
      });
    }

    // ----- Browser: login -> Checkout ----------------------------------------
    section('Dealer page — new dealer admin signs in and is sent to Stripe Checkout');
    const admin = await openPage();
    let sessionId;
    await signInOnPage(admin.page, USERS.newAdmin);
    await check('Signing in redirects the admin to a Checkout Session (mode: payment, $500)', async () => {
      if (STAND_IN) {
        await admin.page.waitForURL(/\/pay\/cs_test_/, { timeout: 15000 });
        sessionId = admin.page.url().split('/pay/')[1];
        const creates = (await stripeRequestLog()).filter((r) => r.method === 'POST' && r.path === '/checkout/sessions');
        eq(creates.length, 1, 'Checkout Sessions created');
        const b = creates[0].body;
        eq(b.mode, 'payment', 'mode');
        eq(b.line_items[0].price_data.unit_amount, '50000', 'unit_amount');
        eq(b.payment_intent_data.setup_future_usage, 'off_session', 'setup_future_usage');
        eq(b.customer_creation, 'always', 'customer_creation');
        eq(b.metadata.kind, 'activation', 'metadata.kind');
        eq(b.metadata.tenant_id, newTenantId, 'metadata.tenant_id');
        eq(b.client_reference_id, newTenantId, 'client_reference_id');
        eq(b.success_url, `${DEALER_URL}?activation=success&session_id={CHECKOUT_SESSION_ID}`, 'success_url');
        eq(b.cancel_url, `${DEALER_URL}?activation=cancelled`, 'cancel_url');
        return `redirected to ${admin.page.url()} — Stripe received mode=payment, unit_amount=50000, setup_future_usage=off_session, customer_creation=always, metadata.kind=activation, success_url back to the dealer page`;
      }
      await admin.page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
      const t = await tenantRow('e2e-new-dealer');
      sessionId = t.activation_checkout_session_id;
      const s = await realStripeGet(`/checkout/sessions/${sessionId}`);
      eq(s.mode, 'payment', 'mode');
      eq(s.amount_total, 50000, 'amount_total');
      eq(s.livemode, false, 'livemode');
      return `redirected to ${admin.page.url().slice(0, 60)}… — Stripe session ${sessionId}: mode=${s.mode} amount_total=${s.amount_total} livemode=${s.livemode}`;
    });

    if (STAND_IN) {
      await check('Backing out of Checkout ("Back") returns to the gate, nothing charged, still locked', async () => {
        await admin.page.click('#cancelLink');
        await admin.page.waitForSelector('#gateBox', { state: 'visible' });
        const msg = await admin.page.textContent('#gateMsg');
        assert(/cancelled/i.test(msg), `gate message: ${msg}`);
        assert(!(await visible(admin.page, '#appArea')), 'app area visible after cancel');
        assert(!admin.page.url().includes('activation='), `query param not stripped: ${admin.page.url()}`);
        const t = await tenantRow('e2e-new-dealer');
        eq(t.activation_paid_at, null, 'activation_paid_at');
        return `gate shows "${msg.trim()}"; activation_paid_at still null`;
      });
    } else {
      skip('Backing out of Checkout ("Back") returns to the gate', 'needs a click on Stripe\'s own page; covered in --stripe=stand-in');
    }

    {
      await check('Faking the return (?activation=success) without paying does NOT unlock — page waits, API still 402', async () => {
        await admin.page.goto(`${DEALER_URL}?activation=success&session_id=cs_test_forged`);
        await admin.page.waitForSelector('#gateBox', { state: 'visible' });
        eq((await admin.page.textContent('#gateTitle')).trim(), 'Payment received', 'gate title');
        await sleep(6000);
        assert(await visible(admin.page, '#gateBox'), 'gate disappeared without a payment');
        assert(!(await visible(admin.page, '#appArea')), 'app area became visible without a payment');
        const me = await api('GET', '/api/me', { token: tokenFor(USERS.newAdmin) });
        eq(me.body.activation.required, true, 'activation.required');
        const r = await api('POST', '/api/customers', { token: tokenFor(USERS.newAdmin), body: { name: 'X', email: 'x@example.test' } });
        eq(r.status, 402, 'POST /api/customers');
        eq((await tenantRow('e2e-new-dealer')).activation_paid_at, null, 'activation_paid_at');
        return 'after 6s on the forged return: still gated in the page, /me required=true, POST /api/customers -> 402, activation_paid_at null';
      });

      await check('Signing out and back in (same tab) goes straight back to the same open Checkout Session — no second $500 session, no stale "payment received" screen', async () => {
        // Same tab, no reload: the ?activation=success this tab saw a
        // moment ago must not be applied to this new sign-in.
        await admin.page.click('#gateSignOutBtn');
        await admin.page.waitForSelector('#loginBox', { state: 'visible' });
        await admin.page.fill('#loginEmail', USERS.newAdmin.email);
        await admin.page.fill('#loginPassword', PASSWORD);
        await admin.page.click('#loginBtn');
        if (STAND_IN) {
          await admin.page.waitForURL(/\/pay\/cs_test_/, { timeout: 15000 });
          eq(admin.page.url().split('/pay/')[1], sessionId, 'session id');
          const creates = (await stripeRequestLog()).filter((r) => r.method === 'POST' && r.path === '/checkout/sessions');
          eq(creates.length, 1, 'Checkout Sessions created');
          return `same session ${sessionId}; 1 session created in total`;
        }
        await admin.page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
        eq((await tenantRow('e2e-new-dealer')).activation_checkout_session_id, sessionId, 'stored session id');
        assert(admin.page.url().includes(sessionId), `redirected to a different session: ${admin.page.url().slice(0, 80)}`);
        return `same Stripe session ${sessionId} reused`;
      });
    }

    if (STAND_IN) {
      await check('A declined card at Checkout leaves the tenant locked', async () => {
        await admin.page.fill('#cardNumber', '4000 0000 0000 0002');
        await admin.page.click('#submitPay');
        await admin.page.waitForSelector('#error:has-text("declined")');
        eq((await tenantRow('e2e-new-dealer')).activation_paid_at, null, 'activation_paid_at');
        return 'Checkout showed "Your card was declined."; activation_paid_at still null';
      });
    } else {
      skip('A declined card at Checkout leaves the tenant locked', 'needs card entry on Stripe\'s own page; covered in --stripe=stand-in');
    }

    section('Dealer page — staff of the unactivated dealer');
    const staff = await openPage();
    await check('Staff sign-in shows "ask your admin" — no redirect to Checkout, no session created', async () => {
      const before = STAND_IN ? (await stripeRequestLog()).filter((r) => r.path === '/checkout/sessions').length : 0;
      await signInOnPage(staff.page, USERS.newStaff);
      await staff.page.waitForSelector('#gateBox', { state: 'visible' });
      await sleep(1500);
      eq((await staff.page.textContent('#gateTitle')).trim(), 'Account not activated yet', 'gate title');
      assert(staff.page.url().startsWith(DEALER_URL), `staff was navigated away: ${staff.page.url()}`);
      if (STAND_IN) {
        const after = (await stripeRequestLog()).filter((r) => r.path === '/checkout/sessions').length;
        eq(after, before, 'Checkout Sessions created by the staff sign-in');
      }
      return `"${(await staff.page.textContent('#gateLede')).trim()}"`;
    });

    // ----- Pay, webhook, unlock ----------------------------------------------
    section('Checkout completes -> webhook -> tenant unlocks (and not one step earlier)');
    if (STAND_IN) {
      await standIn('POST', '/__control/hold-webhooks', { hold: true });
      await check('Paid, redirected back — but with the webhook held the page waits and the API stays locked', async () => {
        await admin.page.fill('#cardNumber', '4242 4242 4242 4242');
        await admin.page.click('#submitPay');
        await admin.page.waitForURL((u) => u.href.startsWith(DEALER_URL), { timeout: 15000 });
        await admin.page.waitForSelector('#gateBox', { state: 'visible' });
        eq((await admin.page.textContent('#gateTitle')).trim(), 'Payment received', 'gate title');
        await sleep(5000);
        assert(!(await visible(admin.page, '#appArea')), 'unlocked before the webhook arrived');
        const me = await api('GET', '/api/me', { token: tokenFor(USERS.newAdmin) });
        eq(me.body.activation.required, true, 'activation.required before webhook');
        eq((await tenantRow('e2e-new-dealer')).activation_paid_at, null, 'activation_paid_at before webhook');
        const held = stripe.state.heldEvents.map((e) => e.type);
        assert(held.includes('checkout.session.completed'), `held events: ${held}`);
        return `Stripe-side: session paid; webhook held -> page "Payment received" for 5s, /me required=true, activation_paid_at null`;
      });
      await check('Webhook delivered -> tenant activated -> the waiting page unlocks on its own', async () => {
        const { delivered } = await standIn('POST', '/__control/release-webhooks');
        const completed = delivered.find((d) => d.type === 'checkout.session.completed');
        eq(completed.status, 200, 'webhook response');
        await admin.page.waitForSelector('#appArea', { state: 'visible', timeout: 15000 });
        const who = (await admin.page.textContent('#authWho')).trim();
        return `webhook ${completed.eventId} -> 200; page unlocked: "${who}"`;
      });
    } else {
      await check('Checkout completed on Stripe\'s hosted page (test card), webhook delivered, page unlocks', async () => {
        await completeRealCheckout(admin.page);
        await admin.page.waitForURL((u) => u.href.startsWith(DEALER_URL), { timeout: 15 * 60 * 1000 });
        await admin.page.waitForSelector('#appArea', { state: 'visible', timeout: 120000 });
        return (await admin.page.textContent('#authWho')).trim();
      });
    }

    let activated;
    await check('Database: activation recorded only from the webhook — paid_at, livemode=false, customer + payment method saved', async () => {
      activated = await tenantRow('e2e-new-dealer');
      assert(activated.activation_paid_at, 'activation_paid_at not set');
      eq(activated.activation_livemode, false, 'activation_livemode');
      eq(activated.billing_status, 'active', 'billing_status');
      assert(activated.stripe_customer_id && activated.stripe_payment_method_id, 'customer/payment method not saved');
      const events = await sql(
        `select amount_cents, status, livemode, stripe_payment_intent_id, stripe_event_id from billing_events where tenant_id = $1 and event_type = 'activation_charge'`,
        [newTenantId]
      );
      eq(events.length, 1, 'activation_charge rows');
      eq(events[0].amount_cents, 50000, 'activation amount');
      eq(events[0].livemode, false, 'billing_events.livemode');
      if (!STAND_IN) {
        const pi = await realStripeGet(`/payment_intents/${events[0].stripe_payment_intent_id}`);
        eq(pi.status, 'succeeded', 'Stripe PaymentIntent status');
        eq(pi.amount, 50000, 'Stripe PaymentIntent amount');
        eq(pi.livemode, false, 'Stripe PaymentIntent livemode');
      }
      return `activation_paid_at=${activated.activation_paid_at.toISOString()} customer=${activated.stripe_customer_id} payment_method=${activated.stripe_payment_method_id}; billing_events: activation_charge 50000 succeeded livemode=false (${events[0].stripe_payment_intent_id}, ${events[0].stripe_event_id})`;
    });
    await check('Unlocked for every user of the tenant: API 200s for admin and staff; staff page opens on "Check again"', async () => {
      for (const user of [USERS.newAdmin, USERS.newStaff]) {
        const r = await api('GET', '/api/referrals', { token: tokenFor(user) });
        eq(r.status, 200, `${user.role} GET /api/referrals`);
      }
      await staff.page.click('#gateBtn');
      await staff.page.waitForSelector('#appArea', { state: 'visible', timeout: 10000 });
      return 'admin + staff GET /api/referrals -> 200; staff page now shows the app';
    });
    await check('Checkout endpoint now refuses a second activation (409 already_activated)', async () => {
      const r = await api('POST', '/api/billing/checkout-session', { token: tokenFor(USERS.newAdmin), body: {} });
      eq(r.status, 409, 'status');
      eq(r.body.code, 'already_activated', 'code');
      return '409 already_activated';
    });
    await check('Admins can still save their Tremendous credentials through the API (the column-level grants keep that write)', async () => {
      const out = [];
      for (const user of [USERS.newAdmin, USERS.gssAdmin]) {
        const r = await api('PUT', '/api/tenant/tremendous-credentials', {
          token: tokenFor(user),
          body: { api_key: 'TEST_e2e_key', funding_source_id: 'fs_e2e', campaign_id: 'camp_e2e' },
        });
        eq(r.status, 200, `${user.tenant} PUT status`);
        eq(r.body.configured, true, `${user.tenant} configured`);
        const del = await api('DELETE', '/api/tenant/tremendous-credentials', { token: tokenFor(user) });
        eq(del.status, 200, `${user.tenant} DELETE status`);
        out.push(`${user.tenant}: PUT 200 configured, DELETE 200`);
      }
      return out.join('; ');
    });

    // ----- Webhook hardening -------------------------------------------------
    if (STAND_IN) {
      section('Webhook hardening');
      await check('Redelivering the same activation event changes nothing', async () => {
        const completedEvent = [...stripe.state.events.values()].find((e) => e.type === 'checkout.session.completed');
        const r = await standIn('POST', '/__control/replay-event', { id: completedEvent.id });
        eq(r.status, 200, 'replay status');
        const [{ n }] = await sql(`select count(*)::int as n from billing_events where tenant_id = $1 and event_type = 'activation_charge'`, [newTenantId]);
        eq(n, 1, 'activation_charge rows after replay');
        return `replayed ${completedEvent.id} -> 200, still 1 activation_charge row`;
      });
      await check('A forged (badly signed) "payment succeeded" event is rejected and unlocks nothing', async () => {
        const r = await standIn('POST', '/__control/send-event', {
          type: 'checkout.session.completed',
          signature: 'tampered',
          object: { id: 'cs_test_forged', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: tenants['acme-sheds'].id, metadata: { kind: 'activation', tenant_id: tenants['acme-sheds'].id }, amount_total: 50000, livemode: false },
        });
        eq(r.status, 400, 'webhook status');
        eq((await tenantRow('acme-sheds')).activation_paid_at, null, 'acme activation_paid_at');
        return 'tampered signature -> 400; acme-sheds still unpaid';
      });
      await check('A validly signed paid session that is not an activation session (e.g. a Payment Link naming the tenant) is ignored', async () => {
        const pi = await standIn('POST', '/__control/payment-intent', { amount: 100, metadata: {} });
        const r = await standIn('POST', '/__control/send-event', {
          type: 'checkout.session.completed',
          object: { id: 'cs_test_paymentlink', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: tenants['acme-sheds'].id, metadata: { kind: 'something_else' }, payment_intent: pi.id, amount_total: 100, livemode: false },
        });
        eq(r.status, 200, 'webhook status');
        eq((await tenantRow('acme-sheds')).activation_paid_at, null, 'acme activation_paid_at');
        const me = await api('GET', '/api/me', { token: tokenFor(USERS.acmeAdmin) });
        eq(me.body.activation.required, true, 'acme still gated');
        return '$1.00 session with metadata.kind=something_else -> acknowledged, nothing activated, acme still gated';
      });
      await check('A legacy session (marker on its PaymentIntent, created before this change) still activates; one whose PaymentIntent is not an activation does not', async () => {
        const legacy = tenants['e2e-legacy-session-dealer'].id;
        const other = await standIn('POST', '/__control/payment-intent', { with_customer: true, metadata: { kind: 'other', tenant_id: legacy } });
        let r = await standIn('POST', '/__control/send-event', {
          type: 'checkout.session.completed',
          object: { id: 'cs_test_legacy_other', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: legacy, payment_intent: other.id, customer: other.customer, amount_total: 50000, livemode: false },
        });
        eq(r.status, 200, 'webhook status (non-activation legacy)');
        eq((await tenantRow('e2e-legacy-session-dealer')).activation_paid_at, null, 'activated by a non-activation PaymentIntent');
        const pi = await standIn('POST', '/__control/payment-intent', { with_customer: true, metadata: { kind: 'activation', tenant_id: legacy } });
        r = await standIn('POST', '/__control/send-event', {
          type: 'checkout.session.completed',
          object: { id: 'cs_test_legacy', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: legacy, payment_intent: pi.id, customer: pi.customer, amount_total: 50000, livemode: false },
        });
        eq(r.status, 200, 'webhook status (legacy activation)');
        const row = await tenantRow('e2e-legacy-session-dealer');
        assert(row.activation_paid_at, 'legacy activation session did not activate');
        eq(row.activation_livemode, false, 'activation_livemode');
        return 'PaymentIntent kind=other -> ignored; PaymentIntent kind=activation -> activated (livemode=false)';
      });
      await check('A LIVE-mode payment supersedes an earlier test-mode activation', async () => {
        const legacy = tenants['e2e-legacy-session-dealer'].id;
        const pi = await standIn('POST', '/__control/payment-intent', { with_customer: true, livemode: true, metadata: { kind: 'activation', tenant_id: legacy } });
        const r = await standIn('POST', '/__control/send-event', {
          type: 'checkout.session.completed',
          livemode: true,
          object: { id: 'cs_live_upgrade', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: legacy, metadata: { kind: 'activation', tenant_id: legacy }, payment_intent: pi.id, customer: pi.customer, amount_total: 50000, livemode: true },
        });
        eq(r.status, 200, 'webhook status');
        const row = await tenantRow('e2e-legacy-session-dealer');
        eq(row.activation_livemode, true, 'activation_livemode');
        eq(row.stripe_customer_id, pi.customer, 'stripe_customer_id replaced with the live one');
        return `activation_livemode false -> true; customer now ${row.stripe_customer_id}`;
      });
      await check('A second, different activation payment is flagged loudly for refund', async () => {
        const pi = await standIn('POST', '/__control/payment-intent', { with_customer: true, metadata: { kind: 'activation', tenant_id: newTenantId } });
        const r = await standIn('POST', '/__control/send-event', {
          type: 'checkout.session.completed',
          object: { id: 'cs_test_second', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: newTenantId, metadata: { kind: 'activation', tenant_id: newTenantId }, payment_intent: pi.id, customer: pi.customer, amount_total: 50000, livemode: false },
        });
        eq(r.status, 200, 'webhook status');
        await sleep(300);
        const line = apiProc.lines.find((l) => l.includes('DUPLICATE ACTIVATION PAYMENT'));
        assert(line, 'no DUPLICATE ACTIVATION PAYMENT log line');
        const row = await tenantRow('e2e-new-dealer');
        eq(row.stripe_customer_id, activated.stripe_customer_id, 'original customer kept');
        return line.replace(/^\[api:\w+\] /, '');
      });
      await check('A saved Stripe customer from the other mode is never sent to Checkout (Checkout creates a fresh one)', async () => {
        // acme-sheds: still unpaid, but carrying a customer id recorded
        // under live mode — what a dealer activated in one mode looks like
        // to an API running on the other mode's key.
        const acmeId = tenants['acme-sheds'].id;
        await sql(`update tenants set stripe_customer_id = 'cus_from_live_mode', activation_livemode = true where id = $1`, [acmeId]);
        try {
          const callsBefore = (await stripeRequestLog()).length;
          const r = await api('POST', '/api/billing/checkout-session', { token: tokenFor(USERS.acmeAdmin), body: {} });
          eq(r.status, 201, 'checkout status');
          const create = (await stripeRequestLog()).slice(callsBefore).find((c) => c.path === '/checkout/sessions');
          eq(create.body.customer, undefined, 'customer sent to Stripe');
          eq(create.body.customer_creation, 'always', 'customer_creation');
          return `201; Stripe received customer_creation=always and no customer (the live-mode cus_ id was not reused); success/cancel URLs = this API's own /billing pages (no return_url given): ${create.body.success_url}`;
        } finally {
          await sql(`update tenants set stripe_customer_id = null, activation_livemode = null, activation_checkout_session_id = null where id = $1`, [acmeId]);
        }
      });
      await check('Five simultaneous "start checkout" requests (two tabs, two admins) get ONE Checkout Session between them', async () => {
        const acmeId = tenants['acme-sheds'].id;
        const callsBefore = (await stripeRequestLog()).length;
        const sessionsBefore = new Set(stripe.state.sessions.keys());
        try {
          const token = tokenFor(USERS.acmeAdmin);
          const responses = await Promise.all(
            Array.from({ length: 5 }, () => api('POST', '/api/billing/checkout-session', { token, body: { return_url: DEALER_URL } }))
          );
          const ids = [...new Set(responses.map((r) => r.body && r.body.session_id))];
          assert(responses.every((r) => r.status === 201 || r.status === 200), `statuses: ${responses.map((r) => r.status)}`);
          eq(ids.length, 1, 'distinct session ids returned');
          const created = [...stripe.state.sessions.values()].filter((s) => !sessionsBefore.has(s.id) && s.client_reference_id === acmeId);
          eq(created.length, 1, 'Checkout Sessions actually created at Stripe');
          const keys = [...new Set((await stripeRequestLog()).slice(callsBefore).filter((c) => c.path === '/checkout/sessions').map((c) => c.idempotencyKey))];
          eq(keys.length, 1, 'distinct Idempotency-Keys');
          eq((await tenantRow('acme-sheds')).activation_checkout_session_id, ids[0], 'stored session id');
          return `5 requests -> statuses ${responses.map((r) => r.status).join(',')}, all session ${ids[0]}; Stripe created 1 (Idempotency-Key ${keys[0]})`;
        } finally {
          await sql(`update tenants set activation_checkout_session_id = null where id = $1`, [acmeId]);
        }
      });
    } else {
      section('Webhook hardening');
      skip('Replayed / forged / non-activation / legacy / live-supersede / duplicate-payment / cross-mode-customer / concurrent-checkout webhook and checkout cases', 'they inject events and sessions Stripe can\'t be made to send on demand; covered in --stripe=stand-in');
    }

    // ----- Usage fee ---------------------------------------------------------
    section('30% usage fee on a rewarded referral (billing-required tenant)');
    let feeReferral;
    await check('Admin creates a customer on the dealer page; a friend submits through the real public flow', async () => {
      await admin.page.fill('#custName', 'Riley Customer');
      await admin.page.fill('#custEmail', 'riley.customer@example.test');
      await admin.page.click('#sendBtn');
      await admin.page.waitForSelector('#confirmBox.show', { timeout: 10000 });
      const link = (await admin.page.textContent('#confirmLink')).trim();
      const code = (/code=([^&\s]+)/.exec(link) || /Invite code: (\S+)/.exec(link) || [])[1];
      assert(code, `no invite code in "${link}"`);
      feeReferral = await submitFriend(code, 1);
      return `invite ${code} -> referral ${feeReferral}`;
    });
    await check('"Mark as paid" quotes the exact fee: $30.00 = 30% of the $100.00 payout', async () => {
      const callsBefore = STAND_IN ? (await stripeRequestLog()).length : 0;
      await markPaidOnPage(admin.page, feeReferral);
      await waitForMarkedPaid(admin.page, feeReferral, 15000);
      const confirmMsg = admin.dialogs.filter((d) => d.type === 'confirm').pop().message;
      assert(confirmMsg.includes('$30.00') && confirmMsg.includes('30% of the $100.00'), `confirm text: ${confirmMsg}`);
      admin.callsBeforeFee = callsBefore;
      return `confirm: "${confirmMsg.replace(/\n+/g, ' ')}"`;
    });
    await check('Exactly one $30.00 off-session charge to the tenant\'s saved card, recorded in billing_events', async () => {
      const [row] = await sql(
        `select id, status, amount_cents, fee_rate_bps, reward_amount_cents, livemode, stripe_payment_intent_id
         from billing_events where referral_id = $1 and event_type = 'referral_fee'`,
        [feeReferral]
      );
      eq(row.status, 'succeeded', 'status');
      eq(row.amount_cents, 3000, 'amount_cents');
      eq(row.fee_rate_bps, 3000, 'fee_rate_bps');
      eq(row.reward_amount_cents, 5000, 'reward_amount_cents (per card)');
      eq(row.livemode, false, 'livemode');
      const [ref] = await sql('select status from referrals where id = $1', [feeReferral]);
      eq(ref.status, 'rewarded', 'referral status');
      let stripeSide;
      if (STAND_IN) {
        const charges = (await stripeRequestLog()).slice(admin.callsBeforeFee).filter((r) => r.method === 'POST' && r.path === '/payment_intents');
        eq(charges.length, 1, 'PaymentIntent create requests');
        const b = charges[0].body;
        eq(b.amount, '3000', 'charged amount');
        eq(b.currency, 'usd', 'currency');
        eq(b.customer, activated.stripe_customer_id, 'customer');
        eq(b.payment_method, activated.stripe_payment_method_id, 'payment_method');
        eq(b.off_session, 'true', 'off_session');
        eq(b.confirm, 'true', 'confirm');
        eq(b.metadata.kind, 'referral_fee', 'metadata.kind');
        eq(b.metadata.referral_id, feeReferral, 'metadata.referral_id');
        eq(charges[0].idempotencyKey, `referral_fee:${row.id}`, 'Idempotency-Key');
        stripeSide = `Stripe got amount=3000 usd, customer+payment_method = the tenant's saved ones, off_session+confirm, Idempotency-Key ${charges[0].idempotencyKey}`;
      } else {
        const pi = await realStripeGet(`/payment_intents/${row.stripe_payment_intent_id}`);
        eq(pi.status, 'succeeded', 'Stripe status');
        eq(pi.amount, 3000, 'Stripe amount');
        eq(pi.customer, activated.stripe_customer_id, 'Stripe customer');
        eq(pi.payment_method, activated.stripe_payment_method_id, 'Stripe payment_method');
        eq(pi.livemode, false, 'Stripe livemode');
        stripeSide = `Stripe ${pi.id}: ${pi.status} ${pi.amount} ${pi.currency} livemode=${pi.livemode}`;
      }
      return `billing_events referral_fee: succeeded 3000 (rate 3000 bps of 2 x 5000) livemode=false ${row.stripe_payment_intent_id}; referral rewarded. ${stripeSide}`;
    });

    if (STAND_IN) {
      await check('Declined fee: referral NOT marked paid, dealer told why; retry after the card is fixed charges once', async () => {
        const referralId = await createReferral(USERS.newAdmin, 2);
        await standIn('POST', '/__control/fail-off-session', { payment_method: activated.stripe_payment_method_id, fail: true });
        const dialogsBefore = admin.dialogs.length;
        await markPaidOnPage(admin.page, referralId);
        const alertMsg = await waitForDialog(admin, dialogsBefore, 'alert');
        assert(/couldn't be charged/.test(alertMsg) && /not marked paid/.test(alertMsg), `alert: ${alertMsg}`);
        let [ref] = await sql('select status from referrals where id = $1', [referralId]);
        assert(ref.status !== 'rewarded', 'referral was marked rewarded despite the declined fee');
        const failed = await sql(`select status, error_detail, stripe_payment_intent_id from billing_events where referral_id = $1 and event_type = 'referral_fee'`, [referralId]);
        eq(failed.length, 1, 'fee rows after decline');
        eq(failed[0].status, 'failed', 'fee row status');

        await standIn('POST', '/__control/fail-off-session', { payment_method: activated.stripe_payment_method_id, fail: false });
        await markPaidOnPage(admin.page, referralId);
        await waitForMarkedPaid(admin.page, referralId, 15000);
        [ref] = await sql('select status from referrals where id = $1', [referralId]);
        eq(ref.status, 'rewarded', 'referral status after retry');
        const rows = await sql(`select status from billing_events where referral_id = $1 and event_type = 'referral_fee' order by created_at`, [referralId]);
        eq(rows.map((r) => r.status).join(','), 'failed,succeeded', 'fee rows');
        const charges = (await stripeRequestLog()).filter((r) => r.path === '/payment_intents' && r.body && r.body.metadata && r.body.metadata.referral_id === referralId);
        eq(charges.length, 2, 'charge attempts');
        assert(charges[0].idempotencyKey !== charges[1].idempotencyKey, 'retry reused the declined attempt\'s Idempotency-Key');
        return `alert: "${alertMsg}" | ledger: failed (${failed[0].error_detail}) then succeeded; 2 attempts, 2 distinct Idempotency-Keys`;
      });

      await check('Lost response after Stripe charged: nothing marked paid, retry resumes the SAME charge — no double charge', async () => {
        const referralId = await createReferral(USERS.newAdmin, 3);
        await standIn('POST', '/__control/drop-next-responses', { count: 1 });
        const first = await api('PATCH', `/api/referrals/${referralId}/status`, { token: tokenFor(USERS.newAdmin), body: { status: 'rewarded' } });
        eq(first.status, 502, 'first attempt status');
        eq(first.body.code, 'referral_fee_unconfirmed', 'first attempt code');
        let [ref] = await sql('select status from referrals where id = $1', [referralId]);
        assert(ref.status !== 'rewarded', 'marked rewarded without a confirmed fee');
        const [pending] = await sql(`select status, error_detail from billing_events where referral_id = $1 and event_type = 'referral_fee'`, [referralId]);
        eq(pending.status, 'pending', 'fee row after a lost response');
        const retry = await api('PATCH', `/api/referrals/${referralId}/status`, { token: tokenFor(USERS.newAdmin), body: { status: 'rewarded' } });
        eq(retry.status, 200, 'retry status');
        eq(retry.body.fee.amount_cents, 3000, 'retry fee');
        [ref] = await sql('select status from referrals where id = $1', [referralId]);
        eq(ref.status, 'rewarded', 'referral status after retry');
        const pis = stripe.state.paymentIntents;
        const created = [...pis.values()].filter((p) => p.metadata && p.metadata.referral_id === referralId);
        eq(created.length, 1, 'PaymentIntents actually created at Stripe for this referral');
        const reqs = (await stripeRequestLog()).filter((r) => r.path === '/payment_intents' && r.body && r.body.metadata && r.body.metadata.referral_id === referralId);
        eq(reqs.length, 2, 'requests');
        eq(reqs[0].idempotencyKey, reqs[1].idempotencyKey, 'both requests used the same Idempotency-Key');
        return `1st: 502 referral_fee_unconfirmed (row pending: "${pending.error_detail.slice(0, 60)}…"); retry: 200, same key ${reqs[0].idempotencyKey}, Stripe replayed the original — 1 PaymentIntent total`;
      });

      await check('10 simultaneous "mark paid" requests charge exactly once', async () => {
        const referralId = await createReferral(USERS.newAdmin, 4);
        const token = tokenFor(USERS.newAdmin);
        const responses = await Promise.all(Array.from({ length: 10 }, () => api('PATCH', `/api/referrals/${referralId}/status`, { token, body: { status: 'rewarded' } })));
        const final = await api('PATCH', `/api/referrals/${referralId}/status`, { token, body: { status: 'rewarded' } });
        eq(final.status, 200, 'final status');
        const created = [...stripe.state.paymentIntents.values()].filter((p) => p.metadata && p.metadata.referral_id === referralId);
        eq(created.length, 1, 'PaymentIntents created');
        const rows = await sql(`select status from billing_events where referral_id = $1 and event_type = 'referral_fee'`, [referralId]);
        eq(rows.length, 1, 'fee rows');
        eq(rows[0].status, 'succeeded', 'fee row status');
        const [{ n }] = await sql(`select count(*)::int as n from audit_log where entity_id = $1 and action = 'referral.status_changed'`, [referralId]);
        eq(n, 1, 'status-change audit rows');
        const tally = responses.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
        return `responses ${JSON.stringify(tally)}; 1 PaymentIntent, 1 succeeded fee row, 1 audit row`;
      });
    } else {
      skip('Declined fee / lost response / concurrency', 'failure injection needs the stand-in; covered in --stripe=stand-in');
    }

    await check('Fee rounding: $33.33 per card -> $66.66 payout -> $20.00 fee (half-up, integer cents)', async () => {
      await sql(`update tenants set reward_amount_cents = 3333 where id = $1`, [newTenantId]);
      const me = await api('GET', '/api/me', { token: tokenFor(USERS.newAdmin) });
      await sql(`update tenants set reward_amount_cents = 5000 where id = $1`, [newTenantId]);
      eq(me.body.referral_fee.payout_cents, 6666, 'payout_cents');
      eq(me.body.referral_fee.fee_cents, 2000, 'fee_cents');
      return JSON.stringify(me.body.referral_fee);
    });

    section('Exempt tenant on the dealer page');
    await check('GSS admin signs in straight to the app; mark-as-paid shows the original confirm, no Stripe call, no ledger row', async () => {
      const gss = await openPage();
      const callsBefore = STAND_IN ? (await stripeRequestLog()).length : 0;
      await signInOnPage(gss.page, USERS.gssAdmin);
      await gss.page.waitForSelector('#appArea', { state: 'visible', timeout: 10000 });
      assert(!(await visible(gss.page, '#gateBox')), 'gate shown to an exempt tenant');
      const referralId = await createReferral(USERS.gssAdmin, 5);
      await markPaidOnPage(gss.page, referralId);
      await waitForMarkedPaid(gss.page, referralId, 10000);
      const confirmMsg = gss.dialogs.filter((d) => d.type === 'confirm').pop().message;
      eq(confirmMsg, "Mark this referral as paid? This can't be undone.", 'confirm text');
      const [{ n }] = await sql('select count(*)::int as n from billing_events where tenant_id = $1', [tenants['good-steward-structures'].id]);
      eq(n, 0, 'GSS billing_events rows');
      if (STAND_IN) eq((await stripeRequestLog()).length - callsBefore, 0, 'Stripe requests');
      await gss.context.close();
      return `no gate; confirm: "${confirmMsg}"; referral rewarded; 0 billing_events, 0 Stripe requests`;
    });
    if (STAND_IN) {
      await check('If an exempt tenant were ever charged an activation (impossible via this API), it is recorded and flagged loudly for refund', async () => {
        const gssId = tenants['good-steward-structures'].id;
        const pi = await standIn('POST', '/__control/payment-intent', { with_customer: true, metadata: { kind: 'activation', tenant_id: gssId } });
        const r = await standIn('POST', '/__control/send-event', {
          type: 'checkout.session.completed',
          object: { id: 'cs_test_exempt', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: gssId, metadata: { kind: 'activation', tenant_id: gssId }, payment_intent: pi.id, customer: pi.customer, amount_total: 50000, livemode: false },
        });
        eq(r.status, 200, 'webhook status');
        await sleep(300);
        const line = apiProc.lines.find((l) => l.includes('BILLING-EXEMPT TENANT CHARGED'));
        assert(line, 'no BILLING-EXEMPT TENANT CHARGED log line');
        const me = await api('GET', '/api/me', { token: tokenFor(USERS.gssAdmin) });
        eq(me.body.referral_fee, null, 'GSS still never charged a usage fee');
        return line.replace(/^\[api:\w+\] /, '');
      });
    }

    // ----- Direct database access ------------------------------------------
    section('A tenant admin\'s own login token cannot rewrite billing columns (Supabase REST access)');
    await check('UPDATE of billing_required / activation_paid_at / referral_fee_bps / reward_amount_cents / activation_fee_cents refused', async () => {
      const out = [];
      for (const stmt of [
        `update tenants set billing_required = false where slug = 'acme-sheds'`,
        `update tenants set activation_paid_at = now(), activation_livemode = true where slug = 'acme-sheds'`,
        `update tenants set referral_fee_bps = 1 where slug = 'acme-sheds'`,
        `update tenants set reward_amount_cents = 100 where slug = 'acme-sheds'`,
        `update tenants set activation_fee_cents = 50 where slug = 'acme-sheds'`,
        `insert into billing_events (tenant_id, event_type, amount_cents, status) select id, 'activation_charge', 50000, 'succeeded' from tenants where slug = 'acme-sheds'`,
      ]) {
        const r = await sqlAsUser(USERS.acmeAdmin.id, stmt);
        assert(!r.ok, `allowed: ${stmt}`);
        out.push(r.error);
      }
      const allowed = await sqlAsUser(USERS.acmeAdmin.id, `update tenants set tremendous_campaign_id = 'camp_e2e' where slug = 'acme-sheds'`);
      assert(allowed.ok && allowed.rowCount === 1, `Tremendous credential update (still needed by the API) refused: ${allowed.error}`);
      return `${[...new Set(out)].join(' / ')}; Tremendous credential column still updatable (1 row)`;
    });
    await check('Marking a referral rewarded directly (skipping the API, so no usage fee) is refused; exempt tenants unaffected', async () => {
      const referralId = await createReferral(USERS.newAdmin, 7);
      const direct = await sqlAsUser(USERS.newAdmin.id, `update referrals set status = 'rewarded' where id = '${referralId}'`);
      assert(!direct.ok && /usage fee/.test(direct.error), `direct update was not refused: ${JSON.stringify(direct)}`);
      const ordered = await sqlAsUser(USERS.newAdmin.id, `update referrals set status = 'ordered' where id = '${referralId}'`);
      assert(ordered.ok && ordered.rowCount === 1, `an ordinary status change was refused: ${JSON.stringify(ordered)}`);
      const exemptReferral = await createReferral(USERS.nmsAdmin, 8);
      const exempt = await sqlAsUser(USERS.nmsAdmin.id, `update referrals set status = 'rewarded' where id = '${exemptReferral}'`);
      assert(exempt.ok && exempt.rowCount === 1, `NMS direct update refused: ${JSON.stringify(exempt)}`);
      return `billing-required tenant -> "${direct.error}"; its 'ordered' update still fine; NMS -> rewarded (1 row)`;
    });

    // ----- Stage 4 worker ----------------------------------------------------
    section('Stage 4 reward worker never charges an exempt tenant');
    await check('Dry run: an eligible exempt-tenant referral (even with active billing + a saved card) is skipped as billing-exempt', async () => {
      const gssId = tenants['good-steward-structures'].id;
      await sql(`update tenants set billing_status = 'active', stripe_customer_id = 'cus_e2e', stripe_payment_method_id = 'pm_e2e' where id = $1`, [gssId]);
      const referralId = await createReferral(USERS.gssAdmin, 6);
      await sql(`update referrals set status = 'closed', closed_at = now() - interval '8 days' where id = $1`, [referralId]);
      const out = await runWorkerDryRun();
      const line = out.split('\n').find((l) => l.includes(referralId));
      assert(line && line.includes('would_skip') && line.includes('billing-exempt'), `worker output for ${referralId}: ${line}\n${out}`);
      return line.trim();
    });

    // ----- Stripe configuration safety -------------------------------------
    section('assertRealStripeConfigured(): no stub/fake Stripe config can activate or charge');
    if (STAND_IN) {
      // expectedFeeStatus: with a usable test key but a stand-in base, the
      // tenant is still activated and the usage fee itself refuses (500).
      // With no usable key at all, a test-mode activation doesn't count
      // (lib/activation.js), so the gate refuses first (402). Either way:
      // nothing charged, nothing marked paid.
      for (const [label, env, expectedFeeStatus] of [
        ['STRIPE_API_BASE pointed at a stand-in', { STRIPE_API_BASE: `${STRIPE_BASE}/v1`, STRIPE_STAND_IN_URL: '' }, 500],
        ['STRIPE_SECRET_KEY unset', { STRIPE_SECRET_KEY: '', STRIPE_STAND_IN_URL: '' }, 402],
        ['STRIPE_SECRET_KEY a placeholder', { STRIPE_SECRET_KEY: 'changeme', STRIPE_STAND_IN_URL: '' }, 402],
      ]) {
        await check(`${label}: checkout, webhook activation and the usage fee all refuse; exempt tenants unaffected`, async () => {
          const proc = await startApi({ port: PORTS.alt, env, preload: false, label: `alt(${label})` });
          try {
            const base = `http://127.0.0.1:${PORTS.alt}`;
            const callsBefore = (await stripeRequestLog()).length;
            const checkout = await api('POST', '/api/billing/checkout-session', { base, token: tokenFor(USERS.acmeAdmin), body: {} });
            eq(checkout.status, 500, 'checkout status');
            const referralId = await createReferral(USERS.newAdmin, `c${label.length}`);
            const patch = await api('PATCH', `/api/referrals/${referralId}/status`, { base, token: tokenFor(USERS.newAdmin), body: { status: 'rewarded' } });
            eq(patch.status, expectedFeeStatus, 'mark-paid status');
            const feeRows = await sql(`select count(*)::int as n from billing_events where referral_id = $1`, [referralId]);
            eq(feeRows[0].n, 0, 'fee rows written');
            const [ref] = await sql('select status from referrals where id = $1', [referralId]);
            assert(ref.status !== 'rewarded', 'referral marked rewarded with no fee');
            const signed = require('./stripe-stand-in').signPayload;
            const event = JSON.stringify({ id: `evt_cfg_${label.length}`, object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_cfg', mode: 'payment', payment_status: 'paid', client_reference_id: tenants['acme-sheds'].id, metadata: { kind: 'activation', tenant_id: tenants['acme-sheds'].id }, payment_intent: 'pi_cfg', customer: 'cus_cfg', amount_total: 50000, livemode: false } } });
            const wh = await fetch(`${base}/api/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signed(event, WEBHOOK_SECRET) }, body: event });
            eq(wh.status, 500, 'webhook activation status');
            eq((await tenantRow('acme-sheds')).activation_paid_at, null, 'acme activated');
            eq((await stripeRequestLog()).length - callsBefore, 0, 'Stripe requests made');
            const exempt = await api('GET', '/api/referrals', { base, token: tokenFor(USERS.nmsAdmin) });
            eq(exempt.status, 200, 'NMS GET /api/referrals');
            const refusal = proc.lines.find((l) => l.includes('Refusing to run a Stripe billing action'));
            assert(refusal, 'no refusal in the server log');
            return `checkout 500, mark-paid ${patch.status}${patch.body && patch.body.code ? ` ${patch.body.code}` : ''} (no fee row, not rewarded), webhook 500 (acme not activated), 0 Stripe requests; NMS 200. Log: ${refusal.replace(/^\[[^\]]+\] /, '').slice(0, 170)}…`;
          } finally {
            await stopApi(proc);
          }
        });
      }
      await check('The stand-in preload itself refuses to load next to a live key', async () => {
        const proc = await startApi({ port: PORTS.alt, env: { STRIPE_SECRET_KEY: 'sk_live_e2eNotARealKey000000000' }, preload: true, label: 'alt(live+preload)', expectExit: true });
        assert(proc.exitCode !== 0 && proc.exitCode !== null, `exit code ${proc.exitCode}`);
        const line = proc.lines.find((l) => l.includes('refusing to load'));
        assert(line, 'no refusal message');
        return `exit ${proc.exitCode}: ${line.replace(/^\[[^\]]+\] /, '')}`;
      });
    }
    await check('On a LIVE key, a test-mode activation does not count (tenant re-gated); a live activation and exempt tenants do', async () => {
      const proc = await startApi({ port: PORTS.alt, env: { STRIPE_SECRET_KEY: 'sk_live_e2eNotARealKey000000000', STRIPE_STAND_IN_URL: '' }, preload: false, label: 'alt(live-key)' });
      try {
        const base = `http://127.0.0.1:${PORTS.alt}`;
        const line = proc.lines.find((l) => l.includes('Stripe billing:'));
        const testActivated = await api('GET', '/api/me', { base, token: tokenFor(USERS.newAdmin) });
        eq(testActivated.body.activation.required, true, 'test-activated tenant on a live key');
        const blocked = await api('GET', '/api/referrals', { base, token: tokenFor(USERS.newAdmin) });
        eq(blocked.status, 402, 'test-activated tenant GET /api/referrals on a live key');
        const exempt = await api('GET', '/api/me', { base, token: tokenFor(USERS.gssAdmin) });
        eq(exempt.body.activation.required, false, 'GSS on a live key');
        let liveNote = '';
        if (STAND_IN) {
          const live = await api('GET', '/api/me', { base, token: tokenFor(USERS.legacyAdmin) });
          eq(live.body.activation.required, false, 'live-activated tenant on a live key');
          liveNote = '; live-activated tenant -> not gated';
        }
        return `${line.replace(/^\[[^\]]+\] /, '')} | test-activated tenant -> gated (402)${liveNote}; GSS -> not gated`;
      } finally {
        await stopApi(proc);
      }
    });

    await admin.context.close();
    await staff.context.close();
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, 'api.log'), apiProcesses.flatMap((p) => p.lines).join('\n'));
    // Every teardown step is bounded, so a stuck one can never hold the
    // run (and its exit code) hostage.
    const step = (what, fn) => withTimeout(Promise.resolve().then(fn), 15000, what).catch((err) => console.error(`teardown: ${err.message}`));
    await step('browser.close', () => browser.close());
    for (const p of apiProcesses) await step(`stop ${p.label}`, () => stopApi(p));
    for (const s of servers) {
      if (s.closeAllConnections) s.closeAllConnections();
      s.close();
    }
    await step('database connection', () => mainDb.end());
    if (!args['keep-db']) {
      await step('drop main database', () => dropDatabase(DB_MAIN));
      await step('drop slug-check database', () => dropDatabase(DB_NEG));
    }
  }
}

// Real Stripe test mode: best-effort fill of Stripe's hosted Checkout page
// with test card 4242 4242 4242 4242; if the page's fields can't be
// found, print the URL and wait (up to 15 minutes) for it to be paid by
// hand — the run continues once Stripe redirects back.
async function completeRealCheckout(page) {
  try {
    const email = page.locator('#email');
    await email.waitFor({ state: 'visible', timeout: 30000 }).then(() => email.fill('e2e-owner@example.test'), () => {});
    // With more than one payment method enabled, Checkout lists them as an
    // accordion (Card, Cash App Pay, Klarna, …) and only renders the card
    // fields once "Card" is selected.
    const cardRow = page.locator('[data-testid="card-accordion-item"]');
    if (!(await page.locator('#cardNumber').isVisible()) && (await cardRow.count())) await cardRow.click();
    await page.fill('#cardNumber', '4242424242424242', { timeout: 15000 });
    await page.fill('#cardExpiry', '12 / 34');
    await page.fill('#cardCvc', '123');
    const name = page.locator('#billingName');
    if (await name.isVisible().catch(() => false)) await name.fill('E2E Owner');
    const zip = page.locator('#billingPostalCode');
    if (await zip.isVisible().catch(() => false)) await zip.fill('17101');
    // Link's "Save my information for faster checkout" comes pre-checked and
    // then requires a phone number — this is a test payment, not a Link signup.
    const link = page.locator('#enableStripePass');
    if ((await link.isVisible().catch(() => false)) && (await link.isChecked())) await link.uncheck();
    await page.click('button[type=submit]');
    // If Stripe hasn't sent the browser back a minute after submitting, keep
    // a screenshot of what Checkout is showing (a decline, a challenge, …).
    const shot = path.join(OUT_DIR, 'checkout-not-redirected.png');
    page
      .waitForURL((u) => !u.href.includes('checkout.stripe.com'), { timeout: 60000 })
      .catch(() => page.screenshot({ path: shot, fullPage: true }).then(() => console.log(`\n  Still on Checkout 60s after submitting — screenshot: ${shot}\n`)))
      .catch(() => {});
  } catch (err) {
    console.log(`\n  Couldn't fill Stripe's Checkout page automatically (${err.message}).`);
    console.log(`  Pay it by hand with test card 4242 4242 4242 4242, any future expiry, any CVC:\n  ${page.url()}\n`);
  }
}

function runWorkerDryRun() {
  // The worker refuses to run at all without a real gift card provider
  // (assertRealGiftCardProviderConfigured — none exists yet). This
  // deliberately bypasses that one gate, in a throwaway process, for a
  // read-only --dry-run against the throwaway database only.
  const script = `
    const gcp = require('./src/lib/giftCardProvider');
    gcp.assertRealGiftCardProviderConfigured = () => {};
    require('./src/workers/rewardIssuance').runRewardIssuanceCycle({ dryRun: true })
      .then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: API_DIR, env: apiEnv({}), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`worker dry run exited ${code}: ${out}`))));
  });
}

function writeReport() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const passed = results.filter((r) => r.pass === true).length;
  const failed = results.filter((r) => r.pass === false).length;
  const skipped = results.filter((r) => r.pass === null).length;
  const lines = [
    `# Activation gate + referral usage fee — e2e results`,
    '',
    `Stripe: **${STAND_IN ? 'local stand-in (test-mode-shaped, sk_test_ key)' : 'REAL Stripe TEST mode'}** · run ${RUN_ID} · ${passed} passed, ${failed} failed, ${skipped} skipped`,
    '',
  ];
  let last = null;
  for (const r of results) {
    if (r.section !== last) {
      lines.push(`\n### ${r.section}\n`, '| | Check | Evidence |', '|---|---|---|');
      last = r.section;
    }
    const mark = r.pass === true ? '✅' : r.pass === false ? '❌' : '⏭️';
    lines.push(`| ${mark} | ${r.title} | ${String(r.evidence).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'results.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ mode: MODE, runId: RUN_ID, passed, failed, skipped, results }, null, 2));
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped — ${path.join(OUT_DIR, 'results.md')}`);
  return failed;
}

main()
  .then(() => process.exit(writeReport() ? 1 : 0))
  .catch((err) => {
    console.error(err);
    writeReport();
    process.exit(1);
  });
