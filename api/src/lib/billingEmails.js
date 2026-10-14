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

function formatPercent(bps) {
  const pct = Number(bps) / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
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
  feeRateBps,
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

  const rate = Number(feeRateBps) > 0 ? feeRateBps : null;
  if (rate && Number(rewardAmountCents) > 0) {
    const { payoutCents, feeCents } = computeReferralFee({ rewardAmountCents: Number(rewardAmountCents), rateBps: Number(rate) });
    blocks.push({
      p: `There's no monthly fee. When you mark a referral rewarded, 50. charges ${formatPercent(rate)} of the total gift card payout to the ${methodWord(paymentMethodType)} on file — for two ${formatMoney(rewardAmountCents, currency)} gift cards (${formatMoney(payoutCents, currency)}), that's ${formatMoney(feeCents, currency)}. In any month that has rewarded referrals, you'll get one summary email at the start of the next month listing every charge.`,
    });
  }
  blocks.push({ p: `Questions? Reply to this email or write ${support}.` });

  return finish(adminName, `Receipt: 50. activation, ${amount} — ${tenantName}`, blocks);
}

// ---------------------------------------------------------------------------
// Monthly referral summary
// ---------------------------------------------------------------------------
// rows: [{ at, referrerName, friendName, payoutCents, feeCents }], oldest first.
function buildReferralStatementEmail({
  tenantName,
  adminName,
  period,
  rows,
  earlierCount = 0,
  currency,
  paymentMethodType,
  supportEmail: support = supportEmail(),
}) {
  const month = formatMonth(period);
  const totalCents = rows.reduce((sum, r) => sum + r.feeCents, 0);
  const total = formatMoney(totalCents, currency);

  const describe = (r) => {
    const who = r.referrerName && r.friendName ? `${r.referrerName} referred ${r.friendName}` : r.friendName ? `Referral from ${r.friendName}` : 'Referral';
    return { who, sub: `${formatMoney(r.payoutCents, currency)} in gift cards` };
  };

  const blocks = [
    {
      p:
        `Here's what 50. charged to the ${methodWord(paymentMethodType)} on file for ${tenantName} when you marked referrals rewarded in ${month}.` +
        // A bank debit that cleared after its month's summary went out (or a
        // charge from before these summaries began) is listed here, once.
        (earlierCount > 0 ? ` It also includes ${plural(earlierCount, 'charge', 'charges')} from earlier that hadn't been on a summary yet.` : ''),
    },
    {
      table: {
        head: ['Date', 'Referral', '50. fee'],
        rows: rows.map((r) => {
          const d = describe(r);
          return [
            formatShortDate(r.at),
            {
              html: `${escapeHtml(d.who)}<br><span style="font-size:12px;color:#6B6A63;">${escapeHtml(d.sub)}</span>`,
              text: `${d.who} (${d.sub})`,
            },
            formatMoney(r.feeCents, currency),
          ];
        }),
        foot: ['Total', plural(rows.length, 'referral', 'referrals'), total],
      },
    },
    { p: `That total has already been charged — there's nothing to pay. This is the only email you'll get for these charges: 50. sends one summary a month, and only for months with rewarded referrals.` },
    { p: `Questions? Reply to this email or write ${support}.` },
  ];
  return finish(adminName, `Your 50. referral summary for ${month}: ${total} charged`, blocks);
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
  feeRateBps,
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
  if (fees.count === 0 && Number(feeRateBps) > 0) {
    blocks.push({ p: `Your program is ready whenever you are — each rewarded referral is charged only then, at ${formatPercent(feeRateBps)} of the gift card payout.` });
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
