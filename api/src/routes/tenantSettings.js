const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, getCallerContext } = require('../db');
const { encryptionKey } = require('../lib/tenantCredentials');

const router = express.Router();

router.use(cors());

function forbidden(message) {
  const err = new Error(message);
  err.status = 403;
  return err;
}

async function requireAdminCtx(client, userId) {
  const ctx = await getCallerContext(client, userId);
  if (!ctx) throw forbidden('No staff account found for this user');
  if (!ctx.is_admin) throw forbidden('Admin access required');
  return ctx;
}

// ---------------------------------------------------------------------------
// Per-tenant Tremendous credentials — each dealer company connects its own
// API key, funding source (their own card), and campaign (their own
// branding/reward choice), so a reward is always funded by — and issued
// under — the company whose customer earned it, never a shared platform
// account. campaign_id is required, not optional: Tremendous itself
// rejects an order with neither a campaign nor a products list, confirmed
// against their real sandbox (see src/lib/tremendous.js). The key is
// encrypted at rest (pgcrypto, see the migration) and is write-only from
// here on out: GET never returns it, only whether one is on file.
// Admin-only, since this is a company-wide payment setting, same as
// everything else on the tenants row.
// ---------------------------------------------------------------------------
const setCredentialsSchema = z.object({
  api_key: z.string().trim().min(1, 'A Tremendous API key is required'),
  funding_source_id: z.string().trim().min(1, 'A Tremendous funding source id is required'),
  campaign_id: z.string().trim().min(1, 'A Tremendous campaign id is required'),
});

router.put('/tenant/tremendous-credentials', requireAuth, async (req, res, next) => {
  const parsed = setCredentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  const { api_key, funding_source_id, campaign_id } = parsed.data;

  try {
    const key = encryptionKey(); // fail fast, before opening a transaction

    const result = await withUserTransaction(req.userId, async (client) => {
      const ctx = await requireAdminCtx(client, req.userId);

      const { rows: [row] } = await client.query(
        `update tenants
         set tremendous_api_key_encrypted = pgp_sym_encrypt($1, $2),
             tremendous_funding_source_id = $3,
             tremendous_campaign_id = $4,
             tremendous_connected_at = now()
         where id = $5
         returning tremendous_funding_source_id, tremendous_campaign_id, tremendous_connected_at`,
        [api_key, key, funding_source_id, campaign_id, ctx.tenant_id]
      );
      return row;
    });

    res.json({
      configured: true,
      funding_source_id: result.tremendous_funding_source_id,
      campaign_id: result.tremendous_campaign_id,
      connected_at: result.tremendous_connected_at,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/tenant/tremendous-credentials', requireAuth, async (req, res, next) => {
  try {
    const result = await withUserTransaction(req.userId, async (client) => {
      const ctx = await requireAdminCtx(client, req.userId);

      const { rows: [row] } = await client.query(
        `select
           (tremendous_api_key_encrypted is not null) as configured,
           tremendous_funding_source_id,
           tremendous_campaign_id,
           tremendous_connected_at
         from tenants
         where id = $1`,
        [ctx.tenant_id]
      );
      return row;
    });

    res.json({
      configured: result.configured,
      funding_source_id: result.tremendous_funding_source_id,
      campaign_id: result.tremendous_campaign_id,
      connected_at: result.tremendous_connected_at,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/tenant/tremendous-credentials', requireAuth, async (req, res, next) => {
  try {
    await withUserTransaction(req.userId, async (client) => {
      const ctx = await requireAdminCtx(client, req.userId);

      await client.query(
        `update tenants
         set tremendous_api_key_encrypted = null,
             tremendous_funding_source_id = null,
             tremendous_campaign_id = null,
             tremendous_connected_at = null
         where id = $1`,
        [ctx.tenant_id]
      );
    });

    res.json({ configured: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
