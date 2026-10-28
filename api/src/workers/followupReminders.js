// Sends each person on the reps page one morning email listing the follow-ups
// they set for today, plus anything older they have not ticked off.
//
// Rides the same hourly tick as the other workers (workers/renewalScheduler.js)
// rather than needing a Render cron job of its own. Because it runs hourly but
// should send once a day, two things decide whether anything goes out:
//
//   1. the hour. Nothing is sent before SEND_AFTER_HOUR in America/New_York,
//      so a cycle at 3am does not wake anybody up. The first tick at or after
//      7am Eastern is the one that sends.
//   2. rep_reminder_emails. One row per (user, day) with a unique index, so
//      the remaining 16 ticks of the day find the row already there and do
//      nothing. Same claim / send / stamp pattern as billingEmails.js: claim,
//      send, stamp sent_at; a failed send deletes its claim so the next hour
//      tries again, and a sender that dies mid-send leaves a claim anyone may
//      retake after 15 minutes.
//
// Everything is read with the service role, because this crosses every user on
// the 50. tenant and rep_followups' RLS deliberately shows a signed-in person
// only their own rows.
const { pool, withServiceRole, assertServiceRoleConnection } = require('../db');
const { isQuietDay, quietDaySummary } = require('../lib/quietDay');
const { sendEmail } = require('../lib/postmark');
const followupDigestEmail = require('../lib/followupDigestEmail');

const ADVISORY_LOCK_KEY = 5031982008;
const TIME_ZONE = 'America/New_York';
const SEND_AFTER_HOUR = 7;
const MAX_PEOPLE_PER_CYCLE = 100;
const OVERDUE_LOOKBACK_DAYS = 30;

// Remembered per process only, like billingEmails.js: a send that just failed
// is not retried every hour, but a restart (or a fix) tries again at once.
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
const recentFailures = new Map();

function log(event, data) {
  console.log(`FOLLOWUP_REMINDERS ${event} ${JSON.stringify(data)}`);
}

// The date and hour as the people reading these emails experience them, not as
// the server happens to be configured. Supabase runs in UTC, so at 9pm Eastern
// a plain current_date is already tomorrow — which would send the digest a day
// early and then skip the real morning.
async function clockAt(now) {
  return withServiceRole(async (client) => {
    const { rows: [r] } = await client.query(
      `select (($1::timestamptz) at time zone $2)::date::text as today,
              extract(hour from (($1::timestamptz) at time zone $2))::int as hour`,
      [now.toISOString(), TIME_ZONE]
    );
    return r;
  });
}

// Everyone on the 50. tenant with an email and at least one outstanding
// follow-up dated today or earlier. A rep whose rep record was switched off
// still gets their list: the follow-ups are their own notes, and silently
// dropping them would be worse than one more email.
async function peopleWithWork(today) {
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      `select u.id, u.email, u.name
         from users u
         join tenants t on t.id = u.tenant_id
        where t.slug = '50-platform'
          and u.email is not null
          and exists (
            select 1 from rep_followups f
             where f.user_id = u.id
               and f.done_at is null
               and f.due_on <= $1::date
               and f.due_on >= $1::date - $2::int
          )
        order by u.name
        limit $3`,
      [today, OVERDUE_LOOKBACK_DAYS, MAX_PEOPLE_PER_CYCLE]
    );
    return rows;
  });
}

async function workFor(userId, today) {
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      `select id, title, note, due_on::text as due_on, due_time::text as due_time
         from rep_followups
        where user_id = $1
          and done_at is null
          and due_on <= $2::date
          and due_on >= $2::date - $3::int
        order by due_on, due_time nulls last, title`,
      [userId, today, OVERDUE_LOOKBACK_DAYS]
    );
    return {
      today: rows.filter((r) => r.due_on === today),
      overdue: rows.filter((r) => r.due_on < today),
    };
  });
}

async function claim(userId, forDate) {
  return withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      `insert into rep_reminder_emails (user_id, for_date) values ($1, $2::date)
       on conflict on constraint rep_reminder_emails_one_per_day do update set claimed_at = now()
         where rep_reminder_emails.sent_at is null
           and rep_reminder_emails.claimed_at < now() - interval '15 minutes'
       returning id`,
      [userId, forDate]
    );
    return row ? row.id : null;
  });
}

