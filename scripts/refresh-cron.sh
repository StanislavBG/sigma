#!/usr/bin/env bash
# Cron entrypoint for the 30-min incremental refresh: catch-up ETL + delta-only publish.
# Installed via `crontab` (see replit.md). flock in the cron line prevents overlapping runs.
set -euo pipefail
cd /home/bilko/Projects/sigma
export PATH="/home/bilko/.npm-global/bin:/usr/bin:/bin"
echo "=== $(date '+%Y-%m-%d %H:%M:%S') sigma refresh ==="
exec pnpm run replit:refresh
