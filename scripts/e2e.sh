#!/usr/bin/env bash
set -euo pipefail
export ORCHESTRA_HOME=$(mktemp -d) ORCHESTRA_PORT=4788
CLI="npx tsx src/cli.ts"
$CLI serve & DPID=$!; sleep 1
trap "kill $DPID 2>/dev/null" EXIT

$CLI join --name amber-fox | grep -q AGENT_NAME=amber-fox
$CLI join --name jade-lynx | grep -q "agent amber-fox"
$CLI card create "Auth refactor" --paths 'src/auth/**' --column in_progress --agent amber-fox | grep -q "card #1"
$CLI card create "Login page" --paths src/auth/login.ts --agent jade-lynx | grep -q "overlap with card #1"
$CLI ask jade-lynx "hold off on login?" --from amber-fox | grep -q "msg #1"
JADE_ID=$($CLI snapshot | python3 -c "import json,sys; print([a['id'] for a in json.load(sys.stdin)['agents'] if a['name']=='jade-lynx'][0])")
$CLI pulse --agent-id $JADE_ID | grep -q "hold off on login?"
$CLI reply 1 "yes, waiting" --from jade-lynx
$CLI card move 1 review --agent amber-fox | grep -q "→ review"
echo "E2E PASS"
