// CLI entry point for the sales-rep earnings worker (workers/repEarnings.js) —
// for running it by hand. The web service already runs it every hour
// (workers/renewalScheduler.js).
//   `npm run rep-earnings`, `npm run rep-earnings:dry-run`, or
//   `node src/workers/runRepEarnings.js [--dry-run]`.
//
// --dry-run reports how many earnings a real run would add, and keeps nothing.
require('dotenv').config();
const { runRepEarningsCycle } = require('./repEarnings');

const dryRun = process.argv.includes('--dry-run');

runRepEarningsCycle({ dryRun })
  .then((summary) => {
    console.log('Rep-earnings worker finished:', JSON.stringify(summary, null, 2));
    process.exit(summary.errored > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Rep-earnings worker refusing to run / crashed:', err.message);
    process.exit(1);
  });
