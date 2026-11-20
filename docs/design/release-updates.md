# Release updates: installs from a release update themselves

An install from the public installer (get.aidenhq.ai) runs a release: `instance.yaml` pins `release: { name, source, sha }`
from the distro repo (`Aiden-HQ/aidenhq-distro`), `product:` is that release's kernel (the official modules are its
`modules/`, the default set its `modules/marketplace.json` bundle), and apply pulls the release's prebuilt images by digest.
Owners of these installs get each graduated release without doing anything and stay in charge: auto-updates on by default, off
in Settings, and "Update now" for the impatient. The kernel finds and files a release; `kernel.apply` does the rest. The code
is `kernel/src/updates.ts`.

## How it works

- **Who updates.** Only an instance whose `instance.yaml` has `release:` sourced from `github: Aiden-HQ/aidenhq-distro`. An
  instance that pins `product:` by hand follows the release train instead.
- **The setting.** `settings.auto_update` (kernel setting, `on` / `off`, unset = on). `ops/setup.sh` writes `on` for release
  installs. Turning it back on is the owner's tap (`auto-update` in `kernel/src/apply-tier.ts`).
- **Graduated releases only.** The distro publishes each cut as a GitHub pre-release; it graduates (published, not a
  pre-release) after a fresh test instance installed the last graduated release, upgraded with this updater and passed its smoke
  checks (the distro's `graduate.yml`). Discovery reads the distro's Releases API (unauthenticated, every page) and considers
  only graduated tags; `verify` checks again (`releases/tags/<name>`), so a pre-release is never offered or told to the owner.
  An API error is the network's: retried, never a refusal.
- **The candidate exception** (graduation's test instance). `AIDENHQ_UPDATE_CANDIDATE=<release> node kernel/src/updates.ts check
  <release> <by>`, run from the host's own shell, considers that one tag and may prepare it while it is still a pre-release;
  every other check stays. The prepared release carries a `candidate` mark (its distro commit) in `data/updates/state.json`, and
  `verify` accepts the pre-release only while the state's ready or filed release is that name and commit. The variable is read
  by that CLI run alone (the kernel's hourly check strips it) and is no `instance.yaml` setting; no agent's container or
  computer mounts `data/updates`. Every read-modify-write of `state.json` holds `data/updates/state.lock` (a dead holder's lock
  is taken over).
- **The check** (`node kernel/src/updates.ts check`, a child process the kernel runs hourly and at once on Update now) lists the
  distro's release tags (`git ls-remote` over https) newer than the one followed that are graduated and takes the newest that
  passes verification. A refused one is told to the owner once and the next older is tried; a network error waits for the next
  check, silently. The result goes to `data/updates/state.json` and a display copy at `~/.local/state/aidenhq/board/updates.json`
  (the board's read-only mount).
- **Release names** are the cut date, `2026.11.18`; a second cut that day is `2026.11.18.1`. They compare part by part as numbers.
- **When it is filed.** The owner asked (Update now), or auto-updates are on, it is 02:00-05:00 in `settings.timezone` (`NIGHT`)
  and this release never failed here. Maintenance, not agent work: quiet start does not hold it.
- **Preparing it.** The kernel commit is put on the product checkout's `origin/main`, where the planner reads the product move;
  one commit moving `product:` and `release.{name,sha}` is made on the instance repo's branch `release/<name>`, built on its main.
- **Filing it.** The kernel files a task of its own for the platform engineer (no agent works on it) and a `kernel.apply` of that
  commit on it (`writes.fileKernel` with UPDATER: requester kind `kernel`, which no token yields). The planner tiers it like any
  apply. Only the updater's own filing, while auto-updates are on, whose head is exactly the pin its own verification writes for
  this base (`verify`: tag on the distro's main, newer than the current release, the tested stamp, the kernel descending), is the
  AI reviewer's (`release-pin`, Tier 1: the owner's standing authority). Every other release move is the owner's after the
  reviewer. The autonomy and routine caps limit what agents do, so they don't hold a write the kernel itself requests: with
  `auto_update` on, a verified release installs on the reviewer's yes with no owner approval (owner, 2026-11-18). The code host
  that owns the instance repo lands it and the kernel's apply executor runs `ops/apply-config.sh` once.
- **The outcome.** The kernel follows the record: done is installed; anything else (a rejected card, a failed apply) is failed
  with its reason, and the night never files that release again (Update now does, while it is still newer). A failed apply leaves
  its pin landed, as any apply does: apply's own health check has put the host back on the last good generation.
- **Telling the owner.** Each event (available, installed, failed, refused, an Update now that couldn't start) is a line in the
  state file; the kernel sends each once through the owner channels' line (kernel.db `update_notices`).
- **Update now.** Settings > Instance links to the kernel's `/updates` page (admin listener, signed-in admin, CSRF); its button
  files the release now.
- **Upgrading by hand.** Run the installer again (`curl -fsSL https://get.aidenhq.ai | sh`). It verifies the new release, refuses
  an older one, and the new kernel's `ops/setup.sh` moves the pin (`node kernel/src/updates.ts pin`) before its apply. That is
  setup's bootstrap and the recovery when the updater is broken, not a runtime path.

## Security model

Hard gates, from day one (no observe mode):

- **Fixed source.** The distro and kernel repositories are constants (`Aiden-HQ/...` on github.com, https only). The release file
  can't redirect them: a `kernel_repo` other than the official one, or an image outside `ghcr.io/aiden-hq/`, is refused.
- **Verified before anything runs.** The tag's commit is on the distro's `main`; the release file resolves against the instance
  it would pin (`scripts/compiler/release.ts`: 40-char shas, image digests, `product:` = kernel); the kernel commit is on the
  repository's `main` (GitHub serves fork and PR commits through the upstream URL, so a sha alone proves nothing). Apply reads
  the file again at the pinned distro sha and checks out exactly those shas; images are pulled by digest.
- **Graduated.** Published and not a pre-release, in discovery and in `verify`, except the host's candidate.
- **No downgrade.** The release name must be newer than the one followed, and the kernel commit must descend from the running
  one. The installer's rerun refuses an older release too.
- **The tested stamp.** The published asset `<release>.json` must equal the file at the tag except for `tested`, and
  `tested.ci_run` must be a successful `release.yml` run of exactly the tag's commit, on the tag itself (a push of the tag, or a
  `workflow_dispatch` on the tag ref), never a run on a branch. A run still in progress is checked again next time. A tag pushed
  without the release workflow passing, or a hand-edited asset, is refused and the owner told once.
- **Authority.** Auto-updates on is the owner's standing authority, so the updater's verified move is the AI reviewer's; any other
  release move, and every release with it off, is the owner's tap below full autonomy, the AI panel's at full
  (docs/design/approvals.md, Autonomy). Update now is an admin's tap on the kernel's page. No agent can file a release. New
  module authority a release brings follows the normal authority diff: under full autonomy only new spend and a non-official
  module's new authority are the owner's.

**Residual risk.** With push access to the distro's `main` and its release workflow, an attacker can publish a release that
passes every check above. The kernel commit must still be on the official repository's `main`, but the prebuilt images are not
independent: the distro's own `release.yml` builds and pushes them to `ghcr.io/aiden-hq`, so distro access alone can ship
arbitrary image code by digest. This is the same trust a fresh install places in the distro repo. Mitigations in place: fixed
repos, main ancestry for every sha, the stamp bound to a workflow run on the tag commit, no downgrades, and the owner told of
every release that fails a check. Not done: signed releases, or rebuilding images from the verified kernel.

## Not covered

- Channels other than graduated releases (betas), pinning to a release line, or delaying a release: no knob beyond on/off.
- Host-level setup a release might need (new packages, units outside apply): an update runs apply only. A release that needs
  `ops/setup.sh` again says so in its notes, and the owner reruns the installer.
- Retrying a failed release on its own: it waits for Update now. A check that stops before anything was filed is retried at the
  next run.
