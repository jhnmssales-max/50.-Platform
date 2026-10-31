// The reminder, as distinct from the invite.
//
// The first email thanks someone for their business and explains the
// programme. Sending that same email again months later reads as a mistake --
// it welcomes a person who was welcomed already, and explains something they
// were told once. So this one assumes all of that and does one job: here is
// your link, it still works.
//
// Short on purpose. Its competition is the delete key.
//
// Built from blocks a dealer can write, the same way inviteEmail.js is. Every
// block defaults to exactly what this email said before it was editable, so
// no dealer's follow-ups change because this went in -- only the ones who
// write their own.

// "Creative Backyards's referral program" is how a name ending in s reads
// when an apostrophe-s is bolted on regardless. English drops the second s.
// Same helper as inviteEmail.js, for the same reason.
function possessive(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

function buildInviteFollowupEmail({
  tenantName,
  customerName,
  inviteUrl,
  buttonColor,
  rewardAmountCents,
  rewardCurrency,
  logoUrl,
  shareButton,
  cardNoun,
  unsubscribeUrl,
  // The dealer's own wording, each optional.
  followupSubject,
  followupPreview,
  followupOpening,
  followupBeforeLink,
  followupAfterLink,
  followupClosing,
  followupSignature,
  followupDisclaimer,
}) {
  const btnColor = /^#[0-9a-fA-F]{3,8}$/.test(buttonColor || '') ? buttonColor : '#1C2B33';
  const firstName = (customerName || '').trim().split(' ')[0] || 'there';
  const amount = formatAmount(rewardAmountCents, rewardCurrency);
  const card = (cardNoun || '').trim() || 'gift card';
  const logo = /^https:\/\/[^\s"'<>]+$/i.test(logoUrl || '') ? logoUrl : null;
  const shareLabel = (typeof shareButton === 'string' && shareButton.trim())
    ? shareButton.trim() : 'Share My Referral Link';
  const logoHtml = logo
    ? `<p style="margin:0 0 20px;"><img src="${escapeHtml(logo)}" alt="${escapeHtml(tenantName)}" width="160" style="display:block;width:160px;max-width:60%;height:auto;border:0;"></p>`
    : '';

  // Same token filling as the invite, so {reward}, {name} and {card} work
  // wherever a dealer puts them.
  const token = (text, fallback) => {
    const raw = (typeof text === 'string' && text.trim()) ? text.trim() : fallback;
    if (!raw) return '';
    return raw
      .replace(/\{reward\}/g, amount)
      .replace(/\{name\}/g, tenantName)
      .replace(/\{card\}/g, card);
  };

  // Says whose link and what it is worth, which is everything someone needs
  // to decide whether to open it.
  const subject = token(followupSubject, `Your ${tenantName} referral link is still here`).replace(/\*\*/g, '');

  // A block becomes a paragraph, or nothing at all. **stars** bold a phrase,
  // and a blank line inside a block starts a new paragraph, so a dealer can
  // write a list or a signature without knowing any HTML.
  const para = (text, style = 'font-size:15px;line-height:1.6;', key = '') => {
    if (!text) return '';
    const mark = key ? ` data-copy="${key}"` : '';
    return text.split(/\n\s*\n/).map((chunk) =>
      `<p style="${style}"${mark}>` +
      escapeHtml(chunk.trim()).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>') +
      '</p>').join('');
  };
  const plain = (text) => (text ? text.replace(/\*\*/g, '') : '');

  const openingText = token(followupOpening,
    `A quick reminder that you have a referral link for **${tenantName}**, and it still works.\n\nIf you know someone who could use us, send them your link. When they buy, you each get a **${amount}** ${card}.`);
  const beforeLinkText = token(followupBeforeLink, '');
  const afterLinkText = token(followupAfterLink, '');
  const closingText = token(followupClosing, '');
  const signatureText = token(followupSignature, '');
  const disclaimerText = token(followupDisclaimer, '');
  const previewText = token(followupPreview, '');

  const join = (...parts) => parts.filter(Boolean).join('\n\n');
  const textBody = join(
    `Hi ${firstName},`,
    plain(openingText),
    plain(beforeLinkText),
    inviteUrl,
    plain(afterLinkText),
    plain(closingText),
    plain(signatureText),
    plain(disclaimerText),
    `---\nDon't want emails about ${possessive(tenantName)} referral program? Unsubscribe here:\n${unsubscribeUrl}`
  );

  // The preheader is the grey line a phone shows after the subject. Hidden in
  // the body itself, which is the only way every client honours it.
  const preheaderHtml = previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(plain(previewText))}</div>`
    : '';

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1B1B1B;">
  ${preheaderHtml}
  ${logoHtml}
  <p style="font-size:15px;line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
  ${para(openingText, 'font-size:15px;line-height:1.6;', 'followupOpening')}
  ${para(beforeLinkText, 'font-size:15px;line-height:1.6;', 'followupBeforeLink')}
  <p style="margin:28px 0;">
    <a href="${inviteUrl}" style="background:${btnColor};color:#FFFFFF;text-decoration:none;
       padding:14px 22px;border-radius:8px;font-weight:bold;display:inline-block;">
      ${escapeHtml(shareLabel)}
    </a>
  </p>
  <p style="font-size:12px;color:#6B6A63;word-break:break-all;">
    Or copy this link: ${inviteUrl}
  </p>
  ${para(afterLinkText, 'font-size:15px;line-height:1.6;', 'followupAfterLink')}
  ${para(closingText, 'font-size:15px;line-height:1.6;', 'followupClosing')}
  ${para(signatureText, 'font-size:15px;line-height:1.6;color:#3A3A3A;', 'followupSignature')}
  ${para(disclaimerText, 'font-size:12px;line-height:1.55;color:#6B6A63;', 'followupDisclaimer')}
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
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { buildInviteFollowupEmail };
