#!/bin/sh
# The fast check, run as a check job (a box) before a push or PR card is filed (kernel/src/checkjobs.ts): the
# typecheck of each package this branch touches, where its dependencies are installed (a package without node_modules is
# skipped: CI still checks it).
base=${AIDENHQ_BASE:-$(git merge-base origin/main HEAD 2>/dev/null)}
changed=$( { git diff --name-only "$base" HEAD 2>/dev/null; git diff --name-only HEAD 2>/dev/null; } )
status=0
for pkg in kernel services/board; do
  printf '%s\n' "$changed" | grep -q "^$pkg/" || continue
  if [ ! -d "$pkg/node_modules" ]; then
    echo "skipped $pkg: its dependencies aren't installed"
    continue
  fi
  echo "typecheck $pkg"
  (cd "$pkg" && bun run --silent typecheck) || status=1
done
exit $status
