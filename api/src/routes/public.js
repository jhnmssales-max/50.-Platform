const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { nanoid } = require('nanoid');
const { withPublicTransaction } = require('../db');
const { resolveLinkLimiter, createShareLimiter, submitReferralLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// These are meant to be called from a browser on whatever domain the
// tenant's static pages are served from, with no cookies/session
// involved — a public, credential-less API surface, so an open CORS
// policy here is intentional and does not widen what an unauthenticated
// caller can already do over plain HTTP.
router.use(cors());

const UNIQUE_VIOLATION = '23505';
const LINK_NOT_FOUND = 'P0002';
const LINK_ALREADY_USED = 'P0003';

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid code');

function notFound(message = 'Link not found') {
  const err = new Error(message);
  err.status = 404;
  return err;
}

function mapFunctionError(err, notFoundMessage, alreadyUsedMessage) {
  if (err.code === LINK_NOT_FOUND) return notFound(notFoundMessage);
  if (err.code === LINK_ALREADY_USED) {
    const e = new Error(alreadyUsedMessage);
    e.status = 409;
    return e;
  }
  return err;
}

// ---------------------------------------------------------------------------
// GET /api/links/:code — resolves either an invite or a share code for the
// customer page or the lead page to render its greeting. Never returns
// phone/email, and treats an unknown code exactly like an expired one
// (both just 404) so this can't be used to distinguish "never existed"
// from "used up its usefulness."
// ---------------------------------------------------------------------------
router.get('/links/:code', resolveLinkLimiter, async (req, res, next) => {
  const parsedCode = codeSchema.safeParse(req.params.code);
  if (!parsedCode.success) return next(notFound());

  try {
    const row = await withPublicTransaction(async (client) => {
      const { rows } = await client.query('select * from resolve_link($1)', [parsedCode.data]);
      return rows[0];
    });

    if (!row) return next(notFound());

    res.json({
      kind: row.kind,
      status: row.status,
      referrer_first_name: row.referrer_first_name,
      tenant: {
        name: row.tenant_name,
        reward_amount_cents: row.tenant_reward_amount_cents,
        reward_currency: row.tenant_reward_currency,
        branding: row.tenant_branding,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/links/:code/share — the customer taps "share": mint a new
// share-kind link off of whatever link got them here (their original
// invite, or — for a referred friend who's since become a customer
// themselves — their own share link), and hand back the full URL.
// ---------------------------------------------------------------------------
router.post('/links/:code/share', createShareLimiter, async (req, res, next) => {
  const parsedCode = codeSchema.safeParse(req.params.code);
  if (!parsedCode.success) return next(notFound());

  try {
    const link = await withPublicTransaction(async (client) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const newCode = nanoid(10);
        try {
          const { rows } = await client.query('select * from create_share_link($1, $2)', [
            parsedCode.data,
            newCode,
          ]);
          return rows[0];
        } catch (err) {
          if (err.code === UNIQUE_VIOLATION && attempt < 4) continue;
          throw mapFunctionError(err, 'Link not found or no longer active');
        }
      }
      throw new Error('Could not generate a unique code after 5 attempts');
    });

    res.status(201).json({
      code: link.code,
      url: `/50/refer/${link.code}`,
      status: link.status,
      created_at: link.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/links/:code/referrals — the friend's lead form. `:code` must
// be a share-kind link; creates the referral and marks the link used
// atomically (see the submit_referral function) so a double-submit race
// can't create two referrals off one link.
// ---------------------------------------------------------------------------
const submitReferralSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  email: z.string().trim().email('A valid email is required').max(254),
  phone: z.string().trim().max(40).optional().nullable(),
  message: z.string().trim().max(1000).optional().nullable(),
});

router.post('/links/:code/referrals', submitReferralLimiter, async (req, res, next) => {
  const parsedCode = codeSchema.safeParse(req.params.code);
  if (!parsedCode.success) return next(notFound());

  const parsedBody = submitReferralSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsedBody.error.flatten() });
  }
  const { name, email, phone, message } = parsedBody.data;

  try {
    const referral = await withPublicTransaction(async (client) => {
      try {
        const { rows } = await client.query('select * from submit_referral($1, $2, $3, $4, $5)', [
          parsedCode.data,
          name,
          email,
          phone || null,
          message || null,
        ]);
        return rows[0];
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION) {
          const e = new Error('This link has already been used');
          e.status = 409;
          throw e;
        }
        throw mapFunctionError(err, 'Link not found', 'This link has already been used');
      }
    });

    res.status(201).json({ id: referral.id, submitted_at: referral.submitted_at });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
