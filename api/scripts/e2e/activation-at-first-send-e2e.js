#!/usr/bin/env node
// Verification that the activation fee is asked for at the first SEND, not
// at the first sign-in: an unpaid dealer gets the real dashboard, and the
// wall sits on the one action that costs anything.
//
//   node scripts/e2e/activation-at-first-send-e2e.js
//
// Needs the scratch Postgres like the other e2e scripts, plus playwright's
// Chromium. The page is driven in a real browser against the real API, with
// Supabase Auth and Postmark stood in.
//
// The thing most worth catching here is the direction of the gate. Reads opt
// OUT of it; writes stay gated by default. So this does not only check that
// the two list routes are open -- it checks that everything else is still
// shut, including routes nobody was thinking about when the change was made.
// If that inverts later, a send-shaped endpoint added next year goes out for
// free and nobody notices until the invoice does not arrive.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { chromium } = require('playwright');
const { createAuthStandIn, SERVICE_ROLE_KEY } = require('./auth-stand-in');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const API_DIR = path.resolve(__dirname, '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const ADMIN = process.env.E2E_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:54329/postgres';
const DB = 'activation_first_send_e2e';
const ACT = '20261001000000_activation_gate_and_referral_fee.sql';
const P = { api: 54441, pm: 54442, auth: 54443, page: 54444 };

let passed = 0; const failures = [];
const ok = (label, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const dbUrl = (n) => { const u = new URL(ADMIN); u.pathname = `/${n}`; return u.toString(); };
const wc = async (u, f) => { const c = new Client({ connectionString: u }); await c.connect(); try { return await f(c); } finally { await c.end(); } };

let api, browser;
const teardown = () => { try { api && api.kill(); } catch {} try { browser && browser.close(); } catch {} };
process.on('exit', teardown);

const sent = [];

(async () => {
  // --- schema -------------------------------------------------------
  await wc(ADMIN, async (c) => {
    await c.query(`drop database if exists ${DB} with (force)`);
    await c.query(`create database ${DB}`);
  });
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  const ids = await wc(dbUrl(DB), async (c) => {
    await c.query(fs.readFileSync(path.join(__dirname, 'supabase-stand-in.sql'), 'utf8'));
    for (const f of files) { if (f >= ACT) continue; await c.query(fs.readFileSync(path.join(MIG, f), 'utf8')); }
    await c.query(`insert into tenants (slug, name) values
      ('good-steward-structures','Good Steward Structures'),('north-mountain-structures','NMS'),('50-platform','50.')`);
    for (const f of files) { if (f < ACT) continue; await c.query(fs.readFileSync(path.join(MIG, f), 'utf8')); }

    // A brand-new dealer exactly as onboarding leaves them: billing
    // required, nothing paid. This is the state the whole change is about.
    const { rows: [t] } = await c.query(
      `insert into tenants (slug, name, billing_required, billing_status, activation_fee_cents)
       values ('new-dealer','Creative Backyards', true, 'pending', 50000) returning id`);
    const mk = async (email, role) => {
      const { rows: [a] } = await c.query('insert into auth.users (id,email) values (gen_random_uuid(),$1) returning id', [email]);
      await c.query('insert into users (id,tenant_id,name,email,role) values ($1,$2,$3,$4,$5)',
        [a.id, t.id, role === 'admin' ? 'Jerald Rhodes' : 'A Salesperson', email, role]);
      return a.id;
    };
    return { tenant: t.id, admin: await mk('jerald@newdealer.com', 'admin'), staff: await mk('rep@newdealer.com', 'staff') };
  });

  // --- stand-ins ----------------------------------------------------
  http.createServer((rq, rs) => { let b = ''; rq.on('data', (d) => (b += d)); rq.on('end', () => {
    try { sent.push(JSON.parse(b)); } catch {}
    rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ MessageID: 's', ErrorCode: 0 }));
  }); }).listen(P.pm);

  const auth = createAuthStandIn({ onUserCreated: (u) =>
    wc(dbUrl(DB), (c) => c.query('insert into auth.users (id,email) values ($1,$2) on conflict (id) do nothing', [u.id, u.email])) });
  await new Promise((r) => auth.app.listen(P.auth, r));
  auth.addUser({ id: ids.admin, email: 'jerald@newdealer.com', password: 'password123' });
  auth.addUser({ id: ids.staff, email: 'rep@newdealer.com', password: 'password123' });
  const tok = (id, email) => auth.mintToken({ id, email });

  api = spawn('node', [path.join('src', 'server.js')], {
    cwd: API_DIR,
    env: { ...process.env,
      DATABASE_URL: dbUrl(DB), PORT: String(P.api),
      SUPABASE_URL: `http://127.0.0.1:${P.auth}`,
      SUPABASE_JWKS_URL: `http://127.0.0.1:${P.auth}/auth/v1/.well-known/jwks.json`,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      POSTMARK_SERVER_TOKEN: 't', POSTMARK_API_BASE: `http://127.0.0.1:${P.pm}`,
      EMAIL_FROM_ADDRESS: 'noreply@referwith50.com',
      TENANT_CREDENTIALS_ENCRYPTION_KEY: 'k', FRONTEND_BASE_URL: 'https://go.referwith50.com' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; api.stdout.on('data', (d) => (log += d)); api.stderr.on('data', (d) => (log += d));

  const call = (p, { method = 'GET', token, body } = {}) => new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const rq = http.request({ host: '127.0.0.1', port: P.api, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    rq.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (payload) rq.write(payload); rq.end();
  });
  for (let i = 0; i < 80; i += 1) { const r = await call('/api/me'); if (r.status) break; await new Promise((x) => setTimeout(x, 200)); }

  try {
    const adminTok = tok(ids.admin, 'jerald@newdealer.com');
    const staffTok = tok(ids.staff, 'rep@newdealer.com');

    console.log('\nAn unpaid dealer can look around');
    const me = await call('/api/me', { token: adminTok });
    ok('GET /me works and says it is unactivated', me.status === 200 && me.body?.activation?.required === true,
      `reason=${me.body?.activation?.reason}`);
    ok('it still carries their own name and branding',
      me.body?.tenant_name === 'Creative Backyards' && me.body?.tenant_branding !== undefined,
      me.body?.tenant_name);

    const custList = await call('/api/customers', { token: adminTok });
    ok('the invited list loads', custList.status === 200, `status ${custList.status}`);
    ok('and is honestly empty', (custList.body?.customers || []).length === 0);

    const refList = await call('/api/referrals', { token: adminTok });
    ok('the referrals list loads', refList.status === 200, `status ${refList.status}`);
    ok('and is honestly empty', (refList.body?.referrals || []).length === 0);

    console.log('\nBut cannot send');
    const before = sent.length;
    const send = await call('/api/customers', { method: 'POST', token: adminTok,
      body: { name: 'Dale Hostetler', email: 'dale@example.com' } });
    ok('the first send is refused with 402', send.status === 402, `status ${send.status}`);
    ok('and names the reason the page keys off', send.body?.code === 'activation_required' || /activation/i.test(send.body?.error || ''),
      send.body?.code || (send.body?.error || '').slice(0, 50));
    ok('no email went out', sent.length === before, `${sent.length - before} sent`);

    // The customer must not be half-created. This is the whole point of
    // refusing before the write rather than after.
    const rows = await wc(dbUrl(DB), async (c) =>
      (await c.query('select count(*)::int n from customers where email = $1', ['dale@example.com'])).rows[0].n);
    ok('nothing was written for the refused send', rows === 0, `${rows} customer row(s)`);
    const links = await wc(dbUrl(DB), async (c) =>
      (await c.query('select count(*)::int n from referral_links')).rows[0].n);
    ok('no orphan referral link was minted', links === 0, `${links} link(s)`);

    console.log('\nEverything else stays shut (the direction of the gate)');
    for (const [label, p, method] of [
      ['resend an invite', '/api/customers/00000000-0000-4000-8000-000000000000/resend', 'POST'],
      ['list reps', '/api/reps', 'GET'],
      ['read reports', '/api/reports/company', 'GET'],
      ['create an API key', '/api/tenant/api-keys', 'POST'],
      ['list API keys', '/api/tenant/api-keys', 'GET'],
    ]) {
      const r = await call(p, { method, token: adminTok, body: method === 'POST' ? { name: 'x' } : undefined });
      ok(`cannot ${label}`, r.status === 402, `status ${r.status}`);
    }

    console.log('\nAnyone on the account can pay');
    const staffCheckout = await call('/api/billing/checkout-session', { method: 'POST', token: staffTok,
      body: { return_url: 'https://go.referwith50.com/fifty-template-dealer.html' } });
    // Stripe is not really configured here, so a 5xx is the stand-in
    // refusing to charge -- what matters is that it was not an authorization
    // refusal, which is what a staff-only block would look like.
    ok('a staff member is not blocked from checkout', staffCheckout.status !== 403 && staffCheckout.status !== 402,
      `status ${staffCheckout.status}`);
    const staffList = await call('/api/customers', { token: staffTok });
    ok('a staff member can see the dashboard too', staffList.status === 200, `status ${staffList.status}`);

    console.log('\nOnce paid, sending works');
    await wc(dbUrl(DB), (c) => c.query(
      `update tenants set activation_paid_at = now(), activation_livemode = true, billing_status = 'active' where id = $1`,
      [ids.tenant]));
    const afterPay = await call('/api/customers', { method: 'POST', token: adminTok,
      body: { name: 'Dale Hostetler', email: 'dale@example.com' } });
    ok('the same send now succeeds', afterPay.status === 201, `status ${afterPay.status}`);
    ok('and the invite really went out', sent.length === before + 1, `${sent.length - before} email(s)`);

    // --- the page itself ------------------------------------------------
    console.log('\nWhat the dealer actually sees');
    await wc(dbUrl(DB), (c) => c.query(
      `update tenants set activation_paid_at = null, activation_livemode = null, billing_status = 'pending' where id = $1`,
      [ids.tenant]));
    const html = fs.readFileSync(path.join(ROOT, 'fifty-template-dealer.html'), 'utf8')
      .replace(/const API_BASE = "[^"]*"/, `const API_BASE = "http://127.0.0.1:${P.api}/api"`);
    http.createServer((rq, rs) => { rs.writeHead(200, { 'Content-Type': 'text/html' }); rs.end(html); }).listen(P.page);

    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 760, height: 1000 } });
    const page = await ctx.newPage();
    const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`http://127.0.0.1:${P.page}/fifty-template-dealer.html`);
    await page.evaluate((t) => localStorage.setItem('fifty:session', JSON.stringify({ access_token: t, refresh_token: 'n' })), adminTok);
    await page.reload();
    await page.waitForTimeout(2000);

    ok('an unpaid dealer lands in the dashboard, not a payment screen',
      await page.locator('#appArea').isVisible() && !(await page.locator('#gateBox').isVisible()));
    ok('the send form is right there', await page.locator('#sendForm').isVisible());
    // The branded header is the thing they are deciding whether to pay for,
    // so it has to actually be theirs before the wall, not after.
    const brandName = (await page.locator('[data-tenant-name]').first().textContent()) || '';
    ok('their own company name is on the page', brandName.includes('Creative Backyards'), brandName.trim().slice(0, 50));
    ok('the API keys section stays hidden until they pay', !(await page.locator('#apiKeysSection').isVisible()));
    await page.locator('#appArea').screenshot({ path: '/var/tmp/unpaid-dashboard.png', scale: 'css' });

    // The moment that matters: typing a customer and pressing send.
    await page.fill('#custName', 'Dale Hostetler');
    await page.fill('#custEmail', 'dale2@example.com');
    const sentBeforeClick = sent.length;
    await page.click('#sendBtn');
    await page.waitForTimeout(2500);

    ok('pressing send puts up the payment screen', await page.locator('#gateBox').isVisible());
    const gateTitle = (await page.locator('#gateTitle').textContent()) || '';
    ok('which asks for the activation', /activate/i.test(gateTitle), gateTitle.trim());
    const gateLede = (await page.locator('#gateLede').textContent()) || '';
    ok('and names the fee', /\$500/.test(gateLede), gateLede.trim().slice(0, 90));
    ok('nothing was emailed', sent.length === sentBeforeClick);
    ok('and nothing was stored', (await wc(dbUrl(DB), async (c) =>
      (await c.query('select count(*)::int n from customers where email = $1', ['dale2@example.com'])).rows[0].n)) === 0);
    ok('no "something went wrong" scare', !/something went wrong/i.test(await page.locator('body').innerText()));
    await page.locator('#gateBox').screenshot({ path: '/var/tmp/paywall.png', scale: 'css' });

    // A salesperson, not an admin, must get the same payment screen.
    await page.evaluate((t) => localStorage.setItem('fifty:session', JSON.stringify({ access_token: t, refresh_token: 'n' })), staffTok);
    await page.reload(); await page.waitForTimeout(2000);
    ok('a salesperson also lands in the dashboard', await page.locator('#appArea').isVisible());
    await page.fill('#custName', 'Someone Else');
    await page.fill('#custEmail', 'someone@example.com');
    await page.click('#sendBtn');
    await page.waitForTimeout(2500);
    const staffGate = (await page.locator('#gateTitle').textContent()) || '';
    ok('and is offered checkout rather than "ask your admin"',
      await page.locator('#gateBox').isVisible() && /activate/i.test(staffGate) && !/admin/i.test(
        (await page.locator('#gateLede').textContent()) || ''),
      staffGate.trim());

    ok('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ').slice(0, 140));
  } finally {
    teardown();
  }

  console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}.`);
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exitCode = 1; }
  await wc(ADMIN, (c) => c.query(`drop database if exists ${DB} with (force)`)).catch(() => {});
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('THREW:', e.message); teardown(); process.exit(1); });
