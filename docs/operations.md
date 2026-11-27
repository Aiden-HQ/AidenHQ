# Operations

## Apply, upgrade, rollback

Run `aidenhq-apply --wait` on the host as the instance's user, never root (`ops/aidenhq-apply` in the product checkout;
`ops/setup.sh` links it into that user's `~/.local/bin`, which a login shell has on its PATH; elsewhere run
`~/aidenhq/ops/aidenhq-apply --wait`). It is the one way an apply starts, for people, sessions and the kernel's approved applies
alike: it queues `ops/apply-config.sh` as a transient user unit, so an ssh disconnect or a kernel restart never kills it,
and prints the unit to follow (`journalctl --user -fu <unit>`). Without `--wait` it returns once the apply is queued;
with it, it follows the output until the apply ends and exits with its status. Once the apply holds the lock its output
names its generation and that generation's log (`~/.local/state/aidenhq/apply-<n>.log`). The unit is collected when it
ends, failed or not.

An apply of a commit already applied is a no-op: when the instance's origin/main and its product pin are the last known good
generation's pair, the apply prints `already applied: generation <n> …` and exits 0 without a new generation. `aidenhq-apply
--wait --force` runs it in full anyway (after a change only this host has, such as `.env` or a secret); `--force` also applies a
pair held after a failed health check.

`ops/apply-config.sh [<instance commit sha>]` is the whole apply. It is the locked entry point: it opens `data/apply.lock`
at that fixed path (before `.env` is read, so nothing the apply reads decides what it locks), holds the lock on fd 9 and
execs `ops/apply-config-work.sh`, which takes no lock of its own. One apply runs at a time; a second one waits for the
lock (`another apply is running: this one waits its turn`) and then applies the instance's `origin/main` as it is by then,
so applies queued behind each other converge on main's head. A rollback, the boot recovery and a module secret's restart
wait for the same lock. The lock is held across the hand-over to a newer script too. The kernel's approved apply
(`kernel.apply`) lands its commit, queues an apply the same way, and is done by the first good generation whose instance
commit contains its commit, its own apply's or one queued before it.

`ops/apply-config-work.sh` is the body:

1. checks the descriptor it was handed: fd 9 must carry a lock this process holds and must be `data/apply.lock` itself,
   by device and inode (`ops/lib/apply-lock.sh`). `AIDENHQ_APPLY_LOCKED` is only the hand-over marker, so a descriptor
   locked on any other file is refused, naming the lock, and nothing below runs. The entry point refuses the same claim
   before it execs this script, so a marker over an unrelated descriptor never causes the real lock to be taken;
2. refuses to run if either checkout has local changes to tracked files;
3. fast-forwards the instance repo (`AIDENHQ_INSTANCE_DIR`) to `origin/main`, or to exactly the commit given;
4. checks out the product commit pinned by `product:` in `instance.yaml` (it must be on the product's `origin/main`); if
   that commit changes `ops/apply-config.sh` or `ops/apply-config-work.sh`, it hands over to the new script once (`exec`,
   with the previous product in `AIDENHQ_APPLY_BEFORE` so restarts are still decided against it), so one run is always
   enough;
5. runs `node scripts/compile.ts`, builds agent computer images, runs `ops/compose-recreate.sh`, and
   `node scripts/paperclip-setup.ts`;
6. restarts the kernel when what it loads at startup changed (the import closure of `kernel/src/main.ts`, which
   includes the compiler under `scripts/`, plus the host's `.env` it reads at boot), compared by a hash kept in `data/kernel-code`.

`ops/compose-recreate.sh` is the compose step. The images are already built (by validation, or by the switch when nothing
was validated, as in `--generation`), and only when what they build from moved since this host last built them (each
build's compose config and the tracked content of its context; `imageInputs`), or one is missing. It stops before dumping
or removing anything when the config lists no services; recreates only the services whose image, compose config or
mounted secret content moved, and when there are any, dumps the warehouse first, when this host runs one (a fresh file
created exclusively under `umask 077` in a `0700` directory, so a taken name is skipped rather than truncated and the dump
is `0600`; an older dump is never rewritten, only has its mode tightened, and only the newest two are kept, the rest
removed); a step that recreates nothing dumps nothing, and so does one on the product already running where no recreated service's image moved (a
settings-only apply recreates containers on the same code, so no migration can run; the nightly dump is the copy). It removes compose's leftovers for
services this config dropped, never a CI job's runner; and retries once for the daemon's two races (a removal already in
progress, a container name still in use). A recreate that was killed leaves its half-made replacement behind (compose
creates it as `<12hex>_<project>-<service>-1` and renames it only once the old one is gone); each pass removes those,
never a running one, before deciding what moved, so a retry never trips on "name already in use". A service still left
`created` at the end is started. It prints one line per service saying what became of it: `recreated`, `kept`, or
`leftover cleaned`.

A generation that fails its health check is reverted once: the last known good's product comes back, and the instance
keeps everything except the failed move (`revertInstance` in `ops/apply-config-work.sh`). When the product moved, the
instance stays at the failed generation's commit with the last known good's `product:`, `product_fork:` and `release:` put
back; otherwise the instance commit that generation applied is reverted. So an app apps-mcp registered, a setting or a
handbook edit committed since the last known good stays. The revert is a local, detached commit on the instance checkout,
anchored by `refs/aidenhq/revert-of-<n>`. Apply never pushes the instance, so its `main` is unchanged, and the
`apply alert:` line says what was undone.

An apply that dies mid-run (killed, its shell gone) leaves its generation `pending`, or `failed` before the auto-revert
ran. It is finished like a failed health check (the snapshot put back, the last known good re-applied) by whichever comes
first: the dying shell's own exit trap, the next apply (before it does anything else; it holds the lock, so nothing else is
applying), or at boot the oneshot user unit `aidenhq-apply-recover` (`ops/apply-config.sh --recover`, installed by apply
and setup). The dead pair is then held like any failed one: `--force` from the owner's shell applies it again. A dead
rollback is only marked failed. From the generation's first line, the apply writes to its log file
(`~/.local/state/aidenhq/apply-<n>.log`) and a follower (`gnutail` where the host has it, else `tail -f --pid`) copies the
lines to the caller; the apply never writes into a pipe, so a follower that dies (uutils `tee`/`tail` 0.10 have panicked)
costs only the copy.

A service reads a mounted secret (a compose `secrets:` entry) once at start in most cases, and rotating the secret's file
changes neither its image nor its compose config hash. The compose step therefore records a digest of each service's
mounted secret files against the container it belongs to (`data/compose-secret-digests/`), and recreates the service when
that content changes. The digest is taken before a service starts, and recorded against the container the step started
only if the files still match it afterwards: a secret that rotates mid-start may have been read either way, so that
container is recreated again on the next apply rather than trusted. A container with no record yet (the first apply after
this was added) is recreated once, then recorded, and a record written for a service the step started is what keeps the
retry after a daemon race from starting it a second time. A service recreated because it was stopped or missing (a data
snapshot stops its module's containers) is recorded the same way, so the next apply keeps it.

Each phase prints one line, `apply timing: <phase> <seconds>s`, and a total; run by the installer (`AIDENHQ_PROGRESS_BASE` set), setup and the apply also print `AIDENHQ_PROGRESS=<n>/<total> <percent>% <step> ~<minutes left>` as each phase starts (`ops/lib/progress.sh`; the phase tables, with estimated seconds, sit in `ops/setup.sh` and `ops/apply-config-work.sh`); setup prints its own sections on one
`setup timing:` line. A cached image build costs a few seconds; a changed one is the real build (the board's tsc and vite
build is about 17s). Setup's Paperclip calls run four at a time.

Module data (spec §6.4.1): before an apply switches, it stops the containers of each module it touches that has
`services.data: true` (new to this host's config, or its `data_version` changed) and archives `data/modules/<module>/` to
`~/checkpoints/gen-<n>/<module>.tar` (as root in a pinned container, so root-owned files come along; the archive is the
owner's, `0600`). Without room for it (1.2 times the dirs plus 20 GB, as `scripts/backup.sh`) the apply is refused and the
containers start again. The newest two `gen-*` snapshots are kept. A failed health check puts the whole snapshot back
before the last known good starts. `ops/rollback.sh <n>` puts back only modules whose `.data_version` marker is above the
`data_version` generation `n` declared, each from the earliest snapshot after `n`, and refuses when that snapshot was
pruned. A restore unpacks into a fresh sibling folder and swaps it in, so a module never has half its old data.
`data/kernel/`, the vault, Paperclip's database and live Postgres clusters are never in a snapshot; `scripts/backup.sh`
covers them. A code-only change to a module is not snapshotted (git and the images bring the old code back), so a
module that changes its data's format must bump `data_version` in its `module.yaml`, or a failed apply can't put its old
data back.

It is idempotent. The Engineer runs it for you after you approve a change.

- **Upgrade the product:** merge to product `main`, bump `product: <sha>` in the instance repo, commit and push, apply.
- **Release updates** (an instance with `release:` from Aiden-HQ/aidenhq-distro; [design](design/release-updates.md)): the
  kernel runs `node kernel/src/updates.ts check` hourly. It verifies the newest release (shas on each official repo's main,
  no downgrade, the published asset's `tested` stamp from a successful `release.yml` run on the tag's commit) and, at
  02:00-05:00 in `settings.timezone` with `auto_update` on (unset = on) or after Update now (the kernel's `/updates` page),
  fast-forwards a local product mirror to the release's kernel and commits the pin on the instance repo's `release/<name>`.
  The kernel files it as a `kernel.apply` (the planner verifies it again; the AI reviewer's while auto-updates are on, the owner's otherwise) and follows
  it. State: `data/updates/state.json`; the board reads `~/.local/state/aidenhq/board/updates.json`. By hand:
  `node kernel/src/updates.ts check`. The installer run again also moves the pin (`node kernel/src/updates.ts pin <release>
  <distro sha>`, from `ops/setup.sh`) and refuses an older release.
- **A release install on a main commit:** the owner's Claude calls the owner MCP's `update` (`main` or a sha); the updater
  verifies it (on main, after what runs, `ci-required` green on it) and files it like Update now. Leaving releases for
  good: [operations/hand-pinned.md](operations/hand-pinned.md).
- **Roll back:** revert the instance commit (or set `product:` to the earlier sha), push, apply again. That rolls back
  code, not module data. `ops/rollback.sh <n> [--plan]` goes back to apply generation `n`
  (`~/.local/state/aidenhq/generations.jsonl`) with the data it needs (above); `--plan` prints the shas and each module
  whose data it would restore, with the time that data goes back to.
- **After changing a connection service:** nothing; apply rebuilds its image and recreates it. A rotated compose secret
  is picked up the same way on the next apply. Force-recreate (`docker compose up -d --force-recreate <svc>`) only after
  changing a file a service reads once at start that is not a compose secret (a bind-mounted config, for example):
  running it after every apply restarts those services a second time for nothing.
- **After changing kernel code:** apply-config restarts `aidenhq-kernel` (SIGTERM; `KillMode=process`): the kernel stops following its jobs (offsets saved in `data/kernel/kernel.db`) and exits; the next kernel adopts every job whose shell is still that run (pid and its `.exit` file name) and reports one that died while no kernel ran as lost, which the kernel resumes in the same session.

- **The model gateway** (`kernel/src/gateway`, user unit `aidenhq-kernel`): every model call goes through it, and it alone reads `openrouter_key`. apply-config installs and starts the unit before compose and setup, and restarts it only when the code it loads at startup (the closure of `kernel/src/main.ts`) or its unit changed. A bind that fails (the backplane address before compose is up) is retried in the process while loopback serves. It listens on `127.0.0.1:8201` (Engineer jobs through their jail, the AI reviewer, and the computer launcher, which forwards its boxes' model calls with the box's run token; the gateway names that run at the launcher's `/whoami`) and `10.231.0.1:8201` (Codex in Paperclip with the run's own JWT, the source writers, the board's cost reports at `/v1/costs/<report>`), and, with the ci module on, `10.231.4.1:8201` (the CI runners' bridge: CI tokens only, see [modules/ci](../modules/ci/README.md#how-it-runs)). Spend (spec §5.12): limits count real cost. A call goes ahead while the install's spend (`spend_day_usd`, a UTC day, default $50; `spend_month_usd`, a UTC calendar month, default $1000) and the task's spend (`task_usd`, default $20; a chat or routine task: per UTC day) are below their limit, so one call may take a limit past it; its output limit is bounded to what the tightest limit's room buys at the model's price on OpenRouter's own models list (`GET /api/v1/models`, held in memory and refreshed hourly, the last good list kept on a failed refresh; an id OpenRouter doesn't list is refused), never under 1,024 tokens. It settles at what OpenRouter billed for it (the answer's `usage.cost`). A call past the install's limit gets HTTP 402 `cap_reached` and the owner is told once per limit, period and value; a call past a task's gets 402 and the delegator is told once; there is no off switch and no card. Raise a limit in Settings (the owner's). Ledger: `data/kernel/kernel.db` (`calls` and `cost_rollup`, the cost reports' 15-minute rollup of it kept by triggers, both 62 days). If it is down, no model call is made (`systemctl --user status aidenhq-kernel`, `journalctl --user -u aidenhq-kernel`).
- **Agent memory** (the `memory` module): `memory_note` writes the agent's own memory document in the kernel at once (`data/kernel/memory/agents/<key>.json`, kernel `memory.ts`); a job's handbook and the chat lane read it each time. The agent page's Handbook tab shows it (Memory). To change one agent's memory, ask that agent to remember or forget something. Turning the `memory` module off removes the tools and the section (the documents stay on the data volume).
- **Advisor and fan-out** (`modules/tasks/connections/tasks-mcp/src/models.ts`): `advisor_ask` (every Codex agent; GPT Sol, 5 calls per run) and `fanout_map` (granted per agent; up to 25 items on DeepSeek Flash) call the gateway's `/advisor` and `/fanout` routes with the run's own credential, billed to its run. Engineer jobs consult the same advisor with `aidenhq advise "<brief>"` (on the job's own credential; 5 per job). Both send `ADVISOR_MODEL` (models.ts). Turning the `model-tools` module off drops its prompts and the default `advisor_ask` grant (so no agent gets the advisor that way), but it is not a fan-out kill switch: `fanout_map` is granted explicitly in `modules/chief-of-staff` and `modules/fleet-steward` and survives, and `aidenhq advise` stays (still under the gateway's limits). To stop an existing explicit fan-out grant, remove it from that agent's definition.

## Health

- Paperclip's console listens on `127.0.0.1:3100` only: in `public` and `local` mode (and `tailscale`) reach it over an SSH
  tunnel, `ssh -N -L 3100:127.0.0.1:3100 <you>@<host>`, then `http://localhost:3100` (setup.md step 6).
