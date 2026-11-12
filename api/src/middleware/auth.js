const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { pool } = require('../db');
const { keyFromHeader, resolveKey } = require('../lib/apiKeys');

if (!process.env.SUPABASE_URL) {
  throw new Error('SUPABASE_URL is not set — see .env.example');
}

// Supabase signs access tokens per-project with a key that rotates — not a
// static shared secret. Verification fetches the current public signing
// key from Supabase's own JWKS endpoint, keyed by the token's `kid`
// header, rather than checking against one fixed HS256 secret (that
// approach silently breaks the moment a project uses Supabase's
// asymmetric (ES256) signing keys instead of the legacy shared secret —
// which is what this project actually does; jwt.verify rejects on an
// algorithm mismatch before the key even matters).
//
// jwks-rsa handles the fetch and caches the result in memory (10 min,
// below) so this isn't a network round trip on every single request, and
// rate-limits its own retries if Supabase's endpoint is ever slow/down.
// SUPABASE_JWKS_URL exists only to point this at a local stand-in during
// tests — see api/README.md and scripts/serve_test_jwks.js.
const client = jwksClient({
  jwksUri:
    process.env.SUPABASE_JWKS_URL ||
    `${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 10 * 60 * 1000,
  rateLimit: true,
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

// Verifies the caller's Supabase-issued access token and attaches the
// verified user id as req.userId. This only establishes *identity* (the
// caller really is who they say, per Supabase) — it deliberately does not
// look up or trust a tenant/role from the token. Every route decides what
// that identity is allowed to do by handing req.userId to
// withUserTransaction() and letting RLS answer.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  // Restricted to ES256 (what this project's tokens are actually signed
  // with, confirmed by decoding a real token's header) rather than left
  // open to whatever algorithm a token claims — accepting an
  // attacker-chosen algorithm here is the classic JWT "alg confusion"
  // hole, so this only ever verifies the one algorithm Supabase actually
  // uses for this project.
  jwt.verify(token, getKey, { algorithms: ['ES256'] }, (err, payload) => {
    if (err || !payload || !payload.sub) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.userId = payload.sub;
    next();
  });
}

// ---------------------------------------------------------------------------
// requireAuthOrApiKey — the same thing, for a route a dealer's CRM may call.
//
// Only a handful of routes get this, never requireAuth's whole surface: a
// leaked key should be able to add a customer and nothing else, so billing,
// logins, reps and reports stay token-only. Which routes those are is visible
// at the mount point, not buried in a flag here.
//
// Both paths end at exactly the same place -- req.userId, and nothing else.
// Downstream, getCallerContext() takes a user id and cannot tell how the
// caller proved it, so RLS, the activation gate and tenant scoping apply to a
// CRM identically to a person, with nothing re-implemented for keys. That
// sameness is the point: there is one authorization model here, not two.
//
// A key sets req.apiKeyId as well, which is what makes an automated call
// recognisable afterwards -- it is recorded against the idempotency row -- and
// what tells a route that an Idempotency-Key is expected of this caller.
function requireAuthOrApiKey(req, res, next) {
  const key = keyFromHeader(req.headers.authorization);

  // Not a key: an ordinary signed-in request, verified the usual way. This
  // branch is the common one and must behave exactly as requireAuth does,
  // including for a malformed header.
  if (!key) return requireAuth(req, res, next);

  resolveKey(pool, key)
    .then((row) => {
      if (!row) {
        // Unknown and revoked are one answer on purpose: telling a caller
        // which it was says whether a key ever existed.
        return res.status(401).json({ error: 'Invalid or revoked API key' });
      }
      req.userId = row.user_id;
      req.apiKeyId = row.id;
      // The tenant, straight off the key row. A route needing to claim an
      // idempotency key needs the tenant before it opens the transaction
      // that would otherwise tell it -- and this is the same tenant
      // getCallerContext will resolve from the user, since api_keys.user_id
      // points at a users row in api_keys.tenant_id.
      req.apiKeyTenantId = row.tenant_id;
      next();
    })
    .catch(next);
}

module.exports = { requireAuth, requireAuthOrApiKey };
