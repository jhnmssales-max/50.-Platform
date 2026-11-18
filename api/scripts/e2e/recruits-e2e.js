#!/usr/bin/env node
// Verification of the Recruits board: Joseph's own list of people he is
// hiring as reps.
//
//   node scripts/e2e/recruits-e2e.js
//
// Needs the scratch Postgres like the other e2e scripts (E2E_PG_ADMIN_URL,
// default postgresql://postgres@127.0.0.1:54329/postgres).
//
// What it checks: only the admin can see or change recruits (the helper and
// a rep get a 403 from the API, and nothing from the table directly); a card
// moving forward stamps its stage once and moving back never unstamps it, so
// the week's counts hold; and signing a recruit on makes exactly one rep,
// however many times it is pressed.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { Client } = require('pg');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_DIR = path.join(REPO_ROOT, 'api');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const ACTIVATION_MIGRATION = '20261001000000_activation_gate_and_referral_fee.sql';
const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:54329/postgres';
const DB = 'recruits_e2e';
const PORTS = { api: 54451, postmark: 54452, jwks: 54453 };
const KEYPAIR = path.join(__dirname, '.recruits-keypair.json');

let passed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dbUrl(name) { const u = new URL(PG_ADMIN_URL); u.pathname = `/${name}`; return u.toString(); }
async function withClient(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function bootstrapDatabase() {
  await withClient(PG_ADMIN_URL, async (c) => {
    await c.query(`drop database if exists ${DB} with (force)`);
    await c.query(`create database ${DB}`);
  });
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  await withClient(dbUrl(DB), async (c) => {
    await c.query(fs.readFileSync(path.join(__dirname, 'supabase-stand-in.sql'), 'utf8'));
    for (const f of files) {
      if (f >= ACTIVATION_MIGRATION) continue;
      await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    }
    await c.query(`insert into tenants (slug, name) values
      ('good-steward-structures','Good Steward Structures'),
      ('north-mountain-structures','North Mountain Structures'),
      ('50-platform','50.')`);
    for (const f of files) {
      if (f < ACTIVATION_MIGRATION) continue;
      await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    }
  });
}

function startPostmark() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ErrorCode":0}'); });
  });
  return new Promise((r) => server.listen(PORTS.postmark, () => r(server)));
}

