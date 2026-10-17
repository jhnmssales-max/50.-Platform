#!/usr/bin/env node
// Verification of building a dealer from a won lead: the dealer_build
// migration, the file/brand/build routes in src/routes/reps.js,
// src/lib/supabaseStorage.js, src/lib/brandGuess.js and the two emails.
//
//   node scripts/e2e/dealer-build-e2e.js
//
// Stand-ins for everything outside this project: Supabase Auth's admin API
// and its Storage API, Postmark, and a small website to read a brand off.
// The real API runs as a child process against a real Postgres built from
// every migration.
const path = require('path');
const fs = require('fs');
const express = require('express');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { PNG } = require('pngjs');
const { createAuthStandIn, SERVICE_ROLE_KEY } = require('./auth-stand-in');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_DIR = path.join(REPO_ROOT, 'api');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const ACTIVATION_MIGRATION = '20261001000000_activation_gate_and_referral_fee.sql';
const BUILD_MIGRATION = '20261017000000_dealer_build.sql';
const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:54329/postgres';
const DB = `fifty_build_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const PORTS = { api: 3103, supabase: 9993, postmark: 12115, site: 8091, front: 8092 };
const API = `http://127.0.0.1:${PORTS.api}`;
const SUPABASE_BASE = `http://127.0.0.1:${PORTS.supabase}`;
const SITE = `http://127.0.0.1:${PORTS.site}`;
const FRONTEND = `http://127.0.0.1:${PORTS.front}`;

