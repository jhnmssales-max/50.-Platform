// Mints a throwaway ES256 access token for local testing, without a real
// Supabase project — the equivalent of what this used to do with a
// shared HS256 secret, before auth.js switched to verifying against
// Supabase's JWKS (real Supabase projects sign with an asymmetric key,
// not a static secret, so a "secret" is no longer something to hand this
// script at all).
//
// Usage: node scripts/gen_test_jwt.js <keypair-file> <user-uuid>
//
// <keypair-file> is generated on first use (an EC P-256 keypair, saved as
// JSON) and reused on later runs, so the same file also backs
// scripts/serve_test_jwks.js — point SUPABASE_JWKS_URL at that stub
// server and this script's tokens verify against it exactly the way a
// real Supabase-issued token verifies against Supabase's real JWKS.
//
// Never use this against a real deployment — it has no connection to any
// real Supabase project's actual signing key.
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const [, , keypairFile, sub] = process.argv;
if (!keypairFile || !sub) {
  console.error('Usage: node scripts/gen_test_jwt.js <keypair-file> <user-uuid>');
  process.exit(1);
}

const KID = 'test-key-1';

function loadOrCreateKeypair() {
  if (fs.existsSync(keypairFile)) {
    return JSON.parse(fs.readFileSync(keypairFile, 'utf8'));
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keypair = {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicJwk: { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'ES256' },
  };
  fs.writeFileSync(keypairFile, JSON.stringify(keypair, null, 2));
  return keypair;
}

const { privatePem } = loadOrCreateKeypair();

const token = jwt.sign({ sub, role: 'authenticated', aud: 'authenticated' }, privatePem, {
  algorithm: 'ES256',
  expiresIn: '2h',
  keyid: KID,
});

console.log(token);
