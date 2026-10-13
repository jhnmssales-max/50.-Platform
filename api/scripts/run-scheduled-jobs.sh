#!/bin/sh
# What the hourly Render cron job runs: the reward-issuance worker, then the
# annual-renewal worker. One cron job (and one set of environment
# variables) for both. Each runs on its own — a failure in one never stops
# the other — and the job exits non-zero if either failed, so Render shows
# the run as failed.
cd "$(dirname "$0")/.." || exit 1

npm run reward-issuance
rewards=$?

npm run annual-renewal
renewals=$?

[ "$rewards" -eq 0 ] && [ "$renewals" -eq 0 ]
