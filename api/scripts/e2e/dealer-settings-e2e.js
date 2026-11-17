#!/usr/bin/env node
// Verification of the dealer Settings feature — the gear at the foot of
// fifty-template-dealer.html, the page behind it (fifty-settings.html), and
// the playbook it links to (50.'s own PDF, hosted in the Supabase bucket).
//
//   node scripts/e2e/dealer-settings-e2e.js
//
// This replaces api-keys-ui-e2e.js, which drove the "Connect your CRM"
// section while it still lived inline at the bottom of the dashboard. Those
// checks are all still here, moved onto the settings page and re-pointed at a
// STAFF login rather than an admin one, because that gate was deliberately
// opened: a dealer's single login is usually a salesperson, so admin-only
// settings were settings almost no dealer could open.
//
// Needs the scratch Postgres like the other e2e scripts, plus the Chromium
// that ships with playwright. Every page is driven in a real browser against
// the real API, with Supabase Auth and Postmark stood in — so "the wording
// saved" means a sentence typed into a box is in tenants.branding.copy, and
// "the key works" means a key created by clicking the button really
// authenticated a request.
//
// Served from 127.0.0.1 rather than a made-up domain on purpose: Chrome
// refuses a public-address-space page fetching loopback, so a fake origin
// fails at the first /api/me and tells us nothing about the screen.
const path=require('path'), fs=require('fs'), http=require('http');
const {spawn}=require('child_process'); const {Client}=require('pg');
const {chromium}=require('playwright');
const {createAuthStandIn, SERVICE_ROLE_KEY}=require('./auth-stand-in');
const ROOT=path.resolve(__dirname,'..','..','..'); const MIG=path.join(ROOT,'supabase','migrations');
const ADMIN='postgresql://postgres@127.0.0.1:54329/postgres'; const DB='dealer_settings_e2e';
const API_DIR=path.resolve(__dirname,'..','..');
const ACT='20261001000000_activation_gate_and_referral_fee.sql';
const P={api:54441,pm:54442,jwks:54443,page:54444};
const url=n=>{const u=new URL(ADMIN);u.pathname='/'+n;return u.toString()};
const wc=async(u,f)=>{const c=new Client({connectionString:u});await c.connect();try{return await f(c)}finally{await c.end()}};

let passed=0, failed=0;
const ok=(l,c,e='')=>{c?passed++:failed++;console.log(`${c?'PASS':'**FAIL**'}  ${l}${e?' — '+e:''}`)};
const section=n=>console.log(`\n--- ${n} ---`);

let api, browser;
const teardown=()=>{try{api&&api.kill()}catch{};try{browser&&browser.close()}catch{}};
process.on('exit',teardown);process.on('uncaughtException',e=>{console.error('THREW:',e.message);teardown();process.exit(1)});

