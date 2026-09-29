// Builds the email a staff member (and every admin) gets the moment a
// referral is marked paid — the "two $50 gift cards need to go out, here's
// who to send them to and where" alert. Same shape and purpose as
// src/lib/leadNotificationEmail.js's "someone needs to follow up" alert,
// just for the payout step instead of the initial lead.
//
// Two recipients, not one: the referrer (the existing customer who shared
// their link) and the referred friend (who submitted the lead form and, in
// doing so, is on their way to becoming a customer themselves) each get
// their own $50 reward — see tenants.reward_amount_cents and
// per_referral_charge_cents' own comment ("one $X reward for the referrer,
// one for the new customer") for why this has always been a two-person
// payout, not a single lump sum to the referrer alone.
function buildPaidNotificationEmail({
  tenantName,
  staffName,
  referrerName,
  referrerEmail,
  referrerPhone,
  friendName,
  friendEmail,
  friendPhone,
  rewardAmountCents,
  currency,
}) {
  const staffFirstName = (staffName || '').trim().split(' ')[0] || 'there';
  const amount = formatAmount(rewardAmountCents, currency);
  const referrerContact = referrerPhone ? `${referrerEmail} / ${referrerPhone}` : referrerEmail;
  const friendContact = friendPhone ? `${friendEmail} / ${friendPhone}` : friendEmail;

  const subject = `Referral marked paid — send gift cards: ${referrerName} & ${friendName}`;

  const textBody = `Hi ${staffFirstName},

A referral in your ${tenantName} referral program was just marked paid — two ${amount} gift cards need to go out.

Referrer (shared their link):
  ${referrerName}
  ${referrerContact}
  Amount: ${amount}

Referred friend (submitted the lead):
  ${friendName}
  ${friendContact}
  Amount: ${amount}`;

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1B1B1B;">
  <p style="font-size:15px;line-height:1.6;">Hi ${escapeHtml(staffFirstName)},</p>
  <p style="font-size:15px;line-height:1.6;">
    A referral in your <strong>${escapeHtml(tenantName)}</strong> referral program was just marked paid —
    two <strong>${escapeHtml(amount)}</strong> gift cards need to go out.
  </p>
  <div style="font-size:14px;line-height:1.6;color:#3a3a3a;background:#F8F5F0;border-radius:8px;padding:12px 14px;margin:12px 0;">
    <p style="margin:0 0 4px;"><strong>Referrer</strong> (shared their link)</p>
    <p style="margin:0 0 2px;">${escapeHtml(referrerName)}</p>
    <p style="margin:0 0 2px;">${escapeHtml(referrerEmail)}${referrerPhone ? ` / ${escapeHtml(referrerPhone)}` : ''}</p>
    <p style="margin:0;">Amount: ${escapeHtml(amount)}</p>
  </div>
  <div style="font-size:14px;line-height:1.6;color:#3a3a3a;background:#F8F5F0;border-radius:8px;padding:12px 14px;margin:12px 0;">
    <p style="margin:0 0 4px;"><strong>Referred friend</strong> (submitted the lead)</p>
    <p style="margin:0 0 2px;">${escapeHtml(friendName)}</p>
    <p style="margin:0 0 2px;">${escapeHtml(friendEmail)}${friendPhone ? ` / ${escapeHtml(friendPhone)}` : ''}</p>
    <p style="margin:0;">Amount: ${escapeHtml(amount)}</p>
  </div>
</div>`;

  return { subject, htmlBody, textBody };
}

// USD (the only currency any tenant uses today — tenants.reward_currency
// defaults to it and nothing in this codebase sets another) renders as
// "$50.00"; anything else renders as "50.00 EUR" rather than guessing at a
// symbol this codebase has never actually needed.
function formatAmount(amountCents, currency) {
  const amount = (amountCents / 100).toFixed(2);
  return (currency || 'USD').toUpperCase() === 'USD' ? `$${amount}` : `${amount} ${currency}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { buildPaidNotificationEmail };
