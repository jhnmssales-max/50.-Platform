// The one email a day someone on the reps page gets about their own
// follow-ups: what is due today, and anything they set earlier and have not
// ticked off.
//
// Deliberately a digest and not one email per item. A rep who sets five
// follow-ups for a Tuesday wants one list on Tuesday morning, not five
// separate emails; and a digest is the thing you can read on a phone between
// appointments, which is where these are read.
//
// Nothing here mentions a milestone. Those appear on the calendar because they
// are useful history, but a dealer that went live last week is not something
// anyone needs reminding to do.
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

// 09:30 -> "9:30am". Postgres hands back a time as 'HH:MM:SS'.
function clock(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':');
  const hour = Number(h);
  if (!Number.isFinite(hour)) return null;
  const suffix = hour < 12 ? 'am' : 'pm';
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}:${m}${suffix}`;
}

// "Tuesday 20 October" — written out because an overdue line has to say WHEN
// it was for, and a bare 2026-10-14 makes the reader do the arithmetic.
function longDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function dayCount(iso, todayIso) {
  const a = Date.parse(`${iso}T00:00:00Z`);
  const b = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// `today` and `overdue` are rows from rep_followups: { title, note, due_on,
// due_time }. Returns null when both are empty, so the worker never sends an
// empty email — the check belongs here, next to the thing that would be blank.
// `today` and `overdue` are what to PRINT; totalToday and totalOverdue are
// how many there really are. The two differ for someone working a very long
// list, where printing all of them would make the digest unreadable — so the
// counts in the subject and the opening line are always the true ones, and
// each section says how many it is not showing.
function build({ name, today, overdue, todayIso, repsUrl,
                 moreToday = 0, moreOverdue = 0, totalToday, totalOverdue }) {
  const dueToday = today || [];
  const late = overdue || [];
  const nToday = totalToday === undefined ? dueToday.length : totalToday;
  const nLate = totalOverdue === undefined ? late.length : totalOverdue;
  if (nToday === 0 && nLate === 0) return null;

  const hi = firstName(name);
  const total = nToday + nLate;
  const subject = nToday && nLate
    ? `${nToday} for today, ${nLate} still open`
    : nToday
      ? (nToday === 1 ? 'One follow-up today' : `${nToday} follow-ups today`)
      : (nLate === 1 ? 'One follow-up still open' : `${nLate} follow-ups still open`);

  const textItem = (f, withDate) => {
    const when = clock(f.due_time);
    const age = withDate ? ` (was ${longDate(f.due_on)}, ${dayCount(f.due_on, todayIso)} day${dayCount(f.due_on, todayIso) === 1 ? '' : 's'} ago)` : when ? ` at ${when}` : '';
    return `- ${f.title}${age}${f.note ? `\n    ${f.note}` : ''}`;
  };

  const text = [
    `Hi ${hi},`,
    '',
    total === 1 ? 'One thing on your list:' : `${total} things on your list:`,
    ...(dueToday.length ? ['', 'TODAY', ...dueToday.map((f) => textItem(f, false)),
      ...(moreToday ? [`  ...and ${moreToday} more today.`] : [])] : []),
    ...(late.length ? ['', 'STILL OPEN', ...late.map((f) => textItem(f, true)),
      ...(moreOverdue ? [`  ...and ${moreOverdue} more still open.`] : [])] : []),
    '',
    `Tick them off on the reps page: ${repsUrl}`,
    '',
    '50.',
  ].join('\n');

  const htmlItem = (f, withDate) => {
    const when = clock(f.due_time);
    const days = dayCount(f.due_on, todayIso);
    const meta = withDate
      ? `was ${escapeHtml(longDate(f.due_on))} &middot; ${days} day${days === 1 ? '' : 's'} ago`
      : when ? escapeHtml(when) : 'any time today';
    return `<tr><td style="padding:0 0 12px;">
      <p style="${FONT}font-size:15px;line-height:1.45;margin:0;"><b>${escapeHtml(f.title)}</b></p>
      <p style="${FONT}font-size:13px;line-height:1.45;color:#6B6A63;margin:2px 0 0;">${meta}</p>
      ${f.note ? `<p style="${FONT}font-size:14px;line-height:1.5;margin:4px 0 0;">${escapeHtml(f.note)}</p>` : ''}
    </td></tr>`;
  };

  const group = (heading, items, withDate, tint, more) => items.length ? `
    <p style="${FONT}font-size:12px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${tint};margin:0 0 10px;">${heading}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 ${more ? '6' : '18'}px;">${items.map((f) => htmlItem(f, withDate)).join('')}</table>
    ${more ? `<p style="${FONT}font-size:13px;line-height:1.5;color:#6B6A63;margin:0 0 18px;">…and ${more} more. They are all on the calendar.</p>` : ''}` : '';

  const html = `
<div style="${FONT}max-width:480px;margin:0 auto;color:#1B1B1B;">
  <p style="${PARA}">Hi ${escapeHtml(hi)},</p>
  <p style="${PARA}">${total === 1 ? 'One thing on your list.' : `${total} things on your list.`}</p>
  ${group('Today', dueToday, false, '#1C2B33', moreToday)}
  ${group('Still open', late, true, '#8A5A2B', moreOverdue)}
  <p style="margin:0 0 18px;">
    <a href="${escapeHtml(repsUrl)}" style="${FONT}display:inline-block;background:#1C2B33;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:bold;padding:11px 20px;border-radius:8px;">Open the reps page</a>
  </p>
  <p style="${FONT}font-size:13px;line-height:1.6;color:#6B6A63;margin:0;">You are getting this because you have follow-ups set on the 50. reps page. Tick one off and it stops appearing here.</p>
</div>`;

  return { subject, text, html };
}

module.exports = { build, clock, longDate };
