# Release updates: installs from a release update themselves

Status: built (2026-11-18), first shipped in release 2026.11.3.

## Intent

An install from the public installer (get.aidenhq.ai) runs a release: `instance.yaml` pins `release: { name, source, sha }`
from the distro repo (Aiden-HQ/aidenhq-distro), `product:` is that release's kernel and the `aidenhq` marketplace is its
modules sha; apply pulls the release's prebuilt images by digest. Until now nothing moved it on: "upgrade to the latest
main" pins a commit that is not a release (apply refuses it), nobody was told a release was out, and re-running the
installer did not move the pin. Owners of these installs should get each release safely, without doing anything, and stay in
charge: auto-updates on by default, off in Settings, and "Update now" for the impatient.

## Approaches considered

- **A routine (an agent checks and files a card).** Routines are paused by quiet start, and an update must never rest on an
  agent's say-so. Rejected.
- **The kernel installs from its own timer.** The install's apply restarts the kernel, so the installer can't be a kernel
  child, and network fetches would sit in the process that holds the model key. Rejected; the kernel keeps the owner-facing
  half only.
- **Re-running the installer from a timer.** It runs as root and redoes host setup each night. Too much. It stays the manual
  path (below).
- **Chosen: a user unit on a timer (`aidenhq-update.timer`, hourly) running `ops/update.sh`**, which checks, verifies and
  installs through the normal apply. The kernel reads what it recorded, tells the owner and serves Update now.

## The design

