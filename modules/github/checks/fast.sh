# A repo's fast check on the change: the dependencies of each package the change touches (from its lockfile: bun.lock with
# Bun, package-lock.json with npm), then the repo's `aidenhq:fast-check` script (with Bun when the repo has a bun.lock). Whether a repo's check is due is the kernel's to say, from the base (check_jobs.fast.declares).
OUT=$(dirname "$(dirname "$(readlink -f "$0")")") # the box's out folder: this script is its recipe/fast.sh
. "$OUT/recipe/history.sh"
git ls-files -- ':(glob)**/bun.lock' ':(glob)**/package-lock.json' | while IFS= read -r lock; do
  d=$(dirname "$lock")
  git diff --quiet "$AIDENHQ_BASE" HEAD -- "$d" && continue
  case "$lock" in
    bun.lock|*/bun.lock) echo "bun install in $d"; (cd "$d" && bun install --frozen-lockfile --ignore-scripts) || exit 1 ;;
    *) echo "npm ci in $d"; (cd "$d" && npm ci) || exit 1 ;;
  esac
done || exit 1
if [ -n "$(git ls-files -- ':(glob)**/bun.lock')" ]; then bun run --silent aidenhq:fast-check; else npm run --silent aidenhq:fast-check; fi
