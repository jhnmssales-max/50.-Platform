#!/usr/bin/env node
// Verification of call lists: an agency's callers working a list Joseph
// imported, rather than typing companies in as they ring them.
//
//   node scripts/e2e/call-lists-e2e.js
//
// Needs the scratch Postgres like the other e2e scripts (E2E_PG_ADMIN_URL,
// default postgresql://postgres@127.0.0.1:54329/postgres). The API runs as a
// child process against a real Postgres built from every migration, and the
// spreadsheets are real .xlsx files built in memory, not fixtures.
//
// What this is actually trying to catch, in order of what it would cost:
//
//   Two callers ringing the same company. The agency is several people on one
//   list; handing the same prospect to two of them is the worst thing a call
//   list can do, and it cannot be caught by reading the code because it only
//   happens under concurrency. Checked by firing real overlapping requests.
//
//   A list that silently imports wrong. A column mapped to the wrong field,
//   or a file that half-imports, is far more work to undo than to prevent --
//   so the import is previewed before it writes, and the preview has to agree
//   with what the import then does.
//
//   Companies rung twice because they were already leads, or already on
//   another list. The whole reason to hold the list centrally is to know
//   that; if the import does not dedupe, it is just a spreadsheet again.
//
//   A rep reaching another rep's list. Same RLS claim the rest of the reps
//   area rests on, checked against the database and not only through the API.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { Client } = require('pg');
const ExcelJS = require('exceljs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const API_DIR = path.join(REPO_ROOT, 'api');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const ACTIVATION_MIGRATION = '20261001000000_activation_gate_and_referral_fee.sql';
const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL || 'postgresql://postgres@127.0.0.1:54329/postgres';
const DB = 'call_lists_e2e';
const PORTS = { api: 54441, postmark: 54442, jwks: 54443 };
const KEYPAIR = path.join(__dirname, '.call-lists-keypair.json');

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

function request(pathname, { method = 'GET', token, body, raw, headers: extra } = {}) {
  return new Promise((resolve) => {
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
async function makeSheet(rows, { headers = ['Business Name', 'Owner', 'Primary Phone', 'Email Address', 'City', 'ST'] } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  if (headers) ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

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
  const jwks = spawn('node', [path.join(API_DIR, 'scripts', 'serve_test_jwks.js'), KEYPAIR, String(PORTS.jwks)], {
    cwd: API_DIR, stdio: 'ignore',
  });

  // Joseph, the agency (a rep row like any other) and a second rep whose
  // lists the agency must not be able to reach.
  const ids = await withClient(dbUrl(DB), async (c) => {
    const { rows: [platform] } = await c.query("select id from tenants where slug = '50-platform'");
    const makeUser = async (email, role, name) => {
      const { rows: [auth] } = await c.query('insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id', [email]);
      await c.query('insert into users (id, tenant_id, name, email, role) values ($1, $2, $3, $4, $5)',
        [auth.id, platform.id, name, email, role]);
      return auth.id;
    };
    const joseph = await makeUser('joseph@referwith50.com', 'admin', 'Joseph');
    const agencyUser = await makeUser('agency@referwith50.com', 'rep', 'Agency Caller');
    const otherUser = await makeUser('other-rep@referwith50.com', 'rep', 'Other Rep');
    const { rows: [agencyRep] } = await c.query(
      `insert into reps (name, email, user_id) values ('Agency Caller', 'agency@referwith50.com', $1) returning id`, [agencyUser]);
    const { rows: [otherRep] } = await c.query(
      `insert into reps (name, email, user_id) values ('Other Rep', 'other-rep@referwith50.com', $1) returning id`, [otherUser]);
    // A company already in the pipeline: importing it again would have the
    // agency cold-calling someone a rep is already talking to.
    await c.query(`insert into rep_leads (company_name, phone, status) values ('Existing Lead Co', '214-555-9000', 'open')`);
    return { joseph, agencyUser, otherUser, agencyRep: agencyRep.id, otherRep: otherRep.id };
  });

  const api = spawn('node', [path.join('src', 'server.js')], {
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl(DB),
      PORT: String(PORTS.api),
      SUPABASE_URL: `http://127.0.0.1:${PORTS.jwks}`,
      SUPABASE_JWKS_URL: `http://127.0.0.1:${PORTS.jwks}/auth/v1/.well-known/jwks.json`,
      POSTMARK_SERVER_TOKEN: 'call-lists-e2e',
      POSTMARK_API_BASE: `http://127.0.0.1:${PORTS.postmark}`,
      EMAIL_FROM_ADDRESS: 'noreply@referwith50.com',
      EMAIL_FROM_NAME: '50.',
      TENANT_CREDENTIALS_ENCRYPTION_KEY: 'call-lists-e2e-key',
      FRONTEND_BASE_URL: 'https://go.referwith50.com',
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
    const agency = tokenFor(ids.agencyUser);
    const other = tokenFor(ids.otherUser);

    // =====================================================================
    console.log('\nImporting a bought list');

    const sheet = await makeSheet([
      ['Acme Roofing', 'Pat Smith', 2145550123, 'pat@acme.example', 'Dallas', 'TX'],
      ['Bluebird Decks', 'Dana Lee', '(214) 555-0199', 'dana@bluebird.example', 'Plano', 'TX'],
      [],
      ['ACME ROOFING', 'Duplicate Row', '', '', '', ''],
      ['Existing Lead Co', 'Already Ours', '214-555-9000', '', 'Dallas', 'TX'],
      ['Copper Creek Decks', 'Sam Ray', '214-555-0144', 'sam@copper.example', 'Frisco', 'TX'],
      ['', '', '', '', '', 'TOTAL 4'],
    ]);

    const preview = await request('/api/call-lists/preview', {
      method: 'POST', token: joseph, raw: sheet,
      headers: { 'x-file-name': 'texas-roofers.xlsx' },
    });
    check('a preview reads the file without writing anything',
      preview.status === 200, `status ${preview.status} ${JSON.stringify(preview.body).slice(0, 200)}`);
    check('the columns are guessed from headings nobody agreed in advance',
      preview.body?.columns?.company_name === 0 && preview.body?.columns?.phone === 2 && preview.body?.columns?.state === 5,
      JSON.stringify(preview.body?.columns));
    check('the repeat inside the file is caught before import',
      (preview.body?.skipped || []).some((s) => /same company/.test(s.reason)));
    check('a company already in the pipeline is counted as known',
      preview.body?.already_leads === 1, `already_leads=${preview.body?.already_leads}`);
    const listsBefore = await withClient(dbUrl(DB), (c) => c.query('select count(*)::int as n from call_lists'));
    check('and the preview really wrote nothing', listsBefore.rows[0].n === 0, `${listsBefore.rows[0].n} list(s)`);

    const created = await request('/api/call-lists', {
      method: 'POST', token: joseph, raw: sheet,
      headers: { 'x-file-name': 'texas-roofers.xlsx', 'x-list-name': 'Texas roofers', 'x-assign-rep': ids.agencyRep },
    });
    check('the import creates the list', created.status === 201, `status ${created.status}`);
    check('only the companies worth ringing are imported',
      created.body?.imported === 3, `imported ${created.body?.imported} (expected Acme, Bluebird, Copper Creek)`);
    check('the company that was already a lead is reported, not imported',
      created.body?.skipped_as_known === 1, `skipped_as_known=${created.body?.skipped_as_known}`);
    const listId = created.body?.list?.id;

    const names = await withClient(dbUrl(DB), (c) => c.query(
      'select company_name, phone, city from call_list_entries where list_id = $1 order by row_no', [listId]));
    check('the phone Excel stored as a number survived',
      names.rows[0]?.phone === '2145550123', `got ${names.rows[0]?.phone}`);
    check('no row numbers were skipped by the rows that were dropped',
      names.rows.map((r) => r.company_name).join(', ') === 'Acme Roofing, Bluebird Decks, Copper Creek Decks',
      names.rows.map((r) => r.company_name).join(', '));

    // Importing the same file again must not double the list.
    const again = await request('/api/call-lists', {
      method: 'POST', token: joseph, raw: sheet,
      headers: { 'x-file-name': 'texas-roofers.xlsx', 'x-list-name': 'Texas roofers (again)' },
    });
    check('importing the same file twice imports nobody a second time',
      again.body?.imported === 0, `imported ${again.body?.imported}`);
    await request(`/api/call-lists/${again.body?.list?.id}`, { method: 'DELETE', token: joseph });

    // =====================================================================
    console.log('\nWorking the list');

    const first = await request(`/api/call-lists/${listId}/next`, { method: 'POST', token: agency });
    check('a caller is handed the first company', first.body?.entry?.company_name === 'Acme Roofing',
      first.body?.entry?.company_name || JSON.stringify(first.body));
    const againSame = await request(`/api/call-lists/${listId}/next`, { method: 'POST', token: agency });
    check('asking again gives back the same company, not the next one',
      againSame.body?.entry?.id === first.body?.entry?.id);

    // The thing that cannot be caught by reading the code: two callers on one
    // list, pressing next at the same instant. Run on a list of its own, left
    // unassigned so both reps may work it, and long enough that running out
    // of companies cannot be what makes the ids differ.
    //
    // Six requests, three from each caller. A caller asking twice gets their
    // own company back, so the right answer is exactly two distinct
    // companies -- not six, and never one.
    const raceSheet = await makeSheet(
      Array.from({ length: 40 }, (_, i) => [`Race Co ${String(i + 1).padStart(3, '0')}`, '', `214556${String(i).padStart(4, '0')}`, '', 'Dallas', 'TX'])
    );
    const raceList = (await request('/api/call-lists', {
      method: 'POST', token: joseph, raw: raceSheet,
      headers: { 'x-file-name': 'race.xlsx', 'x-list-name': 'Race' },
    })).body?.list?.id;
    const racers = await Promise.all([agency, other, agency, other, agency, other].map(
      (t) => request(`/api/call-lists/${raceList}/next`, { method: 'POST', token: t })));
    const got = racers.map((r) => r.body?.entry?.id).filter(Boolean);
    check('both callers were actually handed something to ring', got.length === 6, `${got.length} of 6 answered`);
    check('two simultaneous requests never hand out the same company',
      new Set(got).size === 2,
      `${new Set(got).size} distinct companies across 6 requests from 2 callers (want exactly 2): ` +
      racers.map((r) => r.body?.entry?.company_name).join(', '));
    await request(`/api/call-lists/${raceList}`, { method: 'DELETE', token: joseph });

    const noAnswer = await request(`/api/call-list-entries/${first.body.entry.id}/outcome`, {
      method: 'POST', token: agency, body: { outcome: 'no_answer', note: 'rang out' },
    });
    check('no answer leaves the company on the list', noAnswer.body?.entry?.status === 'waiting');
    check('and puts it beyond reach for a couple of days, so it is not rung again this afternoon',
      new Date(noAnswer.body?.entry?.next_call_after) > new Date(Date.now() + 36 * 3600 * 1000),
      noAnswer.body?.entry?.next_call_after);
    check('the attempt is counted', noAnswer.body?.entry?.attempts === 1);

    const nextUp = await request(`/api/call-lists/${listId}/next`, { method: 'POST', token: agency });
    check('the no-answer company is not handed straight back',
      nextUp.body?.entry?.id !== first.body.entry.id,
      nextUp.body?.entry?.company_name || 'nothing left');

    // A call that goes somewhere becomes an ordinary lead.
    const interested = await request(`/api/call-list-entries/${nextUp.body.entry.id}/outcome`, {
      method: 'POST', token: agency,
      body: { outcome: 'interested', note: 'wants a call back from Joseph', contact_name: 'Dana Lee-Smith', email: 'dana@bluebird.example' },
    });
    check('an interested company graduates into a real lead', !!interested.body?.lead_id, JSON.stringify(interested.body).slice(0, 160));
    check('and is finished on the call list', interested.body?.entry?.status === 'done');
    const lead = await withClient(dbUrl(DB), (c) => c.query(
      'select company_name, contact_name, brought_in_by_rep_id, notes from rep_leads where id = $1', [interested.body.lead_id]));
    check('the lead carries the correction the caller made on the phone',
      lead.rows[0]?.contact_name === 'Dana Lee-Smith', lead.rows[0]?.contact_name);
    check('and is credited to the caller who made the call',
      lead.rows[0]?.brought_in_by_rep_id === ids.agencyRep);

    const callback = await request(`/api/call-lists/${listId}/next`, { method: 'POST', token: agency });
    if (callback.body?.entry) {
      const when = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
      const cb = await request(`/api/call-list-entries/${callback.body.entry.id}/outcome`, {
        method: 'POST', token: agency, body: { outcome: 'callback', call_back_at: when },
      });
      check('a callback stays on the list, due at the time asked for',
        cb.body?.entry?.status === 'waiting' && Math.abs(new Date(cb.body.entry.next_call_after) - new Date(when)) < 2000,
        cb.body?.entry?.next_call_after);
      const missing = await request(`/api/call-list-entries/${callback.body.entry.id}/outcome`, {
        method: 'POST', token: agency, body: { outcome: 'callback' },
      });
      check('a callback with no time is refused rather than lost', missing.status === 400, `status ${missing.status}`);
    }

    const emptyNow = await request(`/api/call-lists/${listId}/next`, { method: 'POST', token: agency });
    check('with everything called or waiting, the caller is told so rather than given nothing',
      emptyNow.body?.entry === null && typeof emptyNow.body?.waiting === 'number',
      JSON.stringify(emptyNow.body));

    // =====================================================================
    console.log('\nWhat Joseph can see');
    const lists = await request('/api/call-lists', { token: joseph });
    const progress = (lists.body?.lists || []).find((l) => l.id === listId);
    check('the list reports its own coverage', progress && progress.total === 3, JSON.stringify(progress));
    check('calls made are counted, including the ones that went nowhere',
      progress?.calls_made >= 3, `calls_made=${progress?.calls_made}`);
    check('and how many turned into real leads', progress?.became_leads === 1, `became_leads=${progress?.became_leads}`);
    check('the untouched remainder is visible, which is the whole point of importing up front',
      typeof progress?.waiting === 'number', `waiting=${progress?.waiting}`);

    // =====================================================================
    console.log('\nWho may see what');
    const mine = await request('/api/call-lists', { token: agency });
    check('the agency sees the list assigned to it',
      (mine.body?.lists || []).some((l) => l.id === listId));

    const privateList = await withClient(dbUrl(DB), (c) => c.query(
      `insert into call_lists (name, assigned_rep_id) values ('Other rep''s list', $1) returning id`, [ids.otherRep]));
    const hidden = await request('/api/call-lists', { token: agency });
    check("a rep cannot see another rep's list",
      !(hidden.body?.lists || []).some((l) => l.id === privateList.rows[0].id));
    const stolen = await request(`/api/call-lists/${privateList.rows[0].id}/next`, { method: 'POST', token: agency });
    check("and cannot take a call from it", stolen.status === 403, `status ${stolen.status}`);

    const repImport = await request('/api/call-lists', {
      method: 'POST', token: agency, raw: sheet, headers: { 'x-file-name': 'sneaky.xlsx' },
    });
    check('a rep cannot import a list of their own', repImport.status === 403, `status ${repImport.status}`);

    // =====================================================================
    console.log('\nA file that is not what anyone thinks it is');
    const junk = await request('/api/call-lists/preview', {
      method: 'POST', token: joseph, raw: Buffer.from('%PDF-1.4 not a spreadsheet at all'),
      headers: { 'x-file-name': 'invoice.xlsx' },
    });
    check('a file that is not a spreadsheet is refused clearly, not as a server fault',
      junk.status === 400, `status ${junk.status} ${junk.body?.error}`);
    const empty = await request('/api/call-lists', {
      method: 'POST', token: joseph, raw: Buffer.from('Company\n'), headers: { 'x-file-name': 'headers-only.csv' },
    });
    check('a file with headings and no companies is refused', empty.status === 400, `status ${empty.status}`);

    // =====================================================================
    console.log('\nAt the size the agency will actually send');
    const big = [];
    for (let i = 1; i <= 10000; i += 1) big.push([`Prospect ${String(i).padStart(5, '0')}`, `Owner ${i}`, `214555${String(i).padStart(4, '0')}`, '', 'Dallas', 'TX']);
    const bigSheet = await makeSheet(big);
    const t0 = Date.now();
    const bulk = await request('/api/call-lists', {
      method: 'POST', token: joseph, raw: bigSheet,
      headers: { 'x-file-name': 'ten-thousand.xlsx', 'x-list-name': 'A month of calls' },
    });
    const took = Date.now() - t0;
    check('a 10,000-company sheet imports in one go',
      bulk.status === 201 && bulk.body?.imported === 10000,
      `status ${bulk.status}, imported ${bulk.body?.imported}, ${(took / 1000).toFixed(1)}s`);
    const t1 = Date.now();
    const fromBig = await request(`/api/call-lists/${bulk.body?.list?.id}/next`, { method: 'POST', token: agency });
    check('and handing out the next company off it is still instant',
      Date.now() - t1 < 1000 && !!fromBig.body?.entry, `${Date.now() - t1}ms`);
  } finally {
    // The API dying mid-run shows up as ECONNREFUSED on every check after it,
    // which says nothing about why. Its own output does.
    if (/ECONNREFUSED/.test(JSON.stringify(failures)) || api.exitCode !== null) {
      console.log(`\n--- the API process said ---\n${apiLog.slice(-3000)}\n---`);
    }
    cleanup();
  }

  console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}.`);
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exitCode = 1; }
  await withClient(PG_ADMIN_URL, (c) => c.query(`drop database if exists ${DB} with (force)`)).catch(() => {});
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
