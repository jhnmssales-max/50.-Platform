#!/usr/bin/env node
// Verification of a dealer's CRM talking to 50.: the api_keys /
// integration_requests migration, src/lib/apiKeys.js, src/lib/idempotency.js,
// requireAuthOrApiKey in src/middleware/auth.js, and what POST /api/customers
// does differently for a machine.
//
//   node scripts/e2e/crm-integration-e2e.js
//
// Needs the scratch Postgres, like the other e2e scripts
// (E2E_PG_ADMIN_URL, default postgresql://postgres@127.0.0.1:54329/postgres).
// Postmark is a stand-in, so "an email was sent" means a real request really
// left the API with a real recipient on it. The API runs as a child process
// against a real Postgres built from every migration.
//
// What it is actually trying to catch, in order of how much it would cost to
// get wrong:
//
//   A key reading or writing another dealer's data. The whole design rests on
//   a key authenticating AS a users row so RLS answers for it unchanged, and
//   that claim is checked here against the database directly, not only
//   through the API.
//
//   The same customer invited twice. Two separate ways that happens -- a
//   retry of one event, and two different events about one person -- and they
//   need two different defences, so both are checked.
//
//   A person's Add button quietly changing behaviour. The machine-only rules
//   are gated on req.apiKeyId, and a signed-in staff member must still get
//   the resend the dashboard depends on.
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
const DB = 'crm_integration_e2e';
const PORTS = { api: 54421, postmark: 54422, jwks: 54423 };
const KEYPAIR = path.join(__dirname, '.crm-integration-keypair.json');
// Unique per run so a completed idempotency key from an earlier run cannot
// replay and make the email assertions pass without sending anything.
const RUN = Date.now().toString(36);

let passed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dbUrl(name) {
  const u = new URL(PG_ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

async function withClient(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Every migration, with the tenants that exist in production seeded before
// the activation migration -- which checks them -- exactly as the other
// suites do.
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
    await c.query(
      `insert into tenants (slug, name) values
         ('good-steward-structures','Good Steward Structures'),
         ('north-mountain-structures','North Mountain Structures'),
         ('50-platform','50.')`
    );
    for (const f of files) {
      if (f < ACTIVATION_MIGRATION) continue;
      await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    }
  });
}

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------
const sent = [];
function startPostmark() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try { sent.push(JSON.parse(body)); } catch { /* a malformed send is a failure the assertions will show */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ MessageID: `stub-${sent.length}`, ErrorCode: 0 }));
    });
  });
  return new Promise((r) => server.listen(PORTS.postmark, () => r(server)));
}

