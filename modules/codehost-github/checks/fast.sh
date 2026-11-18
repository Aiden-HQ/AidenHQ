# A repo's fast check on the change: the dependencies of each package the change touches (npm ci from its lockfile), then the
# repo's `aidenhq:fast-check` script. Whether a repo's check is due is the kernel's to say, from the base (check_jobs.fast.declares).
OUT=$(dirname "$(dirname "$(readlink -f "$0")")") # the box's out folder: this script is its recipe/fast.sh
. "$OUT/recipe/history.sh"
git ls-files -- '*package-lock.json' | while IFS= read -r lock; do
  d=$(dirname "$lock")
  git diff --quiet "$AIDENHQ_BASE" HEAD -- "$d" && continue
  echo "npm ci in $d"
  (cd "$d" && npm ci) || exit 1
done || exit 1
npm run --silent aidenhq:fast-check
