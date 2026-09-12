const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — see .env.example');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Runs `fn` inside a transaction where the Postgres session is impersonating
// the given (already JWT-verified) user: `role` is switched to
// `authenticated` and `auth.uid()` resolves to `userId`, exactly as it
// would under Supabase's own PostgREST layer. This is what makes every
// query inside `fn` subject to the RLS policies from the rls_policies
// migration, rather than running as an unrestricted superuser/service role.
//
// SET LOCAL and set_config(..., true) both scope to the current
// transaction — they're undone automatically on COMMIT or ROLLBACK, so
// nothing here leaks onto the next request that reuses this pooled
// connection.
async function withUserTransaction(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // "authenticated" is a fixed, hardcoded role name — never user input —
    // so inlining it here is not an injection risk.
    await client.query('SET LOCAL ROLE authenticated');
    await client.query(
      `select
         set_config('request.jwt.claim.sub', $1, true),
         set_config('request.jwt.claims', $2, true)`,
      [userId, JSON.stringify({ sub: userId, role: 'authenticated' })]
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Runs `fn` inside a transaction impersonating the `anon` role — for the
// public, unauthenticated routes, where there is no user to impersonate.
// Raw table access is still fully denied to anon (see rls_policies); the
// only thing anon can do inside `fn` is call the narrow, security-definer
// functions from the public_link_functions migration. This keeps the same
// "the database enforces it, not application code" property as
// withUserTransaction — a code path that accidentally queried a table
// directly instead of calling one of those functions would simply fail,
// not silently succeed with unrestricted access.
async function withPublicTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE anon');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Resolves who the caller is, once per request: their tenant, whether
// they're an admin, and their tenant's branding/domain/reward/sending/
// billing details (for building invite links and invite emails, and for
// billing decisions like the close/reopen endpoints and the checkout
// endpoint). Runs as `authenticated` inside the same transaction, so
// it's itself subject to RLS — a userId with no matching `users` row
// (not a recognized staff member) simply returns undefined.
//
// This is an internal decision-making object, not a response shape: it
// deliberately includes stripe_customer_id/stripe_payment_method_id
// (needed to reuse a tenant's saved payment method for an off-session
// charge) precisely because nothing that returns ctx to a caller may
// ever echo those two fields back — every route builds its own response
// body from named fields, never by spreading ctx or a raw tenants row.
async function getCallerContext(client, userId) {
  const { rows } = await client.query(
    `select
       u.tenant_id, u.role = 'admin' as is_admin,
       t.domain as tenant_domain, t.name as tenant_name,
       t.reward_amount_cents, t.reward_currency,
       t.send_from_address, t.send_from_name, t.send_domain_verified,
       t.billing_status, t.activation_fee_cents, t.activation_paid_at,
       t.platform_fee_cents, t.per_referral_charge_cents,
       t.monthly_spend_cap_cents, t.payment_method_type,
       t.stripe_customer_id, t.stripe_payment_method_id
     from users u
     join tenants t on t.id = u.tenant_id
     where u.id = $1`,
    [userId]
  );
  return rows[0];
}

// Runs `fn` with the pool's own connecting role — no `SET LOCAL ROLE`
// impersonation at all. That's deliberate, not an oversight, and not a
// separate connection or a second pool: DATABASE_URL's own connection
// (`postgres`, per .env.example — the same superuser every migration
// already runs as, and the same one supabase/README.md's "Staff
// accounts" section relies on to bypass RLS for provisioning) already
// bypasses RLS by default at the connection level. withUserTransaction
// and withPublicTransaction each spend one `SET LOCAL ROLE` to
// deliberately *downgrade* that connection to `authenticated`/`anon` for
// the scope of one transaction, so RLS applies as if the caller really
// were that lesser role. This function is the one case that doesn't
// downgrade at all — confirmed live: running the exact same query
// through a lesser role that's merely a *member* of `authenticated`
// (not the actual superuser) silently affected 0 rows, RLS-filtered,
// with no error — which is exactly why this must run as the real
// connection, not some other narrower role.
//
// Reserved for code with no logged-in user to impersonate in the first
// place: a Stripe webhook (verified by signature, not a JWT) and the
// reward-issuance background worker. Never use this for anything an
// authenticated staff member's own request triggers — that must go
// through withUserTransaction, so RLS actually scopes what they can
// see and touch.
async function withServiceRole(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withUserTransaction, withPublicTransaction, withServiceRole, getCallerContext };
