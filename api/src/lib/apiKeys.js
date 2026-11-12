// Minting and checking the keys a dealer's CRM authenticates with.
//
// See the migration for why a key authenticates AS a users row rather than
// carrying privileges of its own. This file holds the three mechanical parts
// of that: making a key, hashing it, and turning one back into a user id.
//
// Three rules it keeps:
//
//   The key is shown once. Only its sha256 is stored, so a copy of the
//   database -- a backup, a support export, a screen share of the table --
//   contains nothing that can authenticate. A dealer who loses a key makes a
//   new one; there is no recovering the old one, by anybody, including us.
//
//   Verifying is one indexed lookup, by hash. Not a scan comparing every
//   live key, which would get slower with every dealer and would invite the
//   timing-comparison mistakes that go with it.
//
//   A revoked key is dead immediately. Revocation is a column on the row the
//   lookup already reads, not a separate list to consult, so there is no
//   state where a key is revoked in one place and live in another.
const crypto = require('crypto');
const { nanoid } = require('nanoid');

// Says what it is at a glance, in a log, a config field or a support ticket:
// a 50. key, and a live one. The prefix is also what makes a key findable by
// the secret scanners that watch public repositories, which is worth more
// than the few characters it costs.
const KEY_PREFIX = 'rw50_live_';

// 40 characters of nanoid alphabet. Guessing is hopeless and it still fits on
// one line of a CRM's settings field.
const SECRET_LENGTH = 40;

// How much of the key the management screen may show. Enough to tell two
// keys apart, far too little to narrow down the rest.
const DISPLAY_CHARS = KEY_PREFIX.length + 6;

function hashKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

// A new key: the plaintext to hand over once, and the two values to store.
function mintKey() {
  const key = KEY_PREFIX + nanoid(SECRET_LENGTH);
  return { key, keyHash: hashKey(key), keyPrefix: key.slice(0, DISPLAY_CHARS) };
}

// Pulls the credential out of an Authorization header, or null when the
// header is not a key at all -- which is the ordinary case for every
// browser request and must not read as a bad key.
function keyFromHeader(header) {
  const [scheme, token] = (header || '').split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token.startsWith(KEY_PREFIX) ? token : null;
}

// The user this key acts as, or null if the key is unknown or revoked.
//
// Deliberately run with the pool's own role rather than inside
// withUserTransaction: there is no user id yet, which is the very thing being
// looked up, and this is the one query that reads key_hash. Nothing
// user-supplied reaches it except as a parameter.
//
// last_used_at is written on the way through so a dealer can see whether
// their integration is actually running, and so a key nobody has used for a
// year is recognisable as one to revoke.
async function resolveKey(pool, key) {
  const { rows: [row] } = await pool.query(
    `update api_keys
        set last_used_at = now()
      where key_hash = $1 and revoked_at is null
      returning id, tenant_id, user_id`,
    [hashKey(key)]
  );
  return row || null;
}

module.exports = { KEY_PREFIX, mintKey, hashKey, keyFromHeader, resolveKey };
