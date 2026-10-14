// Test-only. A local stand-in for the two Supabase Auth endpoints this
// project touches: the token endpoint the dealer page signs in against
// (password + refresh_token grants), and the JWKS endpoint
// src/middleware/auth.js verifies access tokens with. Tokens are real
// ES256 JWTs signed by a keypair generated per run — the API verifies
// them exactly as it verifies Supabase's. Never connected to any real
// Supabase project.
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

// onUserCreated: the real Supabase Auth writes its new account into the
// auth.users table of the same Postgres database the API talks to, which is
// what public.users' foreign key points at. This stand-in runs as a separate
// HTTP service, so a test that exercises account creation passes a hook here
// to make that same row appear. Without it the API's insert would fail on a
// foreign key that production always satisfies.
function createAuthStandIn({ onUserCreated } = {}) {
  const kid = 'e2e-auth-stand-in';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' };

  const usersByEmail = new Map();
  const refreshTokens = new Map();

  function mintToken(user) {
    return jwt.sign({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated' }, privatePem, {
      algorithm: 'ES256',
      keyid: kid,
      expiresIn: '1h',
    });
  }

  function issue(user) {
    const refresh = crypto.randomBytes(16).toString('hex');
    refreshTokens.set(refresh, user);
    return { access_token: mintToken(user), token_type: 'bearer', expires_in: 3600, refresh_token: refresh, user: { id: user.id, email: user.email } };
  }

  const app = express();
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'content-type, apikey, authorization, x-client-info');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json());

  app.post('/auth/v1/token', (req, res) => {
    const grant = req.query.grant_type;
    if (grant === 'password') {
      const user = usersByEmail.get(String((req.body && req.body.email) || '').toLowerCase());
      if (!user || user.password !== req.body.password) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid login credentials' });
      }
      return res.json(issue(user));
    }
    if (grant === 'refresh_token') {
      const user = refreshTokens.get(req.body && req.body.refresh_token);
      if (!user) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      refreshTokens.delete(req.body.refresh_token);
      return res.json(issue(user));
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  app.get('/auth/v1/.well-known/jwks.json', (req, res) => res.json({ keys: [publicJwk] }));

  // ---------------------------------------------------------------------------
  // Supabase Auth's admin API — as much of it as src/lib/supabaseAdmin.js uses:
  // creating a login with NO password, and minting the one-time link that lets
  // the person choose one. Guarded by the service-role key exactly as the real
  // one is, so a test that forgets to configure the key fails the way
  // production would instead of quietly succeeding.
  // ---------------------------------------------------------------------------
  const linksSent = [];

  function serviceRole(req, res) {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (bearer !== SERVICE_ROLE_KEY && req.headers.apikey !== SERVICE_ROLE_KEY) {
      res.status(401).json({ msg: 'Invalid service role key' });
      return false;
    }
    return true;
  }

  app.post('/auth/v1/admin/users', (req, res) => {
    if (!serviceRole(req, res)) return;
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ msg: 'email is required' });
    if (usersByEmail.has(email)) {
      return res.status(422).json({ msg: 'A user with this email address has already been registered' });
    }
    // password null: this account cannot sign in at all until one is set.
    const user = { id: crypto.randomUUID(), email, password: null };
    usersByEmail.set(email, user);
    if (onUserCreated) {
      Promise.resolve(onUserCreated(user))
        .then(() => res.json({ id: user.id, email: user.email }))
        .catch((err) => res.status(500).json({ msg: `stand-in onUserCreated failed: ${err.message}` }));
      return;
    }
    res.json({ id: user.id, email: user.email });
  });

  app.get('/auth/v1/admin/users', (req, res) => {
    if (!serviceRole(req, res)) return;
    const filter = String(req.query.filter || '').trim().toLowerCase();
    const list = [...usersByEmail.values()].filter((u) => !filter || String(u.email).toLowerCase() === filter);
    res.json({ users: list.map((u) => ({ id: u.id, email: u.email })) });
  });

  app.post('/auth/v1/admin/generate_link', (req, res) => {
    if (!serviceRole(req, res)) return;
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const user = usersByEmail.get(email);
    if (!user) return res.status(404).json({ msg: 'User not found' });
    const token = crypto.randomBytes(16).toString('hex');
    linksSent.push({ email, token, type: req.body.type, redirectTo: req.body.redirect_to });
    res.json({ properties: { action_link: `http://127.0.0.1/auth/v1/verify?token=${token}&type=${req.body.type}` } });
  });

  function addUser({ id, email, password }) {
    usersByEmail.set(email.toLowerCase(), { id, email, password });
  }

  // Standing in for the person opening the emailed link and choosing a
  // password: after this they can sign in, and not before.
  function setPassword(email, password) {
    const user = usersByEmail.get(String(email).trim().toLowerCase());
    if (!user) throw new Error(`no such stand-in user: ${email}`);
    user.password = password;
    return user.id;
  }

  return {
    app,
    addUser,
    setPassword,
    mintToken: (user) => mintToken(user),
    links: () => linksSent.slice(),
    userIdFor: (email) => (usersByEmail.get(String(email).trim().toLowerCase()) || {}).id,
    SERVICE_ROLE_KEY,
  };
}

const SERVICE_ROLE_KEY = 'e2e-service-role-key';

module.exports = { createAuthStandIn, SERVICE_ROLE_KEY };
