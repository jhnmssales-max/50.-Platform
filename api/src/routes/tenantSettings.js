const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { withUserTransaction, withServiceRole, getCallerContext } = require('../db');
const { encryptionKey } = require('../lib/tenantCredentials');
const supabaseAdmin = require('../lib/supabaseAdmin');
const { mintKey } = require('../lib/apiKeys');
const { nanoid } = require('nanoid');
const tenantCopy = require('../lib/tenantCopy');
const storage = require('../lib/supabaseStorage');

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

// Anyone with a login on this company, admin or not.
//
// Most dealers have one login and it is a salesperson, not an "admin" in any
// sense they would recognise -- the roles exist for 50.'s side of the house,
// not theirs. A settings screen only an admin could open would therefore be a
// settings screen almost no dealer could open, which is the opposite of the
// point. The tenant is still the wall: every query below is scoped to
// ctx.tenant_id, and RLS refuses to reach past it regardless.
async function requireStaffCtx(client, userId) {
  const ctx = await getCallerContext(client, userId);
  if (!ctx) throw forbidden('No staff account found for this user');
  return ctx;
}

// A person on the company, and specifically not the account an API key acts
// as.
//
// Creating a key creates a `users` row for it to be (see the api-keys section
// below), and that row's role is 'staff' -- so opening these routes to staff
// would, on its own, let a key's own identity manage keys and rewrite the
// company's wording. In production it cannot reach here anyway: these routes
// are `requireAuth`, which verifies a Supabase access token, and an
// integration account is created passwordless with no way to sign in, so no
// token for it exists. This is the second lock on that door rather than the
// only one -- a leaked key must not be able to mint a replacement that
// outlives revoking it, and that should not rest on one middleware choice at
// one mount point staying as it is.
//
// `exists` over api_keys, not a column on users: the question is "is this
// account a key's identity", a revoked key still answers yes, and nothing
// has to be kept in sync. RLS confines the lookup to this tenant, which is
// the only tenant whose answer could be yes.
async function requireHumanStaffCtx(client, userId) {
  const ctx = await requireStaffCtx(client, userId);
  const { rows: [row] } = await client.query(
    'select exists(select 1 from api_keys where user_id = $1) as is_integration',
    [userId]
  );
  if (row && row.is_integration) {
    throw forbidden('An API key cannot manage keys or settings. Sign in as a person on the account.');
  }
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
// Any login on the company, on all three. These were admin-only, which read
// as caution but in practice meant nobody: a dealer's single login is created
// as whatever 50. made it, and the person who has to hand a key to their CRM
// installer is the same person who signs in every morning. A key is scoped to
// one endpoint on one tenant and cannot read anything, so the risk it carries
// is adding a customer to a list its holder can already add a customer to.
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
      await requireHumanStaffCtx(client, req.userId);
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
    // Who is asking -- before anything else, including the configuration
    // check below. Somebody with no login on any company gets "no", not a
    // report on whether the platform's service-role key is set: that is
    // operational detail, and the answer to someone who should not be asking
    // must not depend on it.
    const ctx = await withUserTransaction(req.userId, (client) => requireHumanStaffCtx(client, req.userId));

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
      await requireHumanStaffCtx(client, req.userId);
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

// ---------------------------------------------------------------------------
// A company's own look and wording, edited by the company itself.
//
// Both of these already existed for 50.'s side of the house
// (routes/reps.js's /rep-dealers/:tenantId/brand), where a platform admin can
// fix any dealer's logo or rewrite any dealer's sentences. That is the only
// way it could be done, which means every "change 'shed' to 'garage' on my
// invite email" is a message to Joseph and an evening of his time.
//
// These are the same two operations with the tenant taken from the caller
// instead of the URL. There is no :tenantId to pass and no way to name
// another company: ctx.tenant_id is read from the login, so the worst a
// crafted request can do is edit the sender's own wording.
//
// What is deliberately NOT here: the reward amount, anything on the billing
// columns, send-from addresses, reward_fulfillment, and the company's name.
// Those either cost money, affect deliverability, or are what 50. sells --
// they stay where a conversation has to happen first.
// ---------------------------------------------------------------------------
const TENANT_BRAND_COLORS = ['primaryColor', 'primaryDark', 'secondary', 'accentColor', 'accentDark', 'bg', 'taglineColor'];
const tenantHexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'Use a hex color like #C9974B');

// Only a key the platform itself defines can be written, and only within its
// own length limit. A record of arbitrary strings would let a dealer put
// anything of any size into the jsonb every public page reads.
const copyShape = z
  .object(Object.fromEntries(tenantCopy.COPY_FIELDS.map((f) => [f.key, z.string().max(f.max).optional()])))
  .strict();

