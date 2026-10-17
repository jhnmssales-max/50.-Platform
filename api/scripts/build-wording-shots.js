#!/usr/bin/env node
'use strict';

// Regenerates the pictures the reps page shows beside each wording box, so a
// rep can see the page their words land on before they write them.
//
// WHY THIS IS A SCRIPT AND NOT A FOLDER OF HAND-SHOT IMAGES
//
// Every sentence a dealer can reword is already marked up in the real HTML as
// <span data-copy="theKey">, because tenant-branding.js needs that hook to
// swap the words at run time. That markup is the whole trick here: this script
// loads the actual page, finds those spans, and records where they landed. The
// picture and the pin that points at it are produced in the same pass from the
// same DOM, so they cannot drift apart. Move a paragraph, add a field, restyle
// a page — re-run this and both the image and its coordinates follow.
//
// Hand-shot screenshots would go stale silently: the picture would still look
// plausible while pointing at the wrong line.
//
// It also records the words on either side of each span, which is what lets
// the reps page show "When you ___, you and your friend each get a card"
// instead of a box labelled "What the friend has to do". Six of the nine
// fields are sentence fragments, and that is the part reps find confusing.
//
//   node api/scripts/build-wording-shots.js
//
// Writes assets/wording/<id>.png and assets/wording/manifest.json.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { GENERIC_COPY } = require('../src/lib/tenantCopy');
const { buildInviteEmail } = require('../src/lib/inviteEmail');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'assets', 'wording');

// The example business the pictures are shot with. Deliberately not a shed
// company: a rep showing these to a roofer should not see shed wording, and
// GENERIC_COPY is the trade-neutral wording a new dealer actually inherits.
const SAMPLE = { tenantName: 'Your Business', customerName: 'Sarah', referrerName: 'Sarah', rewardText: '$50' };

// One entry per picture. `keys` says which fields this shot is the home of —
// a field appearing on two pages (offerHow) is pinned on each, and the reps
// page picks whichever it wants to show first.
const SHOTS = [
  {
    id: 'invite-email',
    title: 'The email their past customer gets',
    width: 760,
    html: () => buildInviteEmail({
      tenantName: SAMPLE.tenantName,
      customerName: SAMPLE.customerName,
      inviteUrl: 'https://example.com/r/sample',
      buttonColor: '#1C2B33',
      rewardAmountCents: 5000,
      rewardCurrency: 'USD',
      logoUrl: null,
      offerHow: GENERIC_COPY.offerHow,
    }).htmlBody,
    keys: ['offerHow'],
    // The email is built as a string, not a page with data-copy spans, so the
    // offer paragraph is found by its text instead and tagged on the fly.
    prep: (copy) => {
      const want = copy.offerHow.replace(/\*\*/g, '').replace(/\{reward\}/g, '$50').replace(/\{name\}/g, 'Your Business');
      const first = want.split(' ').slice(0, 6).join(' ');
      const el = [...document.querySelectorAll('p,td,div')]
        .reverse()
        .find((n) => n.children.length <= 2 && n.textContent.includes(first));
      if (el) el.setAttribute('data-copy', 'offerHow');
    },
  },
  {
    id: 'share-page',
    title: 'Their customer’s share page',
    file: 'fifty-template-customer.html',
    width: 900,
    keys: ['offerHow'],
  },
  {
    id: 'share-sheet',
    title: 'The phone’s share menu',
    width: 390,
    // shareTitle and shareText never render on any page -- they are handed to
    // navigator.share(), so the only place a rep can ever see them is the
    // phone's own share sheet. This draws that sheet rather than shooting it,
    // which is the one picture here with no real page behind it.
    html: (copy) => shareSheetHtml(copy),
    keys: ['shareTitle', 'shareText'],
  },
  {
    id: 'friend-page',
    title: 'The page their friend lands on',
    file: 'fifty-template-lead.html',
    width: 900,
    // cardNoun is pinned here rather than on the terms page because this is
    // where a rep meets it: the main offer line, in the sentence a customer
    // actually reads. It appears on the terms page too, and querySelector
    // takes the first match, which is this one.
    keys: ['friendAction', 'cardNoun'],
    // Without a link code the page falls back to "A friend", which reads
    // oddly mid-sentence ("you and A friend will each get"). A real name
    // makes the captured sentence read the way a customer will see it.
    prep: () => {
      document.querySelectorAll('[data-referrer-name]').forEach((el) => { el.textContent = 'Sarah'; });
    },
  },
  {
    id: 'friend-confirm',
    title: 'What their friend sees after sending the form',
    file: 'fifty-template-lead.html',
    width: 900,
    keys: ['afterPurchase'],
    // afterPurchase lives on the confirmation panel, which is display:none
    // until the form is sent. Shooting the page as-loaded would record a
    // zero-size box and pin the marker to the top-left corner.
    prep: () => {
      const form = document.querySelector('.formState, #formState');
      if (form) form.style.display = 'none';
      const c = document.getElementById('confirmState');
      if (c) { c.classList.add('show'); c.style.display = 'block'; }
      const n = document.getElementById('confirmName');
      if (n) n.textContent = 'Sarah';
      const r = document.getElementById('confirmReferrer');
      if (r) r.textContent = 'Sarah';
    },
  },
  {
    id: 'terms',
    title: 'Their terms page',
    file: 'referral-terms.html',
    width: 900,
    keys: ['eligibility', 'qualifyingEvent', 'rewardCondition'],
  },
  {
    id: 'privacy',
    title: 'Their privacy page',
    file: 'privacy-policy.html',
    width: 900,
    keys: ['inquiryNoun'],
  },
];

