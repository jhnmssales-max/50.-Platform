// The monthly "here is who you invited" email, sent to every dealer.
//
// A dealer's referral program has been, until now, something they could only
// see by logging in -- and most of them never do. They add a customer, an
// email goes, and it disappears. Whether anyone was reached, whether anyone
// shared their link, whether two of their customers can no longer receive
// mail at all: none of it surfaced anywhere.
//
// Deliberately not a bill. The referral statement is a bill and goes only to
// a dealer who owes something. This goes to everyone, in-house companies
// included, and names people rather than totalling money.
//
// The part that earns its place is the flags. A dealer scanning a list of
// names learns little; a dealer seeing "this address bounced, nothing
// reaches it" learns something they can act on today.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function monthName(period) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

// One line per person. Status is the point of the row, so it is never left
// to be inferred from an empty cell.
function statusOf(p) {
  if (p.delivery_failed_at) return { label: "Couldn't be delivered", tone: 'bad', note: p.delivery_error || '' };
  if (p.unsubscribed_at) return { label: 'Asked to stop', tone: 'muted', note: '' };
  if (p.referrals > 0) return { label: p.referrals === 1 ? 'Sent 1 referral' : `Sent ${p.referrals} referrals`, tone: 'good', note: '' };
  return { label: 'Invited', tone: 'plain', note: '' };
}

const TONE = { bad: '#A33', good: '#2E7D4F', muted: '#8A887F', plain: '#3A3A3A' };

function buildMonthlyActivityEmail({
  tenantName,
  period,            // 'YYYY-MM'
  invited = [],      // [{ name, email, unsubscribed_at, delivery_failed_at, delivery_error, referrals }]
  totalCustomers = null,
  referralsThisMonth = 0,
  unreachable = [],  // people flagged whenever they were invited, not only this month
}) {
  const month = monthName(period);
  const n = invited.length;

  const subject = n
    ? `${tenantName}: ${n} ${n === 1 ? 'person' : 'people'} invited in ${month}`
    : `${tenantName}: your referral program in ${month}`;

  const lead = n
    ? `Here is everyone you invited to your referral program in ${month}.`
    : `Nobody new was invited in ${month}. Here is where your program stands.`;

  const rows = invited.map((p) => {
    const st = statusOf(p);
    return `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid #EFEBE3;font-size:14px;">${escapeHtml(p.name || '')}<div style="color:#8A887F;font-size:12px;">${escapeHtml(p.email || '')}</div></td>
      <td style="padding:7px 10px;border-bottom:1px solid #EFEBE3;font-size:13px;color:${TONE[st.tone]};white-space:nowrap;">${escapeHtml(st.label)}${st.note ? `<div style="color:#8A887F;font-size:11px;white-space:normal;">${escapeHtml(st.note)}</div>` : ''}</td>
    </tr>`;
  }).join('');

  const table = n ? `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:14px 0 18px;">
    <tr><th align="left" style="padding:0 10px 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8A887F;">Who</th>
        <th align="left" style="padding:0 10px 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8A887F;">Where it got to</th></tr>
    ${rows}
  </table>` : '';

  // Anyone unreachable, whenever they were invited. A customer who bounced
  // three months ago is still unreachable today, and the month they happened
  // to be added is not the month a dealer can do anything about it.
  const stuck = unreachable.length ? `
  <p style="font-size:15px;line-height:1.6;margin:18px 0 6px;"><strong>${unreachable.length} ${unreachable.length === 1 ? 'address is' : 'addresses are'} not reaching anyone</strong></p>
  <p style="font-size:13px;line-height:1.6;color:#4A4A4A;margin:0 0 8px;">These bounced, so nothing sent to them arrives. Correcting the address in your dashboard and adding them again is usually all it takes.</p>
  <ul style="font-size:14px;line-height:1.7;color:#1B1B1B;margin:0 0 18px;padding-left:20px;">
    ${unreachable.map((p) => `<li>${escapeHtml(p.name || '')} &mdash; ${escapeHtml(p.email || '')}</li>`).join('')}
  </ul>` : '';

  const totals = `
  <p style="font-size:13px;line-height:1.7;color:#4A4A4A;margin:0 0 4px;">
    ${referralsThisMonth > 0
      ? `<strong>${referralsThisMonth}</strong> referral${referralsThisMonth === 1 ? '' : 's'} came in during ${escapeHtml(month)}.`
      : `No referrals came in during ${escapeHtml(month)}.`}
    ${totalCustomers != null ? ` You have <strong>${totalCustomers}</strong> customer${totalCustomers === 1 ? '' : 's'} in the program altogether.` : ''}
  </p>`;

  // A header, so the email identifies itself before it starts listing people.
  // The company's own name is the title because that is what a dealer
  // recognises in a crowded inbox; "50." and the month sit under it.
  const header = `
  <div style="border-bottom:2px solid #1B1B1B;padding-bottom:10px;margin-bottom:18px;">
    <div style="font-size:19px;font-weight:bold;letter-spacing:-.01em;">${escapeHtml(tenantName)}</div>
    <div style="font-size:13px;color:#8A887F;margin-top:3px;">Referral program &middot; ${escapeHtml(month)} &middot; sent by 50.</div>
  </div>`;

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1B1B1B;">
  ${header}
  <p style="font-size:15px;line-height:1.6;">${escapeHtml(lead)}</p>
  ${table}
  ${stuck}
  ${totals}
  <p style="font-size:12px;color:#8A887F;border-top:1px solid #E6E0D5;padding-top:14px;margin-top:22px;">
    Sent once a month by 50., the referral program behind ${escapeHtml(tenantName)}.
  </p>
</div>`;

  const textRows = invited.map((p) => {
    const st = statusOf(p);
    return `  ${p.name || ''} <${p.email || ''}> — ${st.label}${st.note ? ` (${st.note})` : ''}`;
  }).join('\n');

  const textBody = [
    `${tenantName} — referral program — ${month}`,
    lead,
    n ? textRows : null,
    unreachable.length
      ? `${unreachable.length} address${unreachable.length === 1 ? '' : 'es'} not reaching anyone:\n` +
        unreachable.map((p) => `  ${p.name || ''} <${p.email || ''}>`).join('\n') +
        '\nThese bounced, so nothing sent to them arrives. Correct the address and add them again.'
      : null,
    referralsThisMonth > 0
      ? `${referralsThisMonth} referral${referralsThisMonth === 1 ? '' : 's'} came in during ${month}.`
      : `No referrals came in during ${month}.`,
    totalCustomers != null ? `${totalCustomers} customer${totalCustomers === 1 ? '' : 's'} in the program altogether.` : null,
    `Sent once a month by 50., the referral program behind ${tenantName}.`,
  ].filter(Boolean).join('\n\n');

  return { subject, htmlBody, textBody };
}

module.exports = { buildMonthlyActivityEmail, monthName, statusOf };
