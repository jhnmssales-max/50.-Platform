// The three emails around a dealer's yearly 50. fee, all from 50. itself
// (not from the dealer — the dealer's customers never see these):
//   - notice:  a heads-up two weeks before the fee is charged
//   - receipt: the fee went through
//   - failed:  the card on file was declined (sent on each failed attempt)
// Sent to every admin on the tenant, with 50.'s support address on copy.
function buildRenewalEmail(kind, { tenantName, adminName, feeCents, currency, dueAt, paidAt, supportEmail, nextRetryAt, finalAttempt }) {
  const firstName = (adminName || '').trim().split(' ')[0] || 'there';
  const fee = formatAmount(feeCents, currency);
  const dueText = dueAt ? formatDate(dueAt) : null;

  let subject;
  let lines;
  if (kind === 'notice') {
    subject = `Your 50. annual fee of ${fee} renews on ${dueText}`;
    lines = [
      `Your first year with 50. wraps up soon. On ${dueText}, ${fee} will be charged to the card you saved when you activated ${tenantName}. That covers the next 12 months — your referral program keeps running exactly as it is.`,
      `Nothing for you to do. If you'd like to change or cancel before then, reply to this email or write ${supportEmail}.`,
    ];
  } else if (kind === 'receipt') {
    subject = `Receipt: 50. annual fee, ${fee}`;
    lines = [
      `We charged ${fee}${paidAt ? ` on ${formatDate(paidAt)}` : ''} to the card on file for ${tenantName}'s 50. annual fee. That covers the next 12 months${dueText ? `, through ${dueText}` : ''}.`,
      `Thanks for being with us. Questions? Reply to this email or write ${supportEmail}.`,
    ];
  } else if (kind === 'failed') {
    subject = finalAttempt
      ? `Action needed: 50. annual fee for ${tenantName} couldn't be charged`
      : `Your card was declined for the 50. annual fee`;
    lines = [
      `We tried to charge ${fee} to the card on file for ${tenantName}'s 50. annual fee, and it was declined.`,
      finalAttempt
        ? `This was our last automatic try. Please reply to this email or write ${supportEmail} so we can get a working card on file and keep your referral program running.`
        : `We'll try again on ${formatDate(nextRetryAt)}. If the card has changed, reply to this email or write ${supportEmail} and we'll sort it out.`,
    ];
  } else {
    throw new Error(`Unknown renewal email kind: ${kind}`);
  }

  const textBody = [`Hi ${firstName},`, '', ...lines.flatMap((l) => [l, '']), '— 50.'].join('\n').trim();
  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1B1B1B;">
  <p style="font-size:15px;line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
${lines.map((l) => `  <p style="font-size:15px;line-height:1.6;">${escapeHtml(l)}</p>`).join('\n')}
  <p style="font-size:15px;line-height:1.6;">— 50.</p>
</div>`;
  return { subject, htmlBody, textBody };
}

// USD renders as "$100.00"; anything else as "100.00 EUR", same as the
// paid-notification email.
function formatAmount(amountCents, currency) {
  const amount = (amountCents / 100).toFixed(2);
  return (currency || 'USD').toUpperCase() === 'USD' ? `$${amount}` : `${amount} ${currency}`;
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { buildRenewalEmail };
