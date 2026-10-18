// The money emails 50. sends a dealer, all from 50. itself (never from the
// dealer — the dealer's own customers never see these) to every admin on the
// dealer's account:
//   - activation receipt: right after the one-time activation payment
//   - referral summary:   one a month, only for months with charged referral
//                         fees, listing every fee charged
//   - yearly summary:     one a year, the calendar year's totals
// The yearly-fee notice / receipt / failed-charge emails are separate
// (lib/renewalEmail.js, sent by workers/annualRenewal.js).
//
// Plain inline-styled HTML (email clients don't reliably support more) plus
// a text version, in the same shape as the renewal emails. Dates and months
// are America/New_York — 50.'s own time zone — so a charge at 9 pm on the
// 31st is listed on the 31st and lands in that month's summary.
const { computeReferralFee } = require('./referralFee');

const BILLING_TIME_ZONE = 'America/New_York';
const DEFAULT_SUPPORT_EMAIL = 'joseph@referwith50.com';

function supportEmail() {
  return process.env.BILLING_SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatMoney(cents, currency) {
  const code = (currency || 'USD').toUpperCase();
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format((Number(cents) || 0) / 100);
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: BILLING_TIME_ZONE });
}

function formatShortDate(d) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: BILLING_TIME_ZONE });
}

// '2026-10' -> 'October 2026'. Built from the parts, not parsed as a Date,
// so no time zone can move it to September.
function formatMonth(period) {
  const [year, month] = String(period).split('-').map(Number);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[month - 1]} ${year}`;
}


function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function firstNameOf(adminName) {
  return (adminName || '').trim().split(' ')[0] || 'there';
}

// "card" or "bank account" — what the dealer saved at activation.
function methodWord(paymentMethodType) {
  return paymentMethodType === 'us_bank_account' ? 'bank account' : 'card';
}

// ---------------------------------------------------------------------------
// Layout. Each email is a list of blocks:
//   { p }                       a paragraph
//   { box: [[label, value]] }   a tinted receipt box of label/value lines
//   { table: { head, rows, foot } }
//   { link: { text, url } }
// rendered to HTML and to text from the same description, so the two can
// never say different things.
// ---------------------------------------------------------------------------

const FONT = 'font-family:Arial,Helvetica,sans-serif;';
const PARA = `${FONT}font-size:15px;line-height:1.6;margin:0 0 14px;`;
const CELL = `${FONT}font-size:14px;line-height:1.5;padding:7px 0;border-bottom:1px solid #E7E2D8;vertical-align:top;`;

function renderHtml(firstName, blocks) {
  const parts = blocks.map((b) => {
    if (b.p !== undefined) return `<p style="${PARA}">${escapeHtml(b.p)}</p>`;
    if (b.box) {
      const rows = b.box
        .map(
          ([label, value]) =>
            `<tr><td style="${FONT}font-size:13px;color:#6B6A63;padding:5px 12px 5px 0;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>` +
            `<td style="${FONT}font-size:14px;font-weight:bold;padding:5px 0;text-align:right;">${escapeHtml(value)}</td></tr>`
        )
        .join('');
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F4EE;border-radius:8px;margin:4px 0 16px;"><tr><td style="padding:10px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr></table>`;
    }
    if (b.table) {
      const { head, rows, foot } = b.table;
      const align = (i) => (i === head.length - 1 ? 'text-align:right;' : 'text-align:left;');
      const th = head
        .map((h, i) => `<th style="${FONT}font-size:12px;font-weight:bold;color:#6B6A63;text-transform:uppercase;letter-spacing:.04em;padding:0 0 6px;border-bottom:2px solid #1B1B1B;${align(i)}">${escapeHtml(h)}</th>`)
        .join('');
      const body = rows
        .map((r) => `<tr>${r.map((c, i) => `<td style="${CELL}${align(i)}${i === 0 ? 'white-space:nowrap;padding-right:10px;' : ''}">${c.html !== undefined ? c.html : escapeHtml(c)}</td>`).join('')}</tr>`)
        .join('');
      const tf = foot
        ? `<tr>${foot.map((c, i) => `<td style="${FONT}font-size:14px;font-weight:bold;padding:9px 0 0;${align(i)}">${escapeHtml(c)}</td>`).join('')}</tr>`
        : '';
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 16px;border-collapse:collapse;"><tr>${th}</tr>${body}${tf}</table>`;
    }
    if (b.link) {
      return `<p style="${PARA}"><a href="${escapeHtml(b.link.url)}" style="color:#33475A;font-weight:bold;">${escapeHtml(b.link.text)}</a></p>`;
    }
    return '';
  });
  return `
<div style="${FONT}max-width:480px;margin:0 auto;color:#1B1B1B;">
  <p style="${PARA}">Hi ${escapeHtml(firstName)},</p>
${parts.map((p) => `  ${p}`).join('\n')}
  <p style="${PARA}">— 50.</p>
</div>`;
}

