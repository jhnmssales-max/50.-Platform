const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, withServiceRole, getCallerContext } = require('../db');
const { encryptionKey } = require('../lib/tenantCredentials');
const supabaseAdmin = require('../lib/supabaseAdmin');
const { mintKey } = require('../lib/apiKeys');
const { nanoid } = require('nanoid');

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
// Per-tenant Tremendous credentials — each tenant connects its own
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

// ---------------------------------------------------------------------------
// API keys — what a dealer's CRM authenticates with.
//
// Admin only, on all three. A key can add a customer to this company's list
// and send that customer an email over the company's name, which is not
// something any staff member should be able to hand out.
//
// Creating one makes a staff account for it to act as, rather than borrowing
// the admin's: see the migration. That account is a real users row with a
// real auth.users behind it (createPasswordlessUser, as reps already do), so
// nothing downstream has to know that this particular "person" is a CRM. It
// has no password and no way to be signed into -- the only thing that can
// act as it is a key, and revoking every key leaves it inert.
// ---------------------------------------------------------------------------
const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name the key so you can tell it apart later').max(80),
});

router.get('/tenant/api-keys', requireAuth, async (req, res, next) => {
  try {
    const keys = await withUserTransaction(req.userId, async (client) => {
      await requireAdminCtx(client, req.userId);
      // key_hash is deliberately not selected -- nothing signed in ever needs
      // it, and the RLS policy exists so this route cannot reach past its own
      // tenant even if this query were wrong.
      const { rows } = await client.query(
        `select id, name, key_prefix, created_at, last_used_at, revoked_at
           from api_keys
          where revoked_at is null
          order by created_at desc`
      );
      return rows;
    });
    res.json({ api_keys: keys });
  } catch (err) {
    next(err);
  }
});

router.post('/tenant/api-keys', requireAuth, async (req, res, next) => {
  const parsed = createApiKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  const { name } = parsed.data;

  try {
    // Who is asking, and whether they may -- before anything else, including
    // the configuration check below. A staff member who is not an admin gets
    // "no", not a report on whether the platform's service-role key is set:
    // that is operational detail, and the answer to someone who should not be
    // asking must not depend on it.
    const ctx = await withUserTransaction(req.userId, (client) => requireAdminCtx(client, req.userId));

    if (!supabaseAdmin.isConfigured()) {
      return res.status(503).json({
        error:
          'This platform cannot create the account an API key acts as yet, because SUPABASE_SERVICE_ROLE_KEY is not set on the API service.',
      });
    }

    // The integration's own address. Never deliverable and never typed by
    // anyone: it exists because users.email is unique and not null, and it
    // carries the tenant and a random part so two keys on two dealers (or
    // two keys on one) cannot collide.
    const integrationEmail = `integration+${ctx.tenant_id}.${nanoid(10).toLowerCase()}@integrations.referwith50.com`;

    let authUserId;
    try {
      ({ userId: authUserId } = await supabaseAdmin.createPasswordlessUser(integrationEmail));
    } catch (authErr) {
      return res.status(502).json({ error: `Could not create the integration account: ${authErr.message}` });
    }

    const { key, keyHash, keyPrefix } = mintKey();

    // Creating the pair runs as the service role, not as the admin asking:
    // `authenticated` has no insert on users (see rls_policies.sql) or on
    // api_keys, exactly as rep and dealer-admin creation already works. Who is
    // allowed to do this was settled above, by RLS, before anything existed --
    // this transaction performs it, it does not authorize it.
    //
    // Both inserts in one transaction, so a key can never exist pointing at a
    // users row that was not written, or a users row be left behind with no
    // key naming it.
    const created = await withServiceRole(async (client) => {
      // 'staff', not 'admin': adding a customer needs no more than that, and
      // a leaked key must not reach billing or logins.
      await client.query(
        `insert into users (id, tenant_id, name, email, role)
         values ($1, $2, $3, $4, 'staff')`,
        [authUserId, ctx.tenant_id, name, integrationEmail]
      );

      const { rows: [row] } = await client.query(
        `insert into api_keys (tenant_id, user_id, name, key_prefix, key_hash, created_by)
         values ($1, $2, $3, $4, $5, $6)
         returning id, name, key_prefix, created_at`,
        [ctx.tenant_id, authUserId, name, keyPrefix, keyHash, req.userId]
      );
      return row;
    });

    // The only time the key is ever readable. Said plainly in the response so
    // whoever is building the integration knows not to close the dialog.
    res.status(201).json({
      api_key: created,
      key,
      notice: 'Copy this key now — it is not stored and cannot be shown again. If it is lost, revoke it and create another.',
    });
  } catch (err) {
    next(err);
  }
});

// Revoke. An update, not a delete: a key that has been used stays in the
// table so there is a record of what existed, and api_keys has no delete
// policy at all. The integration's users row is left in place -- removing it
// would break the foreign key from this very row, and an account nothing can
// authenticate as is already inert.
router.delete('/tenant/api-keys/:id', requireAuth, async (req, res, next) => {
  const parsed = z.string().uuid('That is not an API key id').safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

  try {
    const revoked = await withUserTransaction(req.userId, async (client) => {
      await requireAdminCtx(client, req.userId);
      const { rows: [row] } = await client.query(
        `update api_keys set revoked_at = now()
          where id = $1 and revoked_at is null
          returning id, name`,
        [parsed.data]
      );
      return row;
    });

    // Already revoked reads the same as never existed, which is the right
    // answer to "make sure this key cannot be used".
    if (!revoked) return res.status(404).json({ error: 'No live API key with that id' });
    res.json({ revoked });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
