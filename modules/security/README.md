# security

## What it does

Two agents that watch your own estate. Security Watch scans what you run for CVEs, verifies them against the web and
files fix tasks. The Red Teamer attacks your own apps and agents, reports with a proof of concept and never patches.
Findings land in the warehouse (`src_security`), and a reviewed false positive (verdict `not-affected`) isn't new work.

## Connect

Nothing to connect. Optionally set `app_auditor_url` (an App Auditor MCP server behind Cloudflare Access) and put its
service token in the vault (`app_auditor_cf_client_id`, `app_auditor_cf_client_secret`).

## What agents get

- Declares the role `security-verdict` (`finding_verdict` records a verdict on a finding).
- Security Watch reads apps and the warehouse, files verdicts and tasks, and notifies you. The Red Teamer reads apps and
  may call an app's API (`app_api`) and creates tasks.
- Routines: `security-scan` (daily 10:00, or by webhook), `security-weekly` (Monday), `red-team-new` (daily) and
  `red-team-weekly` (Wednesday).

## New installs

In the default bundle. All four routines start paused under quiet start, so no scan or attack runs until you turn them
on.

## How it runs

`modules/security`: Security Watch (`security-watch`) and the Red Teamer (`red-teamer`), plus `security-scanner`, the
`src_security` writer (grype, no LLM). The inventory is made on the host, because it needs the Docker socket and the root
filesystem, which the scanner never gets: `ops/security-sbom.sh` (user timer `aidenhq-security-sbom.timer`, daily 03:30)
runs pinned syft over the host packages, every running image variant (two containers on one multi-platform index — an
amd64 service and an emulated arm64 one — are two targets; the key is a function of the variant alone, never of which
other variants run: the variant on the daemon's own platform always keeps the plain tag key and a variant on any other
platform is always suffixed `@<platform>`, so a target's name does not move when a variant comes or goes and its findings
are not filed under another's; each image is read from a `docker save` archive, never
through a mutable tag: the archive is exported on the platform the container itself runs — its `ImageManifestDescriptor`,
which on the containerd store names the platform manifest the container was created from, not the variant the daemon's own
platform resolves — from an immutable id that holds that manifest, or from the tag itself only while it still names that
manifest, rechecked after the save; keyed by the container's own id, or by its tag while the tag still names what runs, so
findings already held under that id reconcile; a running container whose image record the daemon no longer holds as an
image (untagged and collected while the container kept running) is inventoried from the container itself: `docker export`
into `data/modules/security/sbom-exports` — a sibling of the mounted `sbom` directory, never inside it, because the
security-scanner has that one mounted at `/sbom` and a raw export can hold runtime data no other service should read — and
syft scans the extracted root as a directory under the same `image:<id>` target, with `container:<id>` in the `targets.tsv`
commit column as provenance (a scan of the container's filesystem, not proof about the missing image; two replicas of one
gone image are one target, their files extracted into one real root, and `container:<id>,<id>` names both). The
daemon's own "No such image" or "invalid reference format" takes this path — the latter is how it refuses a reference it
cannot parse at all, such as a bare container id, so a container whose image record the store cannot name is still
inventoried; a timed-out or refused inspect stays an error line so the next pass retries the image; an image nothing can
read or fit, and a container whose export fails, is a
`targets.tsv` line naming the id and the error, never a silent gap), the product and instance checkouts and each
app's deployed source, into `data/modules/security/sbom/current/`. The host target scans `/` without the homes (`./home/**`,
`./root/**`), procfs, the container stores and this instance's own checkouts: a clone, task worktree or tool cache there
belongs to another project's dependency tree, and no apt upgrade or `ops/vm/pins.json` clears it, so it would be permanent
noise beside the packages the operator can fix; `/usr`, `/opt`, `/etc` and `/var/lib/dpkg` stay in it. `targets.tsv`
records the checkout's git HEAD for `repo:product` and `repo:instance` (and `container:<id>` for a container-root scan),
and the scanner copies it to each target's `src_meta.ingest_run` row. The pass writes into `data/modules/security/sbom/.work` on `/`,
keeps each target's archive in `data/modules/security/sbom/.archives` until its scan, and keeps a container export and its extracted root in
`data/modules/security/sbom-exports` (mode 700, because it can hold runtime data) only for the scan: each unit's tar and
extracted root are removed together as soon as its scan ends, and anything left goes with the pass, so nothing of them
stays under `data/`. Every image is saved under the lock, from a reference
resolved there on the container's own platform (an immutable id that holds its platform manifest, else the tag itself),
sized as that same reference and platform (an index reports the whole index while a platform save writes one manifest),
and the plan sizes every image before writing anything, then cuts the set into waves smallest first, admitting an image
only while that wave's archives plus the largest one's own size again (the workspace its scan unpacks into while every
archive is still on disk) fit above the floor. Exports run smallest first and scans largest first: the snapshot deadline
is spent on exports, so a large save that runs it out still leaves the smaller archives written, while the peak scan is
the first one, with the whole wave on disk and its predecessors' archives deleted after each scan — the accounting above
is that peak, not a sum of every workspace. Each wave's saves happen under the apply lock and its scans after the lock is
released, before the next wave's saves, so two waves' archives are never resident together. That is what lets a set whose
whole archive total plus its largest does not fit above the floor still be inventoried in full instead of dropping its
largest image on every pass. A
later wave takes the lock again for its saves, within what is left of the pass's one overall export budget; a wave that
cannot get the lock, or starts after that budget is spent, is recorded as unscanned lines rather than a gap.
An image that cannot fit even a wave of its own — its archive held for its own scan plus its own size to unpack it — is a
line stating the admitted total, its size, the largest archive, the room above the floor and the shortfall, and no bytes
are written for it. Free space is checked again before each save and again before each scan, and an export is written under a file-size
ceiling set to the room left above the floor, so a save larger than the daemon's estimate is stopped while it is written
rather than after it has taken the reserve; the export is watched while it runs, so if free space reaches the floor on the
archive's filesystem or on Docker's root (the daemon staging its own copy, say) it is stopped too; that image is deferred to a wave of its own, and a save blocked when
nothing of its wave is written is retried once before it is a line, since another writer's pressure may be temporary. A target that loses its room between waves is
deferred, not dropped: its numbers are printed, it gets a wave of its own after the planned ones, and it is saved and
scanned once the pass's own archives are freed. If a wave's archives turn out larger than the sizes the plan saw, its
scans run in rounds, the smallest remaining archive taken out when a round can scan none, and that image comes back in a
later wave the same way — so the images the disk can hold are scanned rather than the wave, or the image, being skipped on
every pass. Deferral is bounded: once the pass has spent one extra wave per surveyed image, an image that still does not
fit is a line with the numbers instead of another wave. It empties the work dir after every target, keeps 30 GB free (an
image whose size the daemon won't report is recorded and not scanned: an unknown demand can't be judged to fit). A container that reports no platform descriptor (an
older daemon, or a single-platform
store) is read on the Docker server platform, and the pass says on stderr how many it did that for; a Docker API older
than 1.48 (which has no `image save --platform`) uses a plain save, sized as the whole reference because that is what the
save writes, and then reads the archive back under the same deadline: an `index.json` must name exactly one manifest, a
descriptor that is itself an index is resolved into the blob it names (one platform manifest), and that manifest must be
the platform manifest the container runs (or, on the classic image store, whose image id is the config digest, the sole
manifest's `config.digest`); an archive with no `index.json` must have a `manifest.json` with exactly one image, whose
`Config` digest is that same pin; an archive that cannot be read is a line. So the scan is always of the running variant, never of another platform or build
under its target, and the fallback is also said on stderr.
Its descriptor is the authority on what a container runs: the tag is a target only while it names that manifest, and the
Compose label or the container's own id only answer for a daemon that reports none. A second pass started
while one holds `.lock` skips rather than running two at once.

The container enumeration, the image target list and every `docker save` are taken under the host's apply lock
(`data/apply.lock`), each Docker call bounded by a timeout and the whole phase — from `docker version` before the first
inspect to the last save — by an overall deadline, so an apply neither runs against a half-applied snapshot nor waits on
an unresponsive daemon or a hung save. A pass that cannot enumerate
(a failing `ps`, an inspect that fails for a still-running container, or a re-list that fails after such an inspect) keeps
the previous batch instead of publishing a short one. The lock is released before the syft scans, and the snapshot
deadline ends with the lock so a long host scan can't make a later check look overdue. Every image's archive is exported from the reference the lock
resolved (an immutable id, or the tag itself with a second check after the save), so a tag rebuilt in between is a line
rather than another build's packages under the old target.
`AIDENHQ_SBOM_MIN_FREE_GB` can raise
the floor for a smaller disk, never lower it: 30 GB is the least a pass runs with, and a value under it (or not a number) is
ignored. The scanner matches a new batch within the hour (or daily anyway) and fires Security
Watch's webhook when anything changed. On demand:
`ops/security-sbom.sh`, then `docker compose exec security-scanner node dist/src/main.js once`.

The apply installs and enables the timer while the module is on, and its `AIDENHQ_DIR` follows the checkout the apply applied
(`~/.config/aidenhq-security-sbom.env`, written every apply), so a batch never runs an older checkout that
`~/.config/aidenhq-checkout.env` names. `scripts/healthcheck.sh` fails an apply whose SBOM unit would run another checkout's
`ops/security-sbom.sh`. To run the first batch once the module is on:

```sh
systemctl --user start aidenhq-security-sbom   # first batch; also creates data/modules/security/sbom as you (not root)
```

After the apply, `ops/warehouse-sources.sh` creates `src_security` (apply runs it). A stale batch shows as an
`ingest_run` error on scope `sbom-batch`.

App Auditor (optional): set `app_auditor_url` (the security module's setting) to your App Auditor MCP server and put
a Cloudflare Access service token for it in the vault
(`app_auditor_cf_client_id`, `app_auditor_cf_client_secret`), the scanner starts a vibe audit of each registry app when
it is new and weekly after (one start per pass), and writes the findings to `src_security` (tool `app-auditor`). The token
can read every team's audits, so it stays in the scanner. Empty files: off, and Security Watch asks the owner to run
the audit by hand instead.
