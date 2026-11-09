#!/usr/bin/env bash
# Host-only deploy of an app, including stateful ones (the owner's own go-ahead is the authorisation: only the owner can run this
# on the host). Calls the running apps-mcp so its per-app lock applies.
#   ops/app-deploy.sh deploy <app> [sha]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec docker compose exec -T apps-mcp node dist/src/cli.js "$@"
