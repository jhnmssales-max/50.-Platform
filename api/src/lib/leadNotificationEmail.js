// Builds the email a dealer gets the moment one of their customers'
// referrals actually submits the lead form — this is the "someone needs
// to follow up" alert, distinct from src/lib/inviteEmail.js (which goes
// to the customer, not the dealer).
function buildLeadNotificationEmail({ tenantName, dealerName, leadName, leadEmail, leadPhone, leadMessage, referrerName }) {
  const dealerFirstName = (dealerName || '').trim().split(' ')[0] || 'there';
  const contact = leadPhone ? `${leadEmail} / ${leadPhone}` : leadEmail;
  const messageLine = leadMessage
    ? `Here's what they said: "${leadMessage}"`
    : `They didn't leave a message, but you have their contact info below.`;

  const subject = `New referral lead — ${leadName}`;

  const textBody = `Hi ${dealerFirstName},

You've received a new lead through your ${tenantName} referral program.

${leadName} is interested. ${messageLine}

Contact them at: ${contact}

This came from your customer ${referrerName}.`;

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1B1B1B;">
  <p style="font-size:15px;line-height:1.6;">Hi ${escapeHtml(dealerFirstName)},</p>
  <p style="font-size:15px;line-height:1.6;">
    You've received a new lead through your <strong>${escapeHtml(tenantName)}</strong> referral program.
  </p>
  <p style="font-size:15px;line-height:1.6;">
    <strong>${escapeHtml(leadName)}</strong> is interested.
    ${leadMessage
      ? `Here's what they said:</p>
  <p style="font-size:14px;line-height:1.6;color:#3a3a3a;background:#F8F5F0;border-radius:8px;padding:12px 14px;margin:12px 0;">
    "${escapeHtml(leadMessage)}"
  </p>`
      : `They didn't leave a message, but you have their contact info below.</p>`}
  <p style="font-size:14px;line-height:1.6;">
    <strong>Contact:</strong> ${escapeHtml(leadEmail)}${leadPhone ? ` / ${escapeHtml(leadPhone)}` : ''}
  </p>
  <p style="font-size:13px;color:#6B6A63;">This came from your customer ${escapeHtml(referrerName)}.</p>
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

module.exports = { buildLeadNotificationEmail };