// A plain drawing of a share sheet. Kept deliberately generic -- it is a
// diagram of where the words go, not an imitation of any one phone.
function shareSheetHtml(copy) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const title = esc(copy.shareTitle);
  const text = esc(copy.shareText);
  return `<!doctype html><meta charset="utf8">
<style>
  body{margin:0;background:#E9E6E0;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:22px 16px;}
  .sheet{background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.14);overflow:hidden;}
  .head{padding:16px 16px 12px;border-bottom:1px solid #ECE8E1;display:flex;gap:12px;align-items:flex-start;}
  .ico{width:42px;height:42px;border-radius:9px;background:#1C2B33;color:#C9974B;font:600 15px Georgia,serif;
       display:flex;align-items:center;justify-content:center;flex:0 0 auto;}
  .t{font-size:14px;font-weight:600;color:#14181C;line-height:1.35;}
  .u{font-size:12px;color:#8A8A82;margin-top:3px;}
  .msg{padding:13px 16px;font-size:13.5px;line-height:1.5;color:#2A2F35;border-bottom:1px solid #ECE8E1;}
  .row{display:flex;gap:18px;padding:15px 16px;}
  .app{width:50px;text-align:center;font-size:10px;color:#6B6A63;}
  .dot{width:50px;height:50px;border-radius:12px;background:#DDD9D2;margin-bottom:5px;}
</style>
<div class="sheet">
  <div class="head">
    <div class="ico">50.</div>
    <div><div class="t" data-copy="shareTitle">${title}</div><div class="u">referwith50.com</div></div>
  </div>
  <div class="msg" data-copy="shareText">${text}</div>
  <div class="row">
    <div class="app"><div class="dot"></div>Messages</div>
    <div class="app"><div class="dot"></div>Mail</div>
    <div class="app"><div class="dot"></div>Copy</div>
    <div class="app"><div class="dot"></div>More</div>
  </div>
</div>`;
}

