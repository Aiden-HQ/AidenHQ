#!/usr/bin/env bash
# Agent computers' network: the Docker network boxes run on, and the host rule that keeps them off the LAN, the
# tailnet and the host itself, except the launcher's gateway (model proxy + connections) and the gate's test listener (an
# app-tester's signed-in browser; it serves nothing without a live test session, docs/design/access.md "Test-user sign-in"). Idempotent; run as root after Docker
# starts (aidenhq-computer-net.service, installed by ops/vm/setup.sh), so it survives reboots and Docker restarts.
#   ops/vm/computer-net.sh            apply
#   ops/vm/computer-net.sh --remove   take the rule and the network away
# Env: NET, BRIDGE, SUBNET, GATEWAY, GATEWAY_PORT, TEST_LISTENER, TABLE. The CI runners' network reuses it with its own values,
# its port being the model gateway's CI listener (ops/units/aidenhq-ci-net.service); an empty GATEWAY_PORT opens nothing on the
# host, and an empty TEST_LISTENER (CI's) leaves the test listener closed to the bridge.
set -euo pipefail
NET="${NET:-aidenhq-computers}"
BRIDGE="${BRIDGE:-ahq-computers}"
SUBNET="${SUBNET:-10.231.2.0/24}"
GATEWAY="${GATEWAY:-10.231.2.1}"
GATEWAY_PORT="${GATEWAY_PORT-8200}"
# The gate's test listener (scripts/edge.ts TEST_LISTENER_ADDRESS:TEST_LISTENER_PORT, ops/vm/canary-net.sh's gateway).
TEST_LISTENER="${TEST_LISTENER-10.231.6.1:3132}"
TABLE="${TABLE:-aidenhq_computers}"

if [ "${1:-}" = "--remove" ]; then
  nft delete table inet "$TABLE" 2>/dev/null || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "removed $TABLE and $NET"; exit 0
fi

# No inter-container traffic: one box never reaches another.
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --driver bridge --subnet "$SUBNET" --gateway "$GATEWAY" \
  -o com.docker.network.bridge.name="$BRIDGE" -o com.docker.network.bridge.enable_icc=false "$NET" >/dev/null

# Our own nft table: an accept elsewhere never overrides a drop here. Input = anything addressed to the host itself (its LAN,
# tailnet and bridge-gateway addresses, the launcher's control port); forward = anywhere else. Boxes keep the public Internet.
nft -f - <<EOF
table inet $TABLE
delete table inet $TABLE
table inet $TABLE {
  chain input {
    type filter hook input priority filter - 1; policy accept;
    iifname "$BRIDGE" ct state established,related accept
    ${GATEWAY_PORT:+iifname "$BRIDGE" ip daddr $GATEWAY tcp dport $GATEWAY_PORT accept}
    ${TEST_LISTENER:+iifname "$BRIDGE" ip daddr ${TEST_LISTENER%:*} tcp dport ${TEST_LISTENER##*:} accept}
    iifname "$BRIDGE" counter drop
  }
  chain forward {
    type filter hook forward priority filter - 1; policy accept;
    iifname "$BRIDGE" meta nfproto ipv6 counter drop
    iifname "$BRIDGE" ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/3 } counter drop
  }
}
EOF
echo "computer network $NET ($BRIDGE, $SUBNET) and rule $TABLE in place"
