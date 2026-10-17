// The two emails that go out the moment Joseph approves a build: one to the
// dealer, one to the rep who closed them.
//
// The dealer's carries a one-time link to choose their own password — never a
// password (see lib/supabaseAdmin.js). It also says plainly what happens at
// first sign-in, because the next thing they see is a $500 payment page and
// being surprised by that is a bad first minute with a product they just
// bought.
//
// Both go out as "Joseph at 50." from the one verified sending address, with
// his own address as Reply-To, for the reason in lib/repInviteEmail.js.
const FONT = 'font-family:Arial,Helvetica,sans-serif;';
const PARA = `${FONT}font-size:15px;line-height:1.6;margin:0 0 14px;`;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
}

function button(href, label) {
  return `<p style="margin:0 0 18px;"><a href="${escapeHtml(href)}" style="${FONT}display:inline-block;background:#1C2B33;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:bold;padding:11px 20px;border-radius:8px;">${escapeHtml(label)}</a></p>`;
}

function fallbackLink(link) {
  return `<p style="${FONT}font-size:13px;line-height:1.6;color:#6B6A63;margin:0 0 18px;">This link works once and expires. If the button does not work, copy this:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>`;
}

function logoBlock(logoUrl) {
  return logoUrl
    ? `<p style="margin:0 0 18px;"><img src="${escapeHtml(logoUrl)}" width="44" height="44" alt="50." style="display:block;border:0;" /></p>`
    : '';
}

// ---------------------------------------------------------------------------
// To the dealer's own admin
// ---------------------------------------------------------------------------
function forDealer({ contactName, companyName, link, signInUrl, activationFeeCents, annualFeeCents,
                     referralFeeCents, chargeCardCost, rewardFulfillment, cardNoun,
                     rewardAmountCents, repName, logoUrl }) {
  const hi = firstName(contactName);
  const fee = money(activationFeeCents);
  const card = money(rewardAmountCents);
  // Every figure here comes from this dealer's own terms. These lines used to
  // be hardcoded -- "$100 a year", "30% of that payout" -- which stopped
  // being true the moment prices became per-dealer, and the 30% stopped
  // being true at all when the fee became a flat amount.
  const yearly = money(annualFeeCents);
  const perReferral = money(referralFeeCents);
  const noun = (cardNoun && String(cardNoun).trim()) || 'gift card';
  const weSend = rewardFulfillment === 'platform';
  const rewardSentence = weSend
    ? `When one of your customers refers a friend and that job closes, we email both of them a ${card} ${noun}.`
    : `When one of your customers refers a friend and that job closes, you send both of them a ${card} ${noun}.`;
  const costSentence = chargeCardCost
    ? `Your card on file is charged for the two cards plus a ${perReferral} fee.`
    : `Your card on file is charged ${perReferral}.`;

  const text = [
    `Hi ${hi},`,
    '',
    `Your 50. referral program for ${companyName} is set up and ready.`,
    '',
    'Set your password here (this link works once, and expires):',
    link,
    '',
    `Then sign in any time at: ${signInUrl}`,
    '',
    'What happens when you sign in:',
    `- There is a one-time ${fee} setup payment to switch the program on. That covers your first 12 months.`,
    `- After that it is ${yearly} a year.`,
    `- ${rewardSentence} ${costSentence}`,
    '',
    'Your colours and logo are already on your pages. If anything looks off, reply to this email and we will fix it.',
    '',
    repName ? `${repName} set this up with you — they are still your contact.` : '',
    '',
    'Joseph',
    '50.',
  ].filter((l) => l !== null).join('\n');

  const html = `
<div style="${FONT}max-width:480px;margin:0 auto;color:#1B1B1B;">
  ${logoBlock(logoUrl)}
  <p style="${PARA}">Hi ${escapeHtml(hi)},</p>
  <p style="${PARA}">Your 50. referral program for <b>${escapeHtml(companyName)}</b> is set up and ready.</p>
  ${button(link, 'Set your password')}
  ${fallbackLink(link)}
  <p style="${PARA}">Then sign in any time at <a href="${escapeHtml(signInUrl)}" style="color:#33475A;font-weight:bold;">${escapeHtml(signInUrl)}</a>.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EE;border-radius:8px;margin:4px 0 16px;"><tr><td style="padding:12px 16px;">
    <p style="${FONT}font-size:14px;line-height:1.6;margin:0 0 8px;"><b>When you sign in</b> there is a one-time ${escapeHtml(fee)} setup payment to switch the program on. That covers your first 12 months.</p>
    <p style="${FONT}font-size:14px;line-height:1.6;margin:0 0 8px;">After that it is ${escapeHtml(yearly)} a year.</p>
    <p style="${FONT}font-size:14px;line-height:1.6;margin:0;">${escapeHtml(rewardSentence)} ${escapeHtml(costSentence)}</p>
  </td></tr></table>
  <p style="${PARA}">Your colours and logo are already on your pages. If anything looks off, reply to this email and we will fix it.</p>
  ${repName ? `<p style="${PARA}">${escapeHtml(repName)} set this up with you — they are still your contact.</p>` : ''}
  <p style="${PARA}">Joseph<br>50.</p>
</div>`.trim();

  return { subject: `${companyName}: your 50. referral program is ready`, textBody: text, htmlBody: html };
}

