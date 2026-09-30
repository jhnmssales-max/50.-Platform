// Builds the email a customer gets when a staff member creates their
// referral link — the invite that gets them to their own share page. Plain,
// inline-styled HTML (email clients don't reliably support much more)
// plus a text fallback.
//
// Copy is fixed, not templated off a tenant's own reward_amount_cents —
// it says "$50 gift card" literally, matching the exact wording
// asked for. routes/customers.js's caller still passes
// rewardAmountCents/rewardCurrency alongside these three; they're simply
// ignored here now rather than removed from the call site, since neither
// is otherwise reused.
// buttonColor is the tenant's own branding.primaryColor, so each business's
// invite button is in its own color rather than one tenant's green.
function buildInviteEmail({ tenantName, customerName, inviteUrl, buttonColor }) {
  const btnColor = /^#[0-9a-fA-F]{3,8}$/.test(buttonColor || '') ? buttonColor : '#1C2B33';
  const firstName = (customerName || '').trim().split(' ')[0] || 'there';

  const subject = `${tenantName} wants to say thank you.`;

  const textBody = `Hi ${firstName}, ${tenantName} wants to say thank you.

If you know a friend or family member who's in need of our services, we'd appreciate your recommendation. Share your personal link below. When your friend places an order, you'll both get a $50 gift card emailed to you — no strings attached.

Your link never expires and can be shared as many times as you like. Text it, post it, or hand it out to as many friends and family as you'd like.

${inviteUrl}`;

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1B1B1B;">
  <p style="font-size:15px;line-height:1.6;">
    Hi ${escapeHtml(firstName)}, <strong>${escapeHtml(tenantName)}</strong> wants to say thank you.
  </p>
  <p style="font-size:15px;line-height:1.6;">
    If you know a friend or family member who's in need of our services, we'd appreciate your recommendation.
    Share your personal link below. When your friend places an order, you'll both get a
    <strong>$50 gift card</strong> emailed to you — no strings attached.
  </p>
  <p style="font-size:15px;line-height:1.6;">
    Your link never expires and can be shared as many times as you like. Text it, post it, or hand it
    out to as many friends and family as you'd like.
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { buildInviteEmail };
