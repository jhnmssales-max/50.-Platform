// Runs the annual-renewal worker (workers/annualRenewal.js), and then the
// dealer billing-email worker (workers/billingEmails.js), once an hour
// from inside the web service itself, so the yearly 50. fee needs no
// separate Render cron job, service, or copy of the secrets.
//
// Safe to run on every instance and across restarts: the cycle holds a
// Postgres advisory lock (so overlapping runs stand down), and every charge
// is guarded by the ledger's one-pending-or-succeeded-per-period index and
// a Stripe Idempotency-Key. A failed cycle is logged and never reaches the
// request-serving side of the process.
//
// On by default on Render (which sets RENDER=true on its services), off
// everywhere else, so running the API on a laptop never charges anyone.
// RENEWAL_SCHEDULER=on forces it on, RENEWAL_SCHEDULER=off forces it off.
const { runAnnualRenewalCycle } = require('./annualRenewal');
const { runBillingEmailCycle } = require('./billingEmails');
const { runRepEarningsCycle } = require('./repEarnings');
const { runFollowupReminderCycle } = require('./followupReminders');
const { runInviteFollowupCycle } = require('./inviteFollowups');

const INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;

function schedulerEnabled() {
  const setting = (process.env.RENEWAL_SCHEDULER || '').toLowerCase();
  if (setting === 'off') return false;
  return setting === 'on' || process.env.RENDER === 'true';
}

async function tick() {
  try {
    await runAnnualRenewalCycle();
  } catch (err) {
    console.error('RENEWAL_WORKER scheduled cycle failed:', err.message);
  }
  // The dealer receipt/summary emails ride the same hourly tick (their own
  // advisory lock, their own try/catch — a failure in either cycle never
  // touches the other).
  try {
    await runBillingEmailCycle();
  } catch (err) {
    console.error('BILLING_EMAILS scheduled cycle failed:', err.message);
  }
  // Sales-rep earnings from the payments that cleared (workers/repEarnings.js).
  try {
    await runRepEarningsCycle();
  } catch (err) {
    console.error('REP_EARNINGS scheduled cycle failed:', err.message);
  }
  // The morning follow-up digest (workers/followupReminders.js). It decides
  // for itself that it is after 7am Eastern and that today's has not gone
  // out yet, so riding the hourly tick costs one cheap query the rest of the
  // day. No `force`: a cycle before 7am is meant to do nothing.
  try {
    await runFollowupReminderCycle();
  } catch (err) {
    console.error('FOLLOWUP_REMINDERS scheduled cycle failed:', err.message);
  }
  // Sending invited customers their link again (workers/inviteFollowups.js).
  // Does nothing at all for a dealer with no interval set, which is every
  // dealer until somebody chooses one. The per-cycle limit is what keeps a
  // dealer switching it on for a long list from sending it as one burst.
  try {
    await runInviteFollowupCycle();
  } catch (err) {
    console.error('INVITE_FOLLOWUPS scheduled cycle failed:', err.message);
  }
}

function startRenewalScheduler() {
  if (!schedulerEnabled()) {
    console.log('Annual renewal scheduler: off (set RENEWAL_SCHEDULER=on to enable outside Render).');
    return null;
  }
  console.log(`Annual renewal scheduler: on — first check in ${FIRST_RUN_DELAY_MS / 60000} min, then hourly.`);
  const first = setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS).unref();
  }, FIRST_RUN_DELAY_MS);
  first.unref();
  return first;
}

module.exports = { startRenewalScheduler, schedulerEnabled };
