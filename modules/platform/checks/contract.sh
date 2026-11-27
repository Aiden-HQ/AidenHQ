# A module's contract kit (the SDK's aidenhq-module-test: each engine the module declares through engine@1), run in the module's
# own folder of its snapshot. The module brings the kit and `yaml` as its own dependencies (@aidenhq/sdk), installed from its
# lockfile here (bun.lock with Bun, else npm's), in a box with no credential. A module with no engine has nothing for the kit to run.
set -e
grep -qE '^  engine:' module.yaml || { echo "module.yaml declares no providers.engine: nothing for the kit"; exit 0; }
if [ -f bun.lock ]; then bun install --frozen-lockfile --ignore-scripts; else npm ci; fi
node_modules/.bin/aidenhq-module-test .
