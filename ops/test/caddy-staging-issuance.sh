#!/usr/bin/env bash
# The public front door's exit check (unit U2, docs/design/access.md "The public front door (Caddy)"): the pinned Caddy, with the
# Caddyfile compile generates (scripts/front-door.ts) and only the ACME directory swapped for Let's Encrypt staging, gets
# an IPv4 certificate on the shortlived profile over TLS-ALPN-01 with port 80 closed. It asserts:
#   - both sites (443 and 8446) serve a certificate from the staging CA whose subject alternative name is the IP;
#   - it lasts under 7 days (the shortlived profile: 160 hours);
#   - nothing listens on 80, UDP 443 or Caddy's admin port 2019.
#   bash ops/test/caddy-staging-issuance.sh [<public ipv4>]   (default: the default route's, scripts/front-door.ts detect)
# Needs a throwaway host with a public IPv4, Docker, node, openssl and ss, with tcp 443 reachable from the Internet (a cloud
# security group or ufw may need opening). Not in CI: CI has no public address. It refuses a host where anything listens on
# 443 or 8446 already (an AidenHQ instance's own front door), and it never touches a running instance: its own container,
# its own temporary data dir, removed at the end.
set -euo pipefail
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
staging="https://acme-staging-v02.api.letsencrypt.org/directory"
image="$(sed -n 's/^FROM \(caddy:[^ ]*\)$/\1/p' "$src/services/caddy/Dockerfile")"
ip="${1:-$(node "$src/scripts/front-door.ts" detect)}"
fail() { echo "FAIL $*"; docker logs aidenhq-caddy-staging 2>&1 | tail -30; exit 1; }
ok() { echo "ok   $*"; }
[ -n "$image" ] || fail "no caddy image in services/caddy/Dockerfile"
if ss -Hltn '( sport = :443 or sport = :8446 )' | grep -q .; then echo "refusing: something listens on 443 or 8446 already (an instance?)" >&2; exit 1; fi
work="$(mktemp -d)"; chmod 0755 "$work"; mkdir -m 0700 "$work/data"
trap 'docker rm -f aidenhq-caddy-staging >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
node "$src/scripts/front-door.ts" caddyfile "$ip" "$staging" > "$work/Caddyfile"
head -c 32 /dev/urandom | base64 > "$work/edge"
docker run -d --name aidenhq-caddy-staging --network host --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges:true -v "$work/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$work/data:/data" \
  -v "$work/edge:/run/secrets/edge_board_secret:ro" "$image" >/dev/null

# The certificate a client gets on <port>, without SNI (as a browser sends for an IP), once Caddy has one (up to 3 minutes).
cert() { openssl s_client -connect "$ip:$1" </dev/null 2>/dev/null | openssl x509 -noout -issuer -ext subjectAltName -startdate -enddate 2>/dev/null; }
for _ in $(seq 36); do c="$(cert 443)"; grep -qi staging <<<"$c" && break; sleep 5; done
grep -qi staging <<<"$c" || fail "no staging certificate on $ip:443 within 3 minutes (is tcp 443 reachable from the Internet?)"
ok "a certificate from the staging CA: $(grep -i issuer <<<"$c")"
for port in 443 8446; do
  c="$(cert "$port")"
  grep -q "IP Address:$ip" <<<"$c" || fail "$ip:$port: the certificate doesn't name IP $ip: $c"
  start="$(date -d "$(sed -n 's/^notBefore=//p' <<<"$c")" +%s)" end="$(date -d "$(sed -n 's/^notAfter=//p' <<<"$c")" +%s)"
  [ $((end - start)) -le $((7 * 86400)) ] || fail "$ip:$port: the certificate lasts $(((end - start) / 3600)) hours, not the shortlived profile's 160"
  ok "$ip:$port serves it, IP SAN $ip, $(((end - start) / 3600)) hours"
done
ss -Hltn 'sport = :80' | grep -q . && fail "something listens on tcp 80" || ok "nothing on tcp 80"
ss -Hlun 'sport = :443' | grep -q . && fail "something listens on udp 443 (HTTP/3)" || ok "nothing on udp 443"
ss -Hltn 'sport = :2019' | grep -q . && fail "Caddy's admin API listens on 2019" || ok "no admin API"
echo "PASS: staging issued an IPv4 certificate over TLS-ALPN-01 for $ip"
