const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { nanoid } = require('nanoid');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');
const { slugify } = require('../lib/codes');
const { sendEmail } = require('../lib/postmark');
const { buildInviteEmail } = require('../lib/inviteEmail');

const router = express.Router();

// Prefers the page that's actually reachable and functional today
// (fifty-template-customer.html?code=..., wherever the static frontend is
// deployed) over the tenant's own domain + the aspirational /50/... path
// scheme, which has no routing layer behind it yet. Falls back to the
// latter only if FRONTEND_BASE_URL isn't configured.
function buildInviteUrl(code, tenantDomain) {
  const base = process.env.FRONTEND_BASE_URL;
  if (base) return `${base.replace(/\/$/, '')}/fifty-template-customer.html?code=${encodeURIComponent(code)}`;
  return tenantDomain ? `https://${tenantDomain}/50/${code}` : null;
}

// Auth here is a bearer token the calling page must already possess and
// attach itself — never a cookie the browser sends automatically — so an
// open CORS policy doesn't add a CSRF-style risk. It's what lets a
// same-origin-less static admin page (opened as a file, or served from a
// different host/port than the API) actually call these routes.
router.use(cors());

const UNIQUE_VIOLATION = '23505';

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

// ---------------------------------------------------------------------------
// POST /api/customers — a dealer enters a customer's name/contact; the
// customer and their referral (invite) link are created atomically, then
// the invite is emailed to them through Postmark. This is "creating a
// referral link" from the dealer's side of the flow; the customer's own
// onward "share" link is a public-facing action and out of scope here.
//
// A tenant with its own verified sending domain (tenants.send_domain_verified)
// sends as that domain; every other tenant falls back to the platform's
// single verified sender (EMAIL_FROM_ADDRESS) — today, that's the only
// verified sender that exists, so every tenant uses it until per-tenant
// domain verification is actually built.
// ---------------------------------------------------------------------------
const createCustomerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  email: z.string().trim().email('A valid email is required'),
  phone: z.string().trim().max(40).optional().nullable(),
});

router.post('/customers', requireAuth, async (req, res, next) => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  const { name, email, phone } = parsed.data;

  try {
    const result = await withUserTransaction(req.userId, async (client) => {
      const ctx = await getCallerContext(client, req.userId);
      if (!ctx) throw forbidden('No staff account found for this user');

      const { rows: [customer] } = await client.query(
        `insert into customers (tenant_id, name, email, phone, created_by_user_id)
         values ($1, $2, $3, $4, $5)
         returning id, name, email, phone, created_at`,
        [ctx.tenant_id, name, email, phone || null, req.userId]
      );

      let link;
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = `${slugify(name) || 'friend'}-${nanoid(6)}`;
        try {
          const { rows } = await client.query(
            `insert into referral_links (tenant_id, code, kind, customer_id)
             values ($1, $2, 'invite', $3)
             returning code, status, created_at`,
            [ctx.tenant_id, code, customer.id]
          );
          link = rows[0];
          break;
        } catch (err) {
          if (err.code === UNIQUE_VIOLATION && attempt < 4) continue;
          throw err;
        }
      }

      return { customer, link, ctx };
    });

    const inviteUrl = buildInviteUrl(result.link.code, result.ctx.tenant_domain);

    const responseBody = {
      customer: result.customer,
      invite_link: {
        code: result.link.code,
        url: inviteUrl,
        status: result.link.status,
        created_at: result.link.created_at,
      },
    };

    // Sending is a best-effort side effect, attempted only after the
    // customer and link are safely committed: a slow or failed send must
    // never roll back data that already exists, and shouldn't hold the DB
    // transaction open while waiting on a third-party HTTP call either.
    try {
      const fromAddress =
        (result.ctx.send_domain_verified && result.ctx.send_from_address) || process.env.EMAIL_FROM_ADDRESS;
      if (!fromAddress) {
        throw new Error('No verified sending address configured for this tenant, and no platform default is set');
      }
      const fromName = (result.ctx.send_domain_verified && result.ctx.send_from_name) || result.ctx.tenant_name;

      const { subject, htmlBody, textBody } = buildInviteEmail({
        tenantName: result.ctx.tenant_name,
        rewardAmountCents: result.ctx.reward_amount_cents,
        rewardCurrency: result.ctx.reward_currency,
        customerName: result.customer.name,
        inviteUrl,
      });

      await sendEmail({
        from: `${fromName} <${fromAddress}>`,
        to: result.customer.email,
        subject,
        htmlBody,
        textBody,
      });

      responseBody.email = { sent: true };
    } catch (emailErr) {
      responseBody.email = { sent: false, error: emailErr.message };
    }

    res.status(201).json(responseBody);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
