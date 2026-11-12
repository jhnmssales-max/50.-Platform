const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth, requireAuthOrApiKey } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');
const { MAX_KEY_LENGTH, claimKey, completeKey, releaseKey } = require('../lib/idempotency');
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
      // Readable before activation, so a dealer who has not paid yet sees
      // their real dashboard rather than a wall. Nothing can be sent from it
      // -- POST /customers below stays gated, which is where the fee is
      // asked for -- and the list of an unactivated tenant is empty anyway,
      // since the only way to get onto it is a send.
      const ctx = await getCallerContext(client, req.userId, { allowUnactivatedTenant: true });
      if (!ctx) throw forbidden('No staff account found for this user');

      // The invite code comes back with the row so the list can offer Copy
      // link without a request per customer. Same pick as findInviteLink():
      // oldest 'invite' link, because that is the one already in the
      // customer's inbox, and the one a resend sends again. A row from
      // before links were minted on creation has none, and the page offers
      // nothing to copy rather than a dead URL.
      const { rows } = await client.query(
        `select c.id, c.name, c.email, c.phone, c.created_at, c.last_invited_at,
                c.delivery_failed_at, c.unsubscribed_at,
                l.code as invite_code,
                count(*) over() as total
           from customers c
           left join lateral (
             select code from referral_links
              where customer_id = c.id and kind = 'invite'
              order by created_at asc
              limit 1
           ) l on true
          where (
            $1::text is null
            or lower(c.name) like $1
            or lower(c.email) like $1
            or lower(coalesce(c.phone, '')) like $1
          )
          order by coalesce(c.last_invited_at, c.created_at) desc, c.created_at desc
          limit $2 offset $3`,
        [query ? `%${query.toLowerCase()}%` : null, limit, offset]
      );
      return { rows, ctx };
    });

    const { rows: customerRows, ctx } = result;
    const total = customerRows[0]?.total ? Number(customerRows[0].total) : 0;

    res.json({
      customers: customerRows.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        created_at: c.created_at,
        last_invited_at: c.last_invited_at,
        // The customer's own share link, ready to copy. Null for a customer
        // who has no invite link yet; the page hides Copy in that case.
        invite_url: c.invite_code ? buildInviteUrl(c.invite_code, ctx.tenant_domain) : null,
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

router.post('/customers', requireAuthOrApiKey, async (req, res, next) => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  const { name, email, phone } = parsed.data;

  // An automated caller must say which event it is acting on, so a retry is
  // recognisable as the same one. Required rather than optional: a CRM that
  // forgets gets a 400 it will notice on the first call, instead of silently
  // emailing somebody's customers twice a month later. A person pressing Add
  // sends no key and needs none -- they can see what they did.
  let claim = null;
  if (req.apiKeyId) {
    const key = (req.headers['idempotency-key'] || '').trim();
    if (!key) {
      return res.status(400).json({
        error:
          'An Idempotency-Key header is required when calling with an API key. Send the id of the order or deal this is for, so a retry does not invite the same customer twice.',
      });
    }
    if (key.length > MAX_KEY_LENGTH) {
      return res.status(400).json({ error: `Idempotency-Key must be ${MAX_KEY_LENGTH} characters or fewer` });
    }

    const outcome = await claimKey({
      tenantId: req.apiKeyTenantId,
      apiKeyId: req.apiKeyId,
      key,
      endpoint: 'POST /customers',
    });

    // The original finished. Hand back exactly what it answered, so a caller
    // that lost the first response still learns the customer and their link.
    if (outcome.replay) return res.status(outcome.replay.status).json(outcome.replay.body);

    // 409 rather than 429: nothing is rate-limited, an identical request is
    // simply still running. Retrying shortly is the right response, and a
    // CRM that treats 409 as fatal will surface it rather than loop.
    if (outcome.inFlight) {
      return res.status(409).json({
        error: 'A request with this Idempotency-Key is still being processed. Retry in a moment.',
      });
    }
    if (outcome.conflict) {
      return res.status(409).json({
        error: `This Idempotency-Key was already used for ${outcome.conflict}. Use a different key per request.`,
      });
    }
    claim = outcome;
  }

  // Records the answer against the claim before sending it, so every later
  // retry of this key replays it. Nothing after a successful send is allowed
  // to fail the request -- see completeKey.
  const respond = async (status, body) => {
    if (claim) await completeKey(claim.id, status, body);
    res.status(status).json(body);
  };

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

    // An automated caller never resends to somebody already on the list.
    //
    // The idempotency key stops a RETRY of one event from inviting twice. It
    // cannot stop two different events about the same person: a CRM set to
    // fire on both "won" and "delivered" sends two requests with two honest,
    // different keys, and without this the customer gets the invite twice.
    // Stage names vary per dealer and some fire on three, so telling dealers
    // to pick one stage would be a rule somebody breaks quietly.
    //
    // Resending is simply never what a machine means. A person pressing Add
    // on a known address is saying "they can't find their invite, send it
    // again"; a CRM reporting a closed order is saying "make sure they are in
    // the program", and they already are. So this answers 200 with what the
    // caller wanted to know -- the customer and their link -- and sends
    // nothing. A dealer who does want it sent again presses Resend, where a
    // human has decided.
    if (req.apiKeyId && result.reused) {
      responseBody.email = {
        sent: false,
        reason: 'already_invited',
        error: `${result.customer.name || 'This customer'} is already on the list and was invited on ${new Date(result.customer.created_at).toISOString().slice(0, 10)}, so nothing was sent. Use the dealer dashboard to send their link again.`,
      };
      return respond(200, responseBody);
    }

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
      // Through respond(), not res directly: the customer row exists now, so
      // this is a completed request and a retry of the same key must replay
      // it rather than run again.
      return respond(result.reused ? 200 : 201, responseBody);
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

    await respond(result.reused ? 200 : 201, responseBody);
  } catch (err) {
    // The claim is released only here, where the throw means the transaction
    // rolled back and no customer was created and no invite sent -- so the
    // CRM's retry should be allowed through rather than meeting a permanent
    // "still in flight". A failure after the send does not reach this: the
    // email block above catches its own errors and still answers.
    if (claim) await releaseKey(claim.id);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/customers/:id/resend — send this customer their existing invite
// link again.
//
// POST /customers already resends when the address is one it has seen, so
// this could have been a second call to that. It is not, for one reason: that
// route matches on lower(email) and takes the OLDEST row. There is no unique
// index on (tenant_id, email) -- duplicates predating the dedupe check are
// still in the table -- so for a duplicated address the dealer could press
// Resend on the row in front of them and have a different row's link go out.
// Resending from the row's own id cannot pick the wrong person.
//
// Nothing new is minted for somebody who already has a link, so the customer
// receives the same URL they were sent the first time -- which is the point:
// the usual reason to press this is "I can't find your email", and a fresh
// link would strand any copy of the old one they eventually dig up.
//
// Scoped by RLS like everything else here: a customer id belonging to another
// tenant simply isn't visible, so it reads as 404 rather than 403.
// ---------------------------------------------------------------------------
const resendParamsSchema = z.object({
  id: z.string().uuid('That is not a customer id'),
});

router.post('/customers/:id/resend', requireAuth, async (req, res, next) => {
  const parsed = resendParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  const { id } = parsed.data;

  try {
    const result = await withUserTransaction(req.userId, async (client) => {
      const ctx = await getCallerContext(client, req.userId);
      if (!ctx) throw forbidden('No staff account found for this user');

      const { rows: [customer] } = await client.query(
        `select id, name, email, phone, created_at, last_invited_at, unsubscribed_at
           from customers where id = $1`,
        [id]
      );
      if (!customer) {
        const err = new Error('No customer on your list with that id');
        err.status = 404;
        throw err;
      }

      // Their existing link, or one minted now for a row old enough not to
      // have had one. Same helper the Add form uses.
      const { link } = await ensureInviteLink(client, {
        tenantId: ctx.tenant_id,
        customerId: customer.id,
        name: customer.name,
      });

      const unsubscribeToken = await tokenForSending(client, customer.id);

      // last_invited_at is only moved when something is actually going to be
      // sent. Stamping it for an unsubscribed customer would put a "Last
      // sent" date on the row for a send that never happened.
      let touched = customer;
      if (unsubscribeToken) {
        const { rows: [row] } = await client.query(
          `update customers set last_invited_at = now()
            where id = $1
            returning id, name, email, phone, created_at, last_invited_at`,
          [customer.id]
        );
        touched = row || customer;
      }

      return { customer: touched, link, ctx, unsubscribeToken };
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

    // Same refusal, same wording as the Add form: somebody who asked this
    // dealer to stop emailing them is not sent to, however the send started.
    if (!result.unsubscribeToken) {
      responseBody.email = {
        sent: false,
        reason: 'unsubscribed',
        error: `${result.customer.name || 'This customer'} asked to stop receiving referral emails, so nothing was sent. Their link still works if you want to pass it on another way.`,
      };
      return res.status(200).json(responseBody);
    }

    try {
      await sendInviteEmail({
        tenant: result.ctx,
        customerName: result.customer.name,
        customerEmail: result.customer.email,
        inviteUrl,
        unsubscribeToken: result.unsubscribeToken,
        replyToEmail: result.ctx.user_email,
      });
      responseBody.email = { sent: true, resent: true };
      // A send that gets through clears an earlier bounce, so an address the
      // dealer has since corrected stops being flagged on their row.
      await noteDeliveryOutcome(result.customer.id, null);
    } catch (emailErr) {
      responseBody.email = { sent: false, error: emailErr.message };
      await noteDeliveryOutcome(result.customer.id, emailErr);
    }

    res.status(200).json(responseBody);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
