// The reminder, as distinct from the invite.
//
// The first email thanks someone for their business and explains the
// programme. Sending that same email again six months later reads as a
// mistake -- it welcomes a person who was welcomed already, and explains
// something they were told once. So this one assumes all of that and does
// one job: here is your link, it still works.
//
// Short on purpose. Its competition is the delete key.

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

  // Says whose link and what it is worth, which is everything someone needs
  // to decide whether to open it.
  const subject = `Your ${tenantName} referral link is still here`;

  const textBody = `Hi ${firstName},

A quick reminder that you have a referral link for ${tenantName}, and it still works.

If you know someone who could use us, send them your link. When they buy, you each get a ${amount} ${card}.

${inviteUrl}

---
Don't want emails about ${tenantName}'s referral program? Unsubscribe here:
${unsubscribeUrl}`;

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1B1B1B;">
  ${logoHtml}
  <p style="font-size:15px;line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
  <p style="font-size:15px;line-height:1.6;">
    A quick reminder that you have a referral link for
    <strong>${escapeHtml(tenantName)}</strong>, and it still works.
  </p>
  <p style="font-size:15px;line-height:1.6;">
    If you know someone who could use us, send them your link. When they buy,
    you each get a <strong>${escapeHtml(amount)}</strong> ${escapeHtml(card)}.
  </p>
  <p style="margin:28px 0;">
    <a href="${inviteUrl}" style="background:${btnColor};color:#FFFFFF;text-decoration:none;
       padding:14px 22px;border-radius:8px;font-weight:bold;display:inline-block;">
      ${escapeHtml(shareLabel)}
    </a>
  </p>
  <p style="font-size:12px;color:#6B6A63;word-break:break-all;">
    Or copy this link: ${inviteUrl}
  </p>
  <p style="font-size:12px;color:#8A887F;border-top:1px solid #E6E0D5;padding-top:14px;margin-top:24px;">
    Don't want emails about ${escapeHtml(tenantName)}'s referral program?
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
