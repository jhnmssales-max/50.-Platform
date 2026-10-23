const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');
const { buildInviteUrl, createInviteLink, sendInviteEmail } = require('../lib/customerInvite');
const { tokenForSending } = require('../lib/unsubscribe');

const router = express.Router();

// Auth here is a bearer token the calling page must already possess and
// attach itself — never a cookie the browser sends automatically — so an
// open CORS policy doesn't add a CSRF-style risk. It's what lets a
// same-origin-less static admin page (opened as a file, or served from a
// different host/port than the API) actually call these routes.
router.use(cors());

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

// ---------------------------------------------------------------------------
// POST /api/customers — a staff member enters a customer's name/contact;
// the customer and their referral (invite) link are created atomically,
// then the invite is emailed to them through Postmark. This is "creating a
// referral link" from staff's side of the flow; the customer's own
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

      const link = await createInviteLink(client, {
        tenantId: ctx.tenant_id,
        customerId: customer.id,
        name,
      });

      // Minted inside the same transaction as the customer, so the invite
      // below always has one. A brand-new customer cannot be unsubscribed,
      // but this goes through the same helper as every other send rather
      // than assuming that stays true.
      const unsubscribeToken = await tokenForSending(client, customer.id);

      return { customer, link, ctx, unsubscribeToken };
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
      await sendInviteEmail({
        tenant: result.ctx,
        customerName: result.customer.name,
        customerEmail: result.customer.email,
        inviteUrl,
        unsubscribeToken: result.unsubscribeToken,
        // Replies go to the staff member who sent the invite (their own
        // business inbox), not the platform's shared sending address.
        replyToEmail: result.ctx.user_email,
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
