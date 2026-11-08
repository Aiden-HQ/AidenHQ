#!/usr/bin/env bash
# Apply the instance on this host:
#   1. bring the instance repo ($AIDENHQ_INSTANCE_DIR) to main, or exactly <instance sha>;
#   2. check out the product at the commit instance.yaml pins (`product:`);
#   3. compile modules + instance, bring compose up, rerun the Paperclip setup.
# Run by `aidenhq apply` (Platform Engineer) after the owner's "apply", with the exact instance commit it landed; or by
# hand without one. Idempotent. Rollback: revert the instance commit, run again.
#   ops/apply-config.sh [<instance commit sha>]
set -euo pipefail

main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  local product_dir; product_dir="$(pwd)"
  set -a; [ -f .env ] && . ./.env; set +a
  local inst="${AIDENHQ_INSTANCE_DIR:?set AIDENHQ_INSTANCE_DIR in .env (your instance checkout)}"
  local want="${1:-}"

  # Tracked files must be clean in both checkouts (untracked ones such as compose.override.yaml are left alone).
  for d in "$product_dir" "$inst"; do
    [ -z "$(git -C "$d" status --porcelain --untracked-files=no)" ] || { echo "refusing: $d has local changes to tracked files" >&2; exit 1; }
  done

  git -C "$inst" fetch --quiet origin main
  if [ -n "$want" ]; then
    [[ "$want" =~ ^[0-9a-f]{40}$ ]] || { echo "refusing: not a full commit sha" >&2; exit 1; }
    [ "$(git -C "$inst" rev-parse origin/main)" = "$want" ] || { echo "refusing: instance origin/main is $(git -C "$inst" rev-parse origin/main), not $want" >&2; exit 1; }
  else
    want="$(git -C "$inst" rev-parse origin/main)"
  fi
  git -C "$inst" merge --quiet --ff-only "$want"

  # The product commit the instance pins. It must be on product main: nothing unmerged runs here.
  local product
  product="$(node services/runner/src/apply.mjs product-pin "$inst/instance.yaml")"
  [ -n "$product" ] || { echo "refusing: instance.yaml has no full-sha 'product:' line" >&2; exit 1; }
  git fetch --quiet origin main
  git merge-base --is-ancestor "$product" origin/main || { echo "refusing: product $product is not on origin/main" >&2; exit 1; }
  local before; before="$(git rev-parse HEAD)"
  git checkout --quiet --detach "$product"
  # Host-side Node deps (the compiler/setup and the runner) follow the product's lockfiles.
  for d in scripts services/runner; do
    if [ ! -d "$d/node_modules" ] || ! git diff --quiet "$before" "$product" -- "$d/package-lock.json"; then npm ci --prefix "$d" --silent; fi
  done

  node scripts/compile.mjs
  # Shared access: the tunnel may only point at the gate (never the board, Paperclip or an app port directly).
  node scripts/edge.mjs check config/cloudflared.yml || { echo "refusing: config/cloudflared.yml targets something other than the gate" >&2; exit 1; }
  ops/computer-images.sh # agent computers: only the images an agent names (scripts/computers.mjs)
  docker compose up -d --build --remove-orphans
  # The host's own tailnet name keeps Paperclip and the board only; apps are on their own node (compose.yaml apps-edge).
  node scripts/host-serve.mjs prune
  node scripts/paperclip-setup.mjs
  ops/warehouse-sources.sh # shared sources: roles, schemas, src_meta (skips while the warehouse isn't running)

  # The runner's unit (KillMode=process: a restart leaves the agents' runs going). daemon-reload doesn't touch the runner.
  local unit="$HOME/.config/systemd/user/aidenhq-runner.service"
  if ! cmp -s ops/units/aidenhq-runner.service "$unit"; then
    cp ops/units/aidenhq-runner.service "$unit" && systemctl --user daemon-reload && echo "runner unit updated"
  fi
  # The runner is running this script: restart it only after the apply in flight has reported back. SIGUSR2 to its main
  # process only: it takes no new jobs, leaves the agents' runs going (the new runner adopts them and reports their
  # turns), exits as soon as nothing is half done (a reply being posted, a publish, this apply) and systemd starts it again.
  if [ "$before" != "$product" ] && ! git diff --quiet "$before" "$product" -- services/runner ops/units/aidenhq-runner.service; then
    systemd-run --user --quiet --on-active=30 systemctl --user kill --kill-whom=main -s SIGUSR2 aidenhq-runner && echo "runner code changed: restart once idle, from 30s"
  fi
  # The computer launcher holds live run tokens in memory: restart it only when its code changed (running computers get new tokens next run).
  if [ "$before" != "$product" ] && ! git diff --quiet "$before" "$product" -- services/computer/launcher.mjs services/computer/lib.mjs \
     && systemctl --user is-enabled --quiet aidenhq-computers 2>/dev/null; then
    systemctl --user restart aidenhq-computers && echo "computer launcher restarted"
  fi
  echo "applied instance $(git -C "$inst" rev-parse --short HEAD) product $(git rev-parse --short HEAD)"
}
# The whole script is read before it runs: the checkout above may rewrite this file.
main "$@"; exit
