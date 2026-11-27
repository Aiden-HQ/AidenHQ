# What the product's CI runs on every change, from copies the change can't edit: the secret scan (gitleaks with the base's
# .gitleaks.toml) and the supply-chain checks (the product's scripts/supply-chain, mounted read-only), before anything is
# installed; then the repo's lint, tests and build.
OUT=$(dirname "$(dirname "$(readlink -f "$0")")") # the box's out folder: this script is its recipe/tests.sh
. "$OUT/recipe/history.sh"
status=0
git show "$AIDENHQ_BASE:.gitleaks.toml" > "$OUT/gitleaks.toml" 2>/dev/null || printf '[extend]\nuseDefault = true\n' > "$OUT/gitleaks.toml"
echo "secret scan (gitleaks, the base's config)"
gitleaks git --no-banner --redact --exit-code 1 --config "$OUT/gitleaks.toml" --log-opts "$AIDENHQ_BASE..HEAD" . || status=1
echo "supply chain (the product's checks)"
node /opt/aidenhq/supply-chain/npm-age.ts "$AIDENHQ_BASE" HEAD || status=1
node /opt/aidenhq/supply-chain/pins.ts "$AIDENHQ_BASE" HEAD || status=1
[ "$status" = 0 ] || exit 1
# A repo on Bun (a bun.lock at its root, as the app starter's) installs and runs with Bun; any other repo with npm.
if [ -f bun.lock ]; then
  bun install --frozen-lockfile --ignore-scripts && bun run --if-present lint && bun run test && bun run --if-present build
else
  npm ci && npm run --if-present lint && npm test && npm run --if-present build
fi
