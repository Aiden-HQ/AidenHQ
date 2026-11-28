# Leaving releases: pin the product by hand

Written for the owner's Claude (Claude Code on the server, or over ssh to it). An install from the installer
(get.aidenhq.ai) follows releases: `instance.yaml` has `release:` and the kernel's updater moves it to each graduated
release ([release updates](../design/release-updates.md)). To try one commit on main once, use the owner MCP's `update`
tool instead: it checks the commit and keeps the install on releases. Leave releases only to run main commits for good.

## What it costs

- **Auto-updates stop for good.** Without `release:` the updater never touches the instance; Settings > Updates shows no
  release. If the github module is connected, its release train then moves `product:` to each newest main
  commit whose CI is green, as an apply card; otherwise nothing moves unless you move it.
- **No checks on your move.** The `update` tool's checks (on main, CI green on that commit, after what runs now) don't run.
  Apply refuses only a commit that isn't on the product checkout's `origin/main`.
- **No reviewer on it.** A hand apply is the owner's own act: printed, never filed as a card.
- **Shell on the host**, as the instance's user (default `aidenhq`).
- **Every image builds on the host** (no prebuilt release images), so applies take longer.

## Steps

Paths are the installer's defaults: the product checkout `~/aidenhq`, the instance checkout `~/aidenhq-instance`.

1. Pick the commit: `main`'s head, or a commit on it whose `ci-required` check passed
   (`https://github.com/Aiden-HQ/AidenHQ/commit/<sha>`, or `gh api repos/Aiden-HQ/AidenHQ/commits/<sha>/check-runs?check_name=ci-required`).
   It must descend from the `product:` running now: moving back is a rollback (docs/operations.md).
2. Put it on the product checkout's `origin/main`, where apply reads it. The installer's origin is a local mirror
   (`git -C ~/aidenhq remote get-url origin` prints a path):

   ```sh
   cd ~/aidenhq
   git fetch -q https://github.com/Aiden-HQ/AidenHQ.git main
   SHA=$(git rev-parse FETCH_HEAD)        # or the commit you picked, if it is on main
   git push -q origin "$SHA:refs/heads/main"
   ```

   If origin is `https://github.com/Aiden-HQ/AidenHQ.git` itself, skip the push.
3. Pin it in the instance repo: delete the `release:` line (or block) from `instance.yaml` and set `product:` to the sha.

   ```sh
   cd ~/aidenhq-instance
   git pull -q --ff-only origin main
   sed -i -e '/^release:/d' -e "s/^product: .*/product: $SHA/" instance.yaml   # a multi-line release: block: delete it by hand
   git diff                                                                    # only product: and release: change
   git commit -q -m "product: $SHA, pinned by hand (leaves releases)" -- instance.yaml
   git push -q origin main
   ```

4. Apply: `~/aidenhq/ops/aidenhq-apply --wait`. It exits with the apply's status; a failed apply puts the host back on the
   last good generation. Never `git pull` the product checkout first.

To move again later, repeat steps 1-4 (step 3 only changes `product:`).

## Coming back to releases

Put the `release:` line you removed back into `instance.yaml` (`git log -p -- instance.yaml` shows it), keep `product:` as it
is, commit, push and apply. That works while `product:` is on main and descends from that release's kernel. From then on the
updater installs the next graduated release whose kernel descends from your `product:`; until one does, nothing changes.
Running the installer again (`curl -fsSL https://get.aidenhq.ai | sh`) does not do this for you: on an instance without
`release:` it leaves the pin as it is.
