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
#   10.231.6.1:3132 tcp  the gate's test listener, from the canary browser's bridge (only when settings.edge.test_user names it)
#   10.231.6.1:3132 tcp  the same listener from the computers' bridge (an app-tester's box; it serves no page without a session)
# Nothing on the public interface opens: the rules match the Docker bridges and those addresses only. Idempotent: an
# allow ufw already lists for the same interface, address and port, from Anywhere, is skipped. An explicit DENY, LIMIT or
# REJECT for the same rule is left in place (ufw allow would replace it) and warns that sign-in may fail. An inactive or
# absent ufw changes nothing.
#   ops/vm/ufw-rules.sh public     apply for the public exposure
#   ops/vm/ufw-rules.sh tailscale  apply for any other mode (cloudflare and local too)
# A rule it can't add (no sudo, ufw's own error) warns loudly that the containers can't reach the kernel and sign-in will
# fail, with the commands to run by hand; the install goes on.
set -uo pipefail
mode="${1:-tailscale}"
command -v ufw >/dev/null || exit 0
# ufw's own output is localized, so read it in the C locale. `status verbose` (not plain `status`) prints "ALLOW IN" for
# incoming rules and the interface and source, which is what this script matches. Read it once: piping it into `grep -q`
# ends ufw early, and pipefail would then report a match as a failed pipeline.
if ! status="$(LC_ALL=C ufw status verbose 2>/dev/null)"; then
  echo "WARNING: ufw is installed but its status could not be read (run setup as root): AidenHQ's containers may not reach the kernel, and sign-in may fail" >&2
  exit 0
fi
case "$status" in *"Status: active"*) ;; *) exit 0 ;; esac

failed= conflict= front_failed= front_conflict=
failed_cmds=()
trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; printf '%s' "${s%"${s##*[![:space:]]}"}"; }
# The state ufw already lists for one rule's address, port and interface: allow (an ALLOW IN from Anywhere, IPv4),
# deny (an explicit DENY/LIMIT/REJECT, which must not be replaced), or none.
# `status verbose` prints one rule per line in three padded columns (To, Action, From):
#   10.231.0.1 3130/tcp on br+ ALLOW IN    Anywhere                   # AidenHQ containers to host services
# The destination and source are compared whole: a rule on one interface, on IPv6 only ("443/tcp (v6)"), or from one
# source is narrower than the unrestricted rule this script needs, and must not count as already present.
state_of() {
  local where="$1" line action dir dest source
  while IFS= read -r line; do
    [[ "$line" =~ (ALLOW|DENY|LIMIT|REJECT)[[:space:]]+(IN|OUT|FWD)([[:space:]]|$) ]] || continue
    action="${BASH_REMATCH[1]}"; dir="${BASH_REMATCH[2]}"
    dest="$(trim "${line%%"${BASH_REMATCH[0]}"*}")"
    [ "$dest" = "$where" ] && [ "$dir" = IN ] || continue
    source="$(trim "${line#*"${BASH_REMATCH[0]}"}")"
    source="$(trim "${source%%#*}")"
    case "$action" in
      DENY|LIMIT|REJECT) echo deny; return 0 ;;
      ALLOW) [ "$source" = Anywhere ] && { echo allow; return 0; } ;;
    esac
  done <<<"$status"
  echo none
}
# <where> <ufw allow arguments> <comment or ""> <front|host>
apply() {
  local where="$1" args="$2" comment="$3" bucket="$4" state
  state="$(state_of "$where")"
  case "$state" in
    allow) return 0 ;;
    deny)
      if [ "$bucket" = front ]; then front_conflict=1; else conflict=1; fi
      echo "WARNING: ufw already has a DENY/LIMIT/REJECT rule for $where; leaving it in place (do not replace it): AidenHQ's containers may not reach the kernel, and sign-in may fail" >&2
      return 0 ;;
  esac
  read -r -a argv <<<"$args"
  if [ -n "$comment" ]; then
    ufw allow "${argv[@]}" comment "$comment" || { if [ "$bucket" = front ]; then front_failed=1; else failed=1; failed_cmds+=("sudo ufw allow $args comment '$comment'"); fi; }
  else
    ufw allow "${argv[@]}" || { if [ "$bucket" = front ]; then front_failed=1; else failed=1; failed_cmds+=("sudo ufw allow $args"); fi; }
  fi
}
# comment | destination | port | interface | ufw allow arguments — the one table both the apply and the warning use.
rules=(
  "AidenHQ containers to host services|10.231.0.1|3130|br+|in on br+ to 10.231.0.1 port 3130 proto tcp"
  "AidenHQ containers to host services|10.231.0.1|8199|br+|in on br+ to 10.231.0.1 port 8199 proto tcp"
  "AidenHQ containers to host services|10.231.0.1|8201|br+|in on br+ to 10.231.0.1 port 8201 proto tcp"
  "AidenHQ computers to host|10.231.2.1|8200|ahq-computers|in on ahq-computers to 10.231.2.1 port 8200 proto tcp"
  "AidenHQ test-user canary to the gate's test listener|10.231.6.1|3132|ahq-canary|in on ahq-canary to 10.231.6.1 port 3132 proto tcp"
  "AidenHQ app-tester computers to the gate's test listener|10.231.6.1|3132|ahq-computers|in on ahq-computers to 10.231.6.1 port 3132 proto tcp"
)
if [ "$mode" = public ]; then
  for port in 443 8446 8447; do apply "$port/tcp" "$port/tcp" "" front; done
fi
for rule in "${rules[@]}"; do
  IFS='|' read -r comment dest port iface args <<<"$rule"
  apply "$dest $port/tcp on $iface" "$args" "$comment" host
done
if [ -n "$front_failed" ] || [ -n "$front_conflict" ]; then
  echo "WARNING: ufw is active but the HTTPS front door's ports could not be opened (443, 8446, 8447): the board and sign-in may not be reachable. Add them by hand:" >&2
  for port in 443 8446 8447; do echo "  sudo ufw allow $port/tcp" >&2; done
fi
if [ -n "$failed" ]; then
  echo "WARNING: ufw is active but AidenHQ's rules could not be added: AidenHQ's containers cannot reach the kernel, and sign-in will fail. Add them by hand:" >&2
  for cmd in "${failed_cmds[@]}"; do echo "  $cmd" >&2; done
fi
if [ -n "$conflict" ]; then
  # A preserved DENY/LIMIT/REJECT is not a missing rule: never print an `ufw allow` for it, which would replace it.
  echo "WARNING: ufw keeps a DENY/LIMIT/REJECT rule where AidenHQ needs the containers to reach the kernel, and setup leaves it alone; sign-in may fail until the owner changes that rule" >&2
fi
exit 0
