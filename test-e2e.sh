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

# Minimal valid config (no agents section — managed by xar)
write_config() {
  cat >"$CFG" <<'EOF'
gateway:
  host: 127.0.0.1
  port: 9000
channels: []
routing: []
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

run_cmd $XGW --config "$TD/nonexistent.yaml" config check
assert_exit 1

echo "gateway: [bad: yaml: {" >"$CFG"
run_cmd $X config check
assert_exit 1

write_config

# ══════════════════════════════════════════════════════════════
# 2. agent list (add/remove deprecated)
# ══════════════════════════════════════════════════════════════
section "2. agent list"

run_cmd $X agent list
assert_exit0

run_cmd $X agent add --id bot1
assert_exit 2

run_cmd $X agent remove --id bot1
assert_exit 2

# ══════════════════════════════════════════════════════════════
# 3. channel add / list / remove
# ══════════════════════════════════════════════════════════════
section "3. channel CRUD"

run_cmd $X channel add --id telegram:ch1 --type telegram
assert_exit0
assert_contains "telegram:ch1"

run_cmd $X channel list
assert_exit0
assert_contains "telegram:ch1"

run_cmd $X channel list --json
assert_exit0
assert_json_array
assert_contains "telegram:ch1"

run_cmd $X channel add --id telegram:ch1 --type telegram
assert_exit 1

run_cmd $X channel remove --id telegram:no-such
assert_exit 1

run_cmd $X channel remove --id telegram:ch1
assert_exit0

run_cmd $X channel list
assert_not_contains "telegram:ch1"

# ══════════════════════════════════════════════════════════════
# 4. route add / list / remove
# ══════════════════════════════════════════════════════════════
section "4. route CRUD"

$X channel add --id telegram:routech --type telegram >/dev/null 2>&1

run_cmd $X route add --channel telegram:routech --peer peer1 --agent routebot
assert_exit0
assert_contains "telegram:routech"

run_cmd $X route list
assert_exit0
assert_contains "telegram:routech"
assert_contains "peer1"

run_cmd $X route list --json
assert_exit0
assert_json_array
assert_contains "routebot"

run_cmd $X agent list
assert_exit0
assert_contains "routebot"

run_cmd $X route remove --channel telegram:routech --peer no-such-peer
assert_exit 1

run_cmd $X route remove --channel telegram:routech --peer peer1
assert_exit0

run_cmd $X route list
assert_not_contains "peer1"

# ══════════════════════════════════════════════════════════════
# 5. usage errors → exit 2
# ══════════════════════════════════════════════════════════════
section "5. usage errors → exit 2"

run_cmd $X channel add --id only-id
assert_exit 2

run_cmd $X route add --channel ch --peer p
assert_exit 2

# ══════════════════════════════════════════════════════════════
# 6. --version / --help
# ══════════════════════════════════════════════════════════════
section "6. --version / --help"

run_cmd $XGW --version
assert_exit0
assert_nonempty

run_cmd $XGW --help
assert_exit0
assert_contains "gateway"

# ══════════════════════════════════════════════════════════════
# 7. config check — semantic validation
# ══════════════════════════════════════════════════════════════
section "7. config check — semantic validation"

cat >"$CFG" <<'EOF'
channels: []
routing: []
EOF
run_cmd $X config check
assert_exit 1

cat >"$CFG" <<'EOF'
gateway:
  host: 127.0.0.1
  port: 9000
channels:
  - id: telegram:ch1
    type: telegram
routing:
  - channel: telegram:ch1
    peer: user1
    agent: bot1
EOF
run_cmd $X config check
assert_exit0
assert_contains "Config OK"

cat >"$CFG" <<'EOF'
gateway:
  host: 127.0.0.1
  port: 9000
channels:
  - id: badformat
    type: telegram
routing: []
EOF
run_cmd $X config check
assert_exit 1

write_config

# ══════════════════════════════════════════════════════════════
# 8. channel add --set
# ══════════════════════════════════════════════════════════════
section "8. channel add --set"

run_cmd $X channel add --id telegram:tg1 --type telegram --set token=abc123 webhook_url=https://example.com
assert_exit0
assert_contains "telegram:tg1"

run_cmd $X channel list --json
assert_exit0
assert_contains "telegram:tg1"

$X channel remove --id telegram:tg1 >/dev/null 2>&1

# ══════════════════════════════════════════════════════════════
# 9. status / stop / reload — no daemon
# ══════════════════════════════════════════════════════════════
section "9. status / stop / reload — no daemon"

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
# 10. channel remove cascades route cleanup
# ══════════════════════════════════════════════════════════════
section "10. channel remove cascades route cleanup"

$X channel add --id telegram:cascade-ch --type telegram >/dev/null 2>&1
$X route add --channel telegram:cascade-ch --peer p1 --agent cascade-bot >/dev/null 2>&1

run_cmd $X route list
assert_contains "telegram:cascade-ch"

run_cmd $X channel remove --id telegram:cascade-ch
assert_exit0

run_cmd $X route list
assert_not_contains "telegram:cascade-ch"


# ══════════════════════════════════════════════════════════════
# 11. xgw send — error cases (no live daemon required)
# ══════════════════════════════════════════════════════════════
section "11. xgw send — channel not found exits non-zero"

write_config
run_cmd $X send --channel no-such-channel --peer p1 --session s1 --message "hi"
assert_nonzero_exit

section "11. xgw send — missing --message and no stdin exits non-zero"

$X channel add --id tui:send-test --type tui >/dev/null 2>&1
# Redirect stdin from /dev/null to prevent the command from blocking on stdin read
OUT="$TD/out_send_test.txt"
$X send --channel tui:send-test --peer p1 --session s1 </dev/null >"$OUT" 2>/dev/null
EC=$?
assert_nonzero_exit

$X channel remove --id tui:send-test >/dev/null 2>&1

summary_and_exit
