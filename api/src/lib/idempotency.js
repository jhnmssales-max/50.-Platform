// Making an automated caller's retry harmless.
//
// The problem this exists for, concretely: a CRM fires "order won", 50.
// creates the customer and emails them their referral link, and the response
// is lost on the way back. The CRM retries. Without this, POST /customers
// sees an address it knows, treats it as a human pressing Resend, and emails
// the customer a second time. A dealer's customer gets the same "tell your
// friends" email twice from a company that is supposed to be keeping track of
// them. Fire the CRM on both "won" and "delivered" and it happens every time.
//
// The claim is inserted BEFORE the work runs, not checked before and written
// after. Two retries arriving together both attempt the insert; one wins and
// does the work, the other is told the first is in flight. Check-then-insert
// would let both pass the check before either wrote anything, which is the
// whole failure this is meant to prevent and is invisible in testing until
// the day a CRM retries fast.
//
// What a replay returns is the original response, byte for byte, not a bare
// "already handled" -- so a CRM that lost the first answer still learns the
// customer's id and link from the retry, and does not need a second code path
// for the duplicate case.
const { pool } = require('../db');

// Long enough for any order id or uuid a CRM would send, short enough that
// nobody is storing a payload in it.
const MAX_KEY_LENGTH = 255;

// Claims `key` for this tenant, or reports what already holds it.
//
//   { claimed: true, id }                 -> this caller does the work
//   { replay: { status, body } }          -> the original finished; return it
//   { inFlight: true }                    -> the original is still running
//   { conflict: endpoint }                -> same key, a different endpoint
//
// Runs on the pool's own role: integration_requests has RLS on with no
// policy for `authenticated`, deliberately, so a route that ever reached for
// it on a signed-in person's behalf fails rather than quietly working.
async function claimKey({ tenantId, apiKeyId, key, endpoint }) {
  const { rows: [claimed] } = await pool.query(
    `insert into integration_requests (tenant_id, api_key_id, idempotency_key, endpoint)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, idempotency_key) do nothing
     returning id`,
    [tenantId, apiKeyId, key, endpoint]
  );
  if (claimed) return { claimed: true, id: claimed.id };

  // Lost the insert: somebody else holds this key. Read what they did with
  // it. This cannot be folded into the insert above -- ON CONFLICT DO NOTHING
  // returns no row, by design, and DO UPDATE would overwrite the original
  // caller's record of its own response.
  const { rows: [existing] } = await pool.query(
    `select endpoint, status_code, response_body
       from integration_requests
      where tenant_id = $1 and idempotency_key = $2`,
    [tenantId, key]
  );

  // Vanishingly rare: the holder's transaction rolled back between the two
  // queries. Treated as in-flight rather than claimed, because answering
  // "go ahead" on a row that is no longer there would hand two callers the
  // same claim.
  if (!existing) return { inFlight: true };

  // One order id used for two different calls is a mistake in the CRM's
  // configuration, and replaying one endpoint's answer for the other would
  // hide it.
  if (existing.endpoint !== endpoint) return { conflict: existing.endpoint };

  if (existing.status_code === null) return { inFlight: true };
  return { replay: { status: existing.status_code, body: existing.response_body } };
}

// Stores what the original request answered, so later retries replay it.
//
// Never throws: by the time this runs the customer has been created and the
// invite is gone. Failing the request now would tell the CRM the work did not
// happen when it did, and a CRM told that will retry -- which is exactly the
// double invite this file exists to prevent. A key stuck with no response
// degrades to "in flight", which is safe; losing the record of a completed
// send is not.
async function completeKey(id, status, body) {
  try {
    await pool.query(
      `update integration_requests
          set status_code = $2, response_body = $3, completed_at = now()
        where id = $1`,
      [id, status, JSON.stringify(body)]
    );
  } catch (err) {
    console.error(`Could not record idempotency response for ${id}:`, err.message);
  }
}

// Releases a claim whose work failed, so the CRM's retry is allowed to try
// again instead of meeting a permanent "in flight". Only for a failure that
// sent nothing -- never after an invite has gone out.
async function releaseKey(id) {
  try {
    await pool.query('delete from integration_requests where id = $1 and status_code is null', [id]);
  } catch (err) {
    console.error(`Could not release idempotency claim ${id}:`, err.message);
  }
}

module.exports = { MAX_KEY_LENGTH, claimKey, completeKey, releaseKey };
