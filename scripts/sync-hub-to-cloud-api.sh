#!/usr/bin/env bash
# Mirror the hub service's dev source into its deploy repo.
#
# src/hub/ in this repo is where hub development happens (the org-sync e2e
# tests run the daemon against it in-process), but what actually serves
# cloud.orchestraboard.com is ../orchestraboard/orchestra-cloud-api. On
# 2026-08-30 the two drifted for three days (milestones, CLI auth, browser
# ops shipped here and never reached production) — this script is the
# mandatory step that prevents that: run it after ANY change to src/hub/ or
# the hub-*.test.ts files, then build and test over there.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
API="${1:-$HERE/../orchestraboard/orchestra-cloud-api}"

if [ ! -d "$API/src/hub" ]; then
  echo "orchestra-cloud-api not found at $API (pass its path as \$1)" >&2
  exit 1
fi

rsync -a --delete "$HERE/src/hub/" "$API/src/hub/"
cp "$HERE/src/hub-entry.ts" "$API/src/hub-entry.ts"

# Hub server tests only — daemon-side suites (org-sync, CLI) stay here.
for t in "$HERE"/test/hub-*.test.ts; do
  base="$(basename "$t")"
  case "$base" in
    hub-cli.test.ts) continue ;; # tests src/hub-cli.ts, the daemon's CLI wiring
  esac
  cp "$t" "$API/test/$base"
done

echo "synced src/hub + hub tests -> $API"
echo "now: cd $API && npx tsc --noEmit && npm run build && npx vitest run"
