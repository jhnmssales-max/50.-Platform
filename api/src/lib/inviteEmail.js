function formatReward(amountCents, currency) {
  return (amountCents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

// Builds the email a customer gets when a dealer creates their referral
// link — the invite that gets them to their own share page. Plain,
// inline-styled HTML (email clients don't reliably support much more)
// plus a text fallback.
function buildInviteEmail({ tenantName, rewardAmountCents, rewardCurrency, customerName, inviteUrl }) {
  const reward = formatReward(rewardAmountCents, rewardCurrency);
  const firstName = (customerName || '').trim().split(' ')[0] || 'there';

  const subject = `Refer a friend, get ${reward} — from ${tenantName}`;

  const textBody = `Hi ${firstName},

${tenantName} wants to say thanks — here's your personal referral link. Share it with a friend, and when they place an order, you'll both get ${reward}.

${inviteUrl}

Thanks,
${tenantName}`;

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1B1B1B;">
  <p style="font-size:15px;line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
  <p style="font-size:15px;line-height:1.6;">
    ${escapeHtml(tenantName)} wants to say thanks — here's your personal referral link.
    Share it with a friend, and when they place an order, you'll both get
    <strong>${reward}</strong>.
  </p>
  <p style="margin:28px 0;">
    <a href="${inviteUrl}" style="background:#1F4D36;color:#F8F5F0;text-decoration:none;
       padding:14px 22px;border-radius:8px;font-weight:bold;display:inline-block;">
      Get my referral link
    </a>
  </p>
  <p style="font-size:12px;color:#6B6A63;word-break:break-all;">
    Or copy this link: ${inviteUrl}
  </p>
  <p style="font-size:14px;color:#6B6A63;">Thanks,<br>${escapeHtml(tenantName)}</p>
</div>`;

  return { subject, htmlBody, textBody };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { buildInviteEmail, formatReward };
