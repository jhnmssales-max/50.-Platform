// The email a sales rep gets when Joseph gives them a login to their own
// pipeline. It carries a one-time link to choose a password (see
// lib/supabaseAdmin.js) — never a password itself, and never a temporary one.
//
// Sent as "Joseph at 50." from the platform's one verified sending address,
// with Joseph's own address as Reply-To, so it reads as coming from him and a
// reply reaches him. The alternative — sending as joseph@referwith50.com
// directly — would need that address verified as a Postmark sender signature
// and risks the mail being treated as spoofed until it is.
const FONT = 'font-family:Arial,Helvetica,sans-serif;';
const PARA = `${FONT}font-size:15px;line-height:1.6;margin:0 0 14px;`;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function firstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return first || 'there';
}

// The link is deliberately shown as its own full line as well as a button:
// plenty of mail clients strip or rewrite buttons, and a rep who cannot click
// has to be able to copy it.
function build({ repName, link, signInUrl, logoUrl, resend = false }) {
  const hi = firstName(repName);
  const lead = resend
    ? 'Here is a fresh link to set your password for the 50. reps page — the last one may have expired.'
    : 'You have a login for the 50. reps page. This is where you add the companies you are working, and see what you have earned.';

  const text = [
    `Hi ${hi},`,
    '',
    lead,
    '',
    'Set your password here (this link works once, and expires):',
    link,
    '',
    `After that, sign in any time at: ${signInUrl}`,
    '',
    'What you will find there:',
    '- Leads: add a company you are talking to. Mark it Won when they say yes.',
    '- Dealers: the companies you have signed.',
    '- Money: what you have earned and what is owed to you.',
    '',
    'If anything looks wrong, reply to this email.',
    '',
    'Joseph',
    '50.',
  ].join('\n');

  const html = `
<div style="${FONT}max-width:480px;margin:0 auto;color:#1B1B1B;">
  ${logoUrl ? `<p style="margin:0 0 18px;"><img src="${escapeHtml(logoUrl)}" width="44" height="44" alt="50." style="display:block;border:0;" /></p>` : ''}
  <p style="${PARA}">Hi ${escapeHtml(hi)},</p>
  <p style="${PARA}">${escapeHtml(lead)}</p>
  <p style="margin:0 0 18px;">
    <a href="${escapeHtml(link)}" style="${FONT}display:inline-block;background:#1C2B33;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:bold;padding:11px 20px;border-radius:8px;">Set your password</a>
  </p>
  <p style="${FONT}font-size:13px;line-height:1.6;color:#6B6A63;margin:0 0 18px;">This link works once and expires. If the button does not work, copy this:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
  <p style="${PARA}">After that you can sign in any time at <a href="${escapeHtml(signInUrl)}" style="color:#33475A;font-weight:bold;">${escapeHtml(signInUrl)}</a>.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EE;border-radius:8px;margin:4px 0 16px;"><tr><td style="padding:12px 16px;">
    <p style="${FONT}font-size:14px;line-height:1.6;margin:0 0 8px;"><b>Leads</b> — add a company you are talking to. Mark it Won when they say yes.</p>
    <p style="${FONT}font-size:14px;line-height:1.6;margin:0 0 8px;"><b>Dealers</b> — the companies you have signed.</p>
    <p style="${FONT}font-size:14px;line-height:1.6;margin:0;"><b>Money</b> — what you have earned and what is owed to you.</p>
  </td></tr></table>
  <p style="${PARA}">If anything looks wrong, reply to this email.</p>
  <p style="${PARA}">Joseph<br>50.</p>
</div>`.trim();

  return {
    subject: resend ? 'Your new link for the 50. reps page' : 'Your login for the 50. reps page',
    textBody: text,
    htmlBody: html,
  };
}

module.exports = { build };