function textCell(c) {
  return c && c.text !== undefined ? c.text : String(c);
}

function renderText(firstName, blocks) {
  const out = [`Hi ${firstName},`, ''];
  for (const b of blocks) {
    if (b.p !== undefined) {
      out.push(b.p, '');
    } else if (b.box) {
      const w = Math.max(...b.box.map(([l]) => l.length));
      for (const [label, value] of b.box) out.push(`  ${`${label}:`.padEnd(w + 2)}${value}`);
      out.push('');
    } else if (b.table) {
      const { head, rows, foot } = b.table;
      const all = [head, ...rows.map((r) => r.map(textCell)), ...(foot ? [foot] : [])];
      const widths = head.map((_, i) => Math.max(...all.map((r) => String(r[i] || '').length)));
      const line = (r) => `  ${r.map((c, i) => (i === r.length - 1 ? String(c || '').padStart(widths[i]) : String(c || '').padEnd(widths[i]))).join('  ')}`.trimEnd();
      out.push(line(head));
      for (const r of rows) out.push(line(r.map(textCell)));
      if (foot) out.push(line(foot));
      out.push('');
    } else if (b.link) {
      out.push(`${b.link.text}: ${b.link.url}`, '');
    }
  }
  out.push('— 50.');
  return out.join('\n');
}

function finish(adminName, subject, blocks) {
  const first = firstNameOf(adminName);
  return { subject, htmlBody: renderHtml(first, blocks), textBody: renderText(first, blocks) };
}

// ---------------------------------------------------------------------------
// Activation receipt
// ---------------------------------------------------------------------------
function buildActivationReceiptEmail({
  tenantName,
  adminName,
  amountCents,
  currency,
  paidAt,
  methodLabel,
  receiptUrl,
  annualFeeCents,
  renewalDueAt,
  rewardAmountCents,
  referralFeeCents,
  chargeCardCost,
  paymentMethodType,
  supportEmail: support = supportEmail(),
}) {
  const amount = formatMoney(amountCents, currency);
  const blocks = [
    { p: `Thank you — ${tenantName} is now live on 50. Here is your receipt for the one-time activation.` },
    {
      box: [
        ['Item', `50. activation — ${tenantName}`],
        ['Amount', amount],
        ['Paid', formatDate(paidAt)],
        ...(methodLabel ? [['Paid with', methodLabel]] : []),
      ],
    },
  ];
  if (receiptUrl) blocks.push({ link: { text: 'View the full receipt from Stripe', url: receiptUrl } });

  const hasAnnual = Number(annualFeeCents) > 0 && renewalDueAt;
  blocks.push({
    p: hasAnnual
      ? `That ${amount} covers your first 12 months. After that, the annual fee is ${formatMoney(annualFeeCents, currency)}, next due ${formatDate(renewalDueAt)}. We'll email you two weeks before it's charged, and again when it goes through.`
      : `That ${amount} covers your first 12 months.`,
  });

  // A flat amount per rewarded referral, not a percentage. When this dealer
  // is also charged for gift cards 50. buys, the cards are named separately
  // so the total on their statement is never an unexplained lump.
  const perReferral = Number(referralFeeCents) > 0 ? Number(referralFeeCents) : null;
  if (perReferral) {
    const { payoutCents, totalCents } = computeReferralFee({
      rewardAmountCents: Number(rewardAmountCents) || 0,
      feeCents: perReferral,
      chargeCardCost: !!chargeCardCost,
    });
    const cards = formatMoney(rewardAmountCents, currency);
    blocks.push({
      p: chargeCardCost
        ? `There's no monthly fee. When you mark a referral rewarded, 50. charges the ${methodWord(paymentMethodType)} on file for the two ${cards} gift cards (${formatMoney(payoutCents, currency)}) plus a ${formatMoney(perReferral, currency)} fee — ${formatMoney(totalCents, currency)} in total — and sends the cards out for you. In any month that has rewarded referrals, you'll get one summary email at the start of the next month listing every charge.`
        : `There's no monthly fee. When you mark a referral rewarded, 50. charges ${formatMoney(perReferral, currency)} to the ${methodWord(paymentMethodType)} on file. The gift cards themselves are yours to send. In any month that has rewarded referrals, you'll get one summary email at the start of the next month listing every charge.`,
    });
  }
  blocks.push({ p: `Questions? Reply to this email or write ${support}.` });

  return finish(adminName, `Receipt: 50. activation, ${amount} — ${tenantName}`, blocks);
}

