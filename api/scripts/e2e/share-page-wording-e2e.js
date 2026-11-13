#!/usr/bin/env node
// The share page's own wording: greeting, why-a-referral-matters, sign-off.
//
//   node scripts/e2e/share-page-wording-e2e.js
//
// Those three were hardcoded into fifty-template-customer.html, so a roofer's
// customer read sentences written for a shed company. They are copy fields
// now, and this checks the whole path -- tenantCopy.js, tenant-branding.js and
// the page -- in the four states a real customer arrives in.
//
// Two traps it exists to catch, both of which bit during the change:
//
//   mergeCopy() silently drops any key missing from DEFAULT_COPY, so a rep
//   could type wording that never appeared anywhere. There is already a
//   comment in tenant-branding.js about that happening to cardNoun.
//
//   apply() runs twice -- the fallback branding at load, the real tenant once
//   the link resolves. Filling tokens in place let the first pass eat them,
//   so the page kept showing the fallback's name forever.
//
// No database and no API: the page is served from disk with its API base
// rewritten, and a stub answers /links/:code. Playwright's Chromium renders
// it, so "the customer reads this" means a browser really rendered it.
const { chromium } = require('playwright');
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = '/home/claude/50.-platform';
const ok = (l,c,e='') => console.log(`${c?'PASS':'**FAIL**'}  ${l}${e?' — '+e:''}`);

const PORT = 54551;
let BRANDING = null, FIRST = 'Dana';
http.createServer((rq,rs) => {
  if (rq.url.includes('/links/')) {
    rs.writeHead(200,{'Content-Type':'application/json'});
    return rs.end(JSON.stringify({ code:'dana-8T4kW2', referrer_first_name: FIRST, tenant: BRANDING }));
  }
  const f = rq.url.split('?')[0].replace(/^\//,'') || 'fifty-template-customer.html';
  try {
    let body = fs.readFileSync(path.join(ROOT, f)).toString();
    body = body.replace('https://five0-platform.onrender.com/api', `http://127.0.0.1:${PORT}/api`);
    const type = f.endsWith('.js') ? 'application/javascript' : 'text/html';
    rs.writeHead(200,{'Content-Type':type}); rs.end(body);
  } catch { rs.writeHead(404); rs.end('no'); }
}).listen(PORT);

const mk = (copy) => ({ name:'Hilltop Roofing',
  branding:{ primaryColor:'#2F5D3A', rewardAmountCents:5000, rewardCurrency:'usd', copy } });

(async () => {
  const b = await chromium.launch();
  const page = await (await b.newContext({viewport:{width:430,height:900}})).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const load = async () => {
    await page.goto(`http://127.0.0.1:${PORT}/fifty-template-customer.html?code=dana-8T4kW2`);
    await page.waitForTimeout(700);
  };
  const txt = async (sel) => ((await page.textContent(sel)) || '').trim();

  // 1. A business that wrote nothing: defaults, with tokens filled.
  BRANDING = mk({});
  await load();
  const greet = await txt('#greetingLine');
  const intro = await txt('[data-copy="shareIntro"]');
  const close = await txt('[data-copy="shareClosing"]');
  ok('default greeting uses the first name', greet === 'Hi Dana — thanks for choosing us.', greet);
  ok('default intro fills the company name', intro.includes('Hilltop Roofing'), intro.slice(0,52)+'…');
  const visible = await page.innerText('body');
  ok('NO raw token is left anywhere', !visible.match(/\{(first|name|reward|card|referrer)\}/),
     (visible.match(/\{[a-z]+\}/)||['none'])[0]);
  ok('default closing still reads', close.startsWith('Thank you for supporting'), close.slice(0,40)+'…');

  // 2. A business that wrote its own, in its own trade's voice.
  BRANDING = mk({
    shareGreeting: 'Welcome back, {first}.',
    shareIntro: 'Roofs get recommended over fences. If you point a neighbour at {name}, that matters to us.',
    shareClosing: 'Thanks for trusting us with your home.',
  });
  await load();
  ok('their greeting wins', (await txt('#greetingLine')) === 'Welcome back, Dana.', await txt('#greetingLine'));
  ok('their intro wins, name filled',
     (await txt('[data-copy="shareIntro"]')) === 'Roofs get recommended over fences. If you point a neighbour at Hilltop Roofing, that matters to us.');
  ok('their closing wins', (await txt('[data-copy="shareClosing"]')) === 'Thanks for trusting us with your home.');

  // 3. A greeting with no name token at all.
  BRANDING = mk({ shareGreeting: 'Your referral link is ready.' });
  await load();
  ok('a greeting without {first} is left alone', (await txt('#greetingLine')) === 'Your referral link is ready.');

  // 4. No first name on the link.
  FIRST = null; BRANDING = mk({});
  await load();
  ok('a missing first name falls back to "there"', (await txt('#greetingLine')) === 'Hi there — thanks for choosing us.',
     await txt('#greetingLine'));

  // The elements that fill themselves with spans must not have been flattened.
  ok('the offer line still renders', (await txt('[data-copy="offerHow"]')).length > 30);
  ok('no uncaught page errors', errs.length === 0, errs.slice(0,2).join(' | '));
  await b.close(); process.exit(0);
})().catch(e => { console.error('THREW:', e.message); process.exit(1); });
