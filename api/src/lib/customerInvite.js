// Creating a customer, giving them a link, and inviting them to share it.
//
// Three callers reach this, and they must not drift apart:
//
//   routes/customers.js        a dealer types a customer in by hand
//   routes/referrals.js        a referred friend converts and is marked paid
//   workers/rewardIssuance.js  the same conversion down the automated path
//
// Before this file existed the first two would have been separate inline
// implementations of the same three steps, and the third did only the first
// one: it created the friend's customers row and stopped, so a referred
// friend who went on to buy ended up holding no link and could never refer
// anyone. The chain died at every conversion. The customers table has
// carried a comment describing the intended behaviour since the first
// migration ("any referred friend who goes on to order (auto-created at
// that point so they can refer their own friends)") -- this is that, built.
//
// Every function takes an open `client` rather than opening its own
// transaction, so the caller decides whether that is a user transaction
// under RLS (the two routes, acting as the signed-in staff member) or a
// service-role one (the worker, which has no user to act as).

const { nanoid } = require('nanoid');
const { slugify } = require('./codes');
const { sendEmail } = require('./postmark');
const { buildInviteEmail } = require('./inviteEmail');
const { unsubscribeUrl } = require('./unsubscribe');

const UNIQUE_VIOLATION = '23505';

// Prefers the page that's actually reachable and functional today
// (fifty-template-customer.html?code=..., wherever the static frontend is
// deployed) over the tenant's own domain + the aspirational /50/... path
// scheme, which has no routing layer behind it yet. Falls back to the
// latter only if FRONTEND_BASE_URL isn't configured.
function buildInviteUrl(code, tenantDomain) {
  const base = process.env.FRONTEND_BASE_URL;
  if (base) return `${base.replace(/\/$/, '')}/fifty-template-customer.html?code=${encodeURIComponent(code)}`;
  return tenantDomain ? `https://${tenantDomain}/50/${code}` : null;
}

// Email clients need an absolute https image URL. A root-relative logoUrl
// (the branding shape allows one) is resolved against FRONTEND_BASE_URL.
function resolveLogoUrl(url) {
  if (!url) return null;
  try {
    const base = process.env.FRONTEND_BASE_URL;
    return new URL(url, base ? base.replace(/\/$/, '') + '/' : undefined).toString();
  } catch (_) {
    return null;
  }
}

// Mints an 'invite' link for a customer, retrying on the code collision a
// random suffix can always produce.
async function createInviteLink(client, { tenantId, customerId, name }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `${slugify(name) || 'friend'}-${nanoid(6)}`;
    try {
      const { rows } = await client.query(
        `insert into referral_links (tenant_id, code, kind, customer_id)
         values ($1, $2, 'invite', $3)
         returning code, status, created_at`,
        [tenantId, code, customerId]
      );
      return rows[0];
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION && attempt < 4) continue;
      throw err;
    }
  }
  // Unreachable: the loop either returns or rethrows on the fifth attempt.
  throw new Error('Could not mint a unique invite code');
}

// The link a customer already holds, if any. A customer is only ever meant
// to have one invite link, so re-marking a referral paid must find this
// rather than mint a second.
async function findInviteLink(client, customerId) {
  const { rows: [row] } = await client.query(
    `select code, status, created_at from referral_links
     where customer_id = $1 and kind = 'invite'
     order by created_at asc
     limit 1`,
    [customerId]
  );
  return row || null;
}

// Finds or creates the referred friend's own customers row, claimed via
// source_referral_id rather than an email match -- a true one-time claim,
// not a heuristic merge into whatever customer row happens to share this
// address. See the reward_issuance_worker migration for why.
//
// Returns { id, created }. `created` is what tells the caller whether this
// conversion is the one that minted the row, which is how the invite email
// is sent exactly once however many times the referral is re-marked.
async function findOrCreateReferralCustomer(client, { tenantId, referralId, name, email, phone }) {
  const { rows: [inserted] } = await client.query(
    `insert into customers (tenant_id, name, email, phone, source_referral_id)
     values ($1, $2, $3, $4, $5)
     on conflict (source_referral_id) do nothing
     returning id`,
    [tenantId, name, email, phone || null, referralId]
  );
  if (inserted) return { id: inserted.id, created: true };

  const { rows: [existing] } = await client.query(
    'select id from customers where source_referral_id = $1',
    [referralId]
  );
  if (!existing) {
    // The insert above can only hit its conflict target if a row already
    // claims this exact source_referral_id -- so this means that row
    // existed a moment ago and now doesn't, which is a genuine
    // data-integrity problem (nothing in this codebase deletes customers),
    // not a benign race.
    throw new Error(
      `Referral ${referralId}: customers insert conflicted on source_referral_id but no row can be found for it`
    );
  }
  return { id: existing.id, created: false };
}

