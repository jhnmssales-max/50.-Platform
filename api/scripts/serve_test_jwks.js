// Serves the public half of the keypair scripts/gen_test_jwt.js
// generates, in the same shape Supabase's real JWKS endpoint returns
// (a JSON Web Key Set at /auth/v1/.well-known/jwks.json) — for local
// testing of src/middleware/auth.js's JWKS-based verification without a
// real Supabase project.
//
// Usage: node scripts/serve_test_jwks.js <keypair-file> [port]
// Then point SUPABASE_JWKS_URL at http://localhost:<port>/auth/v1/.well-known/jwks.json
const fs = require('fs');
const http = require('http');

const [, , keypairFile, portArg] = process.argv;
if (!keypairFile) {
  console.error('Usage: node scripts/serve_test_jwks.js <keypair-file> [port]');
  process.exit(1);
}
const port = portArg || 9996;

const server = http.createServer((req, res) => {
  if (req.url !== '/auth/v1/.well-known/jwks.json') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not_found' }));
  }
  const { publicJwk } = JSON.parse(fs.readFileSync(keypairFile, 'utf8'));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ keys: [publicJwk] }));
});

server.listen(port, () => console.log('test JWKS stub listening on :' + port));
