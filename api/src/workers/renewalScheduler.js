// Runs the annual-renewal worker (workers/annualRenewal.js) once an hour
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