(async()=>{
  await wc(ADMIN,async c=>{await c.query(`drop database if exists ${DB} with (force)`);await c.query(`create database ${DB}`)});
  const files=fs.readdirSync(MIG).filter(f=>f.endsWith('.sql')).sort();
  const ids=await wc(url(DB),async c=>{
    await c.query(fs.readFileSync(path.join(__dirname,'supabase-stand-in.sql'),'utf8'));
    for(const f of files){ if(f>=ACT) continue; await c.query(fs.readFileSync(path.join(MIG,f),'utf8')); }
    await c.query(`insert into tenants (slug,name) values ('good-steward-structures','Good Steward Structures'),('north-mountain-structures','NMS'),('50-platform','50.')`);
    for(const f of files){ if(f<ACT) continue; await c.query(fs.readFileSync(path.join(MIG,f),'utf8')); }
    const {rows:[g]}=await c.query("select id from tenants where slug='good-steward-structures'");
    const {rows:[n]}=await c.query("select id from tenants where slug='north-mountain-structures'");
    // A colour and a sentence already set, so the page is tested against a
    // company that has been edited before rather than only a blank one.
    await c.query(`update tenants set branding = '{"primaryColor":"#1c2b33","accentColor":"#c9974b","bg":"#f7f4ee","copy":{"inviteSubject":"A thank-you from Good Steward"}}'::jsonb where id=$1`,[g.id]);
    const mk=async(tenant,role,name,email)=>{
      const {rows:[a]}=await c.query('insert into auth.users (id,email) values (gen_random_uuid(),$1) returning id',[email]);
      await c.query('insert into users (id,tenant_id,name,email,role) values ($1,$2,$3,$4,$5)',[a.id,tenant,name,email,role]);
      return a.id;
    };
    // A fourth company, created after the activation migration so it is
    // billable like every real dealer: the three seeded above are
    // permanently exempt by a CHECK constraint and cannot be used to test
    // the gate.
    const {rows:[u]}=await c.query(`insert into tenants (slug,name) values ('dusty-acres','Dusty Acres Barns') returning id`);
    return {
      admin: await mk(g.id,'admin','Joseph Hacker','joseph@gss.com'),
      staff: await mk(g.id,'staff','Willy Bricker','willy@gss.com'),
      other: await mk(n.id,'admin','Someone Else','admin@nms.com'),
      unpaid: await mk(u.id,'staff','Marlin Zook','marlin@dusty.com'),
      tenant: g.id, otherTenant: n.id, unpaidTenant: u.id,
    };
  });

  http.createServer((rq,rs)=>{let b='';rq.on('data',d=>b+=d);rq.on('end',()=>{rs.writeHead(200,{'Content-Type':'application/json'});rs.end(JSON.stringify({MessageID:'s',ErrorCode:0}))})}).listen(P.pm);
  const auth=createAuthStandIn({ onUserCreated: (u) =>
    wc(url(DB), c => c.query('insert into auth.users (id,email) values ($1,$2) on conflict (id) do nothing',[u.id,u.email])) });
  await new Promise(r=>auth.app.listen(P.jwks, r));
  const emails={[ids.admin]:'joseph@gss.com',[ids.staff]:'willy@gss.com',[ids.other]:'admin@nms.com',[ids.unpaid]:'marlin@dusty.com'};
  Object.entries(emails).forEach(([id,email])=>auth.addUser({id,email,password:'password123'}));
  const tok=u=>auth.mintToken({id:u,email:emails[u]});

  api=spawn('node',['src/server.js'],{cwd:API_DIR,env:{...process.env,DATABASE_URL:url(DB),PORT:String(P.api),
    SUPABASE_URL:`http://127.0.0.1:${P.jwks}`,SUPABASE_JWKS_URL:`http://127.0.0.1:${P.jwks}/auth/v1/.well-known/jwks.json`,
    SUPABASE_SERVICE_ROLE_KEY:SERVICE_ROLE_KEY, POSTMARK_SERVER_TOKEN:'t',POSTMARK_API_BASE:`http://127.0.0.1:${P.pm}`,
    EMAIL_FROM_ADDRESS:'n@referwith50.com',TENANT_CREDENTIALS_ENCRYPTION_KEY:'k',FRONTEND_BASE_URL:'https://go.referwith50.com'},
    stdio:['ignore','pipe','pipe']});
  let log='';api.stdout.on('data',d=>log+=d);api.stderr.on('data',d=>log+=d);
  for(let i=0;i<60;i++){try{await new Promise((r,j)=>http.get(`http://127.0.0.1:${P.api}/api/health`,r).on('error',j));break}catch{await new Promise(r=>setTimeout(r,200))}}

  // Every page in the feature, served together so the links between them work.
  const PAGES=['fifty-template-dealer.html','fifty-settings.html'];
  const MANIFEST=fs.readFileSync(path.join(ROOT,'manifest.webmanifest'),'utf8');
  const served={};
  for(const f of PAGES){
    served[f]=fs.readFileSync(path.join(ROOT,f),'utf8')
      .replace(/const API_BASE = "[^"]*"/, `const API_BASE = "http://127.0.0.1:${P.api}/api"`);
    if(!served[f].includes(`127.0.0.1:${P.api}`)) throw new Error(`${f}: API_BASE was not rewritten — did its spelling change?`);
  }
  http.createServer((rq,rs)=>{
    const name=(rq.url||'').split('?')[0].replace(/^\//,'');
    if(served[name]){ rs.writeHead(200,{'Content-Type':'text/html'}); return rs.end(served[name]); }
    if(name==='manifest.webmanifest'){ rs.writeHead(200,{'Content-Type':'application/manifest+json'}); return rs.end(MANIFEST); }
    rs.writeHead(200,{'Content-Type':'text/plain'}); rs.end('');
  }).listen(P.page);

  browser=await chromium.launch();
  const ctx=await browser.newContext({viewport:{width:760,height:1100},permissions:['clipboard-read','clipboard-write']});
  const page=await ctx.newPage();
  const pageErrors=[];
  page.on('pageerror',e=>pageErrors.push(e.message));
  await page.route('**/*',r=>{const u=r.request().url();
    if(u.startsWith('http://127.0.0.1:')) return r.continue();
    return r.fulfill({status:200,body:''})});

  const go=async(file,userId)=>{
    await page.goto(`http://127.0.0.1:${P.page}/${file}`);
    if(userId) await page.evaluate(t=>{localStorage.setItem('fifty:session',JSON.stringify({access_token:t,refresh_token:'none'}));},tok(userId));
    await page.reload(); await page.waitForTimeout(1500);
  };
  const branding=async(tenant=ids.tenant)=>
    (await wc(url(DB),c=>c.query('select branding from tenants where id=$1',[tenant]))).rows[0].branding;

  // =====================================================================
  section('The way in, from the dashboard');
  await go('fifty-template-dealer.html', ids.staff);
  const row=page.locator('#settingsRow');
  ok('a salesperson sees the Settings row at the foot of the dashboard', await row.isVisible());
  ok('it says what is behind it', ((await row.textContent())||'').includes('wording'),
     ((await row.textContent())||'').replace(/\s+/g,' ').trim().slice(0,70));
  ok('it points at the settings page', (await row.getAttribute('href'))==='fifty-settings.html');
  // Two lines, not one run-on: both labels are spans, so a missing
  // display:block put the description on the same line as "Settings".
  ok('the heading sits above the description, not beside it', await row.evaluate((el) => {
    const t=el.querySelector('.t').getBoundingClientRect(), d=el.querySelector('.d').getBoundingClientRect();
    return d.top >= t.bottom - 1;
  }));
  ok('the CRM section is no longer inline on the dashboard',
     (await page.locator('#apiKeysSection').count())===0 && !served['fifty-template-dealer.html'].includes('apiKeyForm'));
  ok('the dashboard itself still works', await page.locator('#sendForm').isVisible());
  await go('fifty-template-dealer.html', ids.admin);
  ok('an admin sees the same one row, not a second screen', await page.locator('#settingsRow').isVisible());

  // The name in the window, which is not document.title.
  //
  // Joseph found his dashboard window titled "Good Steward Structures" while
  // North Mountain Structures was signed in. That name was never on this
  // platform -- a browser freezes the name into a desktop shortcut when the
  // shortcut is made and never updates it again, and his was made on an older
  // standalone page. The manifest is the only thing that decides it, so it has
  // to be neutral: one file serves every tenant.
  ok('the page carries a manifest', (await page.locator('link[rel=manifest]').count())===1);
  const mf = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]').getAttribute('href');
    return (await fetch(href)).json();
  });
  ok('an installed shortcut is named for the platform, never a company',
     mf.name === '50. Referral Platform' && !/steward|mountain/i.test(JSON.stringify(mf)), mf.name);
  ok('and it opens on the dashboard', mf.start_url === '/login', mf.start_url);
  ok('the tab title is this company, not another one',
     (await page.title()) === 'Good Steward Structures — Referral Incentive', await page.title());
  await page.locator('#settingsRow').screenshot({path:'/var/tmp/settings-row.png',scale:'css'});

  // =====================================================================
  section('Settings opens, in the company’s own branding');
  await go('fifty-settings.html', ids.staff);
  ok('a salesperson can open settings', await page.locator('#settingsArea').isVisible());
  ok('it wears the company name', ((await page.locator('.top .name').textContent())||'').includes('Good Steward'));
  ok('it wears the company colours',
     (await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()))==='#1c2b33');
  ok('all four tabs are there', (await page.locator('nav.tabs button').count())===4);
  await page.locator('.card').screenshot({path:'/var/tmp/settings-wording.png',scale:'css'});

  // =====================================================================
  section('Wording — the wizard, same one the Reps page uses');
  const steps = await page.locator('[data-wstep]').count();
  ok('one step per page a customer actually sees', steps >= 6, `${steps} steps`);
  const boxes = await page.locator('[data-wkey]').count();
  const fieldCount = require('../../src/lib/tenantCopy').COPY_FIELDS.length;
  ok('every field the platform defines has a box', boxes === fieldCount, `${boxes} boxes / ${fieldCount} fields`);

  // The point of the wizard: the boxes sit inside a drawing of the real page,
  // so "the line after the link" is a line somebody can see.
  ok('the first step draws the invite email as a Gmail window',
     await page.locator('[data-wpane="0"] .gmail').isVisible());
  ok('the box for the opening line sits inside that email',
     await page.locator('[data-wpane="0"] .gm-body [data-wkey="inviteOpening"]').count() === 1);
  const titles = await page.locator('.wpane .wh').allTextContents();
  ok('each step is named for the page it draws', titles.some((t) => /email/i.test(t)) && titles.some((t) => /share page/i.test(t)),
     titles.join(' · ').slice(0, 90));

  const ph = await page.locator('[data-wkey="shareGreeting"]').getAttribute('placeholder');
  ok('an untouched box shows the standard wording as its placeholder', Boolean(ph && ph.length > 5), (ph || '').slice(0, 46));
  const already = await page.locator('[data-wkey="inviteSubject"]').inputValue();
  ok('a sentence already set comes back in its box', already === 'A thank-you from Good Steward', already);
  ok('save is off until something changes', await page.locator('#saveWording').isDisabled());

  // Finding a line. Hits are listed rather than filtered — a box drawn inside
  // a Gmail window cannot be hidden without wrecking the window around it.
  const hitCount = async () => page.locator('#wordHits [data-gokey]').count();
  await page.fill('#wordSearch', 'gift card'); await page.waitForTimeout(350);
  const cardHits = await hitCount();
  ok('searching a word in the standard wording finds its line', cardHits > 0 && cardHits < fieldCount,
     `${cardHits} of ${fieldCount}`);
  ok('each hit says which page that line lives on',
     /—/.test((await page.locator('#wordHits .h').first().textContent()) || ''),
     ((await page.locator('#wordHits .h').first().textContent()) || '').slice(0, 60));
  ok('and shows the word in the line it was found in',
     (await page.locator('#wordHits .w b').count()) > 0);
  ok('with the name above the line, not run together with it', await page.locator('#wordHits [data-gokey]').first().evaluate((el) => {
    const h = el.querySelector('.h').getBoundingClientRect(), w = el.querySelector('.w').getBoundingClientRect();
    return w.top >= h.bottom - 1;
  }));
  await page.fill('#wordSearch', 'xyzzy'); await page.waitForTimeout(300);
  ok('a word nothing says says so', await page.locator('#wordNoMatch').isVisible());
  ok('and lists nothing', (await hitCount()) === 0);

  // Pressing a hit goes to the step that line lives on and puts the cursor in it.
  await page.fill('#wordSearch', 'shareGreeting'); await page.waitForTimeout(350);
  await page.locator('#wordHits [data-gokey="shareGreeting"]').click();
  await page.waitForTimeout(600);
  ok('pressing a hit opens the step that line lives on',
     await page.locator('[data-wkey="shareGreeting"]').isVisible());
  ok('and puts the cursor in that box',
     (await page.evaluate(() => (document.activeElement || {}).dataset?.wkey)) === 'shareGreeting');

  await page.locator('[data-wkey="shareGreeting"]').fill('Thanks for trusting us with your build, {name}');
  await page.waitForTimeout(300);
  ok('typing turns save on', !(await page.locator('#saveWording').isDisabled()));
  ok('and says how much is unsaved', ((await page.locator('#wordState').textContent()) || '').includes('1 line'),
     ((await page.locator('#wordState').textContent()) || '').trim());
  await page.locator('.card').screenshot({ path: '/var/tmp/settings-wording.png', scale: 'css' });

  await page.click('#saveWording'); await page.waitForTimeout(1400);
  let b = await branding();
  ok('saving writes that line to the company', b.copy.shareGreeting === 'Thanks for trusting us with your build, {name}',
     String(b.copy.shareGreeting).slice(0, 48));
  ok('and leaves the line that was already there alone', b.copy.inviteSubject === 'A thank-you from Good Steward');
  ok('and leaves the colours alone', b.primaryColor === '#1c2b33' && b.bg === '#f7f4ee');
  ok('it says so on screen', ((await page.locator('#wordMsg').textContent()) || '').includes('live'),
     ((await page.locator('#wordMsg').textContent()) || '').trim().slice(0, 60));
  ok('and save goes back off', await page.locator('#saveWording').isDisabled());
  ok('a search survives a save', (await page.locator('#wordSearch').inputValue()) === 'shareGreeting');

  // A step is marked done once one of its boxes holds the company's own words.
  const donePane = await page.evaluate(() => {
    const el = document.querySelector('[data-wkey="shareGreeting"]');
    return Number(el.closest('[data-wpane]').dataset.wpane);
  });
  ok('the step holding it is marked done once you leave it', await page.evaluate((i) => {
    const bar = document.querySelectorAll('[data-wstep]');
    // Move off that step, which is when the bar re-reads what is filled in.
    bar[i === 0 ? 1 : 0].click();
    return bar[i].classList.contains('done');
  }, donePane));

  // The strip under the wizard puts the standard wording back, which is how a
  // company undoes an edit without having to remember what was there.
  await page.locator('#wordHits [data-gokey="shareGreeting"]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-wkey="shareGreeting"]').focus();
  await page.waitForTimeout(200);
  ok('the strip offers to clear a box that has their words in it',
     ((await page.locator('[data-wuse]').textContent()) || '').trim() === 'Clear it');
  await page.locator('[data-wuse]').dispatchEvent('mousedown');
  await page.waitForTimeout(300);
  ok('pressing it empties the box', (await page.locator('[data-wkey="shareGreeting"]').inputValue()) === '');
  ok('and then offers the standard wording back',
     ((await page.locator('[data-wuse]').textContent()) || '').trim() === 'Use the standard wording');
  // That button sets the value in script, which raises no input event — so
  // without a listener of its own, clearing a line left Save greyed out and
  // the change unsaveable.
  ok('clearing from the strip turns Save on', !(await page.locator('#saveWording').isDisabled()));

  await page.click('#saveWording'); await page.waitForTimeout(1400);
  b = await branding();
  ok('clearing a box removes the override entirely', !('shareGreeting' in b.copy), JSON.stringify(Object.keys(b.copy)));
  ok('the other line survived that', b.copy.inviteSubject === 'A thank-you from Good Steward');

  // The API's own wall, not the page's.
  const rejected = await page.evaluate(async (port) => {
    const t = JSON.parse(localStorage.getItem('fifty:session')).access_token;
    const r = await fetch(`http://127.0.0.1:${port}/api/tenant/brand`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
      body: JSON.stringify({ copy: { somethingInvented: 'x' } }) });
    return r.status;
  }, P.api);
  ok('the API refuses a copy key it does not define', rejected === 400, `status ${rejected}`);
  const tooLong = await page.evaluate(async (port) => {
    const t = JSON.parse(localStorage.getItem('fifty:session')).access_token;
    const r = await fetch(`http://127.0.0.1:${port}/api/tenant/brand`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
      body: JSON.stringify({ copy: { inviteSubject: 'x'.repeat(5000) } }) });
    return r.status;
  }, P.api);
  ok('and a line past its limit', tooLong === 400, `status ${tooLong}`);

  // =====================================================================
  section('Nobody can edit another company');
  const before=JSON.stringify(await branding(ids.otherTenant));
  const cross=await page.evaluate(async ({port,other})=>{
    const t=JSON.parse(localStorage.getItem('fifty:session')).access_token;
    // There is no tenant id in this API at all — the only thing to try is
    // smuggling one into the body and seeing whether anything reads it.
    const r=await fetch(`http://127.0.0.1:${port}/api/tenant/brand`,{method:'PATCH',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+t},
      body:JSON.stringify({tenant_id:other, id:other, copy:{inviteSubject:'theirs now'}})});
    return r.status;
  },{port:P.api,other:ids.otherTenant});
  ok('a smuggled tenant id is refused outright', cross===400, `status ${cross}`);
  ok('the other company is untouched either way', JSON.stringify(await branding(ids.otherTenant))===before);
  const mine=await branding();
  ok('and the edit did not land on the sender either — the whole request was refused',
     mine.copy.inviteSubject==='A thank-you from Good Steward', String(mine.copy.inviteSubject));

  // =====================================================================
  section('Your look');
  await page.click('nav.tabs button[data-tab="look"]'); await page.waitForTimeout(300);
  ok('the look tab shows every colour', (await page.locator('[data-color]').count())===6);
  ok('a company that set colours starts from its own',
     (await page.locator('[data-hex="primaryColor"]').inputValue())==='#1c2b33');
  ok('a colour nobody ever set starts from the one in use, not black',
     /^#[0-9a-f]{6}$/.test(await page.locator('[data-hex="secondary"]').inputValue()),
     await page.locator('[data-hex="secondary"]').inputValue());
  ok('the logo preview has something in it',
     Boolean(await page.locator('#logoPreview').getAttribute('src')));
  ok('save is off until something changes', await page.locator('#saveLook').isDisabled());

  await page.locator('[data-color="accentColor"]').evaluate(el=>{el.value='#e8a828';el.dispatchEvent(new Event('input',{bubbles:true}))});
  await page.waitForTimeout(250);
  ok('picking a colour fills the hex box beside it',
     (await page.locator('[data-hex="accentColor"]').inputValue())==='#e8a828');
  ok('and the share-page preview follows it',
     (await page.evaluate(()=>document.querySelector('.preview').style.getPropertyValue('--pv-accent')))==='#e8a828');
  ok('typing a hex moves the swatch too', await (async()=>{
    await page.locator('[data-hex="bg"]').fill('#fbf8f2'); await page.waitForTimeout(250);
    return (await page.locator('[data-color="bg"]').inputValue())==='#fbf8f2';
  })());
  await page.locator('.preview').screenshot({path:'/var/tmp/settings-preview.png',scale:'css'});
  await page.click('#saveLook'); await page.waitForTimeout(1200);
  b=await branding();
  ok('saving writes the colours to the company', b.accentColor==='#e8a828' && b.bg==='#fbf8f2',
     `${b.accentColor} / ${b.bg}`);
  ok('and the wording is still there afterwards',
     b.copy.inviteSubject==='A thank-you from Good Steward', JSON.stringify(b.copy));
  ok('the page itself re-skins to the new colour',
     (await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()))==='#e8a828');
  await page.locator('.card').screenshot({path:'/var/tmp/settings-look.png',scale:'css'});

  // =====================================================================
  section('Connect your CRM, as a salesperson');
  await page.click('nav.tabs button[data-tab="crm"]'); await page.waitForTimeout(600);
  ok('it starts with no keys', (await page.locator('.keyempty').count())===1);
  await page.fill('#apiKeyName','Velocity360');
  await page.click('#apiKeyBtn'); await page.waitForTimeout(1500);
  const shown=(await page.locator('#newKeyValue').textContent())||'';
  ok('a salesperson can create a key', shown.startsWith('rw50_live_'), shown.slice(0,22)+'…');
  ok('the key is a real credential length', shown.length>40, `${shown.length} chars`);
  ok('it appears in the list', (await page.locator('[data-revoke-key]').count())===1,
     'an empty list here means api_keys RLS is still admin-only — 20261117000000_dealer_settings_any_login');
  const meta=(await page.locator('.keyrow .kmeta').first().textContent())||'';
  ok('the list shows a prefix, not the key', !meta.includes(shown.slice(12)) && meta.includes('rw50_live_'), meta.trim().slice(0,52));
  ok('the list flags it as never used', meta.includes('Never used'));
  await page.click('#copyKeyBtn'); await page.waitForTimeout(300);
  ok('copy puts the whole key on the clipboard', (await page.evaluate(()=>navigator.clipboard.readText()))===shown);
  await page.locator('.card').screenshot({path:'/var/tmp/settings-crm.png',scale:'css'});

  const res=await page.evaluate(async ({k,port})=>{
    const r=await fetch(`http://127.0.0.1:${port}/api/customers`,{method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+k,'Idempotency-Key':'settings-order-1'},
      body:JSON.stringify({name:'Dale Hostetler',email:'dale.set@example.com'})});
    return {status:r.status, body:await r.json()};
  },{k:shown,port:P.api});
  ok('the key created from this screen actually works', res.status===201 && Boolean(res.body?.invite_link?.url), `status ${res.status}`);

  page.once('dialog',d=>d.accept());
  await page.click('[data-revoke-key]'); await page.waitForTimeout(1500);
  ok('revoking empties the list', (await page.locator('.keyempty').count())===1);
  ok('revoking hides the one-time key box', !(await page.locator('#newKeyBox').isVisible()));
  const after=await page.evaluate(async ({k,port})=>(await fetch(`http://127.0.0.1:${port}/api/customers`,{method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+k,'Idempotency-Key':'settings-order-2'},
      body:JSON.stringify({name:'X',email:'x.set@example.com'})})).status,{k:shown,port:P.api});
  ok('the revoked key stops working at once', after===401, `status ${after}`);

  await page.fill('#apiKeyName','Second Key'); await page.click('#apiKeyBtn'); await page.waitForTimeout(1200);
  page.once('dialog',d=>d.dismiss());
  await page.click('[data-revoke-key]'); await page.waitForTimeout(900);
  ok('cancelling the confirm does not revoke', (await page.locator('[data-revoke-key]').count())===1);

  // =====================================================================
  section('The playbook');
  await page.click('nav.tabs button[data-tab="playbook"]'); await page.waitForTimeout(300);
  const open = page.locator('#playbookOpen');
  const dl = page.locator('#playbookDownload');
  const href = await open.getAttribute('href');
  // Hosted in the bucket the platform already uses for logos, not committed
  // to this repository, which is public.
  ok('the playbook tab points at the hosted deck',
     /^https:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/brand-uploads\/.+\.pdf$/.test(href || ''),
     href || '(none)');
  ok('and offers it as a download too', (await dl.getAttribute('href'))===href);
  ok('it opens in a new tab rather than replacing the settings page',
     (await open.getAttribute('target'))==='_blank' && /noopener/.test((await open.getAttribute('rel'))||''));
  ok('the deck is not in this repository',
     !fs.existsSync(path.join(ROOT,'fifty-playbook.html')));
  const pb=(await page.locator('[data-panel="playbook"]').textContent())||'';
  ok('the tab says what is in it', /when to send/i.test(pb) && /reminders/i.test(pb),
     pb.replace(/\s+/g,' ').trim().slice(0,70));
  await page.locator('.card').screenshot({path:'/var/tmp/settings-playbook.png',scale:'css'});

  // =====================================================================
  section('Phone width, and the gate');
  await page.setViewportSize({width:390,height:900}); await page.waitForTimeout(400);
  ok('the playbook does not scroll sideways on a phone',
     !(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)));
  await go('fifty-settings.html', ids.staff);
  ok('settings does not scroll sideways on a phone',
     !(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)));
  await page.locator('.card').screenshot({path:'/var/tmp/settings-narrow.png',scale:'css'});
  await go('fifty-template-dealer.html', ids.staff);
  ok('the dashboard does not scroll sideways on a phone',
     !(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)));
  await page.setViewportSize({width:760,height:1100});

  // An unactivated company has no settings to edit yet: every route behind
  // this page is gated, so the link must not be offered and the page itself
  // must turn them around rather than show an empty shell.
  await go('fifty-template-dealer.html', ids.unpaid);
  ok('an unactivated company is not offered Settings', !(await page.locator('#settingsRow').isVisible()));
  const guarded=await page.evaluate(async (port)=>{
    const t=JSON.parse(localStorage.getItem('fifty:session')).access_token;
    const r=await fetch(`http://127.0.0.1:${port}/api/tenant/brand`,{headers:{'Authorization':'Bearer '+t}});
    return r.status;
  },P.api);
  ok('and the settings API refuses it behind the same gate', guarded===402, `status ${guarded}`);
  await go('fifty-settings.html', ids.unpaid);
  await page.waitForTimeout(2200);
  ok('settings sends them back to the dashboard instead of an empty shell',
     page.url().includes('fifty-template-dealer') || !(await page.locator('#settingsArea').isVisible()),
     page.url().split('/').pop());

  // Paid, and the same login has settings.
  await wc(url(DB),c=>c.query("update tenants set activation_paid_at=now(), activation_livemode=true where id=$1",[ids.unpaidTenant]));
  await go('fifty-template-dealer.html', ids.unpaid);
  ok('once activation is paid, the same login is offered Settings', await page.locator('#settingsRow').isVisible());

  // =====================================================================
  ok('no uncaught page errors in that whole run', pageErrors.length===0, pageErrors.slice(0,3).join(' | ').slice(0,180));
  if(/Error|error:/.test(log) && /\bERR\b/.test(log)) ok('the API logged no errors', false, log.slice(-300));

  console.log(`\n${passed} passed, ${failed} failed`);
  await browser.close(); api.kill();
  await wc(ADMIN,c=>c.query(`drop database if exists ${DB} with (force)`)).catch(()=>{});
  process.exit(failed?1:0);
})().catch(e=>{console.error('THREW:',e.message, e.stack);process.exit(1)});
