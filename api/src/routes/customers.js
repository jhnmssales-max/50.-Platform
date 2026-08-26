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

// ---------------------------------------------------------------------------
// GET /api/customers — the dealer's searchable pipeline: every customer
// they (or a teammate) have invited, whether their referral has paid out
// yet, matching the "Referrals in progress" list from the dealer page
// prototype. "Paid" is computed from gift_card_transactions rather than
// stored redundantly, so it can never drift from the actual ledger.
// ---------------------------------------------------------------------------
const listCustomersQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  status: z.enum(['pending', 'paid']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

router.get('/customers', requireAuth, async (req, res, next) => {
  const parsed = listCustomersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
  }
  const { query, status, limit, offset } = parsed.data;

  try {
    const result = await withUserTransaction(req.userId, async (client) => {
      const ctx = await getCallerContext(client, req.userId);
      if (!ctx) throw forbidden('No staff account found for this user');

      const { rows: [counts] } = await client.query(`
        select
          count(*) filter (where paid) as paid,
          count(*) filter (where not paid) as pending
        from (
          select c.id, exists (
            select 1 from gift_card_transactions gct
            where gct.recipient_customer_id = c.id
              and gct.recipient_role = 'referrer'
              and gct.status = 'issued'
          ) as paid
          from customers c
        ) s
      `);

      const { rows } = await client.query(
        `with pipeline as (
           select
             c.id, c.name, c.email, c.phone, c.created_at,
             il.code as invite_code,
             il.created_at as invite_created_at,
             exists (
               select 1 from gift_card_transactions gct
               where gct.recipient_customer_id = c.id
                 and gct.recipient_role = 'referrer'
                 and gct.status = 'issued'
             ) as paid
           from customers c
           left join referral_links il on il.customer_id = c.id and il.kind = 'invite'
         )
         select *, count(*) over() as total
         from pipeline
         where ($1::text is null or lower(name) like $1 or lower(coalesce(email, '')) like $1 or lower(coalesce(phone, '')) like $1)
           and ($2::text is null or ($2 = 'paid' and paid) or ($2 = 'pending' and not paid))
         order by created_at desc
         limit $3 offset $4`,
        [query ? `%${query.toLowerCase()}%` : null, status || null, limit, offset]
      );

      return { rows, counts };
    });

    const total = result.rows[0]?.total ? Number(result.rows[0].total) : 0;

    res.json({
      customers: result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        created_at: r.created_at,
        invite_link: r.invite_code ? { code: r.invite_code, created_at: r.invite_created_at } : null,
        status: r.paid ? 'paid' : 'pending',
      })),
      pagination: { limit, offset, total },
      counts: { pending: Number(result.counts.pending), paid: Number(result.counts.paid) },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
