# Release updates: installs from a release update themselves

Status: built (2026-11-18), first shipped in release 2026.11.3; through `kernel.apply` since the big switch (P2).

## Intent

An install from the public installer (get.aidenhq.ai) runs a release: `instance.yaml` pins `release: { name, source, sha }`
from the distro repo (Aiden-HQ/aidenhq-distro), `product:` is that release's kernel (the official modules are its `modules/`; the default set is its
`modules/marketplace.json` bundle, so a release has no module list); apply pulls the release's prebuilt images by digest. Until now nothing moved it on: "upgrade to the latest
main" pins a commit that is not a release (apply refuses it), nobody was told a release was out, and re-running the
installer did not move the pin. Owners of these installs should get each release safely, without doing anything, and stay in
charge: auto-updates on by default, off in Settings, and "Update now" for the impatient.

## Approaches considered

- **A routine (an agent checks and files a card).** Routines are paused by quiet start, and an update must never rest on an
  agent's say-so. Rejected.
- **A user unit on a timer that commits, pushes and applies by itself** (built first, 2026-11-18). It was a second way to
  change the pin and run apply, beside `kernel.apply`: its own landing, lock hand-over, revert pusher and crash recovery.
  Replaced (simplification P2).
- **Chosen: the kernel finds and files; `kernel.apply` does the rest.** The check is a child process the kernel runs (its git
  and network work stays off the kernel's loop); the kernel files what it prepared as a `kernel.apply`, which is tiered,
  landed and applied as every instance change is.

## The design

- **Who updates.** Only an instance whose `instance.yaml` has `release:` sourced from `github: Aiden-HQ/aidenhq-distro`. An
  instance that pins `product:` by hand (the maintainer's, tracking main) follows the release train instead.
- **The setting.** `settings.auto_update` (kernel setting, `on`/`off`, unset = on). New release installs get `on` written by
  `ops/setup.sh`. Turning it back on is the owner's tap (`auto-update` in `kernel/src/apply-tier.ts`).
- **The check** (`node kernel/src/updates.ts check`, run by the kernel hourly and at once on Update now) lists the distro
  repo's release tags (`git ls-remote` over https) newer than the release followed and takes the newest that passes
  verification (below): a refused one is told to the owner once and the next older is tried; a network error waits for the
  next check, with no message. The result goes to `data/updates/state.json` and a display copy at
  `~/.local/state/aidenhq/board/updates.json` (the board's read-only mount).
- **Release names** are the cut date, `2026.11.18`; a second cut that day is `2026.11.18.1` (the distro's nightly). They
  compare part by part as numbers: `2026.11.18` < `2026.11.18.1` < `2026.11.19`.
- **When it is filed.** The owner asked (Update now), or auto-updates are on, it is 02:00-05:00 in `settings.timezone` and
  this release never failed here. Maintenance, not agent work: quiet start does not hold it.
- **Preparing it:** the kernel commit is put on the product checkout's `origin/main`, where the planner reads the product move
  (GitHub has it; a local mirror gets a fast-forward push); one commit moving `product:` and `release.{name,sha}` (dropping an
  obsolete `aidenhq` marketplace entry) on the instance repo's branch `release/<name>`, built on its main.
- **Filing it:** the kernel files a task of its own for the platform engineer (no agent works on it) and a `kernel.apply` of
  that commit on it (`writes.fileUpdater`: the requester kind `kernel`, which no token yields), as the release train files a
  product bump. The planner tiers it like any apply. Only the updater's own filing, while auto-updates are on, whose head is
  exactly the pin the planner's own verification of that release writes for this base (`updates.ts verify`: tag on the
  distro's main, newer than the current release, the tested stamp, the kernel descending), is the AI reviewer's (`release-pin`,
  Tier 1: the owner's standing authority). Every other release move is the owner's after the reviewer, and new module
  authority the release brings is the owner's either way. The autonomy and routine caps limit what agents do on their
  own, so they don't hold a write the kernel itself requests: with `auto_update` on, a verified release installs on the
  reviewer's yes with no owner approval (owner, 2026-11-18). The code host
  that owns the instance repo lands it (codehost-local's land for `local/…`, the bare repo on this host; codehost-github's
  otherwise) and the kernel's apply executor runs `ops/apply-config.sh` once.
- **The outcome.** The kernel follows the record: done is installed; anything else (a rejected card, a failed apply) is
  failed, with its reason, and the night never files that release again (Update now does, while it is still newer). A failed
  apply leaves its pin landed, as any apply does: apply's own health check has put the host back on the last good generation.
- **Telling the owner.** Each event (available, installed, failed, refused, an Update now that couldn't start) is a line in
  the state file; the kernel sends each once through the owner channels' line (kernel.db `update_notices`).
- **Update now.** The board's Settings > Instance links to the kernel's `/updates` page (admin listener, signed-in admin,
  CSRF): its button files the release now.
- **Upgrading by hand.** Run the installer again (`curl -fsSL https://get.aidenhq.ai | sh`). It verifies the new release as
  on day one, refuses an older release, and the new kernel's `ops/setup.sh` moves the pin (`node kernel/src/updates.ts pin`)
  before its apply. That is setup's bootstrap and the recovery when the updater itself is broken, not a runtime path.

## Security model

Hard gates, from day one (no observe mode):

- **Fixed source.** The distro and kernel repositories are constants (`Aiden-HQ/...` on github.com, https only; the
  official modules are the kernel's `modules/`). The release file can't redirect them: a `kernel_repo` other than the
  official one (a `marketplace` in it is not read), or an image outside
  `ghcr.io/aiden-hq/`, is refused.
- **Verified before anything runs.** The tag's commit is on the distro's `main`; the release file resolves against the instance it would pin (`release.ts`: 40-char shas, image digests, `product:` = kernel); the kernel
  commit is on the repository's `main` (GitHub serves fork and PR commits through the upstream URL,
  so a sha alone proves nothing). The apply then reads the file again at the pinned distro sha, and checks out exactly
  those shas; images are pulled by digest.
- **No downgrade.** The release name must be newer than the one followed, and the kernel and marketplace commits must
  descend from the running ones. The installer's rerun refuses an older release too.
- **The tested stamp.** The published asset `<release>.json` must equal the file at the tag except for `tested`, and its
  `tested.ci_run` must be a successful `release.yml` run of exactly the tag's commit, on the tag itself: a push of the tag, or a
  `workflow_dispatch` on the tag ref (the distro's nightly dispatches it, since a tag pushed with `GITHUB_TOKEN` starts no
  workflow), never a run on a branch (GitHub's API). A run still in progress is checked again next time. A tag pushed without
  the release workflow passing, or a hand-edited asset, is refused and the owner told once.
- **Authority.** Auto-updates on is the owner's standing authority, so the updater's verified move is the AI reviewer's;
  any other release move, and every release with it off, is the owner's tap. Update now is an admin's tap on the kernel's page. No agent can
  file a release: the kernel files it, from its own check.

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

**New module authority.** A release is planned like any product move: the authority diff it brings is the owner's tap,
whatever `auto_update` says.

## Left out

- Channels other than stable releases (betas), pinning to a release line, or delaying a release: no knob beyond on/off.
- Host-level setup a release might need (new packages, units outside apply): an update runs apply only. A release that needs
  `ops/setup.sh` again says so in its notes, and the owner reruns the installer.
- Retrying a failed release on its own: it waits for Update now. A check that stops before anything was filed is retried at
  the next run.
- Updating instances that pin product by hand: they follow main through the Platform Engineer, as before.
