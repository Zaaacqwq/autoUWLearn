#!/usr/bin/env bash
#
# Deploys the current origin/main to this machine and restarts the service.
#
#   scripts/deploy.sh
#
# Refuses to run with local modifications: this repository was once deployed by
# rsync, which left the server's working tree diverged from git and nearly cost
# 250 lines of uncommitted production code. Deployment reads from git or not at
# all.
set -euo pipefail

cd "$(dirname "$0")/.."
LABEL="com.autouwlearn.mcp"

dirty="$(git status --porcelain | grep -v '^?? \.claude/' || true)"
if [ -n "$dirty" ]; then
  echo "Working tree has local changes; commit or discard them first:" >&2
  echo "$dirty" >&2
  exit 1
fi

echo "==> pulling"
git pull --ff-only

echo "==> installing"
npm install --silent

# tsc leaves orphaned output behind when a source file is deleted.
echo "==> building (clean)"
rm -rf dist
npm run build

echo "==> testing"
npm test

echo "==> restarting $LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
sleep 8

echo "==> health"
curl -fsS -m 10 http://127.0.0.1:8787/health
echo

echo "==> deployed $(git rev-parse --short HEAD)"
