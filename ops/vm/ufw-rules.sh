#!/usr/bin/env bash
# The rules an active host ufw needs for AidenHQ to work (ops/vm/setup.sh runs this after the public firewall). ufw, when
# active, drops everything by default; Docker's containers reach the kernel's host listeners on the bridges' private
# addresses (10.231.0.0/16), so a missing rule leaves the board unable to exchange its sign-in code and sign-in loops.
#   public  also opens 443, 8446 and 8447 (the HTTPS front door: the board, sign-in, the module door)
# Every mode adds the two narrow bridge rules. Nothing on the public interface opens: the rules match the Docker bridges
# only. Idempotent: a rule is skipped when ufw already lists its comment. An inactive or absent ufw changes nothing.
#   ops/vm/ufw-rules.sh public     apply for the public exposure
#   ops/vm/ufw-rules.sh tailscale  apply for any other mode (cloudflare and local too)
# A rule it can't add (no sudo, ufw's own error) warns loudly that the containers can't reach the kernel and sign-in will
# fail, with the commands to run by hand; the install goes on.
set -uo pipefail
mode="${1:-tailscale}"
command -v ufw >/dev/null || exit 0
ufw status 2>/dev/null | grep -q '^Status: active' || exit 0

failed=
add() { # <comment> <ufw allow arguments...>
  local comment="$1"; shift
  ufw status 2>/dev/null | grep -Fq "# $comment" && return 0
  ufw allow "$@" comment "$comment" || failed=1
}
if [ "$mode" = public ]; then
  for port in 443 8446 8447; do ufw allow "$port/tcp" || failed=1; done
fi
add 'AidenHQ containers to host services' in on 'br+' to 10.231.0.0/16
add 'AidenHQ computers to host' in on ahq-computers to 10.231.2.1
if [ -n "$failed" ]; then
  echo "WARNING: ufw is active but AidenHQ's rules could not be added: AidenHQ's containers cannot reach the kernel, and sign-in will fail. Add them by hand:" >&2
  echo "  sudo ufw allow in on br+ to 10.231.0.0/16 comment 'AidenHQ containers to host services'" >&2
  echo "  sudo ufw allow in on ahq-computers to 10.231.2.1 comment 'AidenHQ computers to host'" >&2
fi
exit 0
