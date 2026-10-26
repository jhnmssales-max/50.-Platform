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
// Fills a reward note's tokens. Kept here rather than in the route so the
// email and anything that previews it agree on what {name} means -- the
// recipient's FIRST name, because this is a message to one person, not a
// description of them.
//
// An unknown token is left exactly as typed. Blanking it would silently eat
// a typo and send "Hi  -- thank you", where leaving {naem} visible tells
// whoever is about to paste it that something is wrong, while there is still
// time to fix it.
function fillRewardNote(template, { recipientName, amount, cardNoun, businessName }) {
  if (typeof template !== 'string' || !template.trim()) return null;
  const first = (recipientName || '').trim().split(' ')[0] || 'there';
  return template
    .trim()
    .replace(/\{name\}/g, first)
    .replace(/\{reward\}/g, amount)
    .replace(/\{card\}/g, cardNoun || 'electronic gift card')
    .replace(/\{business\}/g, businessName || '')
    .replace(/\*\*/g, '');
}

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
  // The message to send each person alongside their card. Already filled in
  // -- the caller resolves the tenant's own wording and the tokens in it --
  // so this file only has to lay it out somewhere it can be copied cleanly.
  referrerNote,
  friendNote,
  // True when 50. sends this dealer's cards rather than the dealer
  // (tenants.reward_fulfillment = 'platform'). Same two people, same two
  // amounts, same addresses — what changes is who is being told to act,
  // so the wording names the dealer instead of saying "your programme" to
  // someone who does not run it.
  forPlatform = false,
}) {
  const staffFirstName = (staffName || '').trim().split(' ')[0] || 'there';
  const amount = formatAmount(rewardAmountCents, currency);
  const referrerContact = referrerPhone ? `${referrerEmail} / ${referrerPhone}` : referrerEmail;
  const friendContact = friendPhone ? `${friendEmail} / ${friendPhone}` : friendEmail;

  const subject = forPlatform
    ? `${tenantName} — send gift cards: ${referrerName} & ${friendName}`
    : `Referral marked paid — send gift cards: ${referrerName} & ${friendName}`;

  // One sentence does the whole job of saying whose cards these are and
  // whose job it is to send them.
  const leadTextLine = forPlatform
    ? `A referral at ${tenantName} was just marked paid. You send the cards for this dealer — two ${amount} gift cards need to go out.`
    : `A referral in your ${tenantName} referral program was just marked paid — two ${amount} gift cards need to go out.`;
  const leadHtmlLine = forPlatform
    ? `A referral at <strong>${escapeHtml(tenantName)}</strong> was just marked paid. You send the cards for this
    dealer — two <strong>${escapeHtml(amount)}</strong> gift cards need to go out.`
    : `A referral in your <strong>${escapeHtml(tenantName)}</strong> referral program was just marked paid —
    two <strong>${escapeHtml(amount)}</strong> gift cards need to go out.`;

  // The script sits in a white box inside the person's card, in a serif
  // face, so it reads as "these are the words" rather than as more of the
  // alert. Selecting it on a phone then picks up the message and nothing
  // around it.
  function noteBlock(note, key) {
    if (!note) return '';
    // Inert in email clients; lets the wording screenshots pin this block.
    const mark = key ? ` data-copy="${key}"` : '';
    return `<div style="background:#FFFFFF;border:1px solid #E6E0D5;border-radius:6px;padding:10px 12px;margin:8px 0 0;"${mark}>
      <p style="margin:0 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8A8A8A;">Send with their card</p>
      <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.55;color:#1B1B1B;white-space:pre-wrap;">${escapeHtml(note)}</p>
    </div>`;
  }

  const textBody = `Hi ${staffFirstName},

${leadTextLine}

Referrer (shared their link):
  ${referrerName}
  ${referrerContact}
  Amount: ${amount}
${referrerNote ? `
  Send with their card:
  ${referrerNote}
` : ''}
Referred friend (submitted the lead):
  ${friendName}
  ${friendContact}
  Amount: ${amount}
${friendNote ? `
  Send with their card:
  ${friendNote}
` : ''}`;

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1B1B1B;">
  <p style="font-size:15px;line-height:1.6;">Hi ${escapeHtml(staffFirstName)},</p>
  <p style="font-size:15px;line-height:1.6;">${leadHtmlLine}</p>
  <div style="font-size:14px;line-height:1.6;color:#3a3a3a;background:#F8F5F0;border-radius:8px;padding:12px 14px;margin:12px 0;">
    <p style="margin:0 0 4px;"><strong>Referrer</strong> (shared their link)</p>
    <p style="margin:0 0 2px;">${escapeHtml(referrerName)}</p>
    <p style="margin:0 0 2px;">${escapeHtml(referrerEmail)}${referrerPhone ? ` / ${escapeHtml(referrerPhone)}` : ''}</p>
    <p style="margin:0;">Amount: ${escapeHtml(amount)}</p>
    ${noteBlock(referrerNote, 'rewardNoteReferrer')}
  </div>
  <div style="font-size:14px;line-height:1.6;color:#3a3a3a;background:#F8F5F0;border-radius:8px;padding:12px 14px;margin:12px 0;">
    <p style="margin:0 0 4px;"><strong>Referred friend</strong> (submitted the lead)</p>
    <p style="margin:0 0 2px;">${escapeHtml(friendName)}</p>
    <p style="margin:0 0 2px;">${escapeHtml(friendEmail)}${friendPhone ? ` / ${escapeHtml(friendPhone)}` : ''}</p>
    <p style="margin:0;">Amount: ${escapeHtml(amount)}</p>
    ${noteBlock(friendNote, 'rewardNoteFriend')}
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

// The same amount as a customer has already seen it. Every customer-facing
// surface -- the invite email, the share page -- drops a whole amount's
// trailing .00 and says "$50"; this alert says "$50.00", which is right for
// an internal figure and wrong inside a message that is about to be pasted
// into a gift card and sent to the person who was promised $50.
function formatAmountForCustomer(amountCents, currency) {
  const whole = amountCents % 100 === 0;
  const n = whole ? String(amountCents / 100) : (amountCents / 100).toFixed(2);
  return (currency || 'USD').toUpperCase() === 'USD' ? `$${n}` : `${n} ${currency}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { buildPaidNotificationEmail, fillRewardNote, formatRewardAmount: formatAmount, formatAmountForCustomer };
