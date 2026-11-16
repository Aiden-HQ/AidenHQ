#!/usr/bin/env bash
# The public interface's firewall. On a host with a public address, everything that arrives on that interface is dropped
# except replies, the ICMP that keeps connections working, DHCP replies and the ports the exposure mode needs
# (settings.exposure, docs/design/access.md):
#   public      tcp 22, 443 (Caddy, the HTTPS front door; port 80 stays closed)
#   tailscale   tcp 22, udp 41641 (Tailscale's direct connections); also when EXPOSURE is unset, as before the setting
#   cloudflare  tcp 22 (the tunnel dials out)
#   local       tcp 22 (an SSH tunnel to loopback)
# An unknown EXPOSURE gets tcp 22 only: the unit runs this at boot, where refusing would leave no firewall at all.
# SSH is key-only (ops/vm/setup.sh). Rules match only the public interface, so loopback, tailscale0 and Docker's
# bridges are never touched. The forward hook is covered too: Docker-published ports are DNATed and forwarded, so an
# input-only rule would leave every 0.0.0.0:<port> mapping open.
# Our own nft table, replaced as a whole like ops/vm/computer-net.sh's; never `nft flush ruleset` (it deletes Docker's
# tables and ours). Installed by ops/vm/setup.sh as aidenhq-public-fw.service, with PUBLIC_IF and EXPOSURE in
# /etc/default/aidenhq-public-fw.
#   PUBLIC_IF=eth0 EXPOSURE=public ops/vm/public-fw.sh            apply
#   ops/vm/public-fw.sh --remove                                  take the table away
#   PUBLIC_IF=eth0 EXPOSURE=public ops/vm/public-fw.sh --check    dry run: nft parses the ruleset and applies nothing
#   PUBLIC_IF=eth0 EXPOSURE=public ops/vm/public-fw.sh --print    print the ruleset (no nft needed)
set -euo pipefail
TABLE=aidenhq_public

if [ "${1:-}" = "--remove" ]; then
  nft delete table inet "$TABLE" 2>/dev/null || true
  echo "removed $TABLE"; exit 0
fi
IF="${PUBLIC_IF:?set PUBLIC_IF to the public interface}"
[[ "$IF" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo "PUBLIC_IF '$IF' is not an interface name" >&2; exit 2; }

mode="${EXPOSURE:-tailscale}"
case "$mode" in
  public) open="tcp/22 tcp/443" ;;
  tailscale) open="tcp/22 udp/41641" ;;
  cloudflare|local) open="tcp/22" ;;
  *) echo "EXPOSURE '$mode' is not public, tailscale, cloudflare or local: SSH only" >&2; mode=unknown; open="tcp/22" ;;
esac
ports=""
for p in $open; do ports+="    iifname \"$IF\" ${p%/*} dport ${p#*/} accept"$'\n'; done

ruleset="table inet $TABLE
delete table inet $TABLE
table inet $TABLE {
  chain input {
    type filter hook input priority filter - 2; policy accept;
    iifname \"$IF\" ct state established,related accept
    iifname \"$IF\" ct state invalid drop
    iifname \"$IF\" icmp type { echo-request, destination-unreachable, time-exceeded, parameter-problem } accept
    iifname \"$IF\" icmpv6 type { echo-request, destination-unreachable, packet-too-big, time-exceeded, parameter-problem, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
    iifname \"$IF\" udp dport 68 accept
    iifname \"$IF\" ip6 saddr fe80::/10 udp dport 546 accept
${ports}    iifname \"$IF\" counter drop
  }
  chain forward {
    type filter hook forward priority filter - 2; policy accept;
    iifname \"$IF\" ct state established,related accept
    iifname \"$IF\" counter drop
  }
}"
case "${1:-}" in
  --print) printf '%s\n' "$ruleset" ;;
  --check) nft -c -f - <<<"$ruleset"; echo "public firewall $TABLE on $IF ($mode: ${open// /, }): ruleset checked (dry run)" ;;
  *) nft -f - <<<"$ruleset"; echo "public firewall $TABLE on $IF ($mode: ${open// /, }) in place" ;;
esac
