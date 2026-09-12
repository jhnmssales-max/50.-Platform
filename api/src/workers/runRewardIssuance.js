// CLI entry point for the reward-issuance worker — what an external
// scheduler (a Render Cron Job, or any other "run this on a schedule"
// mechanism) actually invokes. `npm run reward-issuance` (or with
// `-- --dry-run`), or `node src/workers/runRewardIssuance.js [--dry-run]`
// directly.
//
// --dry-run previews a cycle — every candidate's intended charge and
// whether it would actually be attempted — without calling Stripe or the
// gift card provider and without writing anything to the database. Use
// it to sanity-check a cycle (especially the first one against a real
// Stripe account) before trusting the cron job to run it for real.
require('dotenv').config();
const { runRewardIssuanceCycle } = require('./rewardIssuance');

const dryRun = process.argv.includes('--dry-run');

runRewardIssuanceCycle({ dryRun })
  .then((summary) => {
    console.log('Reward issuance worker finished:', summary);
    const failed = summary.errored > 0 || summary.aborted === true;
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('Reward issuance worker crashed:', err);
    process.exit(1);
  });
