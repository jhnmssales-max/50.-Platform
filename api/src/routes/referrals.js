const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');
const { createOrder } = require('../lib/tremendous');
const { encryptionKey } = require('../lib/tenantCredentials');

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

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

async function requireAdminCtx(client, userId) {
  const ctx = await getCallerContext(client, userId);
  if (!ctx) throw forbidden('No staff account found for this user');
  if (!ctx.is_admin) throw forbidden('Admin access required');
  return ctx;
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
// PATCH /api/referrals/:id/status — admin-only manual status override, and
// (as of this tenant-Tremendous integration) the trigger for actually
// issuing the reward: transitioning to 'rewarded' attempts a real
// Tremendous order, funded by the tenant's own connected funding source —
// never a shared platform account — if one is on file. A tenant with no
// Tremendous credentials configured behaves exactly as before: the status
// still flips, no reward is attempted.
//
// Server-authoritative: the caller sends only a target status, never an
// amount or a "did it work" flag — nothing about the transition, or the
// reward, is taken on the client's word. Idempotent and race-safe: a
// genuine double-click (or two admins clicking at once) can't apply the
// status transition, its audit log entry, or a reward, twice — see the
// guarded UPDATE below for the status, and the claimed-before-calling
// gift_card_transactions insert below for the reward.
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
    const { transition, rewardClaim } = await withUserTransaction(req.userId, async (client) => {
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

      // 'closed' has its own dedicated endpoints (POST .../close and
      // .../reopen below) precisely so status and closed_at/
      // reward_eligible_at can never disagree — this endpoint refuses to
      // touch a closed referral at all rather than risk flipping status
      // out of 'closed' while leaving closed_at (and the 7-day hold it
      // started) stale. 'closed' was never a valid *target* here either
      // (see patchStatusSchema below) — this only needs to guard the
      // *current* status.
      if (current.status === 'closed') {
        throw conflict("This referral is closed — use POST /api/referrals/:id/reopen, not this endpoint.");
      }

      let transition;
      if (current.status === targetStatus) {
        // Idempotent no-op: already at the requested status — most likely a
        // double-click or a retry. Report success without touching the
        // audit log again.
        transition = { status: current.status, changed: false };
      } else {
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
          transition = { status: now.status, changed: false };
        } else {
          await client.query(
            `insert into audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
             values ($1, $2, 'referral.status_changed', 'referrals', $3, $4::jsonb)`,
            [updated.tenant_id, req.userId, updated.id, JSON.stringify({ from: current.status, to: updated.status })]
          );
          transition = { status: updated.status, changed: true };
        }
      }

      // Whether or not *this* request is what flipped the status (an admin
      // could double-click, or two admins could click at once), a reward is
      // attempted at most once per referral, ever: claim the idempotency
      // slot with a 'pending' row before deciding whether to call
      // Tremendous. The unique constraint on idempotency_key means only
      // one concurrent request can ever win that insert — Postgres itself
      // is what prevents two simultaneous requests from both issuing a
      // reward, not application logic.
      let rewardClaim = null;
      if (targetStatus === 'rewarded' && transition.status === 'rewarded') {
        const { rows: [payout] } = await client.query(
          `select
             c.id as recipient_customer_id, c.name as recipient_name, c.email as recipient_email,
             t.tremendous_funding_source_id as funding_source_id,
             t.tremendous_campaign_id as campaign_id,
             case when t.tremendous_api_key_encrypted is not null
                  then pgp_sym_decrypt(t.tremendous_api_key_encrypted, $1)
             end as api_key
           from referrals r
           join referral_links rl on rl.id = r.referral_link_id
           join customers c on c.id = rl.customer_id
           join tenants t on t.id = r.tenant_id
           where r.id = $2`,
          [encryptionKeySafe(), referralId]
        );

        if (payout && payout.funding_source_id && payout.campaign_id && payout.api_key) {
          const idempotencyKey = `${referralId}:referrer`;
          const { rows: [claimed] } = await client.query(
            `insert into gift_card_transactions
               (tenant_id, referral_id, recipient_customer_id, recipient_role, amount_cents, currency, provider, status, idempotency_key)
             values ($1, $2, $3, 'referrer', $4, $5, 'tremendous', 'pending', $6)
             on conflict (idempotency_key) do nothing
             returning id`,
            [ctx.tenant_id, referralId, payout.recipient_customer_id, ctx.reward_amount_cents, ctx.reward_currency, idempotencyKey]
          );

          if (claimed) {
            rewardClaim = {
              transactionId: claimed.id,
              apiKey: payout.api_key,
              fundingSourceId: payout.funding_source_id,
              campaignId: payout.campaign_id,
              amountCents: ctx.reward_amount_cents,
              currency: ctx.reward_currency,
              recipientName: payout.recipient_name,
              recipientEmail: payout.recipient_email,
              idempotencyKey,
            };
          }
        }
      }

      return { transition, rewardClaim };
    });

    const responseBody = { id: referralId, status: transition.status };

    // The Tremendous call itself happens outside the transaction above —
    // never hold a database transaction open across a slow external HTTP
    // call. The 'pending' row already committed is what makes this safe to
    // retry-or-not: whatever happens next (success, failure, or this
    // process dying mid-call) is recorded below, but no other request can
    // ever attempt this same referral's reward again regardless.
    if (rewardClaim) {
      try {
        const order = await createOrder({
          apiKey: rewardClaim.apiKey,
          fundingSourceId: rewardClaim.fundingSourceId,
          campaignId: rewardClaim.campaignId,
          amountCents: rewardClaim.amountCents,
          currency: rewardClaim.currency,
          recipientName: rewardClaim.recipientName,
          recipientEmail: rewardClaim.recipientEmail,
          idempotencyKey: rewardClaim.idempotencyKey,
        });
        await withUserTransaction(req.userId, (client) =>
          client.query(
            `update gift_card_transactions set status = 'issued', provider_transaction_id = $1, issued_at = now() where id = $2`,
            [order.orderId, rewardClaim.transactionId]
          )
        );
        responseBody.reward = { issued: true };
      } catch (err) {
        await withUserTransaction(req.userId, (client) =>
          client.query(`update gift_card_transactions set status = 'failed' where id = $1`, [rewardClaim.transactionId])
        ).catch(() => {}); // best-effort — the referral's own status change already succeeded either way
        responseBody.reward = { issued: false, error: err.message };
      }
    }

    res.json(responseBody);
  } catch (err) {
    next(err);
  }
});

