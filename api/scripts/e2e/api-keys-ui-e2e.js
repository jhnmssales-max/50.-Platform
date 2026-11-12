#!/usr/bin/env node
// Verification of the "Connect your CRM" screen in fifty-template-dealer.html:
// that an admin can create a key, that the key is shown once and only in full
// there, that the list never carries a usable credential, that revoking kills
// the key immediately, and that a staff member never sees any of it.
//
//   node scripts/e2e/api-keys-ui-e2e.js
//
// Needs the scratch Postgres like the other e2e scripts, plus the Chromium
// that ships with playwright. The page is driven in a real browser against
// the real API, with Supabase Auth and Postmark stood in -- so "the key
// works" means a key created by clicking the button really authenticated a
// request, not that a function returned true.
//
// Served from 127.0.0.1 rather than a made-up domain on purpose: Chrome
// refuses a public-address-space page fetching loopback, so a fake origin
// fails at the first /api/me and tells us nothing about the screen.
// Drives the API-keys screen in a real browser against the real API.
const path=require('path'), fs=require('fs'), http=require('http');
const {spawn,execFileSync}=require('child_process'); const {Client}=require('pg');
const {chromium}=require('playwright');
const {createAuthStandIn, SERVICE_ROLE_KEY}=require('./auth-stand-in');
const ROOT=path.resolve(__dirname,'..','..','..'); const MIG=path.join(ROOT,'supabase','migrations');
const ADMIN='postgresql://postgres@127.0.0.1:54329/postgres'; const DB='api_keys_ui_e2e';
const API_DIR=path.resolve(__dirname,'..','..');
const ACT='20261001000000_activation_gate_and_referral_fee.sql';
const P={api:54431,pm:54432,jwks:54433,page:54434}; const KP='/var/tmp/uikp.json';
const ok=(l,c,e='')=>console.log(`${c?'PASS':'**FAIL**'}  ${l}${e?' — '+e:''}`);
const url=n=>{const u=new URL(ADMIN);u.pathname='/'+n;return u.toString()};
const wc=async(u,f)=>{const c=new Client({connectionString:u});await c.connect();try{return await f(c)}finally{await c.end()}};

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
    const mk=async(role,email)=>{const {rows:[a]}=await c.query('insert into auth.users (id,email) values (gen_random_uuid(),$1) returning id',[email]);
      await c.query('insert into users (id,tenant_id,name,email,role) values ($1,$2,$3,$4,$5)',[a.id,g.id,role==='admin'?'Joseph Hacker':'Willy Bricker',email,role]);return a.id};
    return {admin:await mk('admin','joseph@gss.com'), staff:await mk('staff','willy@gss.com'), tenant:g.id};
  });

  http.createServer((rq,rs)=>{let b='';rq.on('data',d=>b+=d);rq.on('end',()=>{rs.writeHead(200,{'Content-Type':'application/json'});rs.end(JSON.stringify({MessageID:'s',ErrorCode:0}))})}).listen(P.pm);
  // Supabase Auth stood in, including the hook that writes a new account into
  // auth.users -- which public.users' foreign key points at, and which
  // creating an integration account depends on in production.
  const auth=createAuthStandIn({ onUserCreated: (u) =>
    wc(url(DB), c => c.query('insert into auth.users (id,email) values ($1,$2) on conflict (id) do nothing',[u.id,u.email])) });
  await new Promise(r=>auth.app.listen(P.jwks, r));
  auth.addUser({id:ids.admin,email:'joseph@gss.com',password:'password123'});
  auth.addUser({id:ids.staff,email:'willy@gss.com',password:'password123'});
  const tok=u=>auth.mintToken({id:u,email:u===ids.admin?'joseph@gss.com':'willy@gss.com'});

    api=spawn('node',['src/server.js'],{cwd:API_DIR,env:{...process.env,DATABASE_URL:url(DB),PORT:String(P.api),
    SUPABASE_URL:`http://127.0.0.1:${P.jwks}`,SUPABASE_JWKS_URL:`http://127.0.0.1:${P.jwks}/auth/v1/.well-known/jwks.json`,
    SUPABASE_SERVICE_ROLE_KEY:SERVICE_ROLE_KEY, POSTMARK_SERVER_TOKEN:'t',POSTMARK_API_BASE:`http://127.0.0.1:${P.pm}`,
    EMAIL_FROM_ADDRESS:'n@referwith50.com',TENANT_CREDENTIALS_ENCRYPTION_KEY:'k',FRONTEND_BASE_URL:'https://go.referwith50.com'},
    stdio:['ignore','pipe','pipe']});
  let log='';api.stdout.on('data',d=>log+=d);api.stderr.on('data',d=>log+=d);
  for(let i=0;i<60;i++){try{await new Promise((r,j)=>http.get(`http://127.0.0.1:${P.api}/api/health`,r).on('error',j));break}catch{await new Promise(r=>setTimeout(r,200))}}

  const html=fs.readFileSync(path.join(ROOT,'fifty-template-dealer.html'),'utf8');
  browser=await chromium.launch(); const ctx=await browser.newContext({viewport:{width:760,height:1100},permissions:['clipboard-read','clipboard-write']});
  const page=await ctx.newPage();
  const pageErrors=[];
  page.on('pageerror',e=>pageErrors.push(e.message));
  // The page is served from 127.0.0.1, not a made-up domain: Chrome blocks a
  // public-address-space page from fetching loopback, so a fake origin would
  // fail at the first /api/me rather than tell us anything about the screen.
  const served = html.replace(/const API_BASE = "[^"]*"/, `const API_BASE = "http://127.0.0.1:${P.api}/api"`);
  http.createServer((rq,rs)=>{
    if(rq.url.startsWith('/fifty-template-dealer')){ rs.writeHead(200,{'Content-Type':'text/html'}); return rs.end(served); }
    rs.writeHead(200,{'Content-Type':'text/plain'}); rs.end('');
  }).listen(P.page);
  await page.route('**/*',r=>{const u=r.request().url();
    if(u.startsWith('http://127.0.0.1:')) return r.continue();
    return r.fulfill({status:200,body:''})});

  const signIn=async(userId)=>{
    await page.goto(`http://127.0.0.1:${P.page}/fifty-template-dealer.html`);
    await page.evaluate(t=>{localStorage.setItem('fifty:session',JSON.stringify({access_token:t,refresh_token:'none'}));},tok(userId));
    await page.reload(); await page.waitForTimeout(1500);
  };

  // --- ADMIN ---
  await signIn(ids.admin);
  const sec=page.locator('#apiKeysSection');
  ok('an admin sees the Connect your CRM section', await sec.isVisible());
  ok('it starts with no keys', (await page.locator('.keyempty').count())===1,
     (await page.locator('.keyempty').textContent().catch(()=>''))?.slice(0,40));
  await page.locator('#apiKeysSection').screenshot({path:'/var/tmp/keys-empty.png',scale:'css'});

  await page.fill('#apiKeyName','Velocity360');
  await page.click('#apiKeyBtn'); await page.waitForTimeout(1200);
  const shown=(await page.locator('#newKeyValue').textContent())||'';
  ok('creating a key shows it once', shown.startsWith('rw50_live_'), shown.slice(0,22)+'…');
  ok('the key is a real credential length', shown.length>40, `${shown.length} chars`);
  ok('the new key appears in the list', (await page.locator('[data-revoke-key]').count())===1);
  const meta=(await page.locator('.keyrow .kmeta').first().textContent())||'';
  ok('the list shows a prefix, not the key', !meta.includes(shown.slice(12)) && meta.includes('rw50_live_'), meta.trim().slice(0,52));
  ok('the list flags it as never used', meta.includes('Never used'));
  await page.locator('#apiKeysSection').screenshot({path:'/var/tmp/keys-created.png',scale:'css'});

  await page.click('#copyKeyBtn'); await page.waitForTimeout(300);
  ok('copy puts the whole key on the clipboard', (await page.evaluate(()=>navigator.clipboard.readText()))===shown);

  // The key really works against the API.
  const res=await page.evaluate(async ({k,port})=>{
    const r=await fetch(`http://127.0.0.1:${port}/api/customers`,{method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+k,'Idempotency-Key':'ui-order-1'},
      body:JSON.stringify({name:'Dale Hostetler',email:'dale.ui@example.com'})});
    return {status:r.status, body:await r.json()};
  },{k:shown,port:P.api});
  ok('the key created from this screen actually works', res.status===201 && Boolean(res.body?.invite_link?.url), `status ${res.status}`);

  // Revoke, with the confirm dialog.
  page.once('dialog',d=>d.accept());
  await page.click('[data-revoke-key]'); await page.waitForTimeout(1200);
  ok('revoking empties the list', (await page.locator('.keyempty').count())===1);
  ok('revoking hides the one-time key box', !(await page.locator('#newKeyBox').isVisible()));
  const after=await page.evaluate(async ({k,port})=>(await fetch(`http://127.0.0.1:${port}/api/customers`,{method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+k,'Idempotency-Key':'ui-order-2'},
      body:JSON.stringify({name:'X',email:'x.ui@example.com'})})).status,{k:shown,port:P.api});
  ok('the revoked key stops working at once', after===401, `status ${after}`);

  // Cancelling the confirm must not revoke.
  await page.fill('#apiKeyName','Second Key'); await page.click('#apiKeyBtn'); await page.waitForTimeout(1000);
  page.once('dialog',d=>d.dismiss());
  await page.click('[data-revoke-key]'); await page.waitForTimeout(800);
  ok('cancelling the confirm does not revoke', (await page.locator('[data-revoke-key]').count())===1);

  // --- STAFF ---
  await signIn(ids.staff);
  ok('a staff member does not see the section', !(await page.locator('#apiKeysSection').isVisible()));
  ok('and the rest of the page still works for them', await page.locator('#sendForm').isVisible());

  // Phone width.
  await signIn(ids.admin);
  await page.setViewportSize({width:390,height:900}); await page.waitForTimeout(400);
  ok('no sideways scroll at phone width', !(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)));
  await page.locator('#apiKeysSection').screenshot({path:'/var/tmp/keys-narrow.png',scale:'css'});

  ok('no uncaught page errors in that run', pageErrors.length===0, pageErrors.slice(0,2).join(' | ').slice(0,140));

  await browser.close(); api.kill();
  await wc(ADMIN,c=>c.query(`drop database if exists ${DB} with (force)`)).catch(()=>{});
  process.exit(0);
})().catch(e=>{console.error('THREW:',e.message);process.exit(1)});
