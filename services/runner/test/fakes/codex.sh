#!/bin/sh
# codex sandbox … -- … (around Claude Code) runs the command, in the shell because it runs on every turn; anything
# else is codex.mjs.
if [ "$1" = sandbox ]; then
  while [ "$1" != "--" ]; do shift; done
  shift
  exec "$@"
fi
exec node "$(dirname "$0")/codex.mjs" "$@"