function request(pathname, { method = 'GET', credential, idempotencyKey, body } = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
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

// ---------------------------------------------------------------------------
async function main() {
  if (/supabase\.(co|com)/.test(PG_ADMIN_URL)) {
    throw new Error('E2E_PG_ADMIN_URL points at a Supabase project — this runner only ever runs against a throwaway Postgres server.');
  }

  console.log('Building the database from every migration...');
  await bootstrapDatabase();

  const postmark = await startPostmark();

  // A real keypair and a real token, so the signed-in path is verified the
  // way a Supabase-issued token is rather than stubbed past.
  const tokenOutput = (userId) =>
    execFileSync('node', [path.join(API_DIR, 'scripts', 'gen_test_jwt.js'), KEYPAIR, userId], { cwd: API_DIR })
      .toString().trim().split('\n').pop();
  const jwks = spawn('node', [path.join(API_DIR, 'scripts', 'serve_test_jwks.js'), KEYPAIR, String(PORTS.jwks)], {
    cwd: API_DIR, stdio: 'ignore',
  });

  const { mintKey } = require(path.join(API_DIR, 'src', 'lib', 'apiKeys'));

  // Two dealers, each with an integration account, plus a real person on the
  // first -- the three identities every assertion below is about.
  const ids = await withClient(dbUrl(DB), async (c) => {
    const { rows: [gss] } = await c.query("select id from tenants where slug = 'good-steward-structures'");
    // Activated, because the activation gate would otherwise answer 402
    // before any tenant-scoping assertion could run. The gate itself is
    // proved in activation-gate-e2e.js; this suite is about isolation.
    const { rows: [other] } = await c.query(
      `insert into tenants (slug, name, billing_required, billing_status, activation_paid_at)
       values ('other-co', 'Other Co', false, 'active', now()) returning id`);

    const makeUser = async (tenantId, email, role) => {
      const { rows: [auth] } = await c.query('insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id', [email]);
      await c.query('insert into users (id, tenant_id, name, email, role) values ($1, $2, $3, $4, $5)',
        [auth.id, tenantId, email.split('@')[0], email, role]);
      return auth.id;
    };

    const gssIntegration = await makeUser(gss.id, `integration+gss.${RUN}@integrations.referwith50.com`, 'staff');
    const otherIntegration = await makeUser(other.id, `integration+other.${RUN}@integrations.referwith50.com`, 'staff');
    const person = await makeUser(gss.id, `person.${RUN}@goodstewardstructures.com`, 'admin');

    const gssKey = mintKey();
    const otherKey = mintKey();
    const { rows: [gssKeyRow] } = await c.query(
      `insert into api_keys (tenant_id, user_id, name, key_prefix, key_hash)
       values ($1, $2, 'Velocity', $3, $4) returning id`,
      [gss.id, gssIntegration, gssKey.keyPrefix, gssKey.keyHash]
    );
    await c.query(
      `insert into api_keys (tenant_id, user_id, name, key_prefix, key_hash) values ($1, $2, 'Their CRM', $3, $4)`,
      [other.id, otherIntegration, otherKey.keyPrefix, otherKey.keyHash]
    );

    // A customer belonging to the other dealer, for the isolation checks.
    const { rows: [theirCustomer] } = await c.query(
      "insert into customers (tenant_id, name, email) values ($1, 'Their Person', 'theirs@example.com') returning id",
      [other.id]
    );

    return { gss: gss.id, other: other.id, gssIntegration, person, gssKeyRow: gssKeyRow.id,
             gssKey: gssKey.key, otherKey: otherKey.key, theirCustomer: theirCustomer.id };
  });

  const api = spawn('node', [path.join('src', 'server.js')], {
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl(DB),
      PORT: String(PORTS.api),
      SUPABASE_URL: `http://127.0.0.1:${PORTS.jwks}`,
      SUPABASE_JWKS_URL: `http://127.0.0.1:${PORTS.jwks}/auth/v1/.well-known/jwks.json`,
      POSTMARK_SERVER_TOKEN: 'crm-integration-e2e',
      POSTMARK_API_BASE: `http://127.0.0.1:${PORTS.postmark}`,
      EMAIL_FROM_ADDRESS: 'noreply@referwith50.com',
      EMAIL_FROM_NAME: '50.',
      TENANT_CREDENTIALS_ENCRYPTION_KEY: 'crm-integration-e2e-key',
      FRONTEND_BASE_URL: 'https://go.referwith50.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let apiLog = '';
  api.stdout.on('data', (d) => (apiLog += d));
  api.stderr.on('data', (d) => (apiLog += d));

  const cleanup = () => { api.kill(); jwks.kill(); postmark.close(); };

  try {
    if (!await waitForApi()) {
      throw new Error(`The API did not start.\n${apiLog.slice(-2000)}`);
    }

    const customerEmail = `dale.${RUN}@example.com`;

    console.log('\nWho may call at all');
    check('no credential is rejected',
      (await request('/api/customers', { method: 'POST', body: { name: 'X', email: 'x@example.com' } })).status === 401);
    const badKey = await request('/api/customers', {
      method: 'POST', credential: 'rw50_live_notarealkeyatall', idempotencyKey: 'o-1',
      body: { name: 'X', email: 'x@example.com' },
    });
    check('an unknown key is rejected', badKey.status === 401, badKey.body?.error);

    // Revoking has to bite immediately, since revoking is the only thing a
    // dealer can do about a leaked key.
    await withClient(dbUrl(DB), (c) => c.query('update api_keys set revoked_at = now() where id = $1', [ids.gssKeyRow]));
    const revoked = await request('/api/customers', {
      method: 'POST', credential: ids.gssKey, idempotencyKey: `revoked-${RUN}`,
      body: { name: 'X', email: 'x@example.com' },
    });
    check('a revoked key stops working at once', revoked.status === 401, revoked.body?.error);
    await withClient(dbUrl(DB), (c) => c.query('update api_keys set revoked_at = null where id = $1', [ids.gssKeyRow]));

    console.log('\nWhat a key may reach');
    check('a key cannot call token-only routes', (await request('/api/reps', { credential: ids.gssKey })).status === 401);
    // Reading the customer list is token-only on purpose: the CRM flow needs
    // to create a customer and nothing more, so a leaked key cannot pull a
    // dealer's whole customer list out of the platform.
    check('a key cannot read the customer list', (await request('/api/customers', { credential: ids.gssKey })).status === 401);
    check('a key cannot read reports', (await request('/api/reports/company', { credential: ids.gssKey })).status === 401);

    console.log('\nThe CRM marks an order won');
    const noKeyHeader = await request('/api/customers', {
      method: 'POST', credential: ids.gssKey, body: { name: 'Dale Hostetler', email: customerEmail },
    });
    check('a key without Idempotency-Key is refused', noKeyHeader.status === 400,
      (noKeyHeader.body?.error || '').slice(0, 58) + '…');

    const before = sent.length;
    const won = await request('/api/customers', {
      method: 'POST', credential: ids.gssKey, idempotencyKey: `velocity-order-${RUN}`,
      body: { name: 'Dale Hostetler', email: customerEmail, phone: '402-555-0100' },
    });
    check('the customer is created', won.status === 201, `status ${won.status}`);
    check('a referral link comes back', Boolean(won.body?.invite_link?.url), won.body?.invite_link?.url);
    check('the invite is emailed', sent.length === before + 1, `${sent.length - before} email(s)`);
    check('it goes to the customer', sent[sent.length - 1]?.To === customerEmail, sent[sent.length - 1]?.To);

    console.log('\nThe retry that used to invite twice');
    const beforeRetry = sent.length;
    const retry = await request('/api/customers', {
      method: 'POST', credential: ids.gssKey, idempotencyKey: `velocity-order-${RUN}`,
      body: { name: 'Dale Hostetler', email: customerEmail, phone: '402-555-0100' },
    });
    check('a retry replays the original response', retry.status === 201);
    check('a retry returns the same link', retry.body?.invite_link?.url === won.body?.invite_link?.url);
    check('a retry sends no second email', sent.length === beforeRetry, `${sent.length - beforeRetry} extra`);

    console.log('\n"Won" and "delivered" both firing, about one person');
    const beforeDelivered = sent.length;
    const delivered = await request('/api/customers', {
      method: 'POST', credential: ids.gssKey, idempotencyKey: `velocity-order-${RUN}-delivered`,
      body: { name: 'Dale Hostetler', email: customerEmail },
    });
    check('a second event does not invite again',
      delivered.status === 200 && sent.length === beforeDelivered && delivered.body?.email?.reason === 'already_invited',
      `status ${delivered.status}, ${sent.length - beforeDelivered} extra email(s), reason=${delivered.body?.email?.reason}`);
    check('it still answers with the customer and their link',
      Boolean(delivered.body?.customer?.id && delivered.body?.invite_link?.url));
    const rowCount = await withClient(dbUrl(DB), async (c) =>
      (await c.query('select count(*)::int n from customers where email = $1', [customerEmail])).rows[0].n);
    check('no duplicate customer row', rowCount === 1, `${rowCount} row(s)`);

    console.log('\nOne dealer cannot reach another');
    // Through the API: the other dealer's key must not find this customer.
    const theirIdem = await request('/api/customers', {
      method: 'POST', credential: ids.otherKey, idempotencyKey: `velocity-order-${RUN}`,
      body: { name: 'Dale Hostetler', email: customerEmail },
    });
    check('the same order number is free for another dealer', theirIdem.status === 201,
      `status ${theirIdem.status} — keys are scoped per tenant`);
    const landed = await withClient(dbUrl(DB), async (c) =>
      (await c.query(`select t.slug from customers c join tenants t on t.id = c.tenant_id
                       where c.email = $1 order by c.created_at`, [customerEmail])).rows.map((r) => r.slug));
    check('each dealer gets their own customer row',
      landed.length === 2 && landed.includes('good-steward-structures') && landed.includes('other-co'),
      landed.join(' + '));

    // And at the database, as that key's user, which is where the guarantee
    // actually lives. Through the API alone this would only show that one
    // route happens to be careful.
    const isolation = await withClient(dbUrl(DB), async (c) => {
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claim.sub', $1, true),
                            set_config('request.jwt.claims', json_build_object('sub', $1, 'role', 'authenticated')::text, true)`,
        [ids.gssIntegration]);
      const theirs = (await c.query('select count(*)::int n from customers where id = $1', [ids.theirCustomer])).rows[0].n;
      const tenants = (await c.query('select count(*)::int n from tenants')).rows[0].n;
      const keys = (await c.query('select count(*)::int n from api_keys')).rows[0].n;
      let writeBlocked = false;
      try {
        await c.query("insert into customers (tenant_id, name, email) values ($1, 'Smuggled', 'smuggled@example.com')", [ids.other]);
      } catch (err) { writeBlocked = /row-level security/i.test(err.message); }
      await c.query('rollback');
      return { theirs, tenants, keys, writeBlocked };
    });
    check("cannot read another dealer's customer by id", isolation.theirs === 0);
    check('cannot enumerate other dealers', isolation.tenants === 1, `${isolation.tenants} visible`);
    check('cannot read any api_keys row', isolation.keys === 0,
      `${isolation.keys} visible — a key is staff, and only admins may list keys`);
    check("cannot write into another dealer's list", isolation.writeBlocked);

    // The two halves of a key row cannot disagree. Checked at the database,
    // because this is a constraint, not a rule the route happens to follow:
    // a key owned by one dealer but naming another dealer's user would act
    // with that user's privileges while being listed under the first.
    let mismatchRejected = false;
    try {
      await withClient(dbUrl(DB), (c) => c.query(
        `insert into api_keys (tenant_id, user_id, name, key_prefix, key_hash)
         values ($1, $2, 'Mismatched', 'rw50_live_xx', 'deadbeef')`,
        [ids.other, ids.gssIntegration]));
    } catch (err) { mismatchRejected = /foreign key|violates/i.test(err.message); }
    check('a key cannot name a user from another dealer', mismatchRejected);

    console.log('\nAn admin managing their own keys');
    const token = tokenOutput(ids.person);
    const staffToken = tokenOutput(ids.gssIntegration);

    const listed = await request('/api/tenant/api-keys', { credential: token });
    check('an admin can list their keys', listed.status === 200 && Array.isArray(listed.body?.api_keys),
      `status ${listed.status}, ${listed.body?.api_keys?.length} key(s)`);
    check('the list never carries the hash',
      !JSON.stringify(listed.body || {}).includes('key_hash'));
    check('the list shows only this dealer\'s keys',
      (listed.body?.api_keys || []).every((k) => k.name !== 'Their CRM'),
      (listed.body?.api_keys || []).map((k) => k.name).join(', '));

    check('a non-admin cannot list keys', (await request('/api/tenant/api-keys', { credential: staffToken })).status === 403);
    check('a non-admin cannot create a key',
      (await request('/api/tenant/api-keys', { method: 'POST', credential: staffToken, body: { name: 'Sneaky' } })).status === 403);

    // Revoking through the API, then proving the revoked key is really dead.
    const toRevoke = (listed.body?.api_keys || []).find((k) => k.name === 'Velocity');
    const revokeRes = await request(`/api/tenant/api-keys/${toRevoke?.id}`, { method: 'DELETE', credential: token });
    check('an admin can revoke a key', revokeRes.status === 200, `status ${revokeRes.status}`);
    const afterRevoke = await request('/api/customers', {
      method: 'POST', credential: ids.gssKey, idempotencyKey: `after-revoke-${RUN}`,
      body: { name: 'Nobody', email: `nobody.${RUN}@example.com` },
    });
    check('the revoked key no longer works', afterRevoke.status === 401, `status ${afterRevoke.status}`);
    check('revoking twice is a 404, not a second revoke',
      (await request(`/api/tenant/api-keys/${toRevoke?.id}`, { method: 'DELETE', credential: token })).status === 404);
    check('a revoked key leaves the list', 
      !((await request('/api/tenant/api-keys', { credential: token })).body?.api_keys || []).some((k) => k.id === toRevoke?.id));

    console.log('\nA person pressing Add is unchanged');
    const personEmail = `regress.${RUN}@example.com`;
    const firstAdd = await request('/api/customers', {
      method: 'POST', credential: token, body: { name: 'Regress Person', email: personEmail },
    });
    check('a staff member can still add a customer', firstAdd.status === 201, `status ${firstAdd.status}`);
    const afterFirst = sent.length;
    const secondAdd = await request('/api/customers', {
      method: 'POST', credential: token, body: { name: 'Regress Person', email: personEmail },
    });
    check('pressing Add again still resends',
      secondAdd.status === 200 && secondAdd.body?.email?.sent === true && sent.length === afterFirst + 1,
      `status ${secondAdd.status}, email.sent=${secondAdd.body?.email?.sent}, ${sent.length - afterFirst} email(s)`);
    check('and is reported as a resend', secondAdd.body?.email?.resent === true);
    check('no Idempotency-Key is demanded of a person',
      !JSON.stringify(secondAdd.body || {}).includes('Idempotency-Key'));
  } finally {
    cleanup();
  }

  console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}.`);
  if (failures.length) {
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  }
  await withClient(PG_ADMIN_URL, (c) => c.query(`drop database if exists ${DB} with (force)`)).catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