const tenantBrandBody = z
  .object({
    logoUrl: z
      .union([
        z.string().trim().regex(/^https:\/\/[^\s"'<>]+$/i, 'A logo URL must start with https://'),
        z.string().trim().regex(/^\/[^\s"'<>]*$/, 'A relative logo path must start with /'),
        z.null(),
      ])
      .optional(),
    tagline: z.string().trim().max(80).nullable().optional(),
    ...Object.fromEntries(TENANT_BRAND_COLORS.map((k) => [k, tenantHexColor.nullable().optional()])),
    copy: copyShape.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

router.get('/tenant/brand', requireAuth, async (req, res, next) => {
  try {
    const out = await withUserTransaction(req.userId, async (client) => {
      const ctx = await requireHumanStaffCtx(client, req.userId);
      // Read through the caller's own transaction, so RLS is what decides
      // which tenants row comes back rather than a tenant id in a variable.
      const { rows: [row] } = await client.query(
        'select id, name, slug, branding from tenants where id = $1',
        [ctx.tenant_id]
      );
      return row;
    });
    if (!out) throw forbidden('No company found for this login');

    // The field list travels with the values, so the page renders whatever
    // the platform currently defines instead of carrying its own copy of a
    // list that drifts every time a key is added. `generic` is what runs when
    // a box is left empty -- shown as the placeholder, so an empty box reads
    // as "this is what your customers get" rather than as missing.
    res.json({
      ...out,
      copy_fields: tenantCopy.COPY_FIELDS.map((f) => ({
        key: f.key,
        label: f.label,
        where: f.where,
        stage: f.stage,
        max: f.max,
        multiline: !!f.multiline,
        generic: tenantCopy.GENERIC_COPY[f.key] || '',
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/tenant/brand', requireAuth, async (req, res, next) => {
  const parsed = tenantBrandBody.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  const body = parsed.data;

  try {
    // Who is asking, under their own transaction and their own RLS -- then the
    // write itself as the service role.
    //
    // `authenticated` has no UPDATE on tenants.branding on purpose: the
    // activation-gate migration revoked table-wide UPDATE and granted back
    // only the handful of columns the API writes as the signed-in user,
    // because PostgREST accepts the same login token this page holds and a
    // table-wide grant would let a dealer PATCH their own billing columns
    // directly. Granting branding back would also reach only admins
    // (tenants_update_own_admin), and the whole point here is the
    // salesperson. So the tenant id is resolved from the login first and the
    // service role writes one column on that one row -- the same shape
    // routes/reps.js already uses, with nothing taken from the request but
    // the values being saved.
    const ctx = await withUserTransaction(req.userId, (client) => requireHumanStaffCtx(client, req.userId));

    const out = await withServiceRole(async (client) => {
      const { rows: [t] } = await client.query('select branding from tenants where id = $1', [ctx.tenant_id]);
      if (!t) throw forbidden('No company found for this login');

      // Merged, not replaced, and one level down for `copy` as well: saving
      // the wording step somebody just edited must not clear the colors, and
      // saving one sentence must not clear the other thirty-five. An explicit
      // null deletes a key, which is how a wrong value gets cleared rather
      // than only overwritten -- and for a copy key, clearing it is what puts
      // the platform's own generic wording back.
      const next = { ...(t.branding || {}) };
      for (const [key, value] of Object.entries(body)) {
        if (key === 'copy') {
          const merged = { ...(next.copy || {}) };
          for (const [ck, cv] of Object.entries(value)) {
            if (cv === '') delete merged[ck];
            else merged[ck] = cv;
          }
          next.copy = merged;
          continue;
        }
        if (value === null) delete next[key];
        else next[key] = value;
      }

      const { rows: [row] } = await client.query(
        'update tenants set branding = $2 where id = $1 returning id, name, branding',
        [ctx.tenant_id, JSON.stringify(next)]
      );
      return row;
    });

    console.log(`TENANT BRAND: ${out.name} (${out.id}) updated by ${req.userId} — ${Object.keys(body).join(', ')}`);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// The logo file itself, uploaded by the company. Same raw-body approach as
// the rep-side upload in routes/reps.js, and the same bucket; the difference
// is that the tenant comes from the login rather than the URL.
const tenantUploadBody = express.raw({ type: () => true, limit: storage.MAX_BYTES + 1024 });

router.post('/tenant/logo', requireAuth, tenantUploadBody, async (req, res, next) => {
  try {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();

    if (!storage.isConfigured()) {
      return res.status(503).json({
        error: 'This platform cannot store files yet: SUPABASE_SERVICE_ROLE_KEY is not set on the API service.',
        code: 'uploads_not_configured',
      });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'There was nothing in that file' });
    }
    if (!storage.extensionFor(contentType) || contentType === 'application/pdf') {
      return res.status(400).json({ error: 'A logo has to be a PNG, JPG, WEBP, GIF or SVG image' });
    }

    // Who this is, before anything is stored: a refusal afterwards would
    // leave a file in the bucket that nothing points at.
    const ctx = await withUserTransaction(req.userId, (client) => requireHumanStaffCtx(client, req.userId));

    const stored = await storage.upload({ tenantId: ctx.tenant_id, bytes: req.body, contentType });

    try {
      const out = await withServiceRole(async (client) => {
        const { rows: [row] } = await client.query(
          `update tenants
              set branding = coalesce(branding, '{}'::jsonb) || jsonb_build_object('logoUrl', $2::text)
            where id = $1
            returning id, name, branding`,
          [ctx.tenant_id, stored.publicUrl]
        );
        return row;
      });
      res.status(201).json(out);
    } catch (err) {
      // A stored file the branding does not point at is litter nobody finds.
      await storage.remove(stored.storagePath);
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
