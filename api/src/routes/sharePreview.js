const express = require('express');
const { z } = require('zod');
const { withPublicTransaction } = require('../db');
const { resolveLinkLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Facebook, iMessage, Slack etc. build their link-preview card from the
// Open Graph tags in the HTML they fetch, and none of those crawlers run
// JavaScript. The static lead pages re-brand themselves with JS after
// load, so a crawler only ever saw the generic "50." tags. This route
// returns a tiny page with the tenant's own name/logo/wording in the head
// (what crawlers read) and immediately sends real visitors on to the
// lead page. Deliberately NO <meta http-equiv="refresh">: Facebook follows
// it and then reads the generic lead page's tags instead of these. The
// redirect is JS-only, which real browsers run and crawlers don't.
// Share links point here (via go.referwith50.com/r/<code>,
// see ../../_redirects) instead of straight at the static lead page.

const codeSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);

const LEAD_PAGES = {
  template: 'fifty-template-lead.html',
  referral: 'fifty-referral-lead.html',
};

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function absolute(url, base) {
  if (!url) return null;
  try {
    return new URL(url, base + '/').toString();
  } catch (_) {
    return null;
  }
}

function buildHtml({ title, description, image, pageUrl, redirectUrl, siteName }) {
  const imageTags = image
    ? `<meta property="og:image" content="${esc(image)}">
<meta name="twitter:image" content="${esc(image)}">`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(siteName)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(pageUrl)}">
${imageTags}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="canonical" href="${esc(pageUrl)}">
</head>
<body>
<p><a href="${esc(redirectUrl)}">Continue</a></p>
<script>location.replace(${JSON.stringify(redirectUrl)});</script>
</body>
</html>`;
}

router.get('/r/:code', resolveLinkLimiter, async (req, res, next) => {
  const parsed = codeSchema.safeParse(req.params.code);
  const base = (process.env.FRONTEND_BASE_URL || '').replace(/\/$/, '');
  if (!parsed.success || !base) return res.status(404).type('text/plain').send('Not found');

  const page = LEAD_PAGES[req.query.p] || LEAD_PAGES.template;
  const redirectUrl = `${base}/${page}?ref=${encodeURIComponent(parsed.data)}`;

  try {
    const row = await withPublicTransaction(async (client) => {
      const { rows } = await client.query('select * from resolve_link($1)', [parsed.data]);
      return rows[0];
    });

    // Unknown/expired code: still send the visitor to the real page (it
    // shows its own "link not found" state), with neutral tags.
    const name = (row && row.tenant_name) || '50.';
    const branding = (row && row.tenant_branding) || {};
    const first = row && row.referrer_first_name;
    const title = `You've been referred to ${name}`;
    const description = first
      ? `${first} thought you'd like ${name} and wanted to pass along a personal recommendation. Tap to learn more.`
      : `A friend thought you'd like ${name} and wanted to pass along a personal recommendation. Tap to learn more.`;
    const image =
      absolute(branding.logoUrl, base) || absolute('assets/50-platform-logo.png', base);

    res
      .set('Cache-Control', 'public, max-age=300')
      .type('html')
      .send(
        buildHtml({
          title,
          description,
          image,
          pageUrl: `${new URL(base).origin}/r/${encodeURIComponent(parsed.data)}${req.query.p ? `?p=${encodeURIComponent(req.query.p)}` : ""}`,
          redirectUrl,
          siteName: name,
        })
      );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
