// Sending an invited customer their link again, later.
//
// A customer hears about their referral link once, the day their dealer adds
// them. Someone who meant to share it and forgot never hears again. This is
// the nudge: the same link, sent back to them on a schedule the dealer sets
// (tenants.invite_followup_months -- 3, 6, 9 or 12; null is off and is the
// default, so no dealer starts sending because this shipped).
//
// Three sends at most, ever. At 3 months that is a year of reminders; at 12
// it is three years. The cap is what keeps this a nudge rather than a
// subscription nobody asked for, and it is enforced by the database -- the
// sequence CHECK and the unique constraint on invite_followups together --
// not by this file remembering to stop.
//
// Exactly-once is the same claim pattern as the billing emails: insert the
// claim, send, stamp sent_at. A failed send deletes the claim so the next
// cycle retries; a process that dies mid-send leaves an unsent claim anyone
// may re-claim once it is 15 minutes old. Two overlapping cycles, or two
// servers, can never both send the same person the same reminder.

const { withServiceRole, assertServiceRoleConnection } = require('../db');
const { isQuietDay, quietDaySummary } = require('../lib/quietDay');
const { sendEmail } = require('../lib/postmark');
const { buildInviteFollowupEmail } = require('../lib/inviteFollowupEmail');
const { buildInviteUrl, resolveLogoUrl } = require('../lib/customerInvite');
const { unsubscribeUrl, tokenForSending } = require('../lib/unsubscribe');
const { noteDeliveryOutcome } = require('../lib/deliveryOutcome');

const MAX_FOLLOWUPS = 3;
const STALE_CLAIM = "15 minutes";

// Everyone currently due one, with the data needed to write the email.
//
// Due means: their dealer has an interval set and is still open, their
// invite link was minted at least (sequence x interval) months ago, they
// have not unsubscribed, and no row claims that sequence for them yet. The
// lowest unsent sequence is the one that goes -- so a dealer who switches
// the setting on two years after inviting somebody sends them one reminder
// now, not three at once.
//
// Two guards against mailing people who cannot be mailed. remove_company
// closes a company that traded by scrubbing its customers' addresses to
// removed+<id>@removed.invalid and stamping closed_at -- it does not clear
// the interval, so without the first guard every reminder for a closed
// company would go to an undeliverable address and bounce. The second guard
// catches a scrubbed address whatever closed it, so this does not depend on
// closed_at being the only route to one. Bounces are not free: this account
// already carries a bounce rate worth protecting.
async function findDue(client, limit) {
  const { rows } = await client.query(
    `with invited as (
       select c.id as customer_id, c.tenant_id, c.name, c.email,
              min(rl.created_at) as invited_at
         from customers c
         join referral_links rl on rl.customer_id = c.id and rl.kind = 'invite'
        where c.unsubscribed_at is null
          and c.email not like '%@removed.invalid'
        group by c.id, c.tenant_id, c.name, c.email
     ),
     sent as (
       select customer_id, count(*)::int as n from invite_followups group by customer_id
     )
     select i.customer_id, i.tenant_id, i.name, i.email, i.invited_at,
            coalesce(s.n, 0) + 1 as sequence,
            t.name as tenant_name, t.domain as tenant_domain, t.branding as tenant_branding,
            t.reward_amount_cents, t.reward_currency,
            t.send_from_address, t.send_from_name, t.send_domain_verified,
            t.invite_followup_months
       from invited i
       join tenants t on t.id = i.tenant_id
       left join sent s on s.customer_id = i.customer_id
      where t.invite_followup_months is not null
        and t.closed_at is null
        and coalesce(s.n, 0) < $1
        and i.invited_at <= now() - ((coalesce(s.n, 0) + 1) * t.invite_followup_months || ' months')::interval
      order by i.invited_at
      limit $2`,
    [MAX_FOLLOWUPS, limit]
  );
  return rows;
}

async function claim(customerId, tenantId, sequence) {
  return withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      `insert into invite_followups (tenant_id, customer_id, sequence) values ($1, $2, $3)
       on conflict on constraint invite_followups_one_per_sequence do update set claimed_at = now()
         where invite_followups.sent_at is null
           and invite_followups.claimed_at < now() - interval '${STALE_CLAIM}'
       returning id`,
      [tenantId, customerId, sequence]
    );
    return row ? row.id : null;
  });
}

async function release(claimId) {
  await withServiceRole((client) =>
    client.query('delete from invite_followups where id = $1 and sent_at is null', [claimId])
  ).catch((err) => console.error(`INVITE_FOLLOWUP could not release claim ${claimId}: ${err.message}`));
}

