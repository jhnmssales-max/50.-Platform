const express = require('express');
const { z } = require('zod');
const { nanoid } = require('nanoid');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');
const { slugify } = require('../lib/codes');

const router = express.Router();

const UNIQUE_VIOLATION = '23505';

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

// ---------------------------------------------------------------------------
// POST /api/customers — a dealer enters a customer's name/contact and gets
// back that customer's referral (invite) link, created atomically. This is
// "creating a referral link" from the dealer's side of the flow; the
// customer's own onward "share" link is a public-facing action and out of
// scope here. No email is sent yet — the caller is responsible for handing
// the link to the customer themselves for now.
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

      return { customer, link, tenantDomain: ctx.tenant_domain };
    });

    res.status(201).json({
      customer: result.customer,
      invite_link: {
        code: result.link.code,
        url: result.tenantDomain ? `https://${result.tenantDomain}/50/${result.link.code}` : null,
        status: result.link.status,
        created_at: result.link.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