- `scripts/healthcheck.sh`: read-only check of Paperclip, the board and each service; prints `ok` or `FAIL` per check.
- `scripts/verify-security.sh`: mechanical checks of the security criteria (token scoping, read-only endpoints,
  exposure). Run with the stack up.
- The board's Apps tab lists each app's health; the DevOps Engineer owns an unhealthy app and pages the owner only when
  it cannot fix it.
- The Fleet Steward detects stuck runs, failing apps and sources, and firing alerts and files its "Fleet Ops: check" tasks: [modules/fleet-steward](../modules/fleet-steward/README.md#the-detector).
- The Maintainer (the maintainer module's `maintainer-watcher` service, `modules/maintainer/service/src/watcher.ts`): it has no GitHub
  timer. The github module's change feed posts each issue event to the kernel, and every few seconds the watcher reads the kernel's
  log of the `issues.opened`, `issues.labeled`, `issues.closed` and `github.resync` events on the repos in the github setting
  `maintainer_repos` (the module's `subscribes:`; `GET /v1/events/log` with its own committed cursor) and files one task for the Maintainer
  per trusted issue (`POST /v1/tasks`, source `maintainer-issue:<repo>#<number>`: the same issue is never two tasks; the text names the
  repo and number only, never the issue's title). An event naming the repo's fix label (or `agent-build`) costs one trust read of that
  issue through github-mcp (`/internal/maintainer/issue`), whose verdict, never the event's actor, decides; a label from anyone else is
  logged once and starts nothing. At a first start, after a feed gap (the log is kept 3 days), after a `github.resync` and for a repo
  whose settings changed, github-mcp's bootstrap read (`/internal/maintainer/issues`) lists every open labelled issue and files the
  ones with no task. The cursor and the filed issues are in the watcher's data file (`data/modules/maintainer/state.json`); the cursor
  moves only after a batch's effects are written, so a refused filing or a failed read is retried on the next look and a restart repeats
  and skips none. A fix is its merged PR, and
  the list grants no merge authority: product and official-modules PRs (and agents-org repos) merge on their approved
  card, while a PR on any other maintained repo goes through that repo's own GitHub review and its maintainers merge it.
  A fix PR closes its issue itself through `Fixes <owner>/<repo>#<n>` in its body (`aidenhq publish <owner/repo> <branch> --body-file <body> --fixes <owner>/<repo>#<n>`; `--fixes` needs a body file, since a publish without one keeps an existing PR's description). It reads the host's
  `generations.jsonl` read-only (`AIDENHQ_STATE_DIR`, its mirror in `board/` mounted at `/generations`) for the
  `fleet_generation_status` tool (now the fleet-steward service's, from the kernel): the current pin (the newest generation that got past validation) and the last 20
  generations, newest first. The watcher runs once the module's own token (`maintainer_token`, `MAINTAINER_TOKEN_FILE`) has its content; github-mcp lets that token open its two issue reads (`/internal/maintainer/*`, never `/mcp`) by asking the kernel's `/v1/whoami`, so the github module shares no secret with it. Each look reads the token file again: the watcher logs "maintainer issue watcher waiting" until it is filled, then "maintainer issue watcher on", with no restart. On a repo whose `triage` setting isn't `off` (the default is `new`), each `issues.opened` with no fix label, `feature-request` or `agent-build` that the fleet didn't file
  files a triage task once (source `maintainer-triage:<repo>#<number>`), naming the repo and number only.
  Issues already open when the watcher starts, and any a per-issue run missed, are the daily triage's.
  Those runs read a stranger's text before a trusted label, so they are capped a day per issue author on invalid issues (5, a product constant in `kernel/sdk/src/maintained-repos.ts`; an issue carrying the fix label or `feature-request`, the latter labelled by a trusted labeler, is valid and
  uncounted); past it, the issue is held and triaged the look a slot frees (the daily run has it after a day). A fix that a label leads to still passes the Engineer's gates, the AI reviewer and the merge checks.

- Monitoring (module `monitoring`): Prometheus, Alertmanager and Grafana; every alert becomes a Fleet Ops incident. Setup, alerts and access: [docs/design/monitoring.md](design/monitoring.md).

## Backups

`scripts/backup.sh [output-dir] [--plain]` writes a directory `aidenhq-<timestamp>/` of `.tar.gz` parts (`.tar` with
`--plain`), each streamed straight to its file, with the whole data directory (Paperclip, the board, the accounts and their `auth.secret` (`data/kernel/auth`), the gateway ledger, apps-mcp, ops-mcp,
slack-live, the apps node's state), the kernel's job state dir, every `app-*` volume with its labels, the YAML config and
the instance repo as a git bundle. Every SQLite database is also copied online through SQLite's backup API, and
restore puts that copy over the file copy. Files are read through a container, so no sudo is needed. While Paperclip
runs, its live database is left out and its hourly dumps carry it; for a complete Paperclip database, stop the stack
first. A Postgres volume in use (the warehouse's `pgdata`) is skipped; its nightly dump volume is copied. The secret
vault and the notes vault are not included. The backup holds `auth.secret`, so it is mode 0700. It refuses to start
unless the output filesystem has 1.2 times the sources' size plus 20 GB free (a full root disk crashes Paperclip's
Postgres). Each successful apply prunes unused images older than 48 hours and caps the build cache at 20 GB (least recently used
first; both the buildx `--max-used-space` and the classic builder's `--keep-storage` form are tried, since which one the CLI
knows depends on the buildx plugin). Each prune is its own `-`-prefixed `ExecStart=`, so every one runs whatever the ones
before it did; a last, unprefixed step (`ops/prune-docker-verify.sh`) re-reads the host — daemon answering, build cache under
its 40 GB ceiling, no one-off left — and fails the unit when a prune did nothing. `prune-docker.timer` runs the unit every four hours
(not once a night: the peak between prunes is what crossed the alert line), so the space peak between prunes stays under
the alert line. It also removes one-off containers — a container with no compose service and no `aidenhq.computer` label, the class a
`docker run` without `--rm` leaves behind (WOR-9559's two syft scans) — once it has been *stopped* for over a day. It is not
`docker container prune --filter until=`, which filters on created time and so would delete a compose service that an
apply's generation snapshot had just stopped, and its own check reads `State.FinishedAt`; a container with no stop time
(created and never started) is kept, since the day cannot be measured against it. It only reaches containers that carry
the opt-in label `aidenhq.oneoff=1` (the one `ops/security-sbom.sh` puts on its scan container): a container someone
started by hand is never removed, however old. The stop time is read again immediately before `docker rm`, so a one-off
that was restarted in between is kept rather than deleted on a stale reading. No volume is touched (`docker rm` without
`-v`). That step is `ops/prune-docker-containers.sh`. Apply installs changed prune units and runs the same steps after its
rebuilds. Each prune command has its own `timeout` under the unit's `TimeoutStartSec`, so one that hangs cannot stop
systemd reaching the later steps and the verification; the apply-time steps are bounded the same way, since `|| true`
only helps once the command exits. The verification judges the cache on a snapshot taken immediately after the two builder
prunes and before the image and container prunes (its own prefixed step, `prune-docker-step.sh build-cache ... docker
system df`), so a build that grows the cache while later steps run does not read as a prune that capped nothing. That
ceiling is 40 GB, not the prune's 20 GB target: a working prune leaves the fleet's ordinary cache on the 20 GB line (it
peaks near 30 GB), so a 20 GB judgement would fail every ordinary run;
40 GB is above that peak and still catches a prune that did nothing (an uncapped store holds 100 GB or more), while disk pressure
is left to `DiskSpaceLow`/`DiskNearlyFull`. In that snapshot, over the ceiling with nothing reclaimable is a build holding
that cache in use (the ceiling holds), while any reclaimable bytes at all mean the prune did nothing. The snapshot, its status and its invocation are one record, so a run
is only ever judged on its own result, and the ceiling's only tolerance is the precision Docker printed the size with.

Each step's exit status is recorded for the verification: the `-` prefix keeps a failure from skipping the next step, and
the verification reads the record, so a failed prune still fails the unit without running the same 48 h prune a second
time. The two builder forms are read as a pair: one failing is the expected `unknown flag` on a CLI that lacks that form,
but both failing is no cap at all, and the verification fails the unit for it — under the ceiling the size alone would
read clean. The image step is wrapped by `ops/prune-docker-step.sh`, which writes it; `ops/prune-docker-containers.sh` writes its
own, since a container listing that failed while the daemon was unreachable can recover before the verification's
re-listing, and that fresh listing alone would read as a clean scan. A `build-cache` snapshot that could not be read is
reported as unknown, never as "nothing cached".

`scripts/restore.sh <backup>` refuses to run while containers or the kernel are up, and moves existing state aside
(`.pre-restore-<stamp>/`) rather than deleting it. It leaves an app volume that already exists alone. A new host can be
built from a backup with `ops/setup.sh --restore`. Off-host, nightly: [operations/migrate-host.md](operations/migrate-host.md#10-backups-off-host).

Moving a running instance to another host (drain, cold copy, tailnet names, rollback): [operations/migrate-host.md](operations/migrate-host.md).

## Task workspaces and disk

Every job of a task runs in `<work_dir>/tasks/<identifier>` (default `~/aidenhq-work`), with its build-cache overlays in
`.cache-layers/<identifier>` and its engine home (the Codex home and sessions) in `<state_dir>/<engine>/<agent>_<task>`.
`state_dir` (default `~/.local/state/aidenhq-runner`) is the **kernel's live job state**, whatever its name says: never delete it
(every Engineer job fails with EACCES until it is restored). The kernel's disk sweep (`kernel/src/workspaces.ts`, every 15 minutes) removes each
of those folders, and check folders a dead kernel left in `checks/`, once nothing live uses it (no running job, no box not yet released) and its task has been done or
cancelled for a day, or it has been idle for 3 days whatever the task's state (a resumed task clones again and starts a fresh
session). When a disk is over 80% used the limits drop to a day idle and closed at all. Every job box shares one npm cache,
`<work_dir>/.cache/npm` (packages filed by their integrity hash; `node_modules` and build output stay in the task folder); the
sweep starts it afresh weekly while no job runs, or over 80% once it is an hour old. Docker is bounded by
`prune-docker.timer` (Backups above); Paperclip's dumps, journald (its default cap), `~/checkpoints` (the last generations)
and the skill runtimes are bounded where they are made. `DiskSpaceLow` (80%) and `DiskNearlyFull` (95%) file Fleet Ops
tasks for the Fleet Steward; neither tells the owner.

## Retention

`kernel/src/retention.ts` runs ten minutes after the kernel starts and then daily (stopped by a drain, one batch of 100 rows at a time):

- **Kernel rows.** A finished row loses its big text 14 days after its last move. Records: the card's details (replaced by an
  "expired" note, `card.expired`; an apply's stays), `context`, and every arg value over 1,000
  characters (the connection and tool a veto binds to, and a write's `prs` and `only`, always stay; `paths` is filled from the
  diff first). Jobs (any state but admitted and running):
  `full_prompt` and the step list (`progress` keeps the last words and `stepCount`). Checks (any state but running): `spec` and
  `result` (the receipt, verdict and cost stay; a result recipe asked again after expiry runs again and restores its spec).
  `expired` (ms) marks a cleared row. Live rows are never touched.
- **Paperclip.** `kernel/src/paperclip-prune.mjs` runs inside the Paperclip container (`docker exec`, its bundled `pg`):
  heartbeat runs finished more than 7 days ago with their events, leases and operations, their run logs on disk, execution
  workspaces nothing references any more, and `activity_log` rows older than 30 days. Foreign keys are read from the live
  catalogue: a nullable reference is set NULL, a NOT NULL reference keeps its run, and so does a run still owed its cost
  accounting or holding a lease that is not released or expired. One pass at a time (an advisory lock), stopped after 45
  minutes; `DRY=1` (`docker exec -i -e DRY=1 -e RUN_DAYS=7 -e ACTIVITY_DAYS=30 <container> node --input-type=module - <
  kernel/src/paperclip-prune.mjs`) counts what a pass would delete. Paperclip's own UI loses runs older than a week.
  The container is `AIDENHQ_PAPERCLIP_CONTAINER` (default `aidenhq-paperclip-1`).

Clearing rows frees pages for reuse but never shrinks a file: `ops/compact-stores.sh kernel` (under the apply lock: a short kernel
stop, VACUUM INTO, verified swap) and `ops/compact-stores.sh paperclip` (VACUUM FULL per table) are run by hand, once, when the first runs have
cleared a few weeks of rows (the kernel's first clears start 14 days after the system began; Paperclip's prune frees most at once).

## Host one-offs

A disk reclaim, an image or build-cache prune, or removing runner state is destructive host work, and an apply must never
start inside one: the apply's compose step builds images and restarts services, and a prune can remove an image the apply
has built but not yet attached. Run the whole one-off under the apply lock:

    cd ~/aidenhq
    flock data/apply.lock -c '<the one-off>'

That is the same `data/apply.lock` the apply opens and holds for its whole run (`ops/lib/apply-lock.sh`), so an apply
queued meanwhile waits its turn (`another apply is running: this one waits its turn`) instead of starting inside the work.
A one-off that will outlast a few minutes says so in the message that asks for it.

Never delete stateful data — an app's, the warehouse's or a module's files under `~`. Never remove a path a live job is
using: a closed task's workspace goes through the kernel's own sweep (`kernel/src/workspaces.ts`), and anything a running
job holds waits until it holds none.

## Logs and debugging a run

- `docker compose logs -f <service>` for any service; `systemctl --user status aidenhq-kernel` and
  `journalctl --user -u aidenhq-kernel` for the kernel. After a full disk journald keeps logging to `/run` (no per-user
  file there) until `sudo journalctl --flush`, so `--user` shows nothing new; the owner's `systemd-journal` group
  (`ops/vm/setup.sh`) reads it there too: `journalctl _SYSTEMD_USER_UNIT=aidenhq-kernel.service`.
- A run's full transcript is its Codex session log: `**/sessions/**/*.jsonl` under the Paperclip container's codex
  home (or `/workspace/.paperclip-runtime/codex/home/sessions` in an agent computer). Tool calls are `function_call`
  lines.
- Paperclip's UI shows runs, costs and activity per agent.
- Every agent run failing at once usually means the OpenRouter balance is empty.

## App deploys

Agents deploy apps through `apps-mcp`; sensitive ones wait for the owner's approval. Stateful apps (such as the
warehouse) are deployed only on the owner's explicit say-so. To deploy by hand, on the host:

```sh
ops/app-deploy.sh deploy <app> [sha]
```

This calls the running apps-mcp, so its per-app lock applies.

A deploy records one of four outcomes: `healthy`, `rolled_back` (it ran but failed health or a check, and the previous good
commit is running again), `failed`, and `build_failed` (its `compose up` itself failed: a build error or a broken host, so
nothing of it ever ran). A `build_failed` deploy with no good deploy behind it reads as `failed` in `app_status`. The
auto-deploy loop treats a commit as done once any attempt at it ends in something other than `build_failed`, and retries
a `build_failed` commit on each poll up to three attempts: an environment fault that is fixed lets the same commit deploy
by `auto-deploy` a little later, while an app-side failure is still never retried.

### Where apps are served

Apps are on their own tailnet node, `https://$APPS_TS_HOSTNAME.<tailnet>.ts.net:<port>` (`apps-edge` in
`compose.yaml`), never on the host's name: a browser sends the host's cookies, the board's session among them, to
every port of it. The host's own `tailscale serve` has the board only (`https://<board-host>` on 443, to `127.0.0.1:3121`;
Paperclip's `127.0.0.1:3100` is also allowed, but `ops/setup.sh` doesn't publish it): apply turns anything else off (`scripts/host-serve.ts prune`) and `scripts/verify-security.sh` fails on it. apps-mcp writes the
node's serve config (`data/apps-edge/serve/serve.json`) from the registry and joins the node to each exposed app's
own network, where the app's port-publishing service answers as `edge-<app>` (an alias only the platform sets; an
app deployed before it is served after its next deploy). The node joins once with the vault's
`tailscale_apps_authkey` (a reusable, tagged, pre-authorized key; compile creates the file empty), then keeps its
identity in `data/apps-edge/state`. `apps-edge` runs only when `config/apps-node` is `tailnet` (the key is in the vault
and exposure is `tailscale`): otherwise compile takes it out of the stack and the apply removes its container. After adding
the key, apply again. Set
`APPS_URL_BASE` in `.env` to its address. The node is the apps' door only in `tailscale` exposure with that key and
`APPS_URL_BASE` set (compile writes `config/apps-node`: `tailnet` or `none`): only then may an exposed, unshared app take
token-less callers as anonymous (`AIDENHQ_ANONYMOUS`, set at deploy, so redeploy apps after it changes). Without it every
app requires a signed identity and has no Open link (docs/design/app-identity.md).

## Tiered approvals

Design: [design/approvals.md](design/approvals.md).

The instance setting `autonomy` (`off` | `tier0` | `full`; docs/configuration.md) decides who approves. Code tiers each
write from verified state (`kernel/src/tier.ts`, `kernel/src/writes.ts`): Tier 0 runs at once with an audit row on the board, Tier 1
goes to the AI reviewer (the `modules/ai-reviewer` module, policy `modules/ai-reviewer/service/security/policy/`), Tier 2 to the
owner (Telegram card). Every record shows its tier, reason and `decided_by` on the board; a digest of what was decided
without the owner reaches Telegram once a day from 21:00.

- Agents-org PRs end merged: whenever an agent opens or pushes to a PR in an agents-org repo (not
  the product or instance repo), the code host module requests the merge itself, and tiers each PR on its own. A head the code host
  pushed to a branch of that repo (any task's; `pushed_heads` in its state), with named checks green or still running on
  it, is Tier 0: it starts at once, even while the task's run goes on (merges are GitHub calls, not workspace changes),
  with an audit row. Each Tier 0 PR merges independently, checked every poll, as soon as its named checks are green on
  that exact head and GitHub can merge it: no order, gap or base-branch check, and no branch update after other merges.
  Green means every named check passed, GitHub's own rollup is green, `UNSTABLE` only from advisory checks, and no
  more than one page (100) of checks. A conflict (or "behind" under an up-to-date rule) is updated once, and the PR
  then merges only at GitHub's own update commit of that head (parents: the head and the base's current tip, signed
  by GitHub), once its checks pass there; any other new head is tiered again (a head it didn't push goes to
  the AI reviewer). Each PR is tiered on its own, and one still waiting for its first checks (up to five minutes after
  the push) doesn't hold the others. A card approved while such a queue runs takes over; the queue's waiting PRs are
  requested again and start once the card's queue ends. A PR with a failing
  check, an unresolvable conflict or a refused merge is reported once on the task and left; the others keep merging. A
  queue that finishes during the run sets the task's status only after the run ends. A fork's or anyone else's head
  goes to the AI reviewer; `.github/` changes, sensitive apps and missing checks are cards and red checks a comment, as
  before, once the run is over. Card-approved merges, and everything in the product and instance repos, merge one at a time per
  repository (merges.ts), each only at the head its record bound, once every named check has passed there. In either queue a red check whose Actions job never judged the commit
  (cancelled, timed out, failed to start, or `code-review`'s own "failed"/"incomplete" comment on that head) is re-run
  once per check and head before the merge fails; a second failure, or any real failure beside it, is final. The re-run
  runs as the owner's GitHub sign-in (`repo` covers it).
  A red check whose job ran **no step** and carries a failure annotation (GitHub refused to start it: billing, a spending
  limit, no runner) is the environment's, not the commit's: it is classified apart from a failed check, never sent to the
  Engineer to fix or rebase, and the head is never moved for it. It is re-run once at the same head; if it never starts
  again the merge stops with one receipt naming the check and GitHub's annotation, saying the head is not at fault and the
  change has to happen outside the repository. The product watcher classifies these the same way: such a check wakes no
  rebase, so no new head is minted and a green check set is never thrown away for one.

- Keys (generated by compile, in the vault): `reviewer_key` (the kernel's reviewer slot: files Tier 1, records Tier 0, posts verdicts).
  The owner's own Claude decides through the board's MCP (docs/setup.md, Manage AidenHQ from your Claude); a no that closes a stale or duplicate card is stamped `stale:account:<id>` and is never a veto.
- Before `autonomy: full`, run the planted eval on the host and require 100%:

```sh
cd ~/aidenhq && OPENROUTER_API_KEY="$(cat ~/.config/aidenhq/openrouter_eval_key)" node modules/ai-reviewer/scripts/reviewer-eval.ts
```

- Pause: set `autonomy: off` and apply (a settings change: the AI reviewer and a second reviewer decide it; or edit the
  grants table on the host for an immediate stop).

## Shared sources

Slack, GitHub, Jira, meeting notes and Drive documents are ingested once into the warehouse (`src_slack`, `src_github`,
`src_jira`, `src_meetings`, `src_docs`; design: [design/sources.md](design/sources.md)). The writers
are slack (its live listener), github-mcp, jira-mcp, ops-mcp (meeting notes in full, from the vault) and google-workspace-mcp (the
primary account's Drive: metadata + a cheap summary + link); agents read with apps-mcp's `warehouse_query`,
`source_new` and `source_ack`. apps-mcp also proposes cross-source identity links hourly (`src_meta.people_identities`,
exact email match only).

- Network: writers and apps-mcp reach Postgres on compose's `sources` network (`aidenhq_sources`), which only the
  warehouse app joins (`connects: [sources]`); apps can't, so they never reach those services. The warehouse is stateful:
  after the apply that adds this, deploy it once (the owner's approval) so its container joins `sources`.
- `ops/warehouse-sources.sh` (run by every apply) creates the writer roles, their schemas and `src_meta`; each writer
  creates its own tables and views at start. While the warehouse isn't running it skips; run it again once it is.
  The warehouse module's task search needs pgvector, which ships in the warehouse image: after the apply that brings it, deploy the
  warehouse once, then apply again (or run this script) to create the extension; search answers "unavailable" until then.
- Writer passwords are generated secrets (`warehouse_src_<source>_password`, made by compile). Writers connect lazily and
  retry each pass, so a role created after they started is picked up without a restart.
- The DevOps Engineer checks `src_meta.ingest_run` on each heartbeat and posts a source stale for over an hour to the
  "Fleet issues" task (its handbook, "Shared sources").
- Slack's gap sync reads as the owner through slack-mcp's relay of the Slack sign-in (`slack_relay_key`, its read scopes);
  until the owner connects Slack, src_slack gets live events only.
- Each pass writes `src_meta.ingest_run` (source, scope, rows, error; `status` holds a non-error marker, e.g. `retired`
  for an image target absent from a batch that inventoried every running and configured image: settled against the
  replacement scanned that pass, or, when nothing runs the reference and no configured image names it, with no
  replacement). A batch is complete when every planned image unit has a row; two units that share one key (two containers
  on one image index) are one row, so the marker is written when each planned key is covered, not when the row count
  equals the unit count. When the writer does list two SBOMs under one key, the scanner reconciles them as one
  inventory, and any image row the batch listed that did not scan cleanly leaves every absent image unverified (it may
  be running under the name the writer chose for it), so only a pass that inventoried every image it listed may retire
  one. src_docs has two scopes: `drive` (code) and `summaries` (OpenRouter, the root `openrouter_key`; model
  `DOCS_SUMMARY_MODEL`, default `~deepseek/deepseek-flash-latest`, ZDR). Without the key it stores metadata only.
- Confluence pages are `src_jira.confluence_pages` (jira-mcp; ingest_run source `jira`, scopes `confluence` and
  `confluence_summaries`, model `CONFLUENCE_SUMMARY_MODEL`, else `DOCS_SUMMARY_MODEL`). To check the Atlassian tool
  parameters it uses: `docker compose exec jira-mcp node dist/src/probe.js` (schemas), or with a tool name and JSON args
  to make one read call.

## Security module

Security Watch, the Red Teamer and the scanner: [modules/security](../modules/security/README.md#how-it-runs). The host inventory timer is `aidenhq-security-sbom.timer` (`ops/security-sbom.sh`).

## Vault

The secrets directory is a gocryptfs view mounted at boot by `aidenhq-vault.service`; Docker requires it and the
user units wait for it. Check with `systemctl status aidenhq-vault` and `mountpoint ~/.config/aidenhq`. If it is
locked, nothing that needs secrets starts. Recovery without the TPM: [ops/vault/README.md](../ops/vault/README.md).

## User units

`aidenhq-kernel` is a systemd user unit; the optional `config/runner.yaml` holds the job tuning it reads. Units start only once the vault is
mounted and restart on failure. Other units: `aidenhq-computers` (the agent computer launcher, optional; a restart
never ends a run: boxes stay up and the new launcher adopts them, and the old one drains as the kernel does
(`ops/run-draining.sh`): its model and tool calls in flight finish there while the new one takes new calls; a new image
applies from the next acquire) and
`aidenhq-transcripts.path` (meeting transcript watcher). Enable user units to survive logout with
`loginctl enable-linger <user>`.

## CI runners

Self-hosted GitHub Actions runners for app repos: setup, registration, rotation and scaling are in [modules/ci](../modules/ci/README.md#how-it-runs).
