// The Monday morning email: how last week went across the whole rep program,
// one line per person who did something.
//
// Kept deliberately short. Joseph reads this on a phone before the day starts
// and the thing he is actually asking is "is anything going quiet?" — so what
// is here is the week's movement and the standing pipeline, and nothing else.
// A report nobody finishes reading is a report nobody reads.
//
// Three numbers move: leads found, companies won, companies that actually
// paid. The third is the one with money attached and the one a pipeline
// normally hides, because a lead won and never signed up looks finished on
// every board that stops at Won.
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

// "20 October" — the week is named by its Monday, and a bare 2026-10-20 makes
// the reader do the arithmetic.
function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// How a rep's week reads as one sentence. Written as movement first and
// standing second, because the question is what changed.
function movement(r) {
  const moved = [];
  if (r.leads) moved.push(plural(r.leads, 'new lead', 'new leads'));
  if (r.won) moved.push(plural(r.won, 'won', 'won'));
  if (r.signed_on) moved.push(`${plural(r.signed_on, 'company', 'companies')} signed on`);
  return moved.length ? moved.join(', ') : 'nothing moved';
}

function standing(r) {
  return `${r.working} working · ${r.not_signed_up} not signed up yet · ${r.total_signed_on} signed on`;
}

// `reps` are rows of { name, company, kind, leads, won, signed_on, working,
// not_signed_up, total_signed_on }, already ordered. `quiet` are active reps
// with no movement at all, named but not given a line each.
//
// Returns null when there is nothing to say — no movement anywhere and
// nothing standing — so the worker never sends a blank Monday email. The
// check belongs here, beside the thing that would be blank.
function build({ name, weekStartIso, weekEndIso, reps, quiet, repsUrl }) {
  const active = (reps || []).filter((r) => r.leads || r.won || r.signed_on);
  const resting = quiet || [];
  const totals = (reps || []).reduce((acc, r) => ({
    leads: acc.leads + r.leads,
    won: acc.won + r.won,
    signed_on: acc.signed_on + r.signed_on,
    not_signed_up: acc.not_signed_up + r.not_signed_up,
  }), { leads: 0, won: 0, signed_on: 0, not_signed_up: 0 });

  if (!active.length && !totals.not_signed_up && !resting.length) return null;

  const hi = firstName(name);
  const week = `${shortDate(weekStartIso)}–${shortDate(weekEndIso)}`;
  // His own rule for every subject line he sends; this one answers itself in
  // the first line, which is the point of asking.
  const subject = totals.signed_on
    ? `How did last week go? ${plural(totals.signed_on, 'company', 'companies')} signed on`
    : totals.won
      ? `How did last week go? ${plural(totals.won, 'company', 'companies')} won`
      : totals.leads
        ? `How did last week go? ${plural(totals.leads, 'new lead', 'new leads')}`
        : 'How did last week go? Nothing moved';

  const label = (r) => r.company ? `${r.name} (${r.company})` : r.name;

  const headline = `${plural(totals.leads, 'lead', 'leads')} in, ${totals.won} won, ${totals.signed_on} signed on and paying.`;
  const waiting = totals.not_signed_up
    ? `${plural(totals.not_signed_up, 'company is', 'companies are')} won but not signed up yet.`
    : null;

  const text = [
    `Hi ${hi},`,
    '',
    `Week of ${week}.`,
    headline,
    ...(waiting ? [waiting] : []),
    ...(active.length ? ['', 'WHO DID WHAT', ...active.map((r) => `- ${label(r)}: ${movement(r)}\n    ${standing(r)}`)] : []),
    ...(resting.length ? ['', `Nothing from: ${resting.map(label).join(', ')}`] : []),
    '',
    `The board: ${repsUrl}`,
    '',
    '50.',
  ].join('\n');

  const row = (r) => `<tr><td style="padding:0 0 12px;">
    <p style="${FONT}font-size:15px;line-height:1.45;margin:0;"><b>${escapeHtml(label(r))}</b> &mdash; ${escapeHtml(movement(r))}</p>
    <p style="${FONT}font-size:13px;line-height:1.45;color:#6B6A63;margin:2px 0 0;">${escapeHtml(standing(r))}</p>
  </td></tr>`;

  const html = `
<div style="${FONT}max-width:480px;margin:0 auto;color:#1B1B1B;">
  <p style="${PARA}">Hi ${escapeHtml(hi)},</p>
  <p style="${FONT}font-size:12px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:#6B6A63;margin:0 0 6px;">Week of ${escapeHtml(week)}</p>
  <p style="${PARA}">${escapeHtml(headline)}${waiting ? `<br><span style="color:#8A5A2B;">${escapeHtml(waiting)}</span>` : ''}</p>
  ${active.length ? `
    <p style="${FONT}font-size:12px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:#1C2B33;margin:0 0 10px;">Who did what</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">${active.map(row).join('')}</table>` : ''}
  ${resting.length ? `<p style="${FONT}font-size:13px;line-height:1.6;color:#6B6A63;margin:0 0 18px;">Nothing from: ${escapeHtml(resting.map(label).join(', '))}</p>` : ''}
  <p style="margin:0 0 18px;">
    <a href="${escapeHtml(repsUrl)}" style="${FONT}display:inline-block;background:#1C2B33;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:bold;padding:11px 20px;border-radius:8px;">Open the board</a>
  </p>
  <p style="${FONT}font-size:13px;line-height:1.6;color:#6B6A63;margin:0;">One of these every Monday morning, covering the week before.</p>
</div>`;

  return { subject, text, html, totals };
}

module.exports = { build, movement, standing, shortDate };
