#!/bin/sh
# bwrap … -- … → … (the job's wrapper that hides the gcloud sign-ins): logs its options to $FAKE_LOG, then runs
# the command. A shell script rather than node, because it runs on every turn.
awk 'BEGIN {
  s = "{\"kind\":\"bwrap\",\"data\":["
  for (i = 1; i < ARGC && ARGV[i] != "--"; i++) { a = ARGV[i]; gsub(/\\/, "\\\\", a); gsub(/"/, "\\\"", a); s = s (i > 1 ? "," : "") "\"" a "\"" }
  print s "]}"
}' "$@" >> "$FAKE_LOG"
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
