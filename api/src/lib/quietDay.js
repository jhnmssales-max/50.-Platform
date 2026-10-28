// Sunday is a quiet day: the platform sends no scheduled mail on it.
//
// This covers mail the platform decides to send on its own -- invite
// follow-ups, the monthly dealer summary, renewal notices, rep reminder
// digests. It deliberately does NOT cover mail a person set in motion: an
// invite somebody clicked Send on, a new-lead notification, a reward alert,
// a receipt for money taken. Those are answers to something that just
// happened, and holding them until Monday would be its own kind of broken --
// a referral that came in Sunday afternoon is a sale waiting on an email.
//
// That is why the check lives here, called by each worker, and not inside
// sendEmail(): sendEmail cannot tell who asked it to send.
//
// Nothing is lost by skipping a day. Every scheduled sweep works from what is
// DUE rather than from what day it is, and claims each send in the database
// before making it, so Monday's run picks up exactly what Sunday would have
// sent -- once.

const QUIET_TIME_ZONE = 'America/New_York';
const QUIET_WEEKDAY = 'Sunday';

// Intl, not getDay(), because the server runs in UTC: at 8pm Eastern on a
// Saturday the UTC date is already Sunday, and getDay() would mute a day
// early and un-mute a day early at the other end.
function weekdayIn(now, timeZone = QUIET_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
}

function isQuietDay(now = new Date()) {
  return weekdayIn(now) === QUIET_WEEKDAY;
}

// What a worker returns when it stands down. Shaped like the other early
// returns in these workers (`tooEarly`, `skippedForLock`) so a caller reading
// `.sent` or `.errored` keeps working.
function quietDaySummary(extra = {}) {
  return { quietDay: true, weekday: QUIET_WEEKDAY, errored: 0, sent: 0, ...extra };
}

module.exports = { isQuietDay, weekdayIn, quietDaySummary, QUIET_TIME_ZONE, QUIET_WEEKDAY };
