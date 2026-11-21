#!/usr/bin/env bash
# The rules an active host ufw needs for AidenHQ to work (ops/vm/setup.sh runs this after the public firewall). ufw, when
# active, drops everything by default; the compose containers reach the kernel's host listeners through their bridge
# gateways, so a missing rule leaves the board unable to exchange its sign-in code and sign-in loops.
#   public  also opens 443, 8446 and 8447 (the HTTPS front door: the board, sign-in, the module door)
# Every mode adds the host listeners the containers use, and nothing else:
#   10.231.0.1:3130 tcp  the kernel's backplane (every module and connection)
#   10.231.0.1:8199 tcp  the computer launcher
#   10.231.0.1:8201 tcp  the model gateway
#   10.231.2.1:8200 tcp  the model gateway from the computers' bridge
# Nothing on the public interface opens: the rules match the Docker bridges and those addresses only. Idempotent: a rule
# is skipped when ufw already lists an allow for it. An inactive or absent ufw changes nothing.
#   ops/vm/ufw-rules.sh public     apply for the public exposure
#   ops/vm/ufw-rules.sh tailscale  apply for any other mode (cloudflare and local too)
# A rule it can't add (no sudo, ufw's own error) warns loudly that the containers can't reach the kernel and sign-in will
# fail, with the commands to run by hand; the install goes on.
set -uo pipefail
mode="${1:-tailscale}"
command -v ufw >/dev/null || exit 0
# ufw's own output is localized, so read it in the C locale. Read it once: piping it into `grep -q` ends ufw early, and
# pipefail would then report a match as a failed pipeline.
if ! status="$(LC_ALL=C ufw status 2>/dev/null)"; then
  echo "WARNING: ufw is installed but its status could not be read (run setup as root): AidenHQ's containers may not reach the kernel, and sign-in may fail" >&2
  exit 0
fi
case "$status" in *"Status: active"*) ;; *) exit 0 ;; esac

failed= front_failed=
# <comment> <extended regex matching an allow rule in ufw status> <ufw allow arguments...>
add() {
  local comment="$1" match="$2"; shift 2
  grep -Eq "$match" <<<"$status" && return 0
  ufw allow "$@" comment "$comment" || failed=1
}
if [ "$mode" = public ]; then
  for port in 443 8446 8447; do ufw allow "$port/tcp" || front_failed=1; done
fi
add 'AidenHQ containers to host services' '10\.231\.0\.1 +3130/tcp +on br\+ +ALLOW IN' in on 'br+' to 10.231.0.1 port 3130 proto tcp
add 'AidenHQ containers to host services' '10\.231\.0\.1 +8199/tcp +on br\+ +ALLOW IN' in on 'br+' to 10.231.0.1 port 8199 proto tcp
add 'AidenHQ containers to host services' '10\.231\.0\.1 +8201/tcp +on br\+ +ALLOW IN' in on 'br+' to 10.231.0.1 port 8201 proto tcp
add 'AidenHQ computers to host' '10\.231\.2\.1 +8200/tcp +on ahq-computers +ALLOW IN' in on ahq-computers to 10.231.2.1 port 8200 proto tcp
if [ -n "$failed" ] || [ -n "$front_failed" ]; then
  echo "WARNING: ufw is active but AidenHQ's rules could not be added: AidenHQ's containers cannot reach the kernel, and sign-in will fail. Add them by hand:" >&2
  [ -z "$front_failed" ] || for port in 443 8446 8447; do echo "  sudo ufw allow $port/tcp" >&2; done
  [ -z "$failed" ] || {
    echo "  sudo ufw allow in on br+ to 10.231.0.1 port 3130 proto tcp comment 'AidenHQ containers to host services'" >&2
    echo "  sudo ufw allow in on br+ to 10.231.0.1 port 8199 proto tcp comment 'AidenHQ containers to host services'" >&2
    echo "  sudo ufw allow in on br+ to 10.231.0.1 port 8201 proto tcp comment 'AidenHQ containers to host services'" >&2
    echo "  sudo ufw allow in on ahq-computers to 10.231.2.1 port 8200 proto tcp comment 'AidenHQ computers to host'" >&2
  }
fi
exit 0