function request(pathname, { method = 'GET', token, body, raw, headers: extra, query } = {}) {
  return new Promise((resolve) => {
    if (query) {
      const qs = new URLSearchParams(query).toString();
      pathname += (pathname.includes('?') ? '&' : '?') + qs;
    }
    const payload = raw || (body ? JSON.stringify(body) : null);
    const headers = { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...(extra || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port: PORTS.api, path: pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON is itself the finding */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: { error: err.message } }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForApi() {
  for (let i = 0; i < 80; i += 1) {
    const res = await request('/api/health');
    if (res.status) return true;
    await sleep(200);
  }
  return false;
}

// A spreadsheet of the shape a bought list actually arrives in: headings
// nobody agreed, a phone Excel has turned into a number, a blank row, a
// repeat, and a totals line at the bottom.

async function main() {
  if (/supabase\.(co|com)/.test(PG_ADMIN_URL)) {
    throw new Error('E2E_PG_ADMIN_URL points at a Supabase project — this runner only ever runs against a throwaway Postgres server.');
  }
  console.log('Building the database from every migration...');
  await bootstrapDatabase();
  const postmark = await startPostmark();
  const tokenFor = (userId) =>
    execFileSync('node', [path.join(API_DIR, 'scripts', 'gen_test_jwt.js'), KEYPAIR, userId], { cwd: API_DIR })
      .toString().trim().split('\n').pop();
  const jwks = spawn('node', [path.join(API_DIR, 'scripts', 'serve_test_jwks.js'), KEYPAIR, String(PORTS.jwks)], { cwd: API_DIR, stdio: 'ignore' });

  const ids = await withClient(dbUrl(DB), async (c) => {
    const { rows: [platform] } = await c.query("select id from tenants where slug = '50-platform'");
    const makeUser = async (email, role, name) => {
      const { rows: [auth] } = await c.query('insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id', [email]);
      await c.query('insert into users (id, tenant_id, name, email, role) values ($1, $2, $3, $4, $5)', [auth.id, platform.id, name, email, role]);
      return auth.id;
    };
    const joseph = await makeUser('joseph@referwith50.com', 'admin', 'Joseph');
    const helper = await makeUser('helper@referwith50.com', 'staff', 'Helper');
    const repUser = await makeUser('rep@referwith50.com', 'rep', 'A Rep');
    await c.query(`insert into reps (name, email, user_id) values ('A Rep', 'rep@referwith50.com', $1)`, [repUser]);
    return { joseph, helper, repUser };
  });

  const api = spawn('node', [path.join('src', 'server.js')], {
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl(DB), PORT: String(PORTS.api),
      SUPABASE_URL: `http://127.0.0.1:${PORTS.jwks}`,
      SUPABASE_JWKS_URL: `http://127.0.0.1:${PORTS.jwks}/auth/v1/.well-known/jwks.json`,
      POSTMARK_SERVER_TOKEN: 'recruits-e2e', POSTMARK_API_BASE: `http://127.0.0.1:${PORTS.postmark}`,
      EMAIL_FROM_ADDRESS: 'noreply@referwith50.com', EMAIL_FROM_NAME: '50.',
      TENANT_CREDENTIALS_ENCRYPTION_KEY: 'recruits-e2e-key', FRONTEND_BASE_URL: 'https://go.referwith50.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let apiLog = '';
  api.stdout.on('data', (d) => (apiLog += d));
  api.stderr.on('data', (d) => (apiLog += d));
  const cleanup = () => { api.kill(); jwks.kill(); postmark.close(); };

  try {
    if (!await waitForApi()) throw new Error(`The API did not start.\n${apiLog.slice(-2000)}`);
    const joseph = tokenFor(ids.joseph);
    const helper = tokenFor(ids.helper);
    const rep = tokenFor(ids.repUser);

    console.log('\nAdding and moving recruits');
    const a = await request('/api/recruits', { method: 'POST', token: joseph, body: { name: 'Marc Williams', phone: '717-555-0100', email: 'marc@example.com', source: 'wizehire', location: 'Dallas, TX' } });
    check('Joseph can add a recruit', a.status === 201 && a.body?.stage === 'applied', `status ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`);
    const meetAt = new Date(Date.now() + 2 * 3600000).toISOString();
    const b = await request('/api/recruits', { method: 'POST', token: joseph, body: { name: 'Nora James', source: 'handshake', meeting_at: meetAt } });
    check('a recruit added with a meeting time lands in Meeting booked', b.body?.stage === 'meeting' && b.body?.contacted_at && b.body?.replied_at, b.body?.stage);
    const bad = await request('/api/recruits', { method: 'POST', token: joseph, body: { name: 'X', source: 'myspace' } });
    check('an unknown source is refused', bad.status === 400, `status ${bad.status}`);

    const moved = await request(`/api/recruits/${a.body.id}`, { method: 'PATCH', token: joseph, body: { stage: 'replied' } });
    check('moving forward stamps contacted and replied', moved.body?.contacted_at && moved.body?.replied_at, JSON.stringify(moved.body).slice(0, 160));
    const back = await request(`/api/recruits/${a.body.id}`, { method: 'PATCH', token: joseph, body: { stage: 'applied' } });
    check('moving back keeps the stamps', back.body?.stage === 'applied' && back.body?.replied_at === moved.body.replied_at);
    const note = await request(`/api/recruits/${a.body.id}`, { method: 'PATCH', token: joseph, body: { next_step: 'Texted Tue', meeting_at: '' } });
    check('a card note and a cleared meeting save', note.body?.next_step === 'Texted Tue' && note.body?.meeting_at === null, `status ${note.status}`);

    const list = await request('/api/recruits', { token: joseph });
    check('the board lists both', list.status === 200 && list.body?.recruits?.length === 2, `status ${list.status}`);
    const w = list.body?.week || {};
    check('this week counts them', w.applied === 2 && w.contacted === 2 && w.replied === 2 && w.meetings === 1 && w.hired === 0, JSON.stringify(w));

    console.log('\nSigning a recruit on');
    const m1 = await request(`/api/recruits/${b.body.id}/make-rep`, { method: 'POST', token: joseph });
    const m2 = await request(`/api/recruits/${b.body.id}/make-rep`, { method: 'POST', token: joseph });
    check('signing on moves the card to Signed on with a rep', m1.status === 200 && m1.body?.stage === 'hired' && m1.body?.rep_id && m1.body?.hired_at, `status ${m1.status} ${JSON.stringify(m1.body).slice(0, 160)}`);
    check('pressing it twice gives the same rep', m2.body?.rep_id === m1.body?.rep_id);
    const reps = await withClient(dbUrl(DB), (c) => c.query("select count(*)::int as n from reps where name = 'Nora James'"));
    check('exactly one rep was made', reps.rows[0].n === 1, `${reps.rows[0].n}`);

    console.log('\nNobody else sees it');
    for (const [who, tok] of [['the helper', helper], ['a rep', rep]]) {
      const g = await request('/api/recruits', { token: tok });
      check(`${who} cannot list recruits`, g.status === 403, `status ${g.status}`);
      const p = await request('/api/recruits', { method: 'POST', token: tok, body: { name: 'Sneaky' } });
      check(`${who} cannot add one`, p.status === 403, `status ${p.status}`);
      const d = await request(`/api/recruits/${a.body.id}`, { method: 'DELETE', token: tok });
      check(`${who} cannot delete one`, d.status === 403, `status ${d.status}`);
    }
    const direct = await withClient(dbUrl(DB), async (c) => {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ids.helper, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      const { rows } = await c.query('select count(*)::int as n from recruits');
      await c.query('rollback');
      return rows[0].n;
    });
    check('and RLS gives the helper no rows straight from the table', direct === 0, `${direct} row(s)`);

    const del = await request(`/api/recruits/${a.body.id}`, { method: 'DELETE', token: joseph });
    check('Joseph can delete one', del.status === 200);
  } finally {
    cleanup();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
