const express = require('express');
const cors = require('cors');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');

const router = express.Router();

router.use(cors());

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

// ---------------------------------------------------------------------------
// GET /api/me — who the caller is, once a real Supabase Auth session exists
// instead of a pasted access token: their name, role, and tenant. The
// staff page uses this right after sign-in to show "Signed in as ..." and
// to decide whether to let this session mark a referral paid client-side
// (the server still enforces that on PATCH /referrals/:id/status either
// way — this is display only, never a trust boundary).
//
// `billing` expresses pricing per card, not as one undifferentiated
// per-referral total: cards_per_referral is always 2 (one for the
// referrer, one for the new customer — see per_referral_charge_cents'
// own comment in the billing-schema migration), so a staff member sees
// "2 cards x $99.50 = $199.00" rather than a single $199 figure with no
// visible breakdown. Only these three named fields, same discipline as
// every other route touching ctx — stripe_customer_id,
// stripe_payment_method_id, and billing_status never appear here or
// anywhere else a staff-facing response is built from ctx.
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await withUserTransaction(req.userId, async (client) => {
      const ctx = await getCallerContext(client, req.userId);
      if (!ctx) throw forbidden('No staff account found for this user');

      const { rows: [me] } = await client.query(
        'select name, email, role from users where id = $1',
        [req.userId]
      );

      return { me, ctx };
    });

    res.json({
      name: result.me.name,
      email: result.me.email,
      role: result.me.role,
      tenant_name: result.ctx.tenant_name,
      // {primaryColor, primaryDark, secondary, accentColor, accentDark, bg,
      // logoUrl}, every key optional — see the tenant_branding_shape
      // migration's own comment. fifty-template-dealer.html (the one
      // consumer today) falls back to its own neutral defaults for any
      // key a tenant hasn't set, including when this is the column's
      // untouched default ('{}').
      tenant_branding: result.ctx.tenant_branding,
      billing: {
        per_card_rate_cents: result.ctx.per_card_rate_cents,
        cards_per_referral: 2,
        per_referral_charge_cents: result.ctx.per_referral_charge_cents,
        currency: result.ctx.reward_currency,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
