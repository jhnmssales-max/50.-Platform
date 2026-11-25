// Sends Joseph one email on Monday morning: how last week went, one line per
// rep. See lib/weeklyStatusEmail.js for what it says and why it is short.
//
// Rides the same hourly tick as the other workers (workers/renewalScheduler.js)
// rather than needing a Render cron job of its own. Because it runs hourly but
// should send once a week, three things decide whether anything goes out:
//
//   1. the day. Monday only, in America/New_York.
//   2. the hour. Nothing before SEND_AFTER_HOUR, so the 3am tick does not
//      wake anybody up. The first tick at or after 7am Eastern is the one
//      that sends.
//   3. rep_week_report_emails. One row per (user, week) with a unique index,
//      so the remaining ticks of the day find the row already there and do
//      nothing. Same claim / send / stamp pattern as followupReminders.js:
//      claim, send, stamp sent_at; a failed send deletes its claim so the
//      next hour tries again, and a sender that dies mid-send leaves a claim
//      anyone may retake after 15 minutes.
//
// A Monday missed entirely -- the service was down all day -- is a week not
// reported rather than two reports on Tuesday. Deliberate: the figures are a
// convenience, not a ledger, and they are all still on the board.
//
// Everything is read with the service role, because this crosses every rep on
// the 50. tenant and rep_leads' RLS deliberately shows a signed-in person only
// their own rows.
const { pool, withServiceRole, assertServiceRoleConnection } = require('../db');
const { sendEmail } = require('../lib/postmark');
const weeklyStatusEmail = require('../lib/weeklyStatusEmail');

const ADVISORY_LOCK_KEY = 5031982009;
const TIME_ZONE = 'America/New_York';
const SEND_AFTER_HOUR = 7;
const SEND_ON_WEEKDAY = 1; // Monday, as Postgres counts isodow.

// Remembered per process only, like followupReminders.js: a send that just
// failed is not retried every hour, but a restart (or a fix) tries again.
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
const recentFailures = new Map();

function log(event, data) {
  console.log(`WEEKLY_STATUS ${event} ${JSON.stringify(data)}`);
}

// The date, hour and weekday as the person reading this experiences them, not
// as the server happens to be configured. Supabase runs in UTC, so at 9pm
// Eastern on a Sunday it is already Monday there -- which would send the
// report a day early and then skip the real Monday.
//
// `last_monday` and `last_sunday` are the week the report COVERS: the seven
// days ending yesterday. On a Monday that is exactly the week just finished.
async function clockAt(now) {
  return withServiceRole(async (client) => {
    const { rows: [r] } = await client.query(
      `with local as (select (($1::timestamptz) at time zone $2) as t)
       select t::date::text                                  as today,
              extract(hour from t)::int                      as hour,
              extract(isodow from t)::int                    as weekday,
              (t::date - 7)::text                            as last_monday,
              (t::date - 1)::text                            as last_sunday
         from local`,
      [now.toISOString(), TIME_ZONE]
    );
    return r;
  });
}

// Who the report goes to: every admin of the 50. tenant itself with an email.
// Read rather than configured, so adding a second admin starts reporting to
// them without a setting to remember.
async function recipients() {
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      `select u.id, u.email, u.name
         from users u
         join tenants t on t.id = u.tenant_id
        where t.slug = '50-platform' and u.role = 'admin' and u.email is not null
        order by u.name`
    );
    return rows;
  });
}

// Every active rep, with what moved last week and where their pipeline stands
// right now. One query: a per-rep loop would be a dozen round trips to say a
// dozen short sentences, and the figures would drift apart as it ran.
//
// Agency reps first, then by name. They are the ones whose work Joseph is no
// longer in the middle of, so they are the ones he is actually reading for.
async function weekFor(mondayIso, sundayIso) {
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      `select r.id, r.name, r.kind, r.company,
         (select count(*)::int from rep_leads l
           where l.brought_in_by_rep_id = r.id
             and l.found_on >= $1::date and l.found_on <= $2::date) as leads,
         (select count(*)::int from rep_leads l
           where l.closed_by_rep_id = r.id and l.status = 'won'
             and l.closed_on >= $1::date and l.closed_on <= $2::date) as won,
         -- Signed on IN that week: the money clearing is the event, not the
         -- lead being won, so this is counted off the tenant and not the lead.
         (select count(distinct t.id)::int
            from tenants t
            join rep_assignments a on a.tenant_id = t.id
             and (a.closer_rep_id = r.id or a.onboarder_rep_id = r.id)
           where t.activation_paid_at is not null
             -- Live money only, the same test rep_dealer_list() makes for
             -- "activated", so this email and the board agree.
             and t.activation_livemode is true
             and (t.activation_paid_at at time zone $3)::date >= $1::date
             and (t.activation_paid_at at time zone $3)::date <= $2::date) as signed_on,
         -- And where they stand now. Same three columns the board draws, so
         -- the email and the page never disagree.
         (select count(*)::int from rep_leads l
           where (l.brought_in_by_rep_id = r.id or l.closed_by_rep_id = r.id)
             and l.status = 'open') as working,
         (select count(*)::int from rep_leads l
           where (l.brought_in_by_rep_id = r.id or l.closed_by_rep_id = r.id)
             and l.status = 'won'
             and (l.tenant_id is null
                  or exists (select 1 from tenants t2 where t2.id = l.tenant_id
                              and not (t2.activation_paid_at is not null
                                       and t2.activation_livemode is true)))) as not_signed_up,
         (select count(distinct t.id)::int
            from tenants t
            join rep_assignments a on a.tenant_id = t.id
             and (a.closer_rep_id = r.id or a.onboarder_rep_id = r.id)
           where t.activation_paid_at is not null
             and t.activation_livemode is true) as total_signed_on
       from reps r
      where r.active
      order by (r.kind = 'agency') desc, lower(r.name)`,
      [mondayIso, sundayIso, TIME_ZONE]
    );
    return rows;
  });
}

