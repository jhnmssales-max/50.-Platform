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
// they're an admin, and their tenant's branding/domain/reward/sending
// details (for building invite links and invite emails). Runs as
// `authenticated` inside the same transaction, so it's itself subject to
// RLS — a userId with no matching `users` row (not a recognized staff
// member) simply returns undefined.
async function getCallerContext(client, userId) {
  const { rows } = await client.query(
    `select
       u.tenant_id, u.role = 'admin' as is_admin,
       t.domain as tenant_domain, t.name as tenant_name,
       t.reward_amount_cents, t.reward_currency,
       t.send_from_address, t.send_from_name, t.send_domain_verified
     from users u
     join tenants t on t.id = u.tenant_id
     where u.id = $1`,
    [userId]
  );
  return rows[0];
}

module.exports = { pool, withUserTransaction, withPublicTransaction, getCallerContext };
