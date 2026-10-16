// CLI entry point for the follow-up reminder worker
// (workers/followupReminders.js) — for running it by hand. The web service
// already runs it every hour (workers/renewalScheduler.js).
//   `npm run followup-reminders`, `npm run followup-reminders:dry-run`, or
//   `node src/workers/runFollowupReminders.js [--dry-run] [--now]`.
//
// --dry-run lists who a real run would email, and how many items each digest
// would carry, without sending anything or writing anything to the database.
// --now skips the "not before 7am Eastern" gate, so a run by hand in the
// afternoon still does something.
require('dotenv').config();
const { runFollowupReminderCycle } = require('./followupReminders');

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--now');

runFollowupReminderCycle({ dryRun, force })
  .then((summary) => {
    console.log('Follow-up reminder worker finished:', JSON.stringify(summary, null, 2));
    process.exit(summary.errored > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Follow-up reminder worker refusing to run / crashed:', err.message);
    process.exit(1);
  });
