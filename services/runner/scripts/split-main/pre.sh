#!/bin/sh
# Behaviour-neutral edits main.mjs needs before the split (an imported binding can't be assigned).
# lastMergeCheck: written by poll (the minute tick) and startMerges (start right away) → one shared box.
set -e
f="$1/src/main.mjs"
perl -0pi -e 's/^let lastMergeCheck = 0;/const mergeCheck = { last: 0 };/m; s/\blastMergeCheck\b/mergeCheck.last/g' "$f"
grep -c "mergeCheck.last" "$f"
