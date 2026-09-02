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

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

// A referral counts as "paid" once either signal says so: a gift card was
// actually issued (gift_card_transactions — not wired up yet, since the
// Amazon Incentives integration doesn't exist), or an admin has manually
// marked it rewarded via PATCH .../status below. Once the payout job is
// real, it will set referrals.status = 'rewarded' too as part of issuing
// the cards, so this stays a superset rather than needing to change again.
const PAID_EXPR = `(
  r.status = 'rewarded'
  or exists (
    select 1 from gift_card_transactions gct
    where gct.referral_id = r.id
      and gct.recipient_role = 'referrer'
      and gct.status = 'issued'
  )
)`;

// ---------------------------------------------------------------------------
// GET /api/referrals — the dealer's searchable pipeline of friend
// submissions, one row per referrals row. A single customer can hold
// several share links and so generate several referrals, each of which
// gets paid out (or not) independently — so status lives per referral,
// not aggregated up to the customer.
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
          select r.id, ${PAID_EXPR} as paid
          from referrals r
        ) s
      `);

      const { rows } = await client.query(
        `with pipeline as (
           select
             r.id, r.name, r.email, r.phone, r.message,
             r.status as referral_status, r.submitted_at,
             c.id as referrer_id, c.name as referrer_name,
             ${PAID_EXPR} as paid
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

// ---------------------------------------------------------------------------
// PATCH /api/referrals/:id/status — admin-only manual status override. This
// is what backs the dealer page's "mark as paid" toggle today: setting
// status to 'rewarded' is what the (not-yet-built) Amazon Incentives payout
// job will eventually do automatically once an order comes in, so this is
// the same transition, just triggered by a human instead of a webhook.
//
// Server-authoritative: the caller sends only a target status, never an
// amount or a "did it work" flag — nothing about the transition is taken
// on the client's word. Idempotent and race-safe: a genuine double-click
// (or two admins clicking at once) can't apply the transition, or the
// audit log entry for it, twice — see the guarded UPDATE below. No gift
// card is issued here; that's explicitly deferred until the Amazon
// integration exists.
// ---------------------------------------------------------------------------
const referralIdSchema = z.string().uuid();
const patchStatusSchema = z.object({
  status: z.enum(['contacted', 'ordered', 'rewarded', 'declined']),
});

router.patch('/referrals/:id/status', requireAuth, async (req, res, next) => {
  const parsedId = referralIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(400).json({ error: 'Invalid referral id' });
  }
  const parsedBody = patchStatusSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsedBody.error.flatten() });
  }
  const referralId = parsedId.data;
  const targetStatus = parsedBody.data.status;

  try {
    const result = await withUserTransaction(req.userId, async (client) => {
      const ctx = await getCallerContext(client, req.userId);
      if (!ctx) throw forbidden('No staff account found for this user');

      // Visible to any staff member in the tenant (referrals_select_same_tenant),
      // so a 0-row result here means "doesn't exist or isn't yours" — never
      // "you're not an admin". That distinction is checked explicitly next,
      // so the error message is honest either way.
      const { rows: [current] } = await client.query(
        'select id, status from referrals where id = $1',
        [referralId]
      );
      if (!current) throw notFound('Referral not found');

      if (!ctx.is_admin) throw forbidden('Admin access required to change a referral\'s status');

      if (current.status === targetStatus) {
        // Idempotent no-op: already at the requested status — most likely a
        // double-click or a retry. Report success without touching the
        // audit log again.
        return { status: current.status, changed: false };
      }

      // The WHERE clause (not just the earlier SELECT) is what makes this
      // safe under real concurrency: two simultaneous requests serialize on
      // Postgres's row lock, and whichever runs second re-evaluates "status
      // is distinct from $1" against the already-updated row and affects 0
      // rows — so the transition, and the audit log entry for it, only
      // ever happens once no matter how the double-click lands.
      const { rows: [updated] } = await client.query(
        `update referrals
         set status = $1,
             ordered_at = case when $1 = 'ordered' and ordered_at is null then now() else ordered_at end,
             rewarded_at = case when $1 = 'rewarded' and rewarded_at is null then now() else rewarded_at end
         where id = $2 and status is distinct from $1
         returning id, status, tenant_id`,
        [targetStatus, referralId]
      );

      if (!updated) {
        // Lost the race to a concurrent identical update — re-read and
        // report the same idempotent-success shape as the no-op path above.
        const { rows: [now] } = await client.query('select status from referrals where id = $1', [referralId]);
        return { status: now.status, changed: false };
      }

      await client.query(
        `insert into audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
         values ($1, $2, 'referral.status_changed', 'referrals', $3, $4::jsonb)`,
        [updated.tenant_id, req.userId, updated.id, JSON.stringify({ from: current.status, to: updated.status })]
      );

      return { status: updated.status, changed: true };
    });

    res.json({ id: referralId, status: result.status });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
