// Guessing a company's brand, so a rep does not have to know hex codes.
//
// Two ways in, both of which produce the same thing — the keys
// tenants.branding already uses (primaryColor, primaryDark, secondary,
// accentColor, accentDark, bg, logoUrl):
//
//   1. Their website. Fetch the homepage, find the logo in the markup, and
//      take the colours out of the CSS that is actually in the page.
//   2. A logo the rep uploaded. Read the pixels and take the colours that
//      cover the most of it.
//
// It is a GUESS and is treated as one everywhere: the result carries what it
// found and how sure it is, the approval screen says where each colour came
// from, and Joseph corrects it before a dealer ever sees it. Nothing here
// decides anything on its own.
//
// Everything is bounded — the fetch, the bytes read, the pixels sampled —
// because the input is somebody else's website and the only safe assumption
// about it is that it might be enormous or hostile.
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// 50.'s own palette, which is what a dealer gets for anything not guessed.
const DEFAULTS = {
  primaryColor: '#1C2B33',
  primaryDark: '#33475A',
  secondary: '#7C9FBB',
  accentColor: '#C9974B',
  accentDark: '#8B6B2E',
  bg: '#F7F4EE',
};

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------
function hex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function parseHex(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function parseRgbFunction(value) {
  const m = /rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(String(value || ''));
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function luminance({ r, g, b }) {
  // Rec. 709, good enough to tell "dark" from "light" for picking text and
  // deciding whether a colour can carry a page header.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function saturation({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function shade({ r, g, b }, amount) {
  // Negative darkens, positive lightens, both toward the limit rather than by
  // a flat step, so a colour that is already nearly black still moves.
  const t = amount < 0 ? 0 : 255;
  const k = Math.abs(amount);
  return hex(r + (t - r) * k, g + (t - g) * k, b + (t - b) * k);
}

// A brand usually gives us one strong colour. The rest of the palette is
// derived from it so the dealer's pages look deliberate rather than like one
// colour dropped into a 50.-coloured template.
function paletteFrom(primary, accent, bg) {
  const p = parseHex(primary);
  if (!p) return { ...DEFAULTS, ...(bg ? { bg } : {}) };
  const a = parseHex(accent) || null;
  return {
    primaryColor: hex(p.r, p.g, p.b),
    primaryDark: shade(p, luminance(p) < 0.25 ? 0.22 : -0.28),
    secondary: shade(p, 0.42),
    accentColor: a ? hex(a.r, a.g, a.b) : DEFAULTS.accentColor,
    accentDark: a ? shade(a, -0.3) : DEFAULTS.accentDark,
    // Their own page colour when they have a light one, 50.'s cream when they
    // do not. This was hardcoded cream for everybody, which is a good part of
    // why the result never looked like the site it came from.
    bg: bg || DEFAULTS.bg,
  };
}

// Colours that tell us nothing: black, white, the greys every page is full of,
// and anything so washed out it would read as a mistake on a header.
function isUseful(c) {
  if (!c) return false;
  const lum = luminance(c);
  if (lum > 0.93 || lum < 0.04) return false;
  return saturation(c) >= 0.18;
}

// ---------------------------------------------------------------------------
// From a website
// ---------------------------------------------------------------------------
function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch (err) {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  // A prospect's website is an address somebody typed, and this service
  // fetches it. So anything pointing back inside the network it runs on is
  // refused: loopback, link-local, and the private ranges. A public IP is
  // allowed — rare for a business site, but not our business to forbid.
  //
  // BRAND_LOOKUP_ALLOW_LOCAL exists for the e2e suite, which serves a
  // pretend prospect's website on 127.0.0.1. Same approach as
  // STRIPE_API_BASE and POSTMARK_API_BASE elsewhere in this project; it is
  // never set in production, and setting it is the only way past this.
  const host = url.hostname.toLowerCase();
  if (process.env.BRAND_LOOKUP_ALLOW_LOCAL === '1') return url;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    if (a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return null;
  }
  if (host.includes(':')) return null; // an IPv6 literal, including ::1
  return url;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': '50-platform-brand-lookup/1.0', Accept: 'text/html,*/*' },
    });
    if (!res.ok) throw new Error(`that site answered ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, MAX_HTML_BYTES).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function absolute(href, pageUrl) {
  try {
    return new URL(href, pageUrl).toString();
  } catch (err) {
    return null;
  }
}

// The logo, in the order a human would look: a declared one first, then an
// image that calls itself a logo, then the site icon.
function findLogo(html, pageUrl) {
  const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html);

  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  const logoImg = imgTags.find((tag) => /logo/i.test(tag));
  const srcOf = (tag) => {
    const m = /\ssrc=["']([^"']+)["']/i.exec(tag || '');
    return m ? m[1] : null;
  };

  const iconLink = (html.match(/<link\b[^>]*>/gi) || []).find((tag) => /rel=["'][^"']*icon/i.test(tag));
  const hrefOf = (tag) => {
    const m = /\shref=["']([^"']+)["']/i.exec(tag || '');
    return m ? m[1] : null;
  };

  for (const [candidate, how] of [
    [srcOf(logoImg), 'an image on the page named logo'],
    [og && og[1], 'the image the site shares on social media'],
    [hrefOf(iconLink), 'the site icon'],
  ]) {
    if (!candidate) continue;
    // A data: URI is already the image; keep it rather than resolving it.
    if (/^data:image\//i.test(candidate)) return { logoUrl: candidate, how };
    const abs = absolute(candidate, pageUrl);
    if (abs) return { logoUrl: abs, how };
  }
  return { logoUrl: null, how: null };
}

// Colours in the order they carry meaning: a declared theme colour, then
// whatever the page's own CSS uses most.
// ---------------------------------------------------------------------------
// Reading a brand out of a page, by ROLE rather than by frequency.
//
// The first version counted every hex code in the HTML and took the two most
// common. That is how a roofer with a red logo ended up with a dashboard in
// two greys and a border colour: the most-used colour on a page built with a
// CSS framework is whatever that framework paints its cards and dividers
// with, and none of it is the brand.
//
// What a person means by "their colours" is a small set of ROLES -- the
// colour of their buttons, the colour of their header, their link colour,
// the colour of the page itself. Those live in named declarations, so this
// goes and reads those declarations instead of counting.
//
// Two consequences worth stating:
//
//   - Stylesheets are fetched now, not only the inline <style> blocks. Almost
//     nobody writes button colours inline, so without this the role lookup
//     would find nothing on the sites that matter most. Same host only, three
//     at most, each bounded: a CDN's reset stylesheet says nothing about a
//     brand and somebody else's host is not our business to fetch.
//   - Later rules win, so the rule list is read backwards. A site that
//     overrides its own button colour further down the file means the
//     override, which is the colour a visitor actually sees.
// ---------------------------------------------------------------------------
const MAX_CSS_BYTES = 400_000;
const MAX_STYLESHEETS = 3;

// Enough named colours to cover what people actually write by hand. A site
// using "rebeccapurple" can go through the hex path like everyone else.
const NAMED = {
  white: '#FFFFFF', black: '#000000', red: '#FF0000', green: '#008000', blue: '#0000FF',
  navy: '#000080', teal: '#008080', maroon: '#800000', olive: '#808000', purple: '#800080',
  gray: '#808080', grey: '#808080', silver: '#C0C0C0', orange: '#FFA500', gold: '#FFD700',
  crimson: '#DC143C', forestgreen: '#228B22', darkblue: '#00008B', steelblue: '#4682B4',
  firebrick: '#B22222', darkgreen: '#006400', midnightblue: '#191970', royalblue: '#4169E1',
};

async function collectCss(html, baseUrl) {
  let css = '';
  for (const m of html.matchAll(/<style[^>]*>([\s\S]{0,200000}?)<\/style>/gi)) css += '\n' + m[1];

  let base;
  try { base = new URL(baseUrl); } catch (err) { return css.slice(0, MAX_CSS_BYTES); }

  const hrefs = [];
  for (const m of html.matchAll(/<link\b[^>]{0,500}>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']{1,500})["']/i.exec(tag);
    if (!href) continue;
    let abs;
    try { abs = new URL(href[1], base); } catch (err) { continue; }
    // Same host as the page, which has already been through normalizeUrl's
    // host checks -- so this cannot reach anywhere the page fetch could not.
    if (abs.host !== base.host) continue;
    if (!/^https?:$/.test(abs.protocol)) continue;
    hrefs.push(abs.toString());
    if (hrefs.length >= MAX_STYLESHEETS) break;
  }

  for (const href of hrefs) {
    // A stylesheet that 404s, hangs or is enormous is an ordinary thing for
    // somebody else's site to do, and it is not a reason to fail the guess.
    try { css += '\n' + await fetchText(href); } catch (err) { /* keep what we have */ }
    if (css.length > MAX_CSS_BYTES) break;
  }
  return css.slice(0, MAX_CSS_BYTES);
}

