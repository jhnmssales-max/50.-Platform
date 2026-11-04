const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');
const { buildInviteUrl, ensureInviteLink, sendInviteEmail } = require('../lib/customerInvite');
const { noteDeliveryOutcome } = require('../lib/deliveryOutcome');
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
// GET /api/customers — everyone this dealer has already sent a referral link
// to, newest send first, searchable by name, email or phone.
//
// Joseph: "so they can see or search who they have already sent to, but do
// not keep a visual number of invites sent or received on the page. They will
// get that info on their monthly summary."
//
// So this deliberately returns NO counts object, unlike GET /referrals. The
// page has nothing to render a tally from even if a later change wanted one;
// the monthly activity email is where the numbers live. `total` is in the
// pagination block because Load more has to know when to stop asking, not
// because anything shows it.
//
// Scoped by RLS, not by a tenant_id in the WHERE clause -- same as
// GET /referrals. customers_select_same_tenant already limits this to the
// caller's own tenant, and a second filter here would be a copy of that rule
// that could drift away from it.
//
// Includes customers who were auto-created from a converted referral or from
// an activated dealer, not just ones a dealer typed in: those people were all
// sent a link too, so "who have we sent to" has to count them or the answer
// is wrong in exactly the case the dealer is checking.
// ---------------------------------------------------------------------------
const listCustomersQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

router.get('/customers', requireAuth, async (req, res, next) => {
  const parsed = listCustomersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
  }
  const { query, limit, offset } = parsed.data;

  try {
    const result = await withUserTransaction(req.userId, async (client) => {
      const ctx = await getCallerContext(client, req.userId);
      if (!ctx) throw forbidden('No staff account found for this user');

      const { rows } = await client.query(
        `select id, name, email, phone, created_at, last_invited_at,
                delivery_failed_at, unsubscribed_at,
                count(*) over() as total
           from customers
          where (
            $1::text is null
            or lower(name) like $1
            or lower(email) like $1
            or lower(coalesce(phone, '')) like $1
          )
          order by coalesce(last_invited_at, created_at) desc, created_at desc
          limit $2 offset $3`,
        [query ? `%${query.toLowerCase()}%` : null, limit, offset]
      );
      return rows;
    });

    const total = result[0]?.total ? Number(result[0].total) : 0;

    res.json({
      customers: result.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        created_at: c.created_at,
        last_invited_at: c.last_invited_at,
        // Two reasons a send stops arriving. Both are worth seeing on the row
        // rather than once a month in the summary: a bounced address is the
        // dealer's to correct, and an unsubscribe is theirs to respect.
        delivery_failed_at: c.delivery_failed_at,
        unsubscribed_at: c.unsubscribed_at,
      })),
      pagination: { limit, offset, total },
    });
  } catch (err) {
    next(err);
  }
});

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

      // Somebody already on this dealer's list gets their OWN link sent
      // again rather than a second record. Adding an address twice is
      // almost always a customer saying they cannot find their invite, and
      // the answer to that is the link they already have -- a new row would
      // mint a second link, so the one they eventually share would not be
      // the one the dealer is looking at.
      //
      // Matched on lower(email) because Info@ and info@ are one inbox
      // everywhere except a case-sensitive comparison. There is no unique
      // index backing this yet (duplicates already in the table would stop
      // one being created), so this is the check, not a safety net over one.
      const { rows: [existing] } = await client.query(
        `select id, name, email, phone, created_at from customers
          where tenant_id = $1 and lower(email) = lower($2)
          order by created_at asc
          limit 1`,
        [ctx.tenant_id, email]
      );

      let customer = existing;
      if (!customer) {
        const { rows: [created] } = await client.query(
          `insert into customers (tenant_id, name, email, phone, created_by_user_id, last_invited_at)
           values ($1, $2, $3, $4, $5, now())
           returning id, name, email, phone, created_at, last_invited_at`,
          [ctx.tenant_id, name, email, phone || null, req.userId]
        );
        customer = created;
      } else {
        // A resend is the case the dealer's list most needs recorded: the row
        // already exists, created_at still says March, and without this the
        // page would show a date from before the send that just happened.
        const { rows: [touched] } = await client.query(
          `update customers set last_invited_at = now()
            where id = $1
            returning id, name, email, phone, created_at, last_invited_at`,
          [customer.id]
        );
        customer = touched || customer;
      }

      // Their existing link if they have one. A customer who somehow has
      // none -- a row from before links were minted on creation -- gets one
      // now rather than an error.
      const { link } = await ensureInviteLink(client, {
        tenantId: ctx.tenant_id,
        customerId: customer.id,
        name: customer.name || name,
      });

      // Minted inside the same transaction as the customer, so the invite
      // below always has one. A brand-new customer cannot be unsubscribed,
      // but this goes through the same helper as every other send rather
      // than assuming that stays true.
      const unsubscribeToken = await tokenForSending(client, customer.id);

      return { customer, link, ctx, unsubscribeToken, reused: Boolean(existing) };
    });

    const inviteUrl = buildInviteUrl(result.link.code, result.ctx.tenant_domain);

    const responseBody = {
      // `reused` is the difference between "added" and "resent", which the
      // dealer needs told: pressing Add and seeing "Customer added" for
      // somebody already on their list is how you end up believing you have
      // two customers.
      reused: result.reused,
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
    // Somebody who asked this dealer to stop emailing them is not resent to,
    // however they got here. tokenForSending returns null for them, and
    // sendInviteEmail would refuse anyway -- but refusing here means the
    // dealer is told why rather than shown a send failure.
    if (!result.unsubscribeToken) {
      responseBody.email = {
        sent: false,
        reason: 'unsubscribed',
        error: `${result.customer.name || 'This customer'} asked to stop receiving referral emails, so nothing was sent. Their link still works if you want to pass it on another way.`,
      };
      return res.status(result.reused ? 200 : 201).json(responseBody);
    }

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

      responseBody.email = { sent: true, resent: result.reused };
      await noteDeliveryOutcome(result.customer.id, null);
    } catch (emailErr) {
      responseBody.email = { sent: false, error: emailErr.message };
      // Kept on the customer, so the dealer's monthly summary can say which
      // addresses are not reaching anyone.
      await noteDeliveryOutcome(result.customer.id, emailErr);
    }

    res.status(result.reused ? 200 : 201).json(responseBody);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
