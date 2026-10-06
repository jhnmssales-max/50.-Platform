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
function buildInviteEmail({ tenantName, customerName, inviteUrl, buttonColor, rewardAmountCents, rewardCurrency, logoUrl }) {
  const btnColor = /^#[0-9a-fA-F]{3,8}$/.test(buttonColor || '') ? buttonColor : '#1C2B33';
  const firstName = (customerName || '').trim().split(' ')[0] || 'there';

  const amount = formatAmount(rewardAmountCents, rewardCurrency);

  // Only an absolute https URL is used: email clients can't resolve a
  // relative path, and http images get blocked or flagged.
  const logo = /^https:\/\/[^\s"'<>]+$/i.test(logoUrl || '') ? logoUrl : null;
  const logoHtml = logo
    ? `<p style="margin:0 0 20px;"><img src="${escapeHtml(logo)}" alt="${escapeHtml(tenantName)}" width="160" style="display:block;width:160px;max-width:60%;height:auto;border:0;"></p>`
    : '';

  const subject = `${tenantName} wants to say thank you.`;

  const textBody = `Hi ${firstName},

When you recommend ${tenantName} to a friend, you're trusting us to take good care of someone you know. That means a lot to us. That's why we designed our new referral program as a simple way to say thank you.

Here's how it works: Buy a shed from us and receive your own referral link to share. When your friend buys a building through that link, you each receive a ${amount} Amazon E-Gift Card.

Thank you for supporting our business and giving us the opportunity to serve the people you care about.

Your personal referral link (it never expires, share it as often as you like):
${inviteUrl}`;

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1B1B1B;">
  ${logoHtml}
  <p style="font-size:15px;line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
  <p style="font-size:15px;line-height:1.6;">
    When you recommend <strong>${escapeHtml(tenantName)}</strong> to a friend, you're trusting us to take good care of someone you know.
    That means a lot to us. That's why we designed our new referral program as a simple way to say thank you.
  </p>
  <p style="font-size:15px;line-height:1.6;">
    Here's how it works: Buy a shed from us and receive your own referral link to share. When your friend buys a building
    through that link, you each receive a <strong>${escapeHtml(amount)} Amazon E-Gift Card</strong>.
  </p>
  <p style="font-size:15px;line-height:1.6;">
    Thank you for supporting our business and giving us the opportunity to serve the people you care about.
  </p>
  <p style="margin:28px 0;">
    <a href="${inviteUrl}" style="background:${btnColor};color:#FFFFFF;text-decoration:none;
       padding:14px 22px;border-radius:8px;font-weight:bold;display:inline-block;">
      Get my referral link
    </a>
  </p>
  <p style="font-size:12px;color:#6B6A63;word-break:break-all;">
    Or copy this link: ${inviteUrl}
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
