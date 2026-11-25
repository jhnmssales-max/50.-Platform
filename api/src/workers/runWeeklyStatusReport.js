// CLI entry point for the Monday status report
// (workers/weeklyStatusReport.js) — for running it by hand. The web service
// already runs it every hour (workers/renewalScheduler.js), where it does
// nothing on six days out of seven.
//   `npm run weekly-status`, `npm run weekly-status:dry-run`, or
//   `node src/workers/runWeeklyStatusReport.js [--dry-run] [--now]`.
//
// --dry-run prints the report that a real run would send, and to whom,
// without sending anything or writing anything to the database.
// --now skips both the "Monday only" and the "not before 7am Eastern" gates,
// so a run by hand on a Thursday afternoon still does something. Note that a
// forced run on a day that is not Monday reports the seven days ending
// yesterday, which is a rolling week rather than last week.
require('dotenv').config();
const { runWeeklyStatusCycle } = require('./weeklyStatusReport');

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--now');

runWeeklyStatusCycle({ dryRun, force })
  .then((summary) => {
    console.log('Weekly status worker finished:', JSON.stringify(summary, null, 2));
    process.exit(summary.errored > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Weekly status worker refusing to run / crashed:', err.message);
    process.exit(1);
  });
