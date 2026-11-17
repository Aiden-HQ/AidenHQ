#!/bin/sh
# Redoes the split on the current branch, one commit per module: run from services/runner after pre.sh's commit.
#   sh scripts/split-main/build.sh
set -e
B=$(mktemp)
D=scripts/split-main
cp src/main.mjs "$B"
n=$(node -e 'console.log(Object.keys(require("./'$D'/manifest.json").files).length)')
i=1
while [ "$i" -le "$n" ]; do
  cp "$B" src/main.mjs
  node $D/split.mjs . $D/manifest.json --only "$i" | grep -v '^note:' || true
  node $D/types.mjs . | tail -1
  node $D/verify.mjs "$B" .
  npm run -s typecheck
  f=$(node -e 'const m=require("./'$D'/manifest.json");console.log(Object.keys(m.files)['$i'-1])')
  about=$(node -e 'const m=require("./'$D'/manifest.json");console.log(m.about["'$f'"])')
  git add src/main.mjs src/main
  if [ "$i" = 1 ]; then subject="refactor(runner): main.mjs becomes a thin entry; $about move into src/main/$f, the rest into src/main/unsplit.ts"; else subject="refactor(runner): move $about into src/main/$f"; fi
  git add -A src/main
  git commit -q -m "$subject" -m "Moved byte for byte by scripts/split-main (split.mjs --only $i, then types.mjs for light types); verify.mjs shows every statement of the old main.mjs appears once, types erased.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VsZSHaZiWbfdAWie9BtiGG"
  echo "committed $i/$n: $f"
  i=$((i + 1))
done
