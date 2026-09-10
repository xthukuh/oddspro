#!/bin/sh
# Daily production health snapshot. cwd must be the app root so dotenv finds .env.
# Output goes to last-run.out; cron stays silent. RED leaves ~/ops/health/ALERT
# and (when an alert phone exists) one SMS. The weekly digest reads the ledger.
cd "$HOME/oddspro-app-v1.4.0" || exit 0
"$HOME/nodevenv/oddspro-app-v1.4.0/22/bin/node" "$HOME/ops/prod-health.mjs" > "$HOME/ops/health/last-run.out" 2>&1
exit 0
