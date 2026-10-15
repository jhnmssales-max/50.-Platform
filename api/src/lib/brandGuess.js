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
function paletteFrom(primary, accent) {
  const p = parseHex(primary);
  if (!p) return { ...DEFAULTS };
  const a = parseHex(accent) || null;
  return {
    primaryColor: hex(p.r, p.g, p.b),
    primaryDark: shade(p, luminance(p) < 0.25 ? 0.22 : -0.28),
    secondary: shade(p, 0.42),
    accentColor: a ? hex(a.r, a.g, a.b) : DEFAULTS.accentColor,
    accentDark: a ? shade(a, -0.3) : DEFAULTS.accentDark,
    bg: '#F7F4EE',
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
function findColors(html) {
  const theme = /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i.exec(html);
  const declared = theme && (parseHex(theme[1]) || parseRgbFunction(theme[1]));

  const counts = new Map();
  const bump = (c, weight) => {
    if (!isUseful(c)) return;
    const key = hex(c.r, c.g, c.b);
    counts.set(key, (counts.get(key) || 0) + weight);
  };

  // Weighted by where it appears: a colour used on a button or a header says
  // more about a brand than one buried in a gradient stop.
  for (const m of html.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) bump(parseHex(m[0]), 1);
  for (const m of html.matchAll(/rgba?\([^)]+\)/g)) bump(parseRgbFunction(m[0]), 1);
  for (const m of html.matchAll(/(?:background(?:-color)?|border-color)\s*:\s*([^;}"']+)/gi)) {
    bump(parseHex(m[1]) || parseRgbFunction(m[1]), 3);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const primary = declared ? hex(declared.r, declared.g, declared.b) : ranked[0] || null;
  // An accent worth having is a different hue from the primary, not a shade
  // of it, so anything too close is passed over.
  const accent = ranked.find((c) => {
    if (!primary || c === primary) return false;
    const a = parseHex(c);
    const p = parseHex(primary);
    return Math.abs(luminance(a) - luminance(p)) > 0.15 || Math.abs(a.r - p.r) + Math.abs(a.g - p.g) + Math.abs(a.b - p.b) > 150;
  }) || null;

  return { primary, accent, declared: Boolean(declared), ranked: ranked.slice(0, 6) };
}

// What the whole website path produces. Never throws for an ordinary failure
// — a site being down, slow or hostile is a normal outcome and comes back as
// a reason the approval screen can show.
async function fromWebsite(website) {
  const url = normalizeUrl(website);
  if (!url) return { ok: false, reason: 'That does not look like a website address.', brand: null };
  try {
    const html = await fetchText(url.toString());
    const { logoUrl, how } = findLogo(html, url.toString());
    const { primary, accent, declared, ranked } = findColors(html);
    const titleMatch = /<title[^>]*>([^<]{1,120})</i.exec(html);
    if (!primary && !logoUrl) {
      return { ok: false, reason: 'Nothing on that page looked like a logo or a brand colour.', brand: null, site: url.toString() };
    }
    return {
      ok: true,
      source: 'website',
      site: url.toString(),
      brand: { ...paletteFrom(primary, accent), ...(logoUrl ? { logoUrl } : {}) },
      found: {
        logo: how,
        colorFrom: declared ? 'the colour the site declares for browser chrome' : primary ? 'the colours used most on the page' : null,
        otherColors: ranked,
        title: titleMatch ? titleMatch[1].trim() : null,
      },
    };
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? 'That site took too long to answer.'
      : `Could not read that site: ${err.message}`;
    return { ok: false, reason, brand: null, site: url.toString() };
  }
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
