// CLI entry point for the dealer billing-email worker (receipts and summaries,
// workers/billingEmails.js) — for running it by hand. The web service already
// runs it every hour (workers/renewalScheduler.js).
//   `npm run billing-emails`, `npm run billing-emails:dry-run`, or
//   `node src/workers/runBillingEmails.js [--dry-run]`.
//
// --dry-run lists which emails a real run would send (subject and
// recipients) without sending anything or writing anything to the database.
require('dotenv').config();
const { runBillingEmailCycle } = require('./billingEmails');

const dryRun = process.argv.includes('--dry-run');

runBillingEmailCycle({ dryRun })
  .then((summary) => {
    console.log('Billing-email worker finished:', JSON.stringify(summary, null, 2));
    process.exit(summary.errored > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Billing-email worker refusing to run / crashed:', err.message);
    process.exit(1);
  });
