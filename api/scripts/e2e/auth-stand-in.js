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

function createAuthStandIn() {
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

  function addUser({ id, email, password }) {
    usersByEmail.set(email.toLowerCase(), { id, email, password });
  }

  return { app, addUser, mintToken: (user) => mintToken(user) };
}

module.exports = { createAuthStandIn };
