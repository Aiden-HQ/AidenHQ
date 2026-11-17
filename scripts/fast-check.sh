#!/bin/sh
# The fast check the runner runs in the job sandbox before it files a push or PR card (kernel/src/fastcheck.ts): the
# typecheck of each package this branch touches, where its dependencies are installed (a package without node_modules, or
# the runner without ./modules, is skipped: CI still checks it).
base=${AIDENHQ_BASE:-$(git merge-base origin/main HEAD 2>/dev/null)}
changed=$( { git diff --name-only "$base" HEAD 2>/dev/null; git diff --name-only HEAD 2>/dev/null; } )
status=0
for pkg in kernel services/runner services/board; do
  printf '%s\n' "$changed" | grep -q "^$pkg/" || continue
  if [ ! -d "$pkg/node_modules" ] || { [ "$pkg" = services/runner ] && [ ! -d modules ]; }; then
    echo "skipped $pkg: its dependencies aren't installed"
    continue
  fi
  echo "typecheck $pkg"
  (cd "$pkg" && npm run --silent typecheck) || status=1
done
exit $status
