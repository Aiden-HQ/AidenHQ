#!/bin/sh
# codex … → codex.mjs (a job's turn, or the runner's short calls).
exec node "$(dirname "$0")/codex.mjs" "$@"
