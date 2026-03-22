#!/usr/bin/env bash
#
# XGW CLI End-to-End Test Script — config-file operations (no daemon required)
# Prerequisite: xgw must be installed (npm run build && npm link)
# Usage: bash test-e2e.sh
#
set -uo pipefail

source "$(dirname "$0")/scripts/e2e-lib.sh"

XGW="xgw"

setup_e2e

CFG="$TD/config.yaml"
X="$XGW --config $CFG"

# Minimal valid config written to $CFG
write_config() {
  cat >"$CFG" <<'EOF'
gateway:
  host: 127.0.0.1
  port: 9000
channels: []
routing: []
agents: {}
EOF
}

# ── Pre-flight ────────────────────────────────────────────────
section "Pre-flight"
require_bin $XGW "run npm run build && npm link"

# ══════════════════════════════════════════════════════════════
# 1. config check
# ══════════════════════════════════════════════════════════════
section "1. config check"

write_config
run_cmd $X config check
assert_exit0
assert_contains "Config OK"

# missing config → exit 1
run_cmd $XGW --config "$TD/nonexistent.yaml" config check
assert_exit 1

# invalid YAML → exit 1
echo "gateway: [bad: yaml: {" >"$CFG"
run_cmd $X config check
assert_exit 1

write_config

# ══════════════════════════════════════════════════════════════
# 2. agent add / list / remove
# ══════════════════════════════════════════════════════════════
section "2. agent CRUD"

run_cmd $X agent add --id bot1 --inbox /tmp/bot1
assert_exit0
assert_contains "bot1"

run_cmd $X agent list
assert_exit0
assert_contains "bot1"

run_cmd $X agent list --json
assert_exit0
assert_json_array
assert_contains "bot1"

# add second agent
run_cmd $X agent add --id bot2 --inbox /tmp/bot2
assert_exit0

# remove bot2 (no routes reference it)
run_cmd $X agent remove --id bot2
assert_exit0

run_cmd $X agent list
assert_not_contains "bot2"

# ══════════════════════════════════════════════════════════════
# 3. channel add / list / remove
# ══════════════════════════════════════════════════════════════
section "3. channel CRUD"

run_cmd $X channel add --id ch1 --type telegram
assert_exit0
assert_contains "ch1"

run_cmd $X channel list
assert_exit0
assert_contains "ch1"

run_cmd $X channel list --json
assert_exit0
assert_json_array
assert_contains "ch1"

# duplicate add → exit 1
run_cmd $X channel add --id ch1 --type telegram
assert_exit 1

# remove nonexistent → exit 1
run_cmd $X channel remove --id no-such-channel
assert_exit 1

run_cmd $X channel remove --id ch1
assert_exit0

run_cmd $X channel list
assert_not_contains "ch1"

# ══════════════════════════════════════════════════════════════
# 4. route add / list / remove
# ══════════════════════════════════════════════════════════════
section "4. route CRUD"

# set up prerequisites: agent + channel
$X agent add --id routebot --inbox /tmp/routebot >/dev/null 2>&1
$X channel add --id routech --type telegram >/dev/null 2>&1

run_cmd $X route add --channel routech --peer peer1 --agent routebot
assert_exit0
assert_contains "routech"

run_cmd $X route list
assert_exit0
assert_contains "routech"
assert_contains "peer1"

run_cmd $X route list --json
assert_exit0
assert_json_array
assert_contains "routebot"

# remove nonexistent route → exit 1
run_cmd $X route remove --channel routech --peer no-such-peer
assert_exit 1

run_cmd $X route remove --channel routech --peer peer1
assert_exit0

run_cmd $X route list
assert_not_contains "peer1"

# ══════════════════════════════════════════════════════════════
# 5. agent remove blocked by route reference
# ══════════════════════════════════════════════════════════════
section "5. agent remove blocked by route"

$X route add --channel routech --peer peer2 --agent routebot >/dev/null 2>&1

run_cmd_with_stderr $X agent remove --id routebot
assert_exit 1
assert_contains "routing rules" "$ERR"

# ══════════════════════════════════════════════════════════════
# 6. missing required args → exit 2
# ══════════════════════════════════════════════════════════════
section "6. usage errors → exit 2"

run_cmd $X agent add --id only-id
assert_exit 2

run_cmd $X channel add --id only-id
assert_exit 2

run_cmd $X route add --channel ch --peer p
assert_exit 2

# ══════════════════════════════════════════════════════════════
# 7. --version / --help
# ══════════════════════════════════════════════════════════════
section "7. --version / --help"

run_cmd $XGW --version
assert_exit0
assert_nonempty

run_cmd $XGW --help
assert_exit0
assert_contains "gateway"

# ══════════════════════════════════════════════════════════════
# 8. config check — semantic validation
# ══════════════════════════════════════════════════════════════
section "8. config check — semantic validation"

# missing gateway field
cat >"$CFG" <<'EOF'
channels: []
routing: []
agents: {}
EOF
run_cmd $X config check
assert_exit 1

# missing agents field
cat >"$CFG" <<'EOF'
gateway:
  host: 127.0.0.1
  port: 9000
channels: []
routing: []
EOF
run_cmd $X config check
assert_exit 1

# valid config with agents and routes (referential integrity)
cat >"$CFG" <<'EOF'
gateway:
  host: 127.0.0.1
  port: 9000
channels:
  - id: ch1
    type: telegram
routing:
  - channel: ch1
    peer: user1
    agent: bot1
agents:
  bot1:
    inbox: /tmp/bot1
EOF
run_cmd $X config check
assert_exit0
assert_contains "Config OK"

# route references unknown agent → exit 1
cat >"$CFG" <<'EOF'
gateway:
  host: 127.0.0.1
  port: 9000
channels:
  - id: ch1
    type: telegram
routing:
  - channel: ch1
    peer: user1
    agent: ghost
agents: {}
EOF
run_cmd $X config check
assert_exit 1

write_config

# ══════════════════════════════════════════════════════════════
# 9. channel add --set (extra key=value)
# ══════════════════════════════════════════════════════════════
section "9. channel add --set"

run_cmd $X channel add --id tg1 --type telegram --set token=abc123 webhook_url=https://example.com
assert_exit0
assert_contains "tg1"

# verify the extra fields persisted in config
run_cmd $X channel list --json
assert_exit0
assert_contains "tg1"
assert_contains "telegram"

# clean up
$X channel remove --id tg1 >/dev/null 2>&1

# ══════════════════════════════════════════════════════════════
# 10. status / stop / reload — no daemon
# ══════════════════════════════════════════════════════════════
section "10. status / stop / reload — no daemon"

run_cmd $X status
assert_exit0
assert_contains "stopped"

run_cmd $X status --json
assert_exit0
assert_json_field "$OUT" "running"

run_cmd $X stop
assert_exit0

run_cmd $X reload
assert_exit0

# ══════════════════════════════════════════════════════════════
# 11. channel remove cascades route cleanup
# ══════════════════════════════════════════════════════════════
section "11. channel remove cascades route cleanup"

$X agent add --id cascade-bot --inbox /tmp/cascade-bot >/dev/null 2>&1
$X channel add --id cascade-ch --type telegram >/dev/null 2>&1
$X route add --channel cascade-ch --peer p1 --agent cascade-bot >/dev/null 2>&1

# verify route exists
run_cmd $X route list
assert_contains "cascade-ch"

# remove channel → should also remove associated routes
run_cmd $X channel remove --id cascade-ch
assert_exit0

run_cmd $X route list
assert_not_contains "cascade-ch"

summary_and_exit