async function release(claimId) {
  await withServiceRole((client) =>
    client.query('delete from rep_reminder_emails where id = $1 and sent_at is null', [claimId]));
}

async function markSent(claimId, { recipients, detail }) {
  await withServiceRole((client) =>
    client.query('update rep_reminder_emails set sent_at = now(), recipients = $2, detail = $3::jsonb where id = $1',
      [claimId, recipients, JSON.stringify(detail || {})]));
}

function repsUrl() {
  return `${String(process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '')}/reps`;
}

async function sendOne(person, today, { dryRun }) {
  const work = await workFor(person.id, today);
  const email = followupDigestEmail.build({
    name: person.name,
    today: work.today,
    overdue: work.overdue,
    todayIso: today,
    repsUrl: repsUrl(),
  });
  // Nothing outstanding after all — the row was picked by the sweep and then
  // ticked off between the two queries. Not an error, and nothing to send.
  if (!email) return { skipped: 'nothing_due' };

  if (dryRun) {
    return { wouldSend: { to: person.email, subject: email.subject, today: work.today.length, overdue: work.overdue.length } };
  }

  const failedAt = recentFailures.get(person.id);
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return { skipped: 'recent_failure' };

  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!from) throw new Error('EMAIL_FROM_ADDRESS is not set, so no reminder can be sent.');

  const claimId = await claim(person.id, today);
  if (!claimId) return { skipped: 'already_sent' };

  try {
    await sendEmail({
      from,
      to: person.email,
      subject: email.subject,
      htmlBody: email.html,
      textBody: email.text,
    });
  } catch (err) {
    await release(claimId);
    recentFailures.set(person.id, Date.now());
    throw err;
  }

  recentFailures.delete(person.id);
  await markSent(claimId, {
    recipients: person.email,
    detail: {
      today: work.today.map((f) => f.id),
      overdue: work.overdue.map((f) => f.id),
    },
  });
  return { sent: { to: person.email, subject: email.subject } };
}

async function runFollowupReminderCycle({ dryRun = false, now = new Date(), force = false } = {}) {
  const lockClient = await pool.connect();
  try {
    // A broad read run as the wrong database role returns nothing and looks
    // like "nobody has follow-ups" forever — refuse that loudly (see db.js).
    await assertServiceRoleConnection(lockClient);
    const { rows: [lock] } = await lockClient.query('select pg_try_advisory_lock($1) as locked', [ADVISORY_LOCK_KEY]);
    if (!lock.locked) {
      log('lock_not_acquired', { note: 'another reminder cycle is already running; exiting' });
      return { skippedForLock: true, errored: 0, sent: 0 };
    }
    try {
      const clock = await clockAt(now);
      // force is for the CLI and the tests: it skips the hour gate so a run by
      // hand at 2pm still does something. The scheduler never passes it.
      // Sunday: the digest is the platform's own reminder mail, and the work
      // it lists is still there on Monday. `force` overrides, same as the
      // hour gate, so a run by hand still does something.
      if (!force && isQuietDay(now)) {
        log('quiet_day', { today: clock.today, note: 'Sunday: digest held until Monday' });
        return quietDaySummary({ today: clock.today });
      }
      if (!force && clock.hour < SEND_AFTER_HOUR) {
        log('too_early', { today: clock.today, hour: clock.hour, sendAfterHour: SEND_AFTER_HOUR });
        return { tooEarly: true, errored: 0, sent: 0, today: clock.today };
      }

      const people = await peopleWithWork(clock.today);
      const summary = { dryRun, today: clock.today, considered: people.length, sent: 0, skipped: 0, errored: 0, details: [] };

      for (const person of people) {
        try {
          const outcome = await sendOne(person, clock.today, { dryRun });
          if (outcome.sent || outcome.wouldSend) summary.sent += 1;
          else summary.skipped += 1;
          summary.details.push({ email: person.email, ...outcome });
        } catch (err) {
          summary.errored += 1;
          summary.details.push({ email: person.email, error: err.message });
          log('send_failed', { email: person.email, error: err.message });
        }
      }

      log('cycle_complete', { today: summary.today, considered: summary.considered, sent: summary.sent, skipped: summary.skipped, errored: summary.errored });
      return summary;
    } finally {
      await lockClient.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}

module.exports = { runFollowupReminderCycle, ADVISORY_LOCK_KEY, SEND_AFTER_HOUR, TIME_ZONE };