const results = [];
let currentSection = '';
function section(name) { currentSection = name; console.log(`\n=== ${name}`); }
async function check(title, fn) {
  try {
    const evidence = await fn();
    results.push({ title, pass: true });
    console.log(`  PASS  ${title}${evidence ? `\n        ${evidence}` : ''}`);
  } catch (err) {
    results.push({ title, pass: false });
    console.log(`  FAIL  ${title}\n        ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, what) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const dbUrl = (n) => { const u = new URL(PG_ADMIN_URL); u.pathname = `/${n}`; return u.toString(); };

const PASSWORD = 'e2e-password-1';
const USERS = {
  admin: { id: 'e0000000-0000-4000-8000-000000000001', email: 'joseph@fifty.test', name: 'Joseph', role: 'admin', tenant: '50-platform' },
  helper: { id: 'e0000000-0000-4000-8000-000000000002', email: 'helper@fifty.test', name: 'Helper', role: 'staff', tenant: '50-platform' },
};

// A logo with two colours planted in it, so what comes back out can be checked
// against what went in rather than merely "something plausible".
function makeLogoPng(top, bottom) {
  const png = new PNG({ width: 80, height: 80 });
  for (let y = 0; y < 80; y += 1) {
    for (let x = 0; x < 80; x += 1) {
      const i = (y * 80 + x) << 2;
      const c = y < 50 ? top : y < 70 ? bottom : [0, 0, 0, 0];
      png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = c[3] === undefined ? 255 : c[3];
    }
  }
  return PNG.sync.write(png);
}

async function main() {
  let recordAuthUser = async () => {};
  const auth = createAuthStandIn({ onUserCreated: (u) => recordAuthUser(u) });

  // Supabase stand-in: Auth's admin API (from auth-stand-in) plus Storage.
  const objects = new Map();
  const buckets = new Set();
  const supa = express();
  supa.use((req, res, next) => {
    // Storage goes through here; everything else is Auth's.
    if (req.path.startsWith('/storage/')) return next();
    return auth.app(req, res, next);
  });
  supa.post('/storage/v1/bucket', express.json(), (req, res) => {
    if (buckets.has(req.body.id)) return res.status(409).json({ message: 'Bucket already exists' });
    buckets.add(req.body.id);
    res.json({ name: req.body.id });
  });
  supa.post('/storage/v1/object/:bucket/*', express.raw({ type: () => true, limit: '8mb' }), (req, res) => {
    const key = `${req.params.bucket}/${req.params[0]}`;
    if (!buckets.has(req.params.bucket)) return res.status(404).json({ message: 'Bucket not found' });
    objects.set(key, { bytes: req.body, contentType: req.headers['content-type'] });
    res.json({ Key: key });
  });
  supa.delete('/storage/v1/object/:bucket/*', (req, res) => {
    objects.delete(`${req.params.bucket}/${req.params[0]}`);
    res.json({ message: 'Successfully deleted' });
  });
  supa.get('/storage/v1/object/public/:bucket/*', (req, res) => {
    const o = objects.get(`${req.params.bucket}/${req.params[0]}`);
    if (!o) return res.status(404).end();
    res.type(o.contentType).send(o.bytes);
  });
  const supaServer = supa.listen(PORTS.supabase, '127.0.0.1');

  const sent = [];
  let postmarkFailing = false;
  const mail = express();
  mail.use(express.json());
  mail.post('/email', (req, res) => {
    if (postmarkFailing) return res.status(500).json({ ErrorCode: 500, Message: 'Postmark is down (test)' });
    sent.push(req.body);
    res.json({ ErrorCode: 0, MessageID: `m-${sent.length}` });
  });
  const mailServer = mail.listen(PORTS.postmark, '127.0.0.1');

  // A prospect's website, with a declared theme colour and a logo.
  const site = express();
  site.get('/', (req, res) => res.type('html').send(`<!doctype html><html><head>
    <title>Silver Run Home Improvements</title>
    <meta name="theme-color" content="#B22222">
    <link rel="icon" href="/favicon.png">
    </head><body style="background:#FFFFFF">
    <img src="/img/silver-run-logo.png" alt="Silver Run logo" class="logo">
    <div style="background-color:#1E6F3C">Our work</div>
    <div style="background-color:#1E6F3C">More</div>
    </body></html>`));
  site.get('/slow', (req, res) => setTimeout(() => res.send('too late'), 20000));
  site.get('/bare', (req, res) => res.type('html').send('<html><body>Call us on 717-555-0000</body></html>'));
  const siteServer = site.listen(PORTS.site, '127.0.0.1');

  const admin0 = new Client({ connectionString: PG_ADMIN_URL });
  await admin0.connect();
  await admin0.query(`drop database if exists ${DB} with (force)`);
  await admin0.query(`create database ${DB}`);
  await admin0.end();
  const db = new Client({ connectionString: dbUrl(DB) });
  await db.connect();
  const sql = async (t, p) => (await db.query(t, p)).rows;
  recordAuthUser = (u) => db.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing', [u.id, u.email]);

  let apiChild = null;
  const apiLines = [];

  try {
    section('Migration');
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await db.query(fs.readFileSync(path.join(__dirname, 'supabase-stand-in.sql'), 'utf8'));
    for (const f of files) if (f < ACTIVATION_MIGRATION) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    await db.query(`insert into tenants (slug, name) values
      ('good-steward-structures','GSS'),('north-mountain-structures','NMS'),('50-platform','50.')`);
    await check('Every migration applies in order, including the dealer-build one', async () => {
      const rest = files.filter((f) => f >= ACTIVATION_MIGRATION);
      for (const f of rest) await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      assert(rest.includes(BUILD_MIGRATION), 'dealer_build migration not found');
      return rest.join(', ');
    });

    const tenants = {};
    for (const r of await sql('select id, slug from tenants')) tenants[r.slug] = r;
    for (const u of Object.values(USERS)) {
      await sql('insert into auth.users (id, email) values ($1,$2)', [u.id, u.email]);
      await sql('insert into users (id, tenant_id, email, name, role) values ($1,$2,$3,$4,$5)', [u.id, tenants[u.tenant].id, u.email, u.name, u.role]);
      auth.addUser({ id: u.id, email: u.email, password: PASSWORD });
    }

    apiChild = spawn(process.execPath, ['src/server.js'], {
      cwd: API_DIR,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        DATABASE_URL: dbUrl(DB), SUPABASE_URL: SUPABASE_BASE, SUPABASE_JWKS_URL: '', PORT: String(PORTS.api),
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
        POSTMARK_SERVER_TOKEN: 'postmark-test-token', POSTMARK_API_BASE: `http://127.0.0.1:${PORTS.postmark}`,
        EMAIL_FROM_ADDRESS: 'notifications@referwith50.test', BILLING_SUPPORT_EMAIL: 'joseph@referwith50.test',
        FRONTEND_BASE_URL: FRONTEND, TENANT_CREDENTIALS_ENCRYPTION_KEY: 'e2e-only-passphrase',
        // The pretend prospect's website is served on 127.0.0.1, which the
        // brand lookup refuses by default. Never set in production.
        BRAND_LOOKUP_ALLOW_LOCAL: '1',
        STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_API_BASE: '', STRIPE_STAND_IN_URL: '',
        RENEWAL_SCHEDULER: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const onData = (b) => { for (const l of b.toString().split('\n').filter(Boolean)) { apiLines.push(l); if (l.includes('listening on')) resolve(); } };
      apiChild.stdout.on('data', onData); apiChild.stderr.on('data', onData);
      if (process.env.E2E_SHOW_API === '1') { apiChild.stdout.pipe(process.stderr); apiChild.stderr.pipe(process.stderr); }
      apiChild.on('exit', (c) => reject(new Error(`API exited ${c}:\n${apiLines.join('\n')}`)));
      setTimeout(() => reject(new Error('API did not start')), 15000);
    });

    // The suite talks to the database as a signed-in user in one check, which
    // loads src/db.js in THIS process — so it needs its own connection string.
    process.env.DATABASE_URL = dbUrl(DB);

    const tokenFor = (u) => auth.mintToken(u);
    async function api(method, p, { as, body, raw, headers } = {}) {
      const res = await fetch(`${API}/api${p}`, {
        method,
        headers: {
          ...(raw ? {} : { 'Content-Type': 'application/json' }),
          ...(as ? { Authorization: `Bearer ${tokenFor(as)}` } : {}),
          ...(headers || {}),
        },
        body: raw || (body ? JSON.stringify(body) : undefined),
      });
      let json = null;
      try { json = await res.json(); } catch (e) { /* none */ }
      return { status: res.status, body: json };
    }

    // ======================================================================
    section('A rep drags a logo onto a lead');
    const repRow = (await api('POST', '/reps', { as: USERS.admin, body: { name: 'Alice Rep', email: 'alice@reps.test' } })).body;
    await api('POST', `/reps/${repRow.id}/invite`, { as: USERS.admin });
    auth.setPassword('alice@reps.test', PASSWORD);
    const ALICE = { id: auth.userIdFor('alice@reps.test'), email: 'alice@reps.test' };

    const lead = (await api('POST', '/rep-leads', {
      as: ALICE,
      body: {
        company_name: 'Silver Run Home Improvements', contact_name: 'Christian', email: 'christian@silverrun.test',
        phone: '717-555-0199', website: `${SITE}/`, notes: 'Wants it before spring.',
        // Christian's own words. A roofer does not say "buy a shed".
        copy: { friendAction: 'hire us for your roof', inquiryNoun: 'roofing inquiry' },
      },
    })).body;

    let logoFile;
    await check('A rep uploads a PNG logo; it goes to storage, not to the API disk', async () => {
      const bytes = makeLogoPng([178, 34, 34], [30, 111, 60]);
      const r = await api('POST', `/rep-leads/${lead.id}/files?kind=logo&filename=silver-run.png`, {
        as: ALICE, raw: bytes, headers: { 'Content-Type': 'image/png' },
      });
      eq(r.status, 201, 'upload');
      logoFile = r.body;
      eq(logoFile.kind, 'logo', 'kind');
      assert(logoFile.public_url.includes('/storage/v1/object/public/'), `url: ${logoFile.public_url}`);
      assert(objects.size === 1, 'one object in the bucket');
      // And it is really fetchable at that URL, the way a dealer's page would.
      const fetched = await fetch(logoFile.public_url);
      eq(fetched.status, 200, 'the stored file is readable');
      eq(fetched.headers.get('content-type'), 'image/png', 'content type');
      return `${logoFile.filename} (${logoFile.size_bytes} bytes) stored and publicly readable`;
    });

    await check('Anything that is not an image or a PDF is refused before it is stored', async () => {
      const before = objects.size;
      const r = await api('POST', `/rep-leads/${lead.id}/files?filename=payload.exe`, {
        as: ALICE, raw: Buffer.from('MZ'), headers: { 'Content-Type': 'application/x-msdownload' },
      });
      eq(r.status, 400, 'status');
      assert(/PNG, JPG/.test(r.body.error), r.body.error);
      eq(objects.size, before, 'nothing was stored');
      return 'refused with a plain message; the bucket is untouched';
    });

    await check('Another rep cannot attach a file to this lead, or see the one that is there', async () => {
      const bobRow = (await api('POST', '/reps', { as: USERS.admin, body: { name: 'Bob Rep', email: 'bob@reps.test' } })).body;
      await api('POST', `/reps/${bobRow.id}/invite`, { as: USERS.admin });
      auth.setPassword('bob@reps.test', PASSWORD);
      const BOB = { id: auth.userIdFor('bob@reps.test'), email: 'bob@reps.test' };
      const before = objects.size;
      const up = await api('POST', `/rep-leads/${lead.id}/files?kind=logo&filename=x.png`, {
        as: BOB, raw: makeLogoPng([0, 0, 255], [0, 0, 255]), headers: { 'Content-Type': 'image/png' },
      });
      eq(up.status, 404, 'upload to a lead that is not his');
      eq(objects.size, before, 'and nothing was stored for it');
      const list = await api('GET', `/rep-leads/${lead.id}/files`, { as: BOB });
      eq(list.body.files.length, 0, 'he sees no files on it');
      return 'upload 404, list empty, bucket untouched';
    });

    await check('Deleting a file takes it out of storage too', async () => {
      const spare = await api('POST', `/rep-leads/${lead.id}/files?filename=spare.png`, {
        as: ALICE, raw: makeLogoPng([10, 10, 10], [20, 20, 20]), headers: { 'Content-Type': 'image/png' },
      });
      eq(spare.status, 201, 'uploaded');
      const n = objects.size;
      const del = await api('DELETE', `/rep-lead-files/${spare.body.id}`, { as: ALICE });
      eq(del.status, 200, 'delete');
      eq(objects.size, n - 1, 'gone from storage as well as the list');
      return 'row and object both removed';
    });

    // ======================================================================
    section('Guessing the brand');
    await check('The uploaded logo gives back the two colours that were planted in it', async () => {
      const r = await api('POST', `/rep-leads/${lead.id}/brand-guess?from=logo`, { as: USERS.admin });
      eq(r.status, 200, 'status');
      eq(r.body.ok, true, 'ok');
      eq(r.body.source, 'logo', 'source');
      eq(r.body.brand.primaryColor, '#B22222', 'primary (the red in the logo)');
      eq(r.body.brand.accentColor, '#1E6F3C', 'accent (the green in the logo)');
      eq(r.body.brand.logoUrl, logoFile.public_url, 'the logo itself');
      assert(r.body.brand.primaryDark && r.body.brand.secondary, 'a full palette, not one colour');
      return `${r.body.brand.primaryColor} / ${r.body.brand.accentColor}, from ${r.body.found.colorFrom}`;
    });

    await check('Their website gives its declared colour, its logo, and says where each came from', async () => {
      const r = await api('POST', `/rep-leads/${lead.id}/brand-guess?from=website`, { as: USERS.admin });
      eq(r.status, 200, 'status');
      eq(r.body.ok, true, 'ok');
      eq(r.body.brand.primaryColor, '#B22222', 'the theme colour the site declares');
      eq(r.body.brand.accentColor, '#1E6F3C', 'the colour the page uses most');
      // The uploaded logo wins over one scraped off the page.
      eq(r.body.brand.logoUrl, logoFile.public_url, 'the rep\'s own logo is kept');
      assert(/declares/.test(r.body.found.colorFrom), `colorFrom: ${r.body.found.colorFrom}`);
      eq(r.body.found.title, 'Silver Run Home Improvements', 'title');
      return `${r.body.found.colorFrom}; logo from ${r.body.found.logo}`;
    });

    await check('A site with nothing on it, and a lead with nothing at all, both fall back to 50.\'s colours and say so', async () => {
      const bare = (await api('POST', '/rep-leads', { as: USERS.admin, body: { company_name: 'Bare Co', website: `${SITE}/bare` } })).body;
      const r1 = await api('POST', `/rep-leads/${bare.id}/brand-guess`, { as: USERS.admin });
      eq(r1.status, 200, 'bare site answers 200, not an error');
      eq(r1.body.ok, false, 'but says it found nothing');
      eq(r1.body.brand.primaryColor, '#1C2B33', '50.\'s own navy');
      assert(r1.body.reason, 'and gives a reason');

      const none = (await api('POST', '/rep-leads', { as: USERS.admin, body: { company_name: 'No Website Co' } })).body;
      const r2 = await api('POST', `/rep-leads/${none.id}/brand-guess`, { as: USERS.admin });
      eq(r2.body.ok, false, 'no website');
      assert(/No website on this lead/.test(r2.body.reason), `reason: ${r2.body.reason}`);
      return `bare site: "${r1.body.reason}"; no website: "${r2.body.reason}"`;
    });

    await check('A site that hangs does not hang the platform', async () => {
      const slow = (await api('POST', '/rep-leads', { as: USERS.admin, body: { company_name: 'Slow Co', website: `${SITE}/slow` } })).body;
      const started = Date.now();
      const r = await api('POST', `/rep-leads/${slow.id}/brand-guess`, { as: USERS.admin });
      const took = Date.now() - started;
      eq(r.status, 200, 'status');
      eq(r.body.ok, false, 'gave up');
      assert(took < 15000, `took ${took}ms`);
      assert(/too long|Could not read/.test(r.body.reason), `reason: ${r.body.reason}`);
      return `gave up after ${took}ms: "${r.body.reason}"`;
    });

    await check('A rep cannot run the brand guess, and neither can anyone outside 50.', async () => {
      const r = await api('POST', `/rep-leads/${lead.id}/brand-guess`, { as: ALICE });
      eq(r.status, 403, 'rep'); eq(r.body.code, 'staff_only', 'code');
      return 'rep -> 403 staff_only';
    });

    // ======================================================================
    section('The wording their customers will read');
    await check('What the rep typed is stored on the lead, trimmed, and nothing else is', async () => {
      const r = await api('GET', '/rep-leads', { as: ALICE });
      const mine = r.body.leads.find((x) => x.id === lead.id);
      eq(mine.copy.friendAction, 'hire us for your roof', 'the rep\'s words');
      eq(mine.copy.inquiryNoun, 'roofing inquiry', 'and the second one');
      eq(Object.keys(mine.copy).length, 2, 'only the two boxes that were filled');
      return 'two lines in their own words, seven left to the generic wording';
    });

    await check('Blank boxes are dropped rather than stored empty, and junk keys are refused', async () => {
      const blanks = (await api('POST', '/rep-leads', {
        as: USERS.admin,
        body: { company_name: 'All Blanks Co', copy: { friendAction: '   ', eligibility: '' } },
      })).body;
      eq(blanks.copy, null, 'nine empty boxes store nothing');
      const junk = await api('POST', '/rep-leads', {
        as: USERS.admin, body: { company_name: 'Junk Co', copy: { notAKey: 'x' } },
      });
      eq(junk.status, 400, 'an unknown key is a bad request, not silently dropped');
      return 'blank -> null, unknown key -> 400';
    });

    await check('A rep can come back and fill the wording in later, and empty it again', async () => {
      const later = (await api('PATCH', `/rep-leads/${lead.id}`, {
        as: ALICE,
        body: { copy: { friendAction: 'hire us for your roof', inquiryNoun: 'roofing inquiry', offerHow: 'Have us do your roof and you both get {reward}.' } },
      })).body;
      eq(later.copy.offerHow, 'Have us do your roof and you both get {reward}.', 'the line added on the second call');
      eq(Object.keys(later.copy).length, 3, 'now three');

      const cleared = (await api('PATCH', `/rep-leads/${lead.id}`, { as: ALICE, body: { copy: null } })).body;
      eq(cleared.copy, null, 'clearing it drops back to the generic wording');

      // Put it back the way the rest of this file expects to find it.
      await api('PATCH', `/rep-leads/${lead.id}`, {
        as: ALICE, body: { copy: { friendAction: 'hire us for your roof', inquiryNoun: 'roofing inquiry' } },
      });
      return 'added later, cleared, restored';
    });

    // ======================================================================
    section('The queue');
    await check('A won lead goes into the queue by itself, and no dealer exists yet', async () => {
      const tenantsBefore = (await sql('select count(*)::int n from tenants'))[0].n;
      const w = await api('POST', `/rep-leads/${lead.id}/win`, { as: ALICE, body: {} });
      eq(w.status, 200, 'win');
      eq(w.body.build_status, 'awaiting_approval', 'queued');
      eq((await sql('select count(*)::int n from tenants'))[0].n, tenantsBefore, 'no tenant yet');
      const q = await api('GET', '/rep-builds', { as: USERS.admin });
      eq(q.status, 200, 'queue');
      eq(q.body.builds.length, 1, 'one waiting');
      eq(q.body.builds[0].closed_by_name, 'Alice Rep', 'who closed it');
      eq(q.body.builds[0].file_count, 1, 'and that it has a file');
      return 'queued automatically, with the rep and the file count';
    });

    await check('Even a hand-written UPDATE in the database lands in the queue', async () => {
      // The trigger, not the route, is what guarantees this — a deal won by
      // any means must still reach Joseph.
      const stray = (await api('POST', '/rep-leads', { as: USERS.admin, body: { company_name: 'Stray Co' } })).body;
      await sql(`update rep_leads set status = 'won', closed_by_rep_id = $2, closed_on = current_date where id = $1`, [stray.id, repRow.id]);
      const [row] = await sql('select build_status from rep_leads where id = $1', [stray.id]);
      eq(row.build_status, 'awaiting_approval', 'queued by the trigger');
      await api('POST', `/rep-leads/${stray.id}/decline-build`, { as: USERS.admin, body: { reason: 'test row' } });
      return 'the trigger queues it regardless of how it was won';
    });

    await check('The queue is Joseph\'s alone', async () => {
      eq((await api('GET', '/rep-builds', { as: USERS.helper })).status, 403, 'helper');
      eq((await api('GET', '/rep-builds', { as: ALICE })).status, 403, 'rep');
      return 'helper and rep both 403';
    });

    // ======================================================================
    section('Approving: the dealer comes into existence');
    let built;
    await check('Approving creates the dealer with the corrected brand and the gift card Joseph set', async () => {
      const before = sent.length;
      const r = await api('POST', `/rep-leads/${lead.id}/build`, {
        as: USERS.admin,
        body: {
          brand: { primaryColor: '#8B1A1A', primaryDark: '#5E1111', secondary: '#C98585', accentColor: '#1E6F3C', accentDark: '#154E2A', bg: '#F7F4EE', logoUrl: logoFile.public_url },
          reward_amount_cents: 2500,
          // Joseph priced this one himself on the build screen.
          activation_fee_cents: 75000,
          annual_fee_cents: 15000,
          referral_fee_cents: 4500,
          reward_fulfillment: 'platform',
          charge_card_cost: true,
        },
      });
      eq(r.status, 201, `build: ${JSON.stringify(r.body)}`);
      built = r.body;
      eq(built.slug, 'silver-run-home-improvements', 'slug from the company name');
      eq(built.reward_amount_cents, 2500, 'the $25 card Joseph chose');
      eq(built.admin_email, 'christian@silverrun.test', 'the lead\'s contact');

      const [t] = await sql('select slug, name, branding, reward_amount_cents, billing_required from tenants where id = $1', [built.tenant_id]);
      eq(t.branding.primaryColor, '#8B1A1A', 'Joseph\'s correction, not the guess');
      eq(t.branding.logoUrl, logoFile.public_url, 'their logo');
      eq(t.reward_amount_cents, 2500, 'card amount on the tenant');
      eq(t.billing_required, true, 'they are gated into paying the $500');
      return `${t.name} (${t.slug}), ${t.branding.primaryColor}, $25 card, billing required`;
    });

    await check('The prices Joseph set on the build screen are on the dealer, in the same transaction', async () => {
      // Not a follow-up update: approve_lead_build writes them with the
      // insert, so a dealer never exists for a moment on standard terms.
      const [t] = await sql(
        `select activation_fee_cents, annual_fee_cents, referral_fee_cents,
                reward_amount_cents, reward_fulfillment, charge_card_cost
           from tenants where id = $1`, [built.tenant_id]);
      eq(t.activation_fee_cents, 75000, 'onboarding charge');
      eq(t.annual_fee_cents, 15000, 'yearly');
      eq(t.referral_fee_cents, 4500, 'flat fee per referral');
      eq(t.reward_amount_cents, 2500, 'gift card');
      eq(t.reward_fulfillment, 'platform', 'who sends the cards');
      eq(t.charge_card_cost, true, 'charged for the cards too');
      return '$750 / $150 / $45 a referral, 50. sends the cards and bills for them';
    });

    await check('A build that sets no prices gets the standard terms, not whatever the form showed', async () => {
      // The build screen pre-fills the standard numbers. If it sent them
      // explicitly, every dealer built today would be pinned to today's
      // prices and a later change to what "standard" means would skip them.
      const plain = (await api('POST', '/rep-leads', {
        as: USERS.admin,
        body: { company_name: 'Standard Terms Co', contact_name: 'Pat', email: 'pat@standard.test', found_on: '2026-10-01' },
      })).body;
      await api('POST', `/rep-leads/${plain.id}/win`, { as: USERS.admin, body: { closed_by_rep_id: repRow.id } });
      const r = await api('POST', `/rep-leads/${plain.id}/build`, { as: USERS.admin, body: {} });
      eq(r.status, 201, `build: ${JSON.stringify(r.body)}`);
      const [t] = await sql(
        `select activation_fee_cents, annual_fee_cents, referral_fee_cents,
                reward_amount_cents, reward_fulfillment, charge_card_cost
           from tenants where id = $1`, [r.body.tenant_id]);
      eq(t.activation_fee_cents, 50000, 'standard onboarding charge');
      eq(t.annual_fee_cents, 10000, 'standard yearly');
      eq(t.referral_fee_cents, 3000, 'standard flat fee');
      eq(t.reward_amount_cents, 5000, 'standard gift card');
      eq(t.reward_fulfillment, 'dealer', 'dealer sends their own cards by default');
      eq(t.charge_card_cost, false, 'not charged for cards 50. does not buy');
      global.__standardTenantId = r.body.tenant_id;
      return '$500 / $100 / $30, dealer sends their own cards';
    });


    await check('Changing a running dealer\'s prices sticks, and only Joseph can do it', async () => {
      const id = global.__standardTenantId;
      const read = await api('GET', `/rep-dealers/${id}/pricing`, { as: USERS.admin });
      eq(read.status, 200, `read: ${JSON.stringify(read.body)}`);
      eq(read.body.referral_fee_cents, 3000, 'reads what they currently pay');

      const r = await api('PATCH', `/rep-dealers/${id}/pricing`, {
        as: USERS.admin,
        body: { referral_fee_cents: 2500, annual_fee_cents: 0, reward_fulfillment: 'platform', charge_card_cost: true },
      });
      eq(r.status, 200, `patch: ${JSON.stringify(r.body)}`);
      const [t] = await sql(
        `select activation_fee_cents, annual_fee_cents, referral_fee_cents, reward_fulfillment, charge_card_cost
           from tenants where id = $1`, [id]);
      eq(t.referral_fee_cents, 2500, 'fee changed');
      eq(t.annual_fee_cents, 0, 'a free renewal is allowed, not treated as unset');
      eq(t.reward_fulfillment, 'platform', 'fulfillment changed');
      eq(t.charge_card_cost, true, 'card cost changed');
      // Untouched fields stay put: a partial edit must not reset the rest.
      eq(t.activation_fee_cents, 50000, 'onboarding charge left alone');
      return 'renegotiated to $25 a referral with no yearly, 50. sending the cards';
    });

    await check('The helper cannot read or change what any dealer pays', async () => {
      // This route reaches another tenant's row with the service role, which
      // is exactly what RLS exists to stop — so the admin check in front of
      // it is the only thing standing there, and it has to be tested rather
      // than inferred from the button being hidden.
      //
      // The helper is the case this suite can make: a real signed-in account
      // on the 50. tenant that is not Joseph. A rep is covered in
      // rep-page-e2e, which has rep logins; asserting it here against a
      // USERS.rep this suite does not define would have skipped silently and
      // passed while testing nothing.
      const id = global.__standardTenantId;
      const g = await api('GET', `/rep-dealers/${id}/pricing`, { as: USERS.helper });
      const pch = await api('PATCH', `/rep-dealers/${id}/pricing`, { as: USERS.helper, body: { referral_fee_cents: 1 } });
      eq(g.status, 403, `helper GET: ${JSON.stringify(g.body)}`);
      eq(pch.status, 403, `helper PATCH: ${JSON.stringify(pch.body)}`);
      const [t] = await sql('select referral_fee_cents from tenants where id = $1', [id]);
      eq(t.referral_fee_cents, 2500, 'the refused requests changed nothing');
      return 'helper refused on both, nothing moved';
    });

    await check('An in-house company has no prices to set, and the route says so', async () => {
      // GSS, NMS and 50. itself are never charged. Letting a price be set on
      // one would read as them having started being billed.
      const [gss] = await sql(`select id from tenants where slug = 'good-steward-structures'`);
      const r = await api('PATCH', `/rep-dealers/${gss.id}/pricing`, {
        as: USERS.admin, body: { referral_fee_cents: 5000 },
      });
      eq(r.status, 409, `expected a refusal: ${JSON.stringify(r.body)}`);
      const [t] = await sql('select referral_fee_cents from tenants where id = $1', [gss.id]);
      assert(t.referral_fee_cents !== 5000, 'an in-house company was priced anyway');
      return `refused: ${r.body.error || r.body.message}`;
    });

    await check('Their wording lands on the dealer, with every other line filled in generically', async () => {
      const [t] = await sql('select branding from tenants where id = $1', [built.tenant_id]);
      const c = t.branding.copy;
      assert(c, 'the dealer has wording at all');
      eq(c.friendAction, 'hire us for your roof', 'the rep\'s words, intact');
      eq(c.inquiryNoun, 'roofing inquiry', 'and the second one');
      eq(c.offerHow.includes('make a purchase with us'), true, 'a blank line got the generic wording');
      eq(Object.keys(c).length, 9, 'every line is set, so nothing can fall through to a default');
      return `${Object.keys(c).length} lines: 2 Christian's, 7 generic`;
    });

    await check('No shed wording reaches a dealer who never sold a shed', async () => {
      const [t] = await sql('select branding from tenants where id = $1', [built.tenant_id]);
      const all = JSON.stringify(t.branding.copy).toLowerCase();
      assert(!all.includes('shed'), `shed wording leaked: ${all}`);
      assert(!all.includes('building'), `building wording leaked: ${all}`);
      // And the older tenants are untouched: their pages still read from
      // tenant-branding.js's shed default, which this must not have changed.
      const [gss] = await sql(`select branding from tenants where slug = 'good-steward-structures'`);
      eq(gss.branding.copy, undefined, 'GSS still has no copy of its own, so it keeps the old default');
      return 'nothing about sheds or buildings on the roofer; GSS unchanged';
    });

    await check('Joseph can overrule the rep\'s wording on the build screen', async () => {
      const late = (await api('POST', '/rep-leads', {
        as: USERS.admin, body: { company_name: 'Late Edit Co', email: 'late@edit.test', copy: { friendAction: 'typo here' } },
      })).body;
      // Joseph winning it on a rep's behalf has to name the rep, same as always.
      await api('POST', `/rep-leads/${late.id}/win`, { as: USERS.admin, body: { closed_by_rep_id: repRow.id } });
      const r = await api('POST', `/rep-leads/${late.id}/build`, {
        as: USERS.admin, body: { copy: { friendAction: 'book your install' } },
      });
      eq(r.status, 201, `build: ${JSON.stringify(r.body)}`);
      const [t] = await sql('select branding from tenants where id = $1', [r.body.tenant_id]);
      eq(t.branding.copy.friendAction, 'book your install', 'what Joseph typed wins over what the rep typed');
      return 'the build screen is the last word';
    });

    await check('The dealer gets a login with no password and a link to set one; the rep is told it is live', async () => {
      const dealerMail = sent.find((m) => m.To === 'christian@silverrun.test');
      const repMail = sent.find((m) => m.To === 'alice@reps.test' && /is live/.test(m.Subject));
      assert(dealerMail, 'the dealer was emailed');
      assert(repMail, 'the rep was emailed');
      assert(dealerMail.From.startsWith('Joseph at 50.'), `from: ${dealerMail.From}`);
      assert(/verify\?token=/.test(dealerMail.TextBody), 'a set-password link');
      assert(!/your password is|temporary password/i.test(dealerMail.TextBody), 'no password was emailed');
      assert(dealerMail.TextBody.includes('$500'), 'it says what the first sign-in costs');
      assert(dealerMail.TextBody.includes('$25 gift card'), 'and names their own card amount');
      assert(/Your \$50 lands/.test(repMail.TextBody), 'the rep is told when they get paid');

      // The account exists but cannot be used until a password is chosen.
      const signIn = await fetch(`${SUPABASE_BASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'christian@silverrun.test', password: PASSWORD }),
      });
      eq(signIn.status, 400, 'cannot sign in yet');
      const [u] = await sql(`select role, tenant_id from users where email = 'christian@silverrun.test'`);
      eq(u.role, 'admin', 'they are the admin of their own tenant');
      eq(u.tenant_id, built.tenant_id, 'and it is theirs');
      return 'dealer: set-password link + what it costs; rep: it is live + when they are paid';
    });

    await check('The rep is now on the dealer, which is what earns them the $50', async () => {
      const [a] = await sql('select closer_rep_id, onboarder_rep_id from rep_assignments where tenant_id = $1', [built.tenant_id]);
      eq(a.closer_rep_id, repRow.id, 'closer');
      eq(a.onboarder_rep_id, null, 'no onboarder');
      // And nothing has been earned yet, because nothing has been paid.
      eq((await sql('select count(*)::int n from rep_earnings'))[0].n, 0, 'no earnings until the money clears');
      return 'Alice is the closer on the new dealer; nothing earned until they pay';
    });

    await check('Approving twice does nothing the second time, and the queue is empty', async () => {
      const again = await api('POST', `/rep-leads/${lead.id}/build`, { as: USERS.admin, body: {} });
      eq(again.status, 409, 'second approval');
      eq((await sql('select count(*)::int n from tenants where slug like $1', ['silver-run%']))[0].n, 1, 'still one dealer');
      const q = await api('GET', '/rep-builds', { as: USERS.admin });
      eq(q.body.builds.length, 0, 'queue is clear');
      return 'second attempt 409; one dealer; queue empty';
    });

    await check('Two companies with the same name get different addresses', async () => {
      const twin = (await api('POST', '/rep-leads', { as: USERS.admin, body: { company_name: 'Silver Run Home Improvements', email: 'other@silverrun2.test', confirm_duplicate: true } })).body;
      await api('POST', `/rep-leads/${twin.id}/win`, { as: USERS.admin, body: { closed_by_rep_id: repRow.id } });
      const r = await api('POST', `/rep-leads/${twin.id}/build`, { as: USERS.admin, body: {} });
      eq(r.status, 201, `build: ${JSON.stringify(r.body)}`);
      eq(r.body.slug, 'silver-run-home-improvements', 'the API asks for the plain one');
      const [t] = await sql('select slug from tenants where id = $1', [r.body.tenant_id]);
      eq(t.slug, 'silver-run-home-improvements-2', 'and the database gives the second one its own address');
      return r.body.slug;
    });

    await check('A lead with no email cannot be built, and nothing is half-created', async () => {
      const noEmail = (await api('POST', '/rep-leads', { as: USERS.admin, body: { company_name: 'No Email Co' } })).body;
      await api('POST', `/rep-leads/${noEmail.id}/win`, { as: USERS.admin, body: { closed_by_rep_id: repRow.id } });
      const tenantsBefore = (await sql('select count(*)::int n from tenants'))[0].n;
      const usersBefore = (await sql('select count(*)::int n from users'))[0].n;
      const r = await api('POST', `/rep-leads/${noEmail.id}/build`, { as: USERS.admin, body: {} });
      eq(r.status, 400, 'status');
      assert(/no email address/i.test(r.body.error), r.body.error);
      eq((await sql('select count(*)::int n from tenants'))[0].n, tenantsBefore, 'no tenant');
      eq((await sql('select count(*)::int n from users'))[0].n, usersBefore, 'no login');
      return 'refused before anything was created';
    });

    await check('A lead that has not been won cannot be built', async () => {
      const open = (await api('POST', '/rep-leads', { as: USERS.admin, body: { company_name: 'Still Talking Co', email: 'x@still.test' } })).body;
      const r = await api('POST', `/rep-leads/${open.id}/build`, { as: USERS.admin, body: {} });
      eq(r.status, 409, 'status');
      assert(/won first/i.test(r.body.error), r.body.error);
      return 'open lead -> 409';
    });

    await check('Only Joseph can build or decline', async () => {
      const q = (await api('POST', '/rep-leads', { as: USERS.admin, body: { company_name: 'Gate Co', email: 'g@gate.test' } })).body;
      await api('POST', `/rep-leads/${q.id}/win`, { as: USERS.admin, body: { closed_by_rep_id: repRow.id } });
      for (const who of [USERS.helper, ALICE]) {
        eq((await api('POST', `/rep-leads/${q.id}/build`, { as: who, body: {} })).status, 403, 'build');
        eq((await api('POST', `/rep-leads/${q.id}/decline-build`, { as: who, body: {} })).status, 403, 'decline');
      }
      // And straight at the database, as the helper.
      let refused = false;
      let lastDbError = '';
      try {
        const { withUserTransaction } = require('../../src/db');
        await withUserTransaction(USERS.helper.id, (c) => c.query('select approve_lead_build($1,$2,$3,$4::jsonb,$5)', [q.id, 'sneaky', 'Sneaky', '{}', null]));
      } catch (e) { refused = /admin/i.test(e.message); lastDbError = e.message; }
      assert(refused, `the function itself let a non-admin build a dealer (error was: ${lastDbError || 'none — it succeeded'})`);
      return 'helper and rep refused by the route and by the function itself';
    });

    await check('Declining takes it out of the queue, builds nothing, and leaves the lead won', async () => {
      const d = (await api('POST', '/rep-leads', { as: USERS.admin, body: { company_name: 'Changed Their Mind Co', email: 'c@mind.test' } })).body;
      await api('POST', `/rep-leads/${d.id}/win`, { as: USERS.admin, body: { closed_by_rep_id: repRow.id } });
      const tenantsBefore = (await sql('select count(*)::int n from tenants'))[0].n;
      const r = await api('POST', `/rep-leads/${d.id}/decline-build`, { as: USERS.admin, body: { reason: 'Went with someone else' } });
      eq(r.status, 200, 'decline');
      const [row] = await sql('select status, build_status, declined_reason, tenant_id from rep_leads where id = $1', [d.id]);
      eq([row.status, row.build_status, row.tenant_id], ['won', 'declined', null], 'still won, not built');
      eq(row.declined_reason, 'Went with someone else', 'the reason is kept');
      eq((await sql('select count(*)::int n from tenants'))[0].n, tenantsBefore, 'no dealer');
      return 'out of the queue, reason recorded, lead still won';
    });

    await check('If the email fails the dealer still exists, and the answer says which part failed', async () => {
      const e = (await api('POST', '/rep-leads', { as: USERS.admin, body: { company_name: 'Mail Down Co', email: 'm@maildown.test' } })).body;
      await api('POST', `/rep-leads/${e.id}/win`, { as: USERS.admin, body: { closed_by_rep_id: repRow.id } });
      postmarkFailing = true;
      const r = await api('POST', `/rep-leads/${e.id}/build`, { as: USERS.admin, body: {} });
      postmarkFailing = false;
      eq(r.status, 201, 'the build still succeeded');
      eq(r.body.emailed.dealer, false, 'the dealer was not emailed');
      assert(r.body.emailed.problems.length > 0, 'and it says so');
      const [t] = await sql('select id from tenants where id = $1', [r.body.tenant_id]);
      assert(t, 'the dealer exists');
      return `built, with: "${r.body.emailed.problems[0]}"`;
    });

    await check('Without the Supabase key nothing is built and the reason is plain', async () => {
      const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
      // The API child has its own env, so prove the guard itself rather than
      // restarting the server: the same check the route calls.
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      const admin = require('../../src/lib/supabaseAdmin');
      const store = require('../../src/lib/supabaseStorage');
      eq([admin.isConfigured(), store.isConfigured()], [false, false], 'both report unconfigured');
      let message = '';
      try { await store.upload({ leadId: 'x', bytes: Buffer.from('x'), contentType: 'image/png' }); } catch (err) { message = err.message; }
      assert(/SUPABASE_SERVICE_ROLE_KEY is not set/.test(message), `message: ${message}`);
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
      return 'both the login and the file store refuse loudly and name the setting';
    });
  } catch (err) {
    console.error(`\nThe suite stopped: ${err.message}`);
    if (apiLines.length) console.error(`\n--- API output ---\n${apiLines.slice(-30).join('\n')}`);
    results.push({ title: `suite stopped: ${err.message}`, pass: false });
  } finally {
    if (apiChild) apiChild.kill();
    supaServer.close(); mailServer.close(); siteServer.close();
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
