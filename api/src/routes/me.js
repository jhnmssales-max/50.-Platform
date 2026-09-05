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
// dealer page uses this right after sign-in to show "Signed in as ..." and
// to decide whether to let this session mark a referral paid client-side
// (the server still enforces that on PATCH /referrals/:id/status either
// way — this is display only, never a trust boundary).
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
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