// ---------------------------------------------------------------------------
// To the rep who closed them
// ---------------------------------------------------------------------------
function forRep({ repName, companyName, contactName, contactEmail, signInUrl, activationFeeCents, logoUrl }) {
  const hi = firstName(repName);
  const fee = money(activationFeeCents);

  const text = [
    `Hi ${hi},`,
    '',
    `${companyName} is live. Their account is built and ${contactName || 'their contact'} has been emailed a link to set their password.`,
    '',
    `What happens next: they sign in and pay the one-time ${fee}. Your $50 lands once that payment clears — usually within an hour of it going through.`,
    '',
    'If they go quiet, give them a nudge. You can see where they stand on your Dealers tab:',
    signInUrl,
    '',
    'Nice work.',
    '',
    'Joseph',
    '50.',
  ].join('\n');

  const html = `
<div style="${FONT}max-width:480px;margin:0 auto;color:#1B1B1B;">
  ${logoBlock(logoUrl)}
  <p style="${PARA}">Hi ${escapeHtml(hi)},</p>
  <p style="${PARA}"><b>${escapeHtml(companyName)} is live.</b> Their account is built and ${escapeHtml(contactName || 'their contact')}${contactEmail ? ` (${escapeHtml(contactEmail)})` : ''} has been emailed a link to set their password.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EE;border-radius:8px;margin:4px 0 16px;"><tr><td style="padding:12px 16px;">
    <p style="${FONT}font-size:14px;line-height:1.6;margin:0;">They sign in and pay the one-time ${escapeHtml(fee)}. <b>Your $50 lands once that payment clears</b> — usually within an hour of it going through.</p>
  </td></tr></table>
  <p style="${PARA}">If they go quiet, give them a nudge. You can see where they stand on your <a href="${escapeHtml(signInUrl)}" style="color:#33475A;font-weight:bold;">Dealers tab</a>.</p>
  <p style="${PARA}">Nice work.</p>
  <p style="${PARA}">Joseph<br>50.</p>
</div>`.trim();

  return { subject: `${companyName} is live`, textBody: text, htmlBody: html };
}

// ---------------------------------------------------------------------------
// To someone being added to a dealer AFTER it is built
// ---------------------------------------------------------------------------
// Deliberately not the build email: the program is already running, there is
// no setup payment ahead of them, and quoting prices to a colleague who was
// added to help is both wrong and none of their business. What they need is
// the link, where to sign in, and what the platform will email them about.
function forExtraAdmin({ contactName, companyName, link, signInUrl, logoUrl }) {
  const hi = firstName(contactName);

  const text = [
    `Hi ${hi},`,
    '',
    `You have been given a login for ${companyName}'s 50. referral program.`,
    '',
    'Set your password here (this link works once, and expires):',
    link,
    '',
    `Then sign in any time at: ${signInUrl}`,
    '',
    'What you will see: every referral your customers have sent, and a button to mark one paid once that job closes.',
    '',
    'You will also be emailed whenever a referral is marked paid, so the gift cards can go out.',
    '',
    'Questions? Reply to this email.',
    '',
    '— 50.',
  ].join('\n');

  const html = `
<div style="${FONT}max-width:480px;margin:0 auto;color:#1B1B1B;">
  ${logoBlock(logoUrl)}
  <p style="${PARA}">Hi ${escapeHtml(hi)},</p>
  <p style="${PARA}">You have been given a login for <b>${escapeHtml(companyName)}</b>'s 50. referral program.</p>
  ${button(link, 'Set your password')}
  ${fallbackLink(link)}
  <p style="${PARA}">Then sign in any time at <a href="${escapeHtml(signInUrl)}" style="color:#33475A;font-weight:bold;">${escapeHtml(signInUrl)}</a>.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EE;border-radius:8px;margin:4px 0 16px;"><tr><td style="padding:12px 16px;">
    <p style="${FONT}font-size:14px;line-height:1.6;margin:0 0 8px;">You will see every referral your customers have sent, and a button to mark one paid once that job closes.</p>
    <p style="${FONT}font-size:14px;line-height:1.6;margin:0;">You will also be emailed whenever a referral is marked paid, so the gift cards can go out.</p>
  </td></tr></table>
  <p style="${PARA}">Questions? Reply to this email.</p>
  <p style="${PARA}">— 50.</p>
</div>`;

  return { subject: `Your login for ${companyName}'s referral program`, textBody: text, htmlBody: html };
}

module.exports = { forDealer, forRep, forExtraAdmin };
