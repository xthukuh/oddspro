#!/usr/bin/env bash
# Scheduled daily pipeline run on cPanel (no SSH - wire this into the Cron
# Jobs UI). Linux/cPanel equivalent of scripts/pipeline-task.cmd. Appends
# timestamped output to logs/pipeline.log (gitignored).
#
# Overlap guard via flock: cPanel cron has no built-in "skip if already
# running" (unlike the Windows Task Scheduler default) - an overrunning
# previous tick would otherwise race a fresh `npm run start` against itself.
#
# One-time setup: fill in the venv activation line below with the exact path
# shown on cPanel's "Setup Node.js App" page for this app, then wire the cron
# command to: bash /home/<CPANEL_USER>/<APP_DIR>/scripts/pipeline-cron.sh
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs tmp

# --- fill in once, after creating the Node app in cPanel ---
source /home/<CPANEL_USER>/nodevenv/<APP_DIR>/<NODE_VERSION>/bin/activate

LOCK="tmp/pipeline.lock"
exec 200>"$LOCK"
if ! flock -n 200; then
    echo "[$(date '+%F %T')] pipeline SKIPPED - previous run still active" >> logs/pipeline.log
    exit 0
fi

echo "[$(date '+%F %T')] pipeline start" >> logs/pipeline.log
npm run start >> logs/pipeline.log 2>&1
STATUS=$?
echo "[$(date '+%F %T')] pipeline exit $STATUS" >> logs/pipeline.log
exit $STATUS