// Gives a customer a link if they don't have one, and reports which it is.
// Returns { link, created }.
async function ensureInviteLink(client, { tenantId, customerId, name }) {
  const existing = await findInviteLink(client, customerId);
  if (existing) return { link: existing, created: false };
  return { link: await createInviteLink(client, { tenantId, customerId, name }), created: true };
}

// Sends the invite, unchanged, with the tenant's own branding and sender.
// `tenant` carries the same fields getCallerContext returns, so a route can
// hand its ctx straight in.
//
// Deliberately takes plain data and no DB client: sending is a best-effort
// side effect, attempted only after the rows are safely committed. A slow
// or failed send must never roll back data that already exists, and must
// not hold a transaction open across a third-party HTTP call.
// unsubscribeToken comes from lib/unsubscribe.js's tokenForSending, which
// returns null for a customer who has already unsubscribed -- so a caller
// that forgets to check gets a send with no token, which this refuses,
// rather than an email to somebody who asked not to get one.
async function sendInviteEmail({ tenant, customerName, customerEmail, inviteUrl, replyToEmail, unsubscribeToken }) {
  // An invite whose whole purpose is a link, sent without one, is worse
  // than no invite: the customer reads it, finds nothing to share, and the
  // sender has spent their one introduction. buildInviteUrl returns null
  // when neither FRONTEND_BASE_URL nor the tenant's own domain is set, so
  // refuse rather than send. The customer and their link still exist and
  // the invite can be resent once that is configured.
  if (!inviteUrl) {
    throw new Error(
      'No invite URL could be built — set FRONTEND_BASE_URL, or give this tenant a domain. Nothing was sent.'
    );
  }
  const fromAddress =
    (tenant.send_domain_verified && tenant.send_from_address) || process.env.EMAIL_FROM_ADDRESS;
  if (!fromAddress) {
    throw new Error('No verified sending address configured for this tenant, and no platform default is set');
  }
  // Every referral email carries a way out of them -- the first invite as
  // much as the reminders, because a customer cannot tell from the first one
  // whether more are coming. No token means either nobody minted one or this
  // customer has unsubscribed; both are reasons not to send.
  const unsubUrl = unsubscribeUrl(unsubscribeToken);
  if (!unsubUrl) {
    throw new Error(
      'No unsubscribe link could be built — the customer may have unsubscribed, or FRONTEND_BASE_URL is unset. Nothing was sent.'
    );
  }
  const fromName = (tenant.send_domain_verified && tenant.send_from_name) || tenant.tenant_name;
  const branding = tenant.tenant_branding || {};

  const { subject, htmlBody, textBody } = buildInviteEmail({
    tenantName: tenant.tenant_name,
    rewardAmountCents: tenant.reward_amount_cents,
    rewardCurrency: tenant.reward_currency,
    customerName,
    inviteUrl,
    buttonColor: branding.primaryColor,
    logoUrl: resolveLogoUrl(branding.logoUrl),
    offerHow: (branding.copy || {}).offerHow,
    // What this dealer calls their gift card, for the {card} token in their
    // offer line. Without it the email would print the raw token.
    cardNoun: (branding.copy || {}).cardNoun,
    shareButton: (branding.copy || {}).shareButton,
    unsubscribeUrl: unsubUrl,
  });

  // Replies go to a real person at the business, not the platform's shared
  // sending address.
  const replyTo = replyToEmail ? `${fromName} <${replyToEmail}>` : undefined;

  await sendEmail({
    from: `${fromName} <${fromAddress}>`,
    to: customerEmail,
    replyTo,
    subject,
    htmlBody,
    textBody,
    // What lets a mail client show its own unsubscribe control, and what the
    // large providers look for before treating a repeating sender as
    // legitimate. Worth having on all of this now that some of it repeats.
    headers: [{ Name: 'List-Unsubscribe', Value: `<${unsubUrl}>` }],
  });
}

module.exports = {
  buildInviteUrl,
  resolveLogoUrl,
  createInviteLink,
  findInviteLink,
  ensureInviteLink,
  findOrCreateReferralCustomer,
  sendInviteEmail,
};
