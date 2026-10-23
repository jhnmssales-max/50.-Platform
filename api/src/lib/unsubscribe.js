// Not hearing from a dealer again.
//
// Until the follow-up invites, no referral email carried an unsubscribe
// link. That was defensible for a single thank-you after someone bought
// something; it is not for a reminder arriving every quarter. So every
// referral email now carries one -- the first invite as well as the
// follow-ups -- and every send checks it first.
//
// Three rules this file keeps:
//
//   The token is the whole credential. It arrives in a link in an email, so
//   it is random and unguessable, never derived from a customer id or an
//   address. One per customer, minted on the first send and reused, so an
//   email from a year ago still works.
//
//   Honouring it needs no login. Asking someone to sign in before they can
//   stop being emailed is not an unsubscribe.
//
//   It is scoped to one dealer. A customers row belongs to one tenant, so
//   unsubscribing from the shed company a person bought from has no effect
//   on the roofer they also bought from. That is what someone would expect,
//   and the opposite would be a surprise in the wrong direction.

const { nanoid } = require('nanoid');

// Long enough that guessing is hopeless, short enough to survive an email
// client wrapping the line.
const TOKEN_LENGTH = 32;

// The customer's token, minting one if they have none. Returns null when
// the customer is already unsubscribed -- the caller treats that as "do not
// send", and a caller that forgets gets a null URL rather than a working
// link, which is the safer way round.
async function tokenForSending(client, customerId) {
  const { rows: [row] } = await client.query(
    'select unsubscribe_token, unsubscribed_at from customers where id = $1',
    [customerId]
  );
  if (!row || row.unsubscribed_at) return null;
  if (row.unsubscribe_token) return row.unsubscribe_token;

  const token = nanoid(TOKEN_LENGTH);
  const { rows: [updated] } = await client.query(
    `update customers set unsubscribe_token = $2
      where id = $1 and unsubscribe_token is null
      returning unsubscribe_token`,
    [customerId, token]
  );
  if (updated) return updated.unsubscribe_token;

  // Lost a race to another sender that minted one first. Theirs is in an
  // email by now, so take it rather than overwriting it.
  const { rows: [again] } = await client.query(
    'select unsubscribe_token from customers where id = $1',
    [customerId]
  );
  return again ? again.unsubscribe_token : null;
}

function unsubscribeUrl(token) {
  const base = process.env.FRONTEND_BASE_URL || process.env.API_PUBLIC_BASE_URL;
  if (!base || !token) return null;
  return `${base.replace(/\/$/, '')}/api/unsubscribe/${encodeURIComponent(token)}`;
}

// Has this customer asked not to be emailed? Checked before every referral
// send, not only the follow-ups.
async function isUnsubscribed(client, customerId) {
  const { rows: [row] } = await client.query(
    'select unsubscribed_at from customers where id = $1',
    [customerId]
  );
  return Boolean(row && row.unsubscribed_at);
}

module.exports = { tokenForSending, unsubscribeUrl, isUnsubscribed, TOKEN_LENGTH };