- **Who updates.** Only an instance whose `instance.yaml` has `release:` sourced from `github: Aiden-HQ/aidenhq-distro`.
  Apply installs the timer while that holds and removes it otherwise, so an instance that pins `product:` by hand (the
  maintainer's, tracking main) has no updater at all.
- **The setting.** `settings.auto_update` (kernel setting, `on`/`off`, unset = on). New release installs get `on` written by
  `ops/setup.sh`; 2026.11.2 installs have it unset, which is on. It shows on the board's Settings > Instance (Updates) and
  as a switch; changing it is an ordinary settings change.
- **One run** (`ops/update.sh` → `node kernel/src/updates.ts run`, hourly and on Update now) holds the host's apply lock
  on fd 9 for its whole length, waiting for an apply in progress as a land does (up to 15 minutes; still busy, an Update
  now request is kept for the next run). It finishes what a dead run left, checks, and installs when it should.
- **Release names** are the cut date, `2026.11.18`; a second cut that day is `2026.11.18.1` (the distro's nightly). They
  compare part by part as numbers: `2026.11.18` < `2026.11.18.1` < `2026.11.19`.
- **The check** lists the distro repo's release tags (`git ls-remote` over https) newer than the release followed and
  takes the newest that passes verification (below): a refused one is told to the owner once and the next older is tried;
  a network error stops the check until the next run, with no message. The result goes to `data/updates/state.json` and
  a display copy at `~/.local/state/aidenhq/board/updates.json` (the board's read-only mount): the release followed, the
  one available with its `notes` (an optional list in the release file) and a compare link.
- **When it installs.** The owner asked (Update now), or auto-updates are on and it is 02:00-05:00 in `settings.timezone`
  and this release never failed here. This is maintenance, not scheduled agent work, so **quiet start does not hold it**.
- **The install:** verify again; make sure the kernel commit is on the product checkout's `origin/main` (an installer
  checkout's origin is GitHub, which has it; a local mirror gets it pushed, fast-forward only); one instance commit moving
  `product:` and `release.{name,sha}` (dropping an obsolete `aidenhq` marketplace entry), as an upgrade by hand does, recorded in the state as
  `installing` before it is pushed; then `ops/apply-config.sh` on the instance's main, handed the held lock
  (`ops/lib/apply-lock.sh`). Main, not the commit alone: a commit another writer pushed after it is applied with it rather
  than refused. Apply's output goes to a file, so nothing it leaves running holds the updater. Never a `git pull`.
- **Rollback.** Apply already treats a failed post-switch health check as a failed generation and re-applies the last known
  good one (the previous release) with its data snapshot. The updater then reverts its commit on the instance's main, so
  git and the pin say what runs, records the release as failed (the night never retries it; Update now does) and tells the
  owner why, in the apply's own words.
- **A run that dies mid-install** (a reboot, an OOM kill) leaves `installing`. The next run first lets apply finish its own
  dead generation (`--recover`), then reads what the host applied in full (`data/applied-product`): the new kernel is
  installed; anything else is a failed install, its pin commit reverted and the release marked failed, so no later
  instance commit can bring it back at any hour. A pin commit that never reached main changed nothing.
- **Telling the owner.** Each event (available, installed, failed, refused, an Update now that couldn't start) is a line in the state file; the kernel
  (`createUpdates`) sends each once through the owner channels' line (kernel.db `update_notices`). Aiden can read the same
  state through `fleet_generation_status` (`release`), when the agent holds that tool.
- **Update now.** The board's Settings > Instance links to the kernel's `/updates` page (admin listener, signed-in admin,
  CSRF), which shows the release and what changed; its button writes `now.json` and starts the unit. The board never
  decides it: one-click owner actions live on the kernel's pages.
- **Upgrading from 2026.11.2 by hand.** Run the installer again (`curl -fsSL https://get.aidenhq.ai | sh`). It verifies the
  new release as on day one (baked digest, pinned shas, tree checks), refuses an older release than the instance runs, and
  the new kernel's `ops/setup.sh` moves the pin (`node kernel/src/updates.ts pin`, the same commit) before its apply; if
  that apply fails, setup reverts the pin commit before it stops. From 2026.11.3 on, the updater takes over.

## Security model

Hard gates, from day one (no observe mode):

- **Fixed source.** The distro and kernel repositories are constants (`Aiden-HQ/...` on github.com, https only; the
  official modules are the kernel's `modules/`). The release file can't redirect them: a `kernel_repo` other than the
  official one (a `marketplace` in it is not read), or an image outside
  `ghcr.io/aiden-hq/`, is refused.
- **Verified before anything runs.** The tag's commit is on the distro's `main`; every module sha is on the marketplace's
  history at the release's sha (as `install.sh` checks); the release file resolves against the instance it would pin (`release.ts`: 40-char shas, image digests, `product:` = kernel, marketplace agreeing); the kernel
  and marketplace commits are on their repositories' `main` (GitHub serves fork and PR commits through the upstream URL,
  so a sha alone proves nothing). The apply then reads the file again at the pinned distro sha, and checks out exactly
  those shas; images are pulled by digest.
- **No downgrade.** The release name must be newer than the one followed, and the kernel and marketplace commits must
  descend from the running ones. The installer's rerun refuses an older release too.
- **The tested stamp.** The published asset `<release>.json` must equal the file at the tag except for `tested`, and its
  `tested.ci_run` must be a successful `release.yml` run of exactly the tag's commit, on the tag itself: a push of the tag, or a
  `workflow_dispatch` on the tag ref (the distro's nightly dispatches it, since a tag pushed with `GITHUB_TOKEN` starts no
  workflow), never a run on a branch (GitHub's API). A run still in progress is checked again next time. A tag pushed without
  the release workflow passing, or a hand-edited asset, is refused and the owner told once.
- **Authority.** Auto-updates on is the owner's standing authority; Update now is an admin's tap on the kernel's page. No
  agent can start an install: the unit is started by the timer or the kernel's admin page, and the request file lives in
  the data dir, which no job sees (`kernel/src/sandbox-config.ts` hides it). Turning `auto_update` from off to on through the fleet should
  be the owner's tap (see the tiers note below).

What a compromised distro repo could do: with push access to `main` and the release workflow, an attacker can publish a
release that passes every check above. The kernel and module commits must still be on the official repositories' `main`
(a second compromise), but **the prebuilt images are not independent**: the distro's own `release.yml` builds and pushes
them to `ghcr.io/aiden-hq` (`packages: write`), so distro access alone can ship arbitrary image code by digest. The
`ghcr.io/aiden-hq/` prefix only keeps a release file from pointing at another registry. That is the residual risk, the
same trust a fresh install places in the distro repo; the updater doesn't add to it. Cheap mitigations in place: the fixed
repos, main ancestry for every sha, the stamp bound to a workflow run on the tag commit, no downgrades (an old vulnerable
release can't be replayed), and the owner told of every release that fails a check. Not done: signed releases (a key the
installer bakes in, e.g. minisign over the release file and its image digests), or rebuilding images from the verified
kernel instead of pulling them; either would cut the trust to the key holder or to the source repos. They are the next
step if the distro repo gains more maintainers.

**An update accepts new module authority without a card.** A product bump through the fleet goes through the authority
diff (`tiers.mjs`), and new write authority is the owner's tap. A release update doesn't: the owner's standing
`auto_update: on` is that tap, for exactly the releases the maintainer cut and tested. The release notes should say when a
release adds authority. If that's not acceptable, `auto_update: off` leaves every release to Update now.

**Tiers note.** Enrolling an instance in unattended updates through the fleet is the owner's tap after the reviewer
(`services/runner/src/tiers.mjs`, its own eval-gated PR): adding or moving `release:`, and `auto_update` from off back to on
or unset. Dropping the release pin and turning auto-updates off stay ordinary changes.

## Left out

- Channels other than stable releases (betas), pinning to a release line, or delaying a release: no knob beyond on/off.
- Host-level setup a release might need (new packages, units outside apply): an update runs apply only. A release that needs
  `ops/setup.sh` again says so in its notes, and the owner reruns the installer.
- Retrying a failed release on its own: an apply that failed (a registry blip included) waits for Update now. A check or
  install that stops before anything moved is retried at the next run.
- Updating instances that pin product by hand: they follow main through the Platform Engineer, as before.