// ---------------------------------------------------------------------------
// Monthly incentive summary
// ---------------------------------------------------------------------------
// Leads with the rewards the dealer's customers received, because that is the
// part a dealer cares about and the part that proves the program is working.
// What 50. charged comes last, in a box, as a closing fact rather than the
// headline -- it is already paid and there is nothing to do about it.
//
// rows: [{ at, referrerName, friendName, payoutCents, feeCents }], oldest
// first. pendingCount is referrals sitting at 'ordered' -- the job closed and
// the reward has not been marked yet, which is work the dealer owes someone.
// billingExempt tenants (North Mountain, Good Steward, 50. itself) get the
// same email with the same sections; their fee lines are genuinely $0 and the
// wording never claims a charge that never happened.
function buildReferralStatementEmail({
  tenantName,
  adminName,
  period,
  rows,
  earlierCount = 0,
  currency,
  paymentMethodType,
  pendingCount = 0,
  invitesSent = null,
  formsSubmitted = null,
  rewardFulfillment = 'dealer',
  cardNoun = 'gift card',
  dashboardUrl = null,
  billingExempt = false,
  supportEmail: support = supportEmail(),
}) {
  const month = formatMonth(period);
  const feeTotalCents = rows.reduce((sum, r) => sum + (r.feeCents || 0), 0);
  const payoutTotalCents = rows.reduce((sum, r) => sum + (r.payoutCents || 0), 0);
  const feeTotal = formatMoney(feeTotalCents, currency);
  const payoutTotal = formatMoney(payoutTotalCents, currency);
  const noun = String(cardNoun || 'gift card').trim() || 'gift card';
  const weSend = rewardFulfillment === 'platform';
  const cardsPlural = `${noun}s`;

  // The month at a glance: invites out, forms in, rewards paid. Counted the
  // same way the dashboard's own per-company report counts them (an invite by
  // when its link was minted, which is when the email went out; a form by
  // submitted_at), so the email and the dashboard can never disagree. Null
  // means the caller did not supply the number, which is different from zero
  // and is therefore left out rather than shown as "0".
  const glanceRows = () => {
    const out = [];
    if (invitesSent !== null && invitesSent !== undefined) out.push(['Invites sent', String(invitesSent)]);
    if (formsSubmitted !== null && formsSubmitted !== undefined) out.push(['Referral forms filled in', String(formsSubmitted)]);
    out.push(['Referrals rewarded', String(rows.length)]);
    return out;
  };
  const blocks = [];
  // Pushed only when there is something in it: a box whose single line is
  // "Referrals rewarded: 0" is worse than no box.
  const pushGlance = () => {
    const r = glanceRows();
    if (r.length > 1 || rows.length > 0) blocks.push({ box: r });
  };

  // 1. The incentives, first.
  if (rows.length) {
    blocks.push({
      p:
        `${plural(rows.length, 'customer', 'customers')} of ${tenantName} earned a reward in ${month}` +
        `, and so did the ${rows.length === 1 ? 'friend they' : 'friends they'} referred` +
        ` \u2014 ${payoutTotal} in ${cardsPlural} altogether.`,
    });
    pushGlance();
    blocks.push({
      table: {
        head: ['Date', 'Who earned it', 'Reward'],
        rows: rows.map((r) => {
          const who = r.referrerName && r.friendName
            ? `${r.referrerName} referred ${r.friendName}`
            : r.friendName ? `Referral from ${r.friendName}` : 'Referral';
          const each = formatMoney(Math.round((r.payoutCents || 0) / 2), currency);
          return [
            formatShortDate(r.at),
            {
              html: `${escapeHtml(who)}<br><span style="font-size:12px;color:#6B6A63;">${escapeHtml(`${each} each`)}</span>`,
              text: `${who} (${each} each)`,
            },
            formatMoney(r.payoutCents, currency),
          ];
        }),
        foot: ['Total', plural(rows.length, 'referral', 'referrals'), payoutTotal],
      },
    });
    blocks.push({
      p: weSend
        ? `We emailed ${rows.length === 1 ? 'both cards' : 'every card'} the day you marked the referral rewarded, so there is nothing for you to send.`
        : `You send ${cardsPlural} for these yourself \u2014 50. does not send them on your behalf.`,
    });
  } else {
    blocks.push({ p: `No rewards went out for ${tenantName} in ${month}.` });
    pushGlance();
  }

  // 2. What is still waiting on them. The only part of this email that asks
  //    for anything, so it sits on its own and names the number plainly.
  if (pendingCount > 0) {
    blocks.push({
      p:
        `${plural(pendingCount, 'referral', 'referrals')} ${pendingCount === 1 ? 'is' : 'are'} waiting on you` +
        ` \u2014 the job closed and the reward has not been marked yet. Nobody is paid until you mark it.`,
    });
    if (dashboardUrl) blocks.push({ link: { text: 'Mark them in your dashboard', url: dashboardUrl } });
  }

  // 3. The money, last.
  if (!billingExempt && rows.length) {
    blocks.push({
      box: [
        [plural(rows.length, 'referral fee', 'referral fees'), feeTotal],
        ['Already charged', `to the ${methodWord(paymentMethodType)} on file`],
      ],
    });
    blocks.push({
      p:
        `There is nothing to pay \u2014 that total was charged as each referral was marked.` +
        (earlierCount > 0 ? ` It includes ${plural(earlierCount, 'charge', 'charges')} from earlier that had not been on a summary yet.` : ''),
    });
  } else if (billingExempt) {
    blocks.push({
      box: [
        [plural(Math.max(rows.length, 1), 'referral fee', 'referral fees'), formatMoney(0, currency)],
        ['Why', 'this is one of your own companies'],
      ],
    });
  }

  blocks.push({ p: `Questions? Reply to this email or write ${support}.` });

  // The subject names whichever of the two the dealer should act on. An email
  // whose only content is "3 referrals are waiting on you" must not arrive
  // calling itself a summary -- that is how it gets left unopened.
  const subject = rows.length
    ? `${tenantName}: ${payoutTotal} in rewards went out in ${month}`
    : pendingCount > 0
      ? `${plural(pendingCount, 'referral', 'referrals')} waiting on you at ${tenantName}`
      : `${tenantName}: your ${month} referral summary`;
  return finish(adminName, subject, blocks);
}

