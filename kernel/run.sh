#!/bin/sh
# The kernel unit's main process (ops/units/aidenhq-kernel.service). A stop or restart signals this shell alone
# (KillMode=process): it tells the kernel to drain (SIGUSR2, kernel/src/main.ts) and exits at once, so the next kernel starts
# while this one finishes the model calls in flight and then exits by itself.
node --disable-warning=ExperimentalWarning "$AIDENHQ_DIR/kernel/src/main.ts" &
kernel=$!
trap 'kill -USR2 "$kernel"; exit 0' TERM INT
wait "$kernel"
