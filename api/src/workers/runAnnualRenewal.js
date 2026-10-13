// CLI entry point for the annual-renewal worker — what the Render Cron Job
// invokes. `npm run annual-renewal` (or `npm run annual-renewal:dry-run`),
// or `node src/workers/runAnnualRenewal.js [--dry-run]` directly.
//
// --dry-run lists what a real run would do (which tenants would be charged
// or sent a notice) without calling Stripe, sending any email, or writing
// anything to the database.
require('dotenv').config();
const { runAnnualRenewalCycle } = require('./annualRenewal');

const dryRun = process.argv.includes('--dry-run');

runAnnualRenewalCycle({ dryRun })
  .then((summary) => {
    console.log('Annual renewal worker finished:', summary);
    process.exit(summary.errored > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Annual renewal worker refusing to run / crashed:', err.message);
    process.exit(1);
  });
