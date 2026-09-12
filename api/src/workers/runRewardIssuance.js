// CLI entry point for the reward-issuance worker — what an external
// scheduler (a Render Cron Job, or any other "run this on a schedule"
// mechanism) actually invokes. `npm run reward-issuance` from api/, or
// `node src/workers/runRewardIssuance.js` directly. Not wired into any
// running scheduler in this deploy yet — see api/README.md for the
// still-open question of cadence and where that gets configured.
require('dotenv').config();
const { runRewardIssuanceCycle } = require('./rewardIssuance');

runRewardIssuanceCycle()
  .then((summary) => {
    console.log('Reward issuance worker finished:', summary);
    process.exit(summary.errored > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Reward issuance worker crashed:', err);
    process.exit(1);
  });
