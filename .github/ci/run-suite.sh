#!/usr/bin/env bash
# Runs one suite's command (its `run` in areas.json) in the current directory. When it fails, it runs once more: node's test
# runner then re-runs only the tests that failed (--test-rerun-failures keeps what passed), so a flake costs one retry
# instead of a red run. A test that needed the retry is named in a warning; one that fails twice fails the job.
state="$(mktemp -d)/rerun.json"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--test-rerun-failures=$state"
bash -eo pipefail -c "$1" && exit 0
echo "::warning::$(basename "$PWD") failed: re-running its failed tests once"
bash -eo pipefail -c "$1" || exit 1
node -e '
  const attempts = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const a of attempts) for (const [at, t] of Object.entries(a)) if (t.passed_on_attempt > 0) console.log(`::warning::flaky: ${t.name} (${at}) passed only on the retry`);
' "$state" 2>/dev/null | sort -u
exit 0
