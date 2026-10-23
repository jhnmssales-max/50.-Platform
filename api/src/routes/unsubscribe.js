// The page at the end of an unsubscribe link.
//
// Public and credential-less on purpose: the token in the link is the whole
// credential, and asking someone to sign in before they can stop being
// emailed is not an unsubscribe.
//
// GET shows a confirmation with a button; POST is what actually stops the
// email. That split is deliberate. Corporate mail scanners and link
// prefetchers follow every URL in an incoming message, and a GET that
// unsubscribed on sight would quietly cut people off from mail they never
// asked to stop -- the dealer would see their list go silent with nobody
// having clicked anything.
//
// Both render plain HTML rather than JSON: a person is reading this in a
// browser, not a program.

const express = require('express');
const { z } = require('zod');
const { withPublicTransaction } = require('../db');

const router = express.Router();

const tokenSchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;background:#F7F4EE;color:#1B1B1B;
    font:16px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;}
  main{max-width:460px;margin:0 auto;padding:56px 20px;}
  .card{background:#fff;border:1px solid #E6E0D5;border-radius:14px;padding:26px;}
  h1{margin:0 0 10px;font-size:20px;}
  p{margin:0 0 14px;color:#444;}
  button{border:0;border-radius:9px;padding:11px 18px;font:inherit;font-weight:600;
    background:#1C2B33;color:#fff;cursor:pointer;}
  .muted{color:#777;font-size:14px;}
</style></head>
<body><main><div class="card">${bodyHtml}</div></main></body></html>`;
}

// A token that does not match anything gets the same page as one that does.
// Telling a stranger which tokens are real would turn this into a way to
// confirm that an address is on a dealer's list.
function notFoundPage() {
  return page('Already unsubscribed', `
    <h1>You're unsubscribed</h1>
    <p>You won't get any more referral emails from this business.</p>
    <p class="muted">If you're still receiving them a week from now, reply to one
      of them and the business will sort it out directly.</p>`);
}

router.get('/unsubscribe/:token', async (req, res, next) => {
  try {
    const parsed = tokenSchema.safeParse(req.params.token);
    if (!parsed.success) return res.status(200).type('html').send(notFoundPage());

    const row = await withPublicTransaction(async (client) => {
      // Through the function, not the table: anon has no access to
      // customers anywhere in this schema, and this route is not the place
      // to make the first exception.
      const { rows } = await client.query('select * from unsubscribe_lookup($1)', [parsed.data]);
      return rows[0] || null;
    });
    if (!row) return res.status(200).type('html').send(notFoundPage());

    if (row.already) {
      return res.status(200).type('html').send(page('Already unsubscribed', `
        <h1>You're unsubscribed</h1>
        <p>${escapeHtml(row.tenant_name)} won't send you any more referral emails.</p>`));
    }

    res.status(200).type('html').send(page('Unsubscribe', `
      <h1>Stop referral emails?</h1>
      <p>${escapeHtml(row.tenant_name)} will stop sending you emails about their
         referral program. You'll keep hearing from them about anything else,
         and this doesn't affect any other business.</p>
      <form method="POST">
        <button type="submit">Yes, stop these emails</button>
      </form>`));
  } catch (err) { next(err); }
});

router.post('/unsubscribe/:token', express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const parsed = tokenSchema.safeParse(req.params.token);
    if (!parsed.success) return res.status(200).type('html').send(notFoundPage());

    const row = await withPublicTransaction(async (client) => {
      // Idempotent: a second click keeps the original timestamp rather than
      // moving it, so the record says when they actually asked.
      const { rows } = await client.query('select * from unsubscribe_confirm($1)', [parsed.data]);
      return rows[0] || null;
    });
    if (!row) return res.status(200).type('html').send(notFoundPage());

    console.log(`UNSUBSCRIBE: somebody asked ${row.tenant_name} to stop sending them referral emails`);
    res.status(200).type('html').send(page('Unsubscribed', `
      <h1>Done</h1>
      <p>${escapeHtml(row.tenant_name)} won't send you any more referral emails.</p>`));
  } catch (err) { next(err); }
});

module.exports = router;
