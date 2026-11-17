#!/usr/bin/env bash
# Cuts the official modules repository (lean-core 5b, spec §6.6, §8.7) out of the product: a fresh clone of the product at
# <sha>, `git filter-repo --subdirectory-filter modules` (each module folder keeps its history, blame and tree id), then one
# commit adding the root files (scripts/modules-repo/root: MIT LICENSE, NOTICE, LICENSES/, module CI). marketplace.json and
# advisories.json are already at the root after the filter. Module folders are not touched here, so each keeps the tree id
# it has in the product at <sha> (the instance's switch is an empty authority diff); per-module licence edits are a later,
# reviewed commit. Writes <out>/repo (main) and <out>/commit-map (filter-repo's old → new commit map).
#   scripts/modules-repo/cut.sh <product repo url or path> <product sha on main> <out dir>
set -euo pipefail
[ $# -eq 3 ] || { echo "usage: cut.sh <product repo> <product sha> <out dir>" >&2; exit 2; }
src="$1" sha="$2" out="$3"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "cut.sh: $sha is not a full sha" >&2; exit 2; }
[ ! -e "$out/repo" ] || { echo "cut.sh: $out/repo exists" >&2; exit 1; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

# git filter-repo, pinned by version and hash, in its own venv (never a global install).
python3 -m venv "$out/venv"
"$out/venv/bin/pip" install --quiet --no-deps --require-hashes -r "$here/requirements.txt"

# A fresh clone of main at <sha>: main only, no tags, no remote left behind (nothing can be pushed by accident).
git clone --quiet --no-local --no-tags --single-branch --branch main "$src" "$out/repo"
cd "$out/repo"
git merge-base --is-ancestor "$sha" HEAD || { echo "cut.sh: $sha is not on main" >&2; exit 1; }
git reset --quiet --hard "$sha"
git remote remove origin
git cat-file -e "$sha:modules/marketplace.json" || { echo "cut.sh: no modules/marketplace.json at $sha" >&2; exit 1; }
# The inherited notices the modules carry (NOTICE names the files), kept before the filter drops everything outside modules/.
mkdir -p "$out/licenses"
for f in pennyworth-MIT.txt grafana-dashboards-Apache-2.0.txt; do git show "$sha:LICENSES/$f" > "$out/licenses/$f"; done

PATH="$out/venv/bin:$PATH" git filter-repo --quiet --force --subdirectory-filter modules
cp .git/filter-repo/commit-map "$out/commit-map"

# The root files, as one commit on top.
for f in LICENSE NOTICE LICENSES .github; do
  [ -z "$(git ls-tree HEAD -- "$f")" ] || { echo "cut.sh: $f already exists at the modules root" >&2; exit 1; }
done
cp -R "$here/root/." .
cp -R "$out/licenses" LICENSES
git add LICENSE NOTICE LICENSES .github
git commit --quiet -m "chore: the official modules repository's root files" -m "MIT licence, notices and module CI, cut from the product at $sha (lean-core 5b)."
echo "modules repository: $out/repo at $(git rev-parse HEAD) (cut from product $sha)"
