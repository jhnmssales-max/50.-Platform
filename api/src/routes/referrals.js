const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');

const router = express.Router();

// See the same comment in routes/customers.js — bearer-token auth, not
// cookies, so an open CORS policy here isn't a CSRF-style risk.
router.use(cors());

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

// ---------------------------------------------------------------------------
// GET /api/referrals — the dealer's searchable pipeline of friend
// submissions, one row per referrals row. A single customer can hold
// several share links and so generate several referrals, each of which
// gets paid out (or not) independently — so status lives per referral,
// not aggregated up to the customer. "paid" is computed live from
// gift_card_transactions.referral_id, never stored redundantly.
// ---------------------------------------------------------------------------
const listReferralsQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  status: z.enum(['pending', 'paid']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

router.get('/referrals', requireAuth, async (req, res, next) => {
  const parsed = listReferralsQuerySchema.safeParse(req.query);
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
          select r.id, exists (
            select 1 from gift_card_transactions gct
            where gct.referral_id = r.id
              and gct.recipient_role = 'referrer'
              and gct.status = 'issued'
          ) as paid
          from referrals r
        ) s
      `);

      const { rows } = await client.query(
        `with pipeline as (
           select
             r.id, r.name, r.email, r.phone, r.message,
             r.status as referral_status, r.submitted_at,
             c.id as referrer_id, c.name as referrer_name,
             exists (
               select 1 from gift_card_transactions gct
               where gct.referral_id = r.id
                 and gct.recipient_role = 'referrer'
                 and gct.status = 'issued'
             ) as paid
           from referrals r
           join referral_links rl on rl.id = r.referral_link_id
           join customers c on c.id = rl.customer_id
         )
         select *, count(*) over() as total
         from pipeline
         where (
           $1::text is null
           or lower(name) like $1
           or lower(coalesce(email, '')) like $1
           or lower(coalesce(phone, '')) like $1
           or lower(referrer_name) like $1
         )
         and ($2::text is null or ($2 = 'paid' and paid) or ($2 = 'pending' and not paid))
         order by submitted_at desc
         limit $3 offset $4`,
        [query ? `%${query.toLowerCase()}%` : null, status || null, limit, offset]
      );

      return { rows, counts };
    });

    const total = result.rows[0]?.total ? Number(result.rows[0].total) : 0;

    res.json({
      referrals: result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        phone: r.phone,
        message: r.message,
        submitted_at: r.submitted_at,
        referral_status: r.referral_status,
        status: r.paid ? 'paid' : 'pending',
        referrer: { id: r.referrer_id, name: r.referrer_name },
      })),
      pagination: { limit, offset, total },
      counts: { pending: Number(result.counts.pending), paid: Number(result.counts.paid) },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