// Replaces {reward} and {name} the same way the live pages do, so the picture
// reads like a finished page rather than a template.
function fill(s) {
  return String(s).replace(/\*\*/g, '').replace(/\{reward\}/g, '$50').replace(/\{name\}/g, SAMPLE.tenantName);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const copy = {};
  for (const k of Object.keys(GENERIC_COPY)) copy[k] = fill(GENERIC_COPY[k]);

  const browser = await chromium.launch();
  // No build date in here on purpose: it would change on every run and make
  // `git status` dirty after a no-op rebuild, which trains people to ignore
  // the dirt. Git already records when these files last changed.
  const manifest = { shots: [] };
  const seen = new Set();

  for (const shot of SHOTS) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: 1000 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    if (shot.file) {
      await page.goto('file://' + path.join(ROOT, shot.file), { waitUntil: 'networkidle' });
    } else {
      await page.setContent(shot.html(copy), { waitUntil: 'networkidle' });
    }
    await page.waitForTimeout(400);

    // The generic, trade-neutral wording -- not tenant-branding.js's own
    // DEFAULT_COPY, which is still the original shed wording and would show a
    // roofer "Buy a shed from us".
    await page.evaluate(({ c, name }) => {
      document.querySelectorAll('[data-copy]').forEach((el) => {
        const k = el.getAttribute('data-copy');
        if (c[k]) el.textContent = c[k];
      });
      // Otherwise every picture reads "50.", which is this platform's own
      // name -- a rep showing these to a roofer needs a stand-in business.
      document.querySelectorAll('[data-tenant-name],[data-tenant-name-inline]')
        .forEach((el) => { el.textContent = name; });
    }, { c: copy, name: SAMPLE.tenantName });

    if (shot.prep) await page.evaluate(shot.prep, copy);
    await page.waitForTimeout(250);

    const marks = await page.evaluate((keys) => {
      const BLOCK = 'p,li,h1,h2,h3,div';
      return keys.map((key) => {
        const el = document.querySelector('[data-copy="' + key + '"]');
        if (!el) return { key, missing: true };
        const r = el.getBoundingClientRect();
        const par = el.closest(BLOCK) || el.parentElement;
        const full = par ? par.textContent : el.textContent;
        const own = el.textContent;
        const i = full.indexOf(own);
        const tidy = (s) => s.replace(/\s+/g, ' ').replace(/ /g, ' ');
        return {
          key,
          box: {
            x: Math.round(r.x + window.scrollX),
            y: Math.round(r.y + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
          },
          // The fixed words on either side. These are what the reps page wraps
          // around the rep's own fragment to show the finished sentence.
          before: i >= 0 ? tidy(full.slice(0, i)).trimStart() : '',
          after: i >= 0 ? tidy(full.slice(i + own.length)).trimEnd() : '',
        };
      });
    }, shot.keys);

    const contentH = await page.evaluate(() => {
      let bottom = 0;
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) bottom = Math.max(bottom, r.bottom + window.scrollY);
      });
      const cs = getComputedStyle(document.body);
      return Math.ceil(bottom + parseFloat(cs.paddingBottom || 0) + parseFloat(cs.marginBottom || 0));
    });
    await page.setViewportSize({ width: shot.width, height: Math.max(contentH, 200) });
    await page.waitForTimeout(150);

    const dims = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));

    // Shot as PNG, shipped as WebP. These load on a phone in someone's
    // driveway, often on cellular: WebP is roughly a third the size at a
    // quality where the body text is still sharp, and the reps page loads
    // only the one picture the rep is looking at.
    const png = path.join(OUT, shot.id + '.png');
    await page.screenshot({ path: png, fullPage: true });
    execFileSync('convert', [png, '-quality', '78', '-define', 'webp:method=6', path.join(OUT, shot.id + '.webp')]);
    fs.unlinkSync(png);

    const missing = marks.filter((m) => m.missing).map((m) => m.key);
    const zero = marks.filter((m) => m.box && !m.box.w).map((m) => m.key);
    if (errors.length) console.warn('  ! page errors on ' + shot.id + ': ' + errors.join('; '));
    if (missing.length) throw new Error(shot.id + ': no [data-copy] found for ' + missing.join(', '));
    if (zero.length) throw new Error(shot.id + ': zero-size box for ' + zero.join(', ') + ' (hidden when shot?)');

    // The pictures show a stand-in business name, but the sentences around
    // each box are re-used live with the REAL company in them -- so the name
    // goes back to being a token. Without this the reps page would tell a
    // roofer their own terms page says "customers of Your Business".
    // Both the stand-in business name and the card amount go back to being
    // tokens. The name because the reps page substitutes the real company;
    // the amount because it is set per dealer and is not known at lead stage
    // -- and because a figure here would put a money amount in front of a
    // helper, who is not supposed to see one anywhere.
    const tokenise = (t) => t
      .split(SAMPLE.tenantName).join('{name}')
      .split(SAMPLE.rewardText).join('{reward}');
    marks.forEach((m) => {
      if (m.before) m.before = tokenise(m.before);
      if (m.after) m.after = tokenise(m.after);
    });

    marks.forEach((m) => seen.add(m.key));
    manifest.shots.push({ id: shot.id, title: shot.title, img: 'assets/wording/' + shot.id + '.webp', page: dims, marks });
    console.log('  ' + shot.id.padEnd(16) + dims.w + 'x' + dims.h + '  ' + marks.map((m) => m.key).join(', '));
    await page.close();
  }

  await browser.close();

  // Every field must be pinned somewhere, or the reps page would show a box
  // with no picture beside it and no sentence around it.
  const { COPY_KEYS } = require('../src/lib/tenantCopy');
  const unpinned = COPY_KEYS.filter((k) => !seen.has(k));
  if (unpinned.length) throw new Error('no picture pins these fields: ' + unpinned.join(', '));

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('\n' + manifest.shots.length + ' pictures, all ' + COPY_KEYS.length + ' fields pinned -> assets/wording/');
}

main().catch((e) => { console.error('\nFAILED: ' + e.message); process.exit(1); });
