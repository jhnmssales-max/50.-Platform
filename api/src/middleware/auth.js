const jwt = require('jsonwebtoken');

if (!process.env.SUPABASE_JWT_SECRET) {
  throw new Error('SUPABASE_JWT_SECRET is not set — see .env.example');
}

// Verifies the caller's Supabase-issued access token and attaches the
// verified user id as req.userId. This only establishes *identity* — it
// deliberately does not look up or trust a tenant/role from the token.
// Every route decides what that identity is allowed to do by handing
// req.userId to withUserTransaction() and letting RLS answer.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    const payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload.sub) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.userId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };
