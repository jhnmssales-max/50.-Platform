// 50. running its own referral program on its own platform.
//
// A dealer who pays the activation fee is a customer of 50. the same way a
// shed buyer is a customer of their dealer. So when that payment clears,
// each of that dealer's admins becomes a customer of the 50. tenant, gets
// their own invite link, and receives the ordinary invite email -- the same
// buildInviteEmail, the same branding, the same sender any customer gets.
//
// That sameness is the point. They learn what the product does by being on
// the receiving end of it, with their own link to pass on, rather than from
// anything written specially for them.
//
// Two rules this file keeps:
//
//   It never breaks an activation. Everything here runs after the
//   activation transaction has committed, in its own try/catch. A missing
//   50. tenant, a dead Postmark, a tenant with no admins -- none of it may
//   cost a dealer the activation they paid for.
//
//   It fires once per admin per dealer. The claim is
//   (source_activated_tenant_id, email), so a redelivered Stripe event, a
//   second activation payment, or an admin removed and re-added all land on
//   the one row and the one email.

const { withServiceRole, assertServiceRoleConnection } = require('../db');
const { buildInviteUrl, ensureInviteLink, sendInviteEmail } = require('./customerInvite');
const { tokenForSending } = require('./unsubscribe');

// The 50. tenant's own slug. is_platform_staff() in the rep-pipeline
// migration is defined against this same value -- 50. is a tenant like any
// other, and this is which one.
const PLATFORM_TENANT_SLUG = '50-platform';

// Everything sendInviteEmail and buildInviteUrl need, under the names
// getCallerContext uses for them, so one shape serves both callers.
const PLATFORM_TENANT_COLUMNS = `
  id,
  name as tenant_name,
  domain as tenant_domain,
  branding as tenant_branding,
  reward_amount_cents,
  reward_currency,
  send_from_address,
  send_from_name,
  send_domain_verified
`;

// Sets up every admin of a newly-activated dealer as a referrer for 50.,
// and returns what to send. Reads and writes only through the service role:
// these rows belong to the 50. tenant, not to the dealer whose payment
// triggered them, so no dealer's own session could create them.
//
// Returns [] when there is nothing to do -- no 50. tenant configured, no
// admins, or everyone already set up -- which is a quiet, ordinary outcome,
// not a failure.
async function enrolActivatedDealerAdmins({ dealerTenantId }) {
  return withServiceRole(async (client) => {
    await assertServiceRoleConnection(client);

    const { rows: [platform] } = await client.query(
      `select ${PLATFORM_TENANT_COLUMNS} from tenants where slug = $1`,
      [PLATFORM_TENANT_SLUG]
    );
    if (!platform) {
      console.log(
        `No '${PLATFORM_TENANT_SLUG}' tenant exists, so there is no 50. referral program to enrol tenant ${dealerTenantId}'s admins into — skipping.`
      );
      return [];
    }
    // A dealer cannot be enrolled into its own program. This only happens
    // if 50.'s own tenant is ever put through activation, which nothing
    // does today (it is billing-exempt), but the guard costs nothing and
    // the alternative is 50. inviting itself.
    if (platform.id === dealerTenantId) return [];

    const { rows: admins } = await client.query(
      `select name, email from users
       where tenant_id = $1 and role = 'admin' and email is not null
       order by created_at asc`,
      [dealerTenantId]
    );
    if (!admins.length) {
      console.log(`Activated tenant ${dealerTenantId} has no admin users to enrol in 50.'s referral program.`);
      return [];
    }

    const enrolled = [];
    for (const admin of admins) {
      // The claim. DO NOTHING rather than DO UPDATE: an admin already
      // enrolled keeps the row and the link they already have.
      const { rows: [created] } = await client.query(
        `insert into customers (tenant_id, name, email, source_activated_tenant_id)
         values ($1, $2, $3, $4)
         on conflict (source_activated_tenant_id, email) do nothing
         returning id`,
        [platform.id, admin.name, admin.email, dealerTenantId]
      );
      // No row back means this admin was enrolled by an earlier delivery of
      // this same activation. They have their link; they were told once.
      if (!created) continue;

      const { link } = await ensureInviteLink(client, {
        tenantId: platform.id,
        customerId: created.id,
        name: admin.name,
      });
      enrolled.push({
        name: admin.name,
        email: admin.email,
        code: link.code,
        unsubscribeToken: await tokenForSending(client, created.id),
      });
    }

    return enrolled.map((e) => ({ ...e, platform }));
  });
}

// Sends each newly-enrolled admin their invite. Best-effort per recipient:
// one dead address must not cost the others their email, and none of it may
// surface as an activation failure.
async function sendPlatformInvites(enrolled) {
  for (const person of enrolled) {
    try {
      await sendInviteEmail({
        tenant: person.platform,
        customerName: person.name,
        customerEmail: person.email,
        inviteUrl: buildInviteUrl(person.code, person.platform.tenant_domain),
        unsubscribeToken: person.unsubscribeToken,
        // Replies reach Joseph, not the platform's shared sending address:
        // a dealer answering this email is answering 50., and someone
        // should be reading it.
        replyToEmail: process.env.BILLING_SUPPORT_EMAIL || 'joseph@referwith50.com',
      });
      console.log(`Sent the 50. referral invite to activated dealer admin ${person.email} (link ${person.code})`);
    } catch (err) {
      // The link exists and works regardless; this only means they were not
      // told about it. Name the address so it can be resent by hand.
      console.error(
        `Failed to send the 50. referral invite to ${person.email} (link ${person.code}): ${err.message}`
      );
    }
  }
}

module.exports = { enrolActivatedDealerAdmins, sendPlatformInvites, PLATFORM_TENANT_SLUG };
