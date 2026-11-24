#!/usr/bin/env bash
# The test-user page canary's browser network: a Docker bridge for the one-shot canary browser (modules/apps-platform/apps-mcp,
# app_page_canary), and the host rule that keeps it off the LAN, the tailnet, the host and every other container except the
# gate's test listener. Idempotent; run as root after Docker starts (aidenhq-canary-net.service, installed by ops/vm/setup.sh),
# so it survives reboots and Docker restarts.
#   ops/vm/canary-net.sh            apply
#   ops/vm/canary-net.sh --remove   take the rule and the network away
# Env: NET, BRIDGE, SUBNET, GATEWAY, GATEWAY_PORT, TABLE. The listener's address and port are scripts/edge.ts's
# TEST_LISTENER_ADDRESS and TEST_LISTENER_PORT; this script's defaults match them, and the gate (host networking) is the only
# process that binds there. With no settings.edge.test_user nothing listens, and this network reaches nothing: the rule is
# harmless either way (the capability is inert until the instance sets it).
set -euo pipefail
NET="${NET:-aidenhq-canary}"
BRIDGE="${BRIDGE:-ahq-canary}"
SUBNET="${SUBNET:-10.231.6.0/24}"
GATEWAY="${GATEWAY:-10.231.6.1}"
GATEWAY_PORT="${GATEWAY_PORT-3132}"
TABLE="${TABLE:-aidenhq_canary}"

if [ "${1:-}" = "--remove" ]; then
  nft delete table inet "$TABLE" 2>/dev/null || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "removed $TABLE and $NET"; exit 0
fi

# No inter-container traffic: one canary browser never reaches another.
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --driver bridge --subnet "$SUBNET" --gateway "$GATEWAY" \
  -o com.docker.network.bridge.name="$BRIDGE" -o com.docker.network.bridge.enable_icc=false "$NET" >/dev/null

# Our own nft table: an accept elsewhere never overrides a drop here. Input = anything addressed to the host itself; forward =
# anywhere else. The one way in is the gate's test listener on the bridge gateway, and there is no way out at all: a signed-in
# page's external request must not be able to carry anything off the host.
nft -f - <<EOF
table inet $TABLE
delete table inet $TABLE
table inet $TABLE {
  chain input {
    type filter hook input priority filter - 1; policy accept;
    iifname "$BRIDGE" ct state established,related accept
    ${GATEWAY_PORT:+iifname "$BRIDGE" ip daddr $GATEWAY tcp dport $GATEWAY_PORT accept}
    iifname "$BRIDGE" counter drop
  }
  chain forward {
    type filter hook forward priority filter - 1; policy accept;
    # The canary browser reaches the test listener only, and nothing beyond it: no Internet, no LAN, no tailnet, no other
    # container. Access to the listener is host input (the chain above), never a forwarded packet, so everything here drops.
    iifname "$BRIDGE" counter drop
  }
}
EOF
echo "canary network $NET ($BRIDGE, $SUBNET) and rule $TABLE in place"