async function claim(userId, weekStart) {
  return withServiceRole(async (client) => {
    const { rows: [row] } = await client.query(
      `insert into rep_week_report_emails (user_id, week_start) values ($1, $2::date)
       on conflict on constraint rep_week_report_emails_one_per_week do update set claimed_at = now()
         where rep_week_report_emails.sent_at is null
           and rep_week_report_emails.claimed_at < now() - interval '15 minutes'
       returning id`,
      [userId, weekStart]
    );
    return row ? row.id : null;
  });
}

async function release(claimId) {
  await withServiceRole((client) =>
    client.query('delete from rep_week_report_emails where id = $1 and sent_at is null', [claimId]));
}

async function markSent(claimId, { recipients: to, detail }) {
  await withServiceRole((client) =>
    client.query('update rep_week_report_emails set sent_at = now(), recipients = $2, detail = $3::jsonb where id = $1',
      [claimId, to, JSON.stringify(detail || {})]));
}

function repsUrl() {
  return `${String(process.env.FRONTEND_BASE_URL || '').replace(/\/+$/, '')}/reps`;
}

async function sendOne(person, clock, reps, { dryRun }) {
  const email = weeklyStatusEmail.build({
    name: person.name,
    weekStartIso: clock.last_monday,
    weekEndIso: clock.last_sunday,
    reps,
    // Named, not given a line each: a list of names is enough to notice one
    // that has been there three weeks running.
    quiet: reps.filter((r) => !r.leads && !r.won && !r.signed_on),
    repsUrl: repsUrl(),
  });
  // Nothing to say at all -- no reps, no movement, nothing standing. Not an
  // error, and better than a Monday email that says nothing.
  if (!email) return { skipped: 'nothing_to_report' };

  if (dryRun) {
    return { wouldSend: { to: person.email, subject: email.subject, totals: email.totals } };
  }

  const failedAt = recentFailures.get(person.id);
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return { skipped: 'recent_failure' };

  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!from) throw new Error('EMAIL_FROM_ADDRESS is not set, so no status report can be sent.');

  const claimId = await claim(person.id, clock.last_monday);
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
      week: [clock.last_monday, clock.last_sunday],
      totals: email.totals,
      reps: reps.map((r) => ({ name: r.name, leads: r.leads, won: r.won, signed_on: r.signed_on })),
    },
  });
  return { sent: { to: person.email, subject: email.subject } };
}

async function runWeeklyStatusCycle({ dryRun = false, now = new Date(), force = false } = {}) {
  const lockClient = await pool.connect();
  try {
    // A broad read run as the wrong database role returns nothing and looks
    // like "nobody did anything" forever -- refuse that loudly (see db.js).
    await assertServiceRoleConnection(lockClient);
    const { rows: [lock] } = await lockClient.query('select pg_try_advisory_lock($1) as locked', [ADVISORY_LOCK_KEY]);
    if (!lock.locked) {
      log('lock_not_acquired', { note: 'another status cycle is already running; exiting' });
      return { skippedForLock: true, errored: 0, sent: 0 };
    }
    try {
      const clock = await clockAt(now);
      // force is for the CLI and the tests: it skips the day and hour gates so
      // a run by hand on a Thursday afternoon still does something. The
      // scheduler never passes it.
      if (!force && clock.weekday !== SEND_ON_WEEKDAY) {
        log('not_monday', { today: clock.today, weekday: clock.weekday });
        return { notMonday: true, errored: 0, sent: 0, today: clock.today };
      }
      if (!force && clock.hour < SEND_AFTER_HOUR) {
        log('too_early', { today: clock.today, hour: clock.hour, sendAfterHour: SEND_AFTER_HOUR });
        return { tooEarly: true, errored: 0, sent: 0, today: clock.today };
      }

      const reps = await weekFor(clock.last_monday, clock.last_sunday);
      const people = await recipients();
      const summary = {
        dryRun, today: clock.today, week: [clock.last_monday, clock.last_sunday],
        considered: people.length, sent: 0, skipped: 0, errored: 0, details: [],
      };

      for (const person of people) {
        try {
          const outcome = await sendOne(person, clock, reps, { dryRun });
          if (outcome.sent || outcome.wouldSend) summary.sent += 1;
          else summary.skipped += 1;
          summary.details.push({ email: person.email, ...outcome });
        } catch (err) {
          summary.errored += 1;
          summary.details.push({ email: person.email, error: err.message });
          log('send_failed', { email: person.email, error: err.message });
        }
      }

      log('cycle_complete', { today: summary.today, week: summary.week, considered: summary.considered, sent: summary.sent, skipped: summary.skipped, errored: summary.errored });
      return summary;
    } finally {
      await lockClient.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}

module.exports = { runWeeklyStatusCycle, ADVISORY_LOCK_KEY, SEND_AFTER_HOUR, SEND_ON_WEEKDAY, TIME_ZONE };