// ---------------------------------------------------------------------------
// Yearly summary
// ---------------------------------------------------------------------------
// activation: { amountCents, at } | null    renewals: [{ amountCents, at }]
// fees: { count, totalCents, payoutCents }   months: [{ period, count, feeCents }]
function buildAnnualSummaryEmail({
  tenantName,
  adminName,
  year,
  activation,
  renewals,
  fees,
  months,
  currency,
  nextRenewalAt,
  referralFeeCents,
  chargeCardCost,
  supportEmail: support = supportEmail(),
}) {
  const renewalTotal = renewals.reduce((sum, r) => sum + r.amountCents, 0);
  const totalCents = (activation ? activation.amountCents : 0) + renewalTotal + fees.totalCents;

  const paid = [];
  if (activation) paid.push([`Activation (${formatShortDate(activation.at)})`, formatMoney(activation.amountCents, currency)]);
  if (fees.count > 0) paid.push([`Referral fees (${plural(fees.count, 'referral', 'referrals')})`, formatMoney(fees.totalCents, currency)]);
  for (const r of renewals) paid.push([`Annual fee (${formatShortDate(r.at)})`, formatMoney(r.amountCents, currency)]);
  paid.push(['Total paid to 50.', formatMoney(totalCents, currency)]);

  const blocks = [
    { p: `Here's your ${year} with 50. for ${tenantName}, January 1 to December 31.` },
    {
      p: fees.count > 0
        ? `You rewarded ${plural(fees.count, 'referral', 'referrals')} this year, with ${formatMoney(fees.payoutCents, currency)} in gift cards going to your customers and the friends they referred.`
        : `No referrals were rewarded this year.`,
    },
    { box: paid },
  ];
  if (months.length) {
    blocks.push({
      table: {
        head: ['Month', 'Referrals', '50. fees'],
        rows: months.map((m) => [formatMonth(m.period), String(m.count), formatMoney(m.feeCents, currency)]),
      },
    });
  }
  if (nextRenewalAt) {
    blocks.push({ p: `Your next annual fee is due ${formatDate(nextRenewalAt)}. We'll email you two weeks before it's charged.` });
  }
  if (fees.count === 0 && Number(referralFeeCents) > 0) {
    blocks.push({ p: `Your program is ready whenever you are — each rewarded referral is charged only then, at ${formatMoney(referralFeeCents, currency)} a time.` });
  }
  blocks.push({ p: `Questions? Reply to this email or write ${support}.` });
  return finish(adminName, `Your ${year} with 50.: ${tenantName}`, blocks);
}

module.exports = {
  BILLING_TIME_ZONE,
  supportEmail,
  formatMoney,
  formatDate,
  formatMonth,
  buildActivationReceiptEmail,
  buildReferralStatementEmail,
  buildAnnualSummaryEmail,
};
