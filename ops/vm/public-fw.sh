#!/usr/bin/env bash
# The public interface's firewall. On a host with a public address, everything that arrives on that interface is dropped
# except replies, the ICMP that keeps connections working, DHCP replies, SSH (22; key-only, ops/vm/setup.sh) and
# Tailscale's direct connections (UDP 41641). Rules match only the public interface, so loopback, tailscale0 and Docker's
# bridges are never touched. The forward hook is covered too: Docker-published ports are DNATed and forwarded, so an
# input-only rule would leave every 0.0.0.0:<port> mapping open.
# Our own nft table, replaced as a whole like ops/vm/computer-net.sh's; never `nft flush ruleset` (it deletes Docker's
# tables and ours). Installed by ops/vm/setup.sh as aidenhq-public-fw.service, with PUBLIC_IF in /etc/default/aidenhq-public-fw.
#   PUBLIC_IF=eth0 ops/vm/public-fw.sh     apply
#   ops/vm/public-fw.sh --remove           take the table away
#   PUBLIC_IF=eth0 ops/vm/public-fw.sh --check   dry run: nft parses the ruleset and applies nothing
set -euo pipefail
TABLE=aidenhq_public

if [ "${1:-}" = "--remove" ]; then
  nft delete table inet "$TABLE" 2>/dev/null || true
  echo "removed $TABLE"; exit 0
fi
IF="${PUBLIC_IF:?set PUBLIC_IF to the public interface}"
[[ "$IF" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo "PUBLIC_IF '$IF' is not an interface name" >&2; exit 2; }

check=; [ "${1:-}" = "--check" ] && check=-c
nft $check -f - <<NFT
table inet $TABLE
delete table inet $TABLE
table inet $TABLE {
  chain input {
    type filter hook input priority filter - 2; policy accept;
    iifname "$IF" ct state established,related accept
    iifname "$IF" ct state invalid drop
    iifname "$IF" icmp type { echo-request, destination-unreachable, time-exceeded, parameter-problem } accept
    iifname "$IF" icmpv6 type { echo-request, destination-unreachable, packet-too-big, time-exceeded, parameter-problem, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
    iifname "$IF" udp dport 68 accept
    iifname "$IF" ip6 saddr fe80::/10 udp dport 546 accept
    iifname "$IF" tcp dport 22 accept
    iifname "$IF" udp dport 41641 accept
    iifname "$IF" counter drop
  }
  chain forward {
    type filter hook forward priority filter - 2; policy accept;
    iifname "$IF" ct state established,related accept
    iifname "$IF" counter drop
  }
}
NFT
if [ -n "$check" ]; then echo "public firewall $TABLE on $IF: ruleset checked (dry run)"; else echo "public firewall $TABLE on $IF in place"; fi
