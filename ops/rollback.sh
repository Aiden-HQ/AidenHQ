#!/usr/bin/env bash
# Roll this host back to apply generation <n> (spec §6.4.1): its product and instance shas, plus, for each module whose data
# is newer than generation n declared (its .data_version marker above n's data_version), that module's earliest snapshot
# taken after n. Other modules keep their data. A snapshot it needs that was pruned refuses. The rollback is
# `ops/apply-config.sh --generation <n>`, under the host's apply lock; --plan only prints what it would do.
#   ops/rollback.sh <n> [--plan]
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."
n="${1:-}"
[[ "$n" =~ ^[0-9]+$ ]] && { [ $# -eq 1 ] || { [ $# -eq 2 ] && [ "$2" = --plan ]; }; } || { echo "usage: ops/rollback.sh <generation> [--plan]" >&2; exit 2; }
set -a; [ -f .env ] && . ./.env; set +a
. ops/lib/generations.sh
product="$(genGet "$n" product)"; instance="$(genGet "$n" instance)"
[ -n "$product" ] || { echo "refusing: no generation $n in $GEN_FILE" >&2; exit 1; }
echo "generation $n: product $product, instance $instance"
plan="$(genJs plan "$n" "$(genDataDir)")"
if [ -z "$plan" ]; then echo "  no module data to restore"
else while read -r m k at _; do echo "  $m: data back to $at (the snapshot before generation $k)"; done <<< "$plan"; fi
[ "${2:-}" = --plan ] && exit 0
exec ops/apply-config.sh --generation "$n"