async function sendOne(person) {
  // The link they already have, and the token that lets them stop. Both read
  // inside one service-role transaction so a customer who unsubscribes
  // between the sweep and the send is caught here rather than emailed.
  const prepared = await withServiceRole(async (client) => {
    await assertServiceRoleConnection(client);
    const token = await tokenForSending(client, person.customer_id);
    if (!token) return null; // unsubscribed after the sweep read them
    const { rows: [link] } = await client.query(
      `select code from referral_links
        where customer_id = $1 and kind = 'invite'
        order by created_at asc limit 1`,
      [person.customer_id]
    );
    return link ? { token, code: link.code } : null;
  });
  if (!prepared) return { outcome: 'skipped' };

  const inviteUrl = buildInviteUrl(prepared.code, person.tenant_domain);
  const unsubUrl = unsubscribeUrl(prepared.token);
  if (!inviteUrl || !unsubUrl) {
    throw new Error('Could not build the invite or unsubscribe link — is FRONTEND_BASE_URL set?');
  }

  const fromAddress =
    (person.send_domain_verified && person.send_from_address) || process.env.EMAIL_FROM_ADDRESS;
  if (!fromAddress) {
    throw new Error('No verified sending address for this tenant, and no platform default is set');
  }
  const fromName = (person.send_domain_verified && person.send_from_name) || person.tenant_name;
  const branding = person.tenant_branding || {};

  const { subject, htmlBody, textBody } = buildInviteFollowupEmail({
    tenantName: person.tenant_name,
    customerName: person.name,
    inviteUrl,
    buttonColor: branding.primaryColor,
    rewardAmountCents: person.reward_amount_cents,
    rewardCurrency: person.reward_currency,
    logoUrl: resolveLogoUrl(branding.logoUrl),
    cardNoun: (branding.copy || {}).cardNoun,
    shareButton: (branding.copy || {}).shareButton,
    // The dealer's own reminder wording. Anything they have not written
    // falls back inside the builder to what this email always said.
    followupSubject: (branding.copy || {}).followupSubject,
    followupPreview: (branding.copy || {}).followupPreview,
    followupOpening: (branding.copy || {}).followupOpening,
    followupBeforeLink: (branding.copy || {}).followupBeforeLink,
    followupAfterLink: (branding.copy || {}).followupAfterLink,
    followupClosing: (branding.copy || {}).followupClosing,
    followupSignature: (branding.copy || {}).followupSignature,
    followupDisclaimer: (branding.copy || {}).followupDisclaimer,
    unsubscribeUrl: unsubUrl,
  });

  await sendEmail({
    from: `${fromName} <${fromAddress}>`,
    to: person.email,
    subject,
    htmlBody,
    textBody,
    headers: [{ Name: 'List-Unsubscribe', Value: `<${unsubUrl}>` }],
  });
  return { outcome: 'sent' };
}

// One pass. `limit` bounds a single cycle so a dealer switching the setting
// on for a list of thousands sends them over several hours rather than in
// one burst that a mail provider would read as a blast.
async function runInviteFollowupCycle({ limit = 200, dryRun = false, now = new Date() } = {}) {
  // Every one of these is the platform mailing a customer on its own schedule.
  // A follow-up is due once an invite is older than the interval, so a day
  // skipped is a day later, never a send missed.
  if (isQuietDay(now)) {
    console.log('INVITE_FOLLOWUP quiet_day Sunday: holding follow-ups until Monday');
    return quietDaySummary({ due: 0, skipped: 0, failed: 0, dryRun });
  }
  const due = await withServiceRole(async (client) => {
    await assertServiceRoleConnection(client);
    return findDue(client, limit);
  });
  const summary = { due: due.length, sent: 0, skipped: 0, failed: 0, dryRun };
  if (!due.length) return summary;

  for (const person of due) {
    if (dryRun) {
      console.log(
        `INVITE_FOLLOWUP would send #${person.sequence} to ${person.email} for ${person.tenant_name} (invited ${new Date(person.invited_at).toISOString().slice(0, 10)})`
      );
      summary.sent += 1;
      continue;
    }
    const claimId = await claim(person.customer_id, person.tenant_id, person.sequence);
    if (!claimId) { summary.skipped += 1; continue; }
    try {
      const { outcome } = await sendOne(person);
      if (outcome === 'skipped') {
        await release(claimId);
        summary.skipped += 1;
        continue;
      }
      await withServiceRole((client) =>
        client.query('update invite_followups set sent_at = now() where id = $1', [claimId])
      );
      await noteDeliveryOutcome(person.customer_id, null);
      summary.sent += 1;
      console.log(
        `INVITE_FOLLOWUP sent #${person.sequence} to ${person.email} for ${person.tenant_name}`
      );
    } catch (err) {
      await release(claimId);
      // A reminder refused because the address is suppressed is the clearest
      // signal there is that this customer stopped being reachable, and the
      // dealer should see it in their monthly summary.
      await noteDeliveryOutcome(person.customer_id, err);
      summary.failed += 1;
      console.error(
        `INVITE_FOLLOWUP failed #${person.sequence} to ${person.email} for ${person.tenant_name}: ${err.message}`
      );
    }
  }
  return summary;
}

module.exports = { runInviteFollowupCycle, findDue, MAX_FOLLOWUPS };
