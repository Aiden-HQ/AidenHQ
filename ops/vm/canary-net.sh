#!/usr/bin/env bash
# The test-user page canary's browser network: a Docker bridge for the one-shot canary browser (modules/apps-platform/apps-mcp,
# app_page_canary), and the host rule that keeps it off the LAN, the tailnet, the host and every other container except the
# gate's test listener. Idempotent; run as root after Docker starts (aidenhq-canary-net.service, installed by ops/vm/setup.sh),
# so it survives reboots and Docker restarts.
#   ops/vm/canary-net.sh            apply
#   ops/vm/canary-net.sh --remove   take the rule and the network away
# Env: NET, BRIDGE, SUBNET, GATEWAY, GATEWAY_PORT, ALSO_FROM, TABLE. The listener's address and port are scripts/edge.ts's
# TEST_LISTENER_ADDRESS and TEST_LISTENER_PORT; this script's defaults match them, and the gate (host networking) is the only
# process that binds there. With no settings.edge.test_user nothing listens, and this network reaches nothing: the rule is
# harmless either way (the capability is inert until the instance sets it).
set -euo pipefail
NET="${NET:-aidenhq-canary}"
BRIDGE="${BRIDGE:-ahq-canary}"
SUBNET="${SUBNET:-10.231.6.0/24}"
GATEWAY="${GATEWAY:-10.231.6.1}"
GATEWAY_PORT="${GATEWAY_PORT-3132}"
# The one other bridge that may reach the listener: the agent computers' (ops/vm/computer-net.sh), for an app-tester's box.
ALSO_FROM="${ALSO_FROM-ahq-computers}"
TABLE="${TABLE:-aidenhq_canary}"
LISTENER_DROP=""
if [ -n "$GATEWAY_PORT" ]; then
  LISTENER_DROP="ip daddr $GATEWAY tcp dport $GATEWAY_PORT iifname != { \"$BRIDGE\"${ALSO_FROM:+, \"$ALSO_FROM\"} } counter drop"
fi

if [ "${1:-}" = "--remove" ]; then
  # The network goes first: while it exists (a canary browser still attached keeps it), its bridge stays guarded. The table is
  # dropped only once the network is gone, so a failed removal never leaves a usable bridge without its rules.
  if docker network inspect "$NET" >/dev/null 2>&1; then
    if ! docker network rm "$NET" >/dev/null; then
      echo "couldn't remove $NET (a canary browser may still be attached): the $TABLE rule stays in place" >&2
      exit 1
    fi
  fi
  nft delete table inet "$TABLE" 2>/dev/null || true
  echo "removed $TABLE and $NET"; exit 0
fi

# The rules go in before the network exists: a bridge that is up while their transaction fails would be a usable, unrestricted
# network (the gate could bind its listener there, and apps-mcp could launch a signed-in browser), so a failure here must stop
# before there is anything to reach. They match the bridge by name, so they apply the moment Docker creates it.
#
# Our own nft table: an accept elsewhere never overrides a drop here. Input = anything addressed to the host itself; forward =
# anywhere else. The one way in is the gate's test listener on the bridge gateway, and there is no way out at all: a signed-in
# page's external request must not be able to carry anything off the host.
#
# A re-run may find the network already restored by Docker (a reboot), so a failed transaction must take it away: apps-mcp's
# launch check only proves the bridge's shape, and a bridge whose rule never loaded is an unrestricted, signed-in network.
if ! nft -f - <<EOF
table inet $TABLE
delete table inet $TABLE
table inet $TABLE {
  chain input {
    type filter hook input priority filter - 1; policy accept;
    iifname "$BRIDGE" ct state established,related accept
    ${GATEWAY_PORT:+iifname "$BRIDGE" ip daddr $GATEWAY tcp dport $GATEWAY_PORT accept}
    # The listener is the canary bridge's and the agent computers' alone: the address is also routable from the host and the
    # other bridges, so a packet to it arriving on any other interface (another Docker bridge included) is dropped here, not
    # just outside. The computers' own rule (computer-net.sh) opens only this address and port from their bridge.
    $LISTENER_DROP
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
then
  if docker network inspect "$NET" >/dev/null 2>&1; then
    # A browser already attached keeps the network from being removed, so it is detached first; and the link itself goes down
    # whatever happens, because a removed network object is not the only way to make an unguarded bridge unusable.
    for id in $(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$NET" 2>/dev/null); do
      docker network disconnect -f "$NET" "$id" >/dev/null 2>&1 || true
    done
    docker network rm "$NET" >/dev/null 2>&1 || echo "couldn't remove $NET after the rule failed" >&2
    ip link set dev "$BRIDGE" down 2>/dev/null || true
  fi
  echo "couldn't install the $TABLE rule: the network is gone, so nothing can launch a browser on it" >&2
  exit 1
fi

# The network: created here, or (a re-run after a reboot) proved to be this one. A network that merely carries the right name is
# not enough: the rule above matches a bridge name, so a bridge of another name, subnet or gateway (or with inter-container
# traffic on) is a network the rules never guarded. A mismatch stops the run instead of being adopted.
if docker network inspect "$NET" >/dev/null 2>&1; then
  got="$(docker network inspect --format '{{index .Options "com.docker.network.bridge.name"}}|{{index .Options "com.docker.network.bridge.enable_icc"}}|{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}}{{end}}' "$NET")"
  want="$BRIDGE|false|$SUBNET|$GATEWAY"
  if [ "$got" != "$want" ]; then
    echo "$NET exists but isn't the canary network (want $want, found $got): remove it and run this again" >&2
    exit 1
  fi
else
  docker network create --driver bridge --subnet "$SUBNET" --gateway "$GATEWAY" \
    -o com.docker.network.bridge.name="$BRIDGE" -o com.docker.network.bridge.enable_icc=false "$NET" >/dev/null
fi

echo "canary network $NET ($BRIDGE, $SUBNET) and rule $TABLE in place"
