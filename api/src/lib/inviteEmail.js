// Builds the email a customer gets when a staff member creates their
// referral link — the invite that gets them to their own share page. Plain,
// inline-styled HTML (email clients don't reliably support much more)
// plus a text fallback.
//
// Copy is the program message Joseph wrote ("When you recommend ... to a
// friend ..."). The reward amount comes from the tenant's own
// reward_amount_cents (falls back to $50 if it isn't passed).
// buttonColor is the tenant's own branding.primaryColor, so each business's
// invite button is in its own color rather than one tenant's green.
// Shed-dealer wording, used unless the tenant sets branding.copy.offerHow
// ({reward} = the reward amount; **...** = bold in the HTML version). Keep this
// identical to DEFAULT_COPY.offerHow in tenant-branding.js.
const DEFAULT_OFFER_HOW =
  "Here's how it works: Buy a shed from us and receive your own referral link to share. When your friend buys a building through that link, you each receive a **{reward} Amazon E-Gift Card**.";

// "Creative Backyards's referral program" is how a name ending in s reads
// when an apostrophe-s is bolted on regardless. English drops the second s.
function possessive(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

function buildInviteEmail({ tenantName, customerName, inviteUrl, buttonColor, rewardAmountCents, rewardCurrency, logoUrl, offerHow, cardNoun, shareButton, unsubscribeUrl,
  // The email as blocks a dealer can write. The optional ones are left out
  // of the email entirely when blank, rather than rendered as empty space.
  inviteSubject, inviteOpening, inviteHowItWorks, inviteAfterLink, inviteClosing, inviteSignature, inviteDisclaimer }) {
  const btnColor = /^#[0-9a-fA-F]{3,8}$/.test(buttonColor || '') ? buttonColor : '#1C2B33';
  const firstName = (customerName || '').trim().split(' ')[0] || 'there';

  const amount = formatAmount(rewardAmountCents, rewardCurrency);

  // Never an empty button: a tenant that has set no wording gets the generic
  // label rather than an anchor with nothing in it.
  const shareLabel = (typeof shareButton === 'string' && shareButton.trim())
    ? shareButton.trim() : 'Share My Referral Link';

  // Only an absolute https URL is used: email clients can't resolve a
  // relative path, and http images get blocked or flagged.
  const logo = /^https:\/\/[^\s"'<>]+$/i.test(logoUrl || '') ? logoUrl : null;
  const logoHtml = logo
    ? `<p style="margin:0 0 20px;"><img src="${escapeHtml(logo)}" alt="${escapeHtml(tenantName)}" width="160" style="display:block;width:160px;max-width:60%;height:auto;border:0;"></p>`
    : '';

  // Every block goes through the same token filling as the offer line, so
  // {reward} and {name} work wherever a dealer puts them.
  const token = (text, fallback) => {
    const raw = (typeof text === 'string' && text.trim()) ? text.trim() : fallback;
    if (!raw) return '';
    return raw
      .replace(/\{reward\}/g, amount)
      .replace(/\{name\}/g, tenantName)
      .replace(/\{card\}/g, (cardNoun && String(cardNoun).trim()) || 'electronic gift card');
  };

  const subject = token(inviteSubject, `${tenantName} wants to say thank you.`).replace(/\*\*/g, '');

  // A block becomes a paragraph, or nothing at all. **stars** bold a phrase,
  // and a blank line inside a block starts a new paragraph, so a dealer can
  // write a signature on two lines without knowing any HTML.
  const para = (text, style = 'font-size:15px;line-height:1.6;') => {
    if (!text) return '';
    return text.split(/\n\s*\n/).map((chunk) =>
      `<p style="${style}">` +
      escapeHtml(chunk.trim()).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>') +
      '</p>').join('');
  };
  const plain = (text) => (text ? text.replace(/\*\*/g, '') : '');

  const openingText = token(inviteOpening,
    `When you recommend **${tenantName}** to a friend, you're trusting us to take good care of someone you know. That means a lot to us. That's why we designed our new referral program as a simple way to say thank you.`);
  const howText = token(inviteHowItWorks, '');
  const afterLinkText = token(inviteAfterLink, '');
  const closingText = token(inviteClosing,
    'Thank you for supporting our business and giving us the opportunity to serve the people you care about.');
  const signatureText = token(inviteSignature, '');
  const disclaimerText = token(inviteDisclaimer, '');

  const offerTemplate = typeof offerHow === 'string' && offerHow.trim() ? offerHow.trim() : DEFAULT_OFFER_HOW;
  const withAmount = offerTemplate
    .replace(/\{reward\}/g, amount)
    .replace(/\{name\}/g, tenantName)
    .replace(/\{card\}/g, (cardNoun && String(cardNoun).trim()) || 'electronic gift card');
  const offerText = withAmount.replace(/\*\*/g, '');
  const offerHtml = escapeHtml(withAmount).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  const join = (...parts) => parts.filter(Boolean).join('\n\n');
  const textBody = join(
    `Hi ${firstName},`,
    plain(openingText),
    offerText,
    plain(howText),
    `Your personal referral link (it never expires, share it as often as you like):\n${inviteUrl}`,
    plain(afterLinkText),
    plain(closingText),
    plain(signatureText),
    plain(disclaimerText),
    `---\nDon't want emails about ${possessive(tenantName)} referral program? Unsubscribe here:\n${unsubscribeUrl}`
  );

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1B1B1B;">
  ${logoHtml}
  <p style="font-size:15px;line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
  ${para(openingText)}
  <p style="font-size:15px;line-height:1.6;">
    ${offerHtml}
  </p>
  ${para(howText)}
  <p style="margin:28px 0;">
    <a href="${inviteUrl}" style="background:${btnColor};color:#FFFFFF;text-decoration:none;
       padding:14px 22px;border-radius:8px;font-weight:bold;display:inline-block;">
      ${escapeHtml(shareLabel)}
    </a>
  </p>
  <p style="font-size:13px;line-height:1.6;color:#4A4A4A;margin:0 0 4px;">Your personal referral link:</p>
  <p style="font-size:13px;color:#6B6A63;word-break:break-all;margin:0 0 18px;">${inviteUrl}</p>
  ${para(afterLinkText)}
  ${para(closingText)}
  ${para(signatureText)}
  ${para(disclaimerText, 'font-size:12px;line-height:1.6;color:#8A887F;margin-top:18px;')}
  <p style="font-size:12px;color:#8A887F;border-top:1px solid #E6E0D5;padding-top:14px;margin-top:24px;">
    Don't want emails about ${escapeHtml(possessive(tenantName))} referral program?
    <a href="${unsubscribeUrl}" style="color:#8A887F;">Unsubscribe</a>.
  </p>
</div>`;

  return { subject, htmlBody, textBody };
}

function formatAmount(cents, currency) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return '$50';
  const whole = n % 100 === 0;
  const v = whole ? String(n / 100) : (n / 100).toFixed(2);
  return (currency || 'USD').toUpperCase() === 'USD' ? `$${v}` : `${v} ${currency}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { buildInviteEmail };