// Deliberately not a CSS parser. Blocks are matched shallowly, which answers
// "what colour are their buttons" and cannot hang on a minified bundle: both
// halves are length-bounded, so there is no nested quantifier to blow up on.
function cssRules(css) {
  const out = [];
  for (const m of String(css || '').matchAll(/([^{}]{1,300})\{([^{}]{0,3000})\}/g)) {
    out.push({ selector: m[1].trim().toLowerCase().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

function declValue(body, prop) {
  const m = new RegExp('(?:^|;|\\{)\\s*' + prop + '\\s*:\\s*([^;}]{1,200})', 'i').exec(body);
  return m ? m[1].trim() : null;
}

function colorIn(value) {
  if (!value) return null;
  if (/\b(transparent|inherit|currentcolor|none)\b/i.test(value) && !/#|rgb/i.test(value)) return null;
  const hexM = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/.exec(value);
  if (hexM) return parseHex(hexM[0]);
  const rgbM = /rgba?\([^)]{1,80}\)/.exec(value);
  if (rgbM) return parseRgbFunction(rgbM[0]);
  const named = NAMED[value.trim().toLowerCase()];
  return named ? parseHex(named) : null;
}

// Later rules win in CSS, so this reads the list backwards: a site that
// overrides its own button colour further down means the override.
function roleColor(rules, matches, props) {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    if (!matches(rules[i].selector)) continue;
    for (const p of props) {
      const c = colorIn(declValue(rules[i].body, p));
      if (c) return c;
    }
  }
  return null;
}

const IS_PAGE = (s) => /^(html|body)( ?, ?(html|body))*$/.test(s);
const IS_BUTTON = (s) => /(^|[\s,.#>])(btn|button|cta)|\[type ?= ?["']?(submit|button)/.test(s);
const IS_LINK = (s) => /^a( ?, ?a)*(:(link|visited))?$/.test(s);
const IS_HEADER = (s) => /(^|[\s,.#>])(header|navbar|nav-bar|masthead|topbar|site-nav|site-header)/.test(s);

function findColors(html, css) {
  const rules = cssRules(css);
  const theme = /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i.exec(html);
  const declared = theme && (parseHex(theme[1]) || parseRgbFunction(theme[1]));

  const roles = {
    pageBg: roleColor(rules, IS_PAGE, ['background-color', 'background']),
    text: roleColor(rules, IS_PAGE, ['color']),
    button: roleColor(rules, IS_BUTTON, ['background-color', 'background']),
    buttonText: roleColor(rules, IS_BUTTON, ['color']),
    link: roleColor(rules, IS_LINK, ['color']),
    header: roleColor(rules, IS_HEADER, ['background-color', 'background']),
  };

  // The old frequency count stays as the last resort, for a page that
  // declares nothing recognisable. A guess Joseph can correct on the screen
  // in front of him beats handing every such dealer 50.'s own navy.
  const counts = new Map();
  const bump = (c, weight) => {
    if (!isUseful(c)) return;
    const key = hex(c.r, c.g, c.b);
    counts.set(key, (counts.get(key) || 0) + weight);
  };
  for (const m2 of html.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) bump(parseHex(m2[0]), 1);
  for (const m2 of html.matchAll(/rgba?\([^)]{1,80}\)/g)) bump(parseRgbFunction(m2[0]), 1);
  for (const m2 of String(css || '').matchAll(/(?:background(?:-color)?|border-color)\s*:\s*([^;}"']{1,120})/gi)) {
    bump(colorIn(m2[1]), 3);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  // In the order a person would point at them: what the site tells browsers
  // it is, then the thing they click, then the band across the top.
  const chosen = [
    [declared, 'the colour the site declares for browser chrome'],
    [roles.button, 'the colour of their buttons'],
    [roles.header, 'the colour of their header'],
    [roles.link, 'their link colour'],
    [ranked[0] ? parseHex(ranked[0]) : null, 'the colours used most on the page'],
  ].find(([c]) => c && isUseful(c));
  const primary = chosen ? hex(chosen[0].r, chosen[0].g, chosen[0].b) : null;
  const colorFrom = chosen ? chosen[1] : null;

  // An accent worth having is a different hue from the primary, not a shade
  // of it, so anything too close is passed over.
  const farFromPrimary = (c) => {
    if (!c || !primary) return false;
    const pc = parseHex(primary);
    return Math.abs(luminance(c) - luminance(pc)) > 0.15
      || Math.abs(c.r - pc.r) + Math.abs(c.g - pc.g) + Math.abs(c.b - pc.b) > 150;
  };
  const accentPick = [
    [roles.link, 'their link colour'],
    [roles.button, 'the colour of their buttons'],
    [roles.header, 'the colour of their header'],
  ].find(([c]) => c && isUseful(c) && farFromPrimary(c));
  const accent = accentPick
    ? hex(accentPick[0].r, accentPick[0].g, accentPick[0].b)
    : (ranked.find((c) => c !== primary && farFromPrimary(parseHex(c))) || null);
  const accentFrom = accentPick ? accentPick[1] : (accent ? 'the colours used most on the page' : null);

  // The page background is the one role where near-white is the right answer,
  // so isUseful -- which exists to throw greys away -- must not be consulted
  // for it. It does have to stay light: this becomes the card their own
  // referral page prints charcoal text on, and a dark one makes that
  // unreadable. A dark site keeps 50.'s cream and Joseph can override it.
  const bg = roles.pageBg && luminance(roles.pageBg) > 0.8
    ? hex(roles.pageBg.r, roles.pageBg.g, roles.pageBg.b)
    : null;

  return {
    primary,
    accent,
    bg,
    colorFrom,
    accentFrom,
    declared: Boolean(declared),
    ranked: ranked.slice(0, 6),
    // What each role actually resolved to, so the build screen can say where
    // a colour came from instead of presenting six numbers with no account
    // of themselves.
    roles: Object.fromEntries(Object.entries(roles).map(([k, c]) => [k, c ? hex(c.r, c.g, c.b) : null])),
  };
}

// What the whole website path produces. Never throws for an ordinary failure
// — a site being down, slow or hostile is a normal outcome and comes back as
// a reason the approval screen can show.
// A bare domain is normalised to https, which is right for nearly everything
// and wrong for exactly the sites this has to read: plenty of small builders
// still run an http-only page, and forcing https turned those into "could not
// read that site" with nothing anybody could do about it. So a bare domain
// tries https and then falls back to http. An address typed WITH a scheme is
// left alone -- somebody who wrote https is not asking to be downgraded.
async function fromWebsite(website) {
  const url = normalizeUrl(website);
  if (!url) return { ok: false, reason: 'That does not look like a website address.', brand: null };

  const typed = String(website || '').trim();
  const tries = [url];
  if (!/^https?:\/\//i.test(typed) && url.protocol === 'https:') {
    // normalizeUrl runs its own host checks again, so the fallback cannot
    // reach anywhere the first attempt was not already allowed to go.
    const plain = normalizeUrl(`http://${typed}`);
    if (plain) tries.push(plain);
  }

  let lastErr = null;
  let lastUrl = url;

  for (const attempt of tries) {
    lastUrl = attempt;
    let html;
    try {
      html = await fetchText(attempt.toString());
    } catch (err) {
      lastErr = err;
      continue;
    }

    // Past here the page was read. Whatever it does or does not contain is
    // the answer -- retrying the same page over http would find the same
    // nothing, so this returns rather than falling through to the next try.
    const { logoUrl, how } = findLogo(html, attempt.toString());
    // Their stylesheets, not only the inline <style> blocks: almost nobody
    // writes a button colour inline, so without this the role lookup finds
    // nothing on exactly the sites worth reading.
    const css = await collectCss(html, attempt.toString());
    const { primary, accent, bg, colorFrom, accentFrom, declared, ranked, roles } = findColors(html, css);
    const titleMatch = /<title[^>]*>([^<]{1,120})</i.exec(html);
    if (!primary && !logoUrl) {
      return { ok: false, reason: 'Nothing on that page looked like a logo or a brand colour.', brand: null, site: attempt.toString() };
    }
    return {
      ok: true,
      source: 'website',
      site: attempt.toString(),
      brand: { ...paletteFrom(primary, accent, bg), ...(logoUrl ? { logoUrl } : {}) },
      found: {
        logo: how,
        // Where each colour actually came from, in words, rather than the
        // old blanket "the colours used most on the page" -- which was true
        // of everything and so told nobody anything.
        colorFrom,
        accentFrom,
        bgFrom: bg ? 'their page background' : null,
        roles,
        otherColors: ranked,
        title: titleMatch ? titleMatch[1].trim() : null,
      },
    };
  }

  const reason = lastErr && lastErr.name === 'AbortError'
    ? 'That site took too long to answer.'
    : `Could not read that site: ${lastErr ? lastErr.message : 'no answer'}`;
  return { ok: false, reason, brand: null, site: lastUrl.toString() };
}

// ---------------------------------------------------------------------------
// From a logo image
// ---------------------------------------------------------------------------
function decodePixels(bytes, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) {
    const png = PNG.sync.read(bytes);
    return { data: png.data, width: png.width, height: png.height, channels: 4 };
  }
  if (type.includes('jpeg') || type.includes('jpg')) {
    const img = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 64 });
    return { data: img.data, width: img.width, height: img.height, channels: 4 };
  }
  return null;
}

// An SVG is text, so its colours are simply written in it — no decoding, and
// the order they appear is a decent proxy for importance.
function colorsFromSvg(bytes) {
  const text = bytes.subarray(0, 400_000).toString('utf8');
  const found = [];
  for (const m of text.matchAll(/(?:fill|stop-color|stroke)\s*[:=]\s*["']?(#[0-9a-fA-F]{3,6}|rgba?\([^)]+\))/g)) {
    const c = parseHex(m[1]) || parseRgbFunction(m[1]);
    if (isUseful(c)) found.push(hex(c.r, c.g, c.b));
  }
  const counts = new Map();
  found.forEach((c) => counts.set(c, (counts.get(c) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

// Buckets rather than exact matches: a logo that looks like one flat colour is
// usually a few dozen near-identical ones after compression and anti-aliasing,
// so near-identical shades are counted together and the bucket's average wins.
function colorsFromPixels({ data, width, height, channels }) {
  const buckets = new Map();
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channels;
      const a = channels === 4 ? data[i + 3] : 255;
      if (a < 160) continue; // transparent padding, which most logos are mostly made of
      const c = { r: data[i], g: data[i + 1], b: data[i + 2] };
      if (!isUseful(c)) continue;
      const key = `${c.r >> 4}-${c.g >> 4}-${c.b >> 4}`;
      const slot = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      slot.n += 1; slot.r += c.r; slot.g += c.g; slot.b += c.b;
      buckets.set(key, slot);
    }
  }
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 6)
    .map((s) => hex(s.r / s.n, s.g / s.n, s.b / s.n));
}

function fromLogo(bytes, contentType, logoUrl) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return { ok: false, reason: 'There was nothing in that file.', brand: null };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'That image is too big to read.', brand: null };
  try {
    const type = String(contentType || '').toLowerCase();
    const ranked = type.includes('svg') ? colorsFromSvg(bytes) : (() => {
      const pixels = decodePixels(bytes, type);
      if (!pixels) return null;
      return colorsFromPixels(pixels);
    })();

    if (ranked === null) {
      // A PDF or a format with no colours to read: still a perfectly good
      // logo to put on their pages, just not one to take a palette from.
      return {
        ok: true,
        source: 'logo',
        brand: { ...DEFAULTS, ...(logoUrl ? { logoUrl } : {}) },
        found: { colorFrom: null, otherColors: [], note: 'Colours could not be read from this kind of file — these are 50.’s own, to change.' },
      };
    }
    if (!ranked.length) {
      return {
        ok: true,
        source: 'logo',
        brand: { ...DEFAULTS, ...(logoUrl ? { logoUrl } : {}) },
        found: { colorFrom: null, otherColors: [], note: 'That logo is black, white or grey, so there was no colour to take — these are 50.’s own, to change.' },
      };
    }
    return {
      ok: true,
      source: 'logo',
      brand: { ...paletteFrom(ranked[0], ranked[1]), ...(logoUrl ? { logoUrl } : {}) },
      found: { colorFrom: 'the colours that cover most of the logo', otherColors: ranked },
    };
  } catch (err) {
    return { ok: false, reason: `That image could not be read: ${err.message}`, brand: null };
  }
}

module.exports = { DEFAULTS, fromWebsite, fromLogo, paletteFrom, parseHex, normalizeUrl, isUseful, shade };