// Reads TENANT_CREDENTIALS_ENCRYPTION_KEY lazily and only as a query
// parameter value (never interpolated into SQL text), same discipline as
// every other parameterized query in this file — but tolerates it being
// unset (returns a value that will never match a real encrypted key)
// rather than failing the whole status-change request for a tenant that
// was never going to have Tremendous credentials to decrypt anyway.
function encryptionKeySafe() {
  try {
    return encryptionKey();
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/referrals/:id/close — starts the 7-day reward hold.
// Admin-only, same gate as PATCH .../status, since this also sets money
// in motion. Idempotent: closing an already-closed referral is a no-op,
// not an error — a double-click or a client retry must not fail.
// Rejects a 'declined' or already-'rewarded' referral (closing either
// doesn't mean anything) and rejects outright if the tenant's own
// billing_status isn't 'active' — no point starting a hold toward a
// reward this tenant currently can't be charged for.
// ---------------------------------------------------------------------------
router.post('/referrals/:id/close', requireAuth, async (req, res, next) => {
  const parsedId = referralIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(400).json({ error: 'Invalid referral id' });
  }
  const referralId = parsedId.data;

  try {
    const result = await withUserTransaction(req.userId, async (client) => {
      const ctx = await requireAdminCtx(client, req.userId);

      const { rows: [current] } = await client.query(
        'select id, status, closed_at, reward_eligible_at from referrals where id = $1',
        [referralId]
      );
      if (!current) throw notFound('Referral not found');

      if (current.status === 'closed') {
        // Idempotent no-op — already closed. No new audit row: nothing
        // actually happened on this call.
        return { ...current, changed: false };
      }

      if (current.status === 'declined' || current.status === 'rewarded') {
        throw conflict(`Cannot close a referral with status '${current.status}'`);
      }

      if (ctx.billing_status !== 'active') {
        throw conflict('Billing is not active for this tenant');
      }

      // The WHERE clause (not just the SELECT above) is the real guard
      // against a double-close race, same pattern as PATCH .../status:
      // whichever concurrent request loses the race affects 0 rows and
      // falls into the re-read branch below instead of writing a second
      // audit_log row.
      const { rows: [updated] } = await client.query(
        `update referrals
         set status = 'closed', closed_at = now()
         where id = $1 and status is distinct from 'closed'
         returning id, status, closed_at, reward_eligible_at, tenant_id`,
        [referralId]
      );

      if (!updated) {
        const { rows: [now] } = await client.query(
          'select id, status, closed_at, reward_eligible_at from referrals where id = $1',
          [referralId]
        );
        return { ...now, changed: false };
      }

      await client.query(
        `insert into audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
         values ($1, $2, 'referral.closed', 'referrals', $3, $4::jsonb)`,
        [updated.tenant_id, req.userId, updated.id, JSON.stringify({ from: current.status, to: 'closed' })]
      );

      return { ...updated, changed: true };
    });

    res.json({
      id: result.id,
      status: result.status,
      closed_at: result.closed_at,
      reward_eligible_at: result.reward_eligible_at,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/referrals/:id/reopen — undoes a close, but only while
// there's genuinely something to undo. Same admin-only gate. Two hard
// requirements, both enforced in the guarded UPDATE's WHERE clause (not
// just an earlier SELECT), since either can become false at any moment
// out from under this request — the reward-issuance worker (Stage 4)
// runs on its own schedule, not this request's:
//   - reward_issued_at must still be null — once a card is out, this is
//     permanently rejected, full stop.
//   - now() must still be before reward_eligible_at — once the 7-day
//     hold has run out, the referral is no longer "provisionally"
//     closed, it's actually eligible, whether or not the worker has
//     gotten to it yet.
// Reverts status to whatever it was immediately before closing, read
// back from that close action's own audit_log row (metadata.from) —
// not a separate stored column, so there's exactly one place that fact
// is recorded.
// ---------------------------------------------------------------------------
router.post('/referrals/:id/reopen', requireAuth, async (req, res, next) => {
  const parsedId = referralIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(400).json({ error: 'Invalid referral id' });
  }
  const referralId = parsedId.data;

  try {
    const result = await withUserTransaction(req.userId, async (client) => {
      await requireAdminCtx(client, req.userId);

      const { rows: [current] } = await client.query(
        'select id, status, reward_issued_at from referrals where id = $1',
        [referralId]
      );
      if (!current) throw notFound('Referral not found');

      if (current.reward_issued_at) {
        throw conflict('Cannot reopen — the reward has already been issued');
      }

      if (current.status !== 'closed') {
        throw conflict('Referral is not currently closed');
      }

      const { rows: [closedEvent] } = await client.query(
        `select metadata->>'from' as previous_status
         from audit_log
         where entity_type = 'referrals' and entity_id = $1 and action = 'referral.closed'
         order by created_at desc
         limit 1`,
        [referralId]
      );
      if (!closedEvent || !closedEvent.previous_status) {
        // Shouldn't happen — every close goes through POST .../close,
        // which always writes this row on the transition that actually
        // closed the referral. Surfaced as a 500 (not a 409) since this
        // means the data itself is in a state this code doesn't expect,
        // not that the caller did anything wrong.
        throw new Error(`Referral ${referralId} is closed but has no referral.closed audit_log row to revert from`);
      }
      const previousStatus = closedEvent.previous_status;

      // Clearing closed_at here also clears reward_eligible_at
      // automatically (the trigger from the billing-schema migration
      // recomputes it as closed_at + 7 days, and null + any interval is
      // null) — no separate SET needed for it.
      const { rows: [updated] } = await client.query(
        `update referrals
         set status = $1, closed_at = null
         where id = $2
           and status = 'closed'
           and reward_issued_at is null
           and reward_eligible_at > now()
         returning id, status, tenant_id`,
        [previousStatus, referralId]
      );

      if (!updated) {
        throw conflict('Cannot reopen — the hold has ended or the reward has already been issued');
      }

      await client.query(
        `insert into audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
         values ($1, $2, 'referral.reopened', 'referrals', $3, $4::jsonb)`,
        [updated.tenant_id, req.userId, updated.id, JSON.stringify({ from: 'closed', to: previousStatus })]
      );

      return updated;
    });

    res.json({ id: result.id, status: result.status, closed_at: null, reward_eligible_at: null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
