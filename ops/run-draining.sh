#!/bin/sh
# The main process of a unit that drains on a restart (ops/units/aidenhq-kernel.service, aidenhq-computers.service; $1 = the
# service's script). A stop or restart signals this shell alone (KillMode=process): it tells the service to drain (SIGUSR2: it
# closes its listeners at once) and exits, so the next one starts and binds them while this one finishes the calls in flight
# and then exits by itself.
node --disable-warning=ExperimentalWarning "$1" &
child=$!
trap 'kill -USR2 "$child"; exit 0' TERM INT
wait "$child"
