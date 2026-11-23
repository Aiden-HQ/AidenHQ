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
6. restarts the kernel when its code changed.

`ops/compose-recreate.sh` is the compose step. The images are already built (by validation, or by the switch when nothing
was validated, as in `--generation`), and only when what they build from moved since this host last built them (each
build's compose config and the tracked content of its context; `imageInputs`), or one is missing. It stops before dumping
or removing anything when the config lists no services; recreates only the services whose image, compose config or
mounted secret content moved, and when there are any, dumps the warehouse first, when this host runs one (a fresh file
created exclusively under `umask 077` in a `0700` directory, so a taken name is skipped rather than truncated and the dump
is `0600`; an older dump is never rewritten, only has its mode tightened, and only the newest two are kept, the rest
removed); a step that recreates nothing dumps nothing. It removes compose's leftovers for
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

- **The model gateway** (`kernel/src/gateway`, user unit `aidenhq-kernel`): every model call goes through it, and it alone reads `openrouter_key`. apply-config installs and starts the unit before compose and setup, and restarts it only when `kernel/src/gateway` or its unit changed. A host whose apply-config predates the hand-over (step 3) runs its old script for the apply that brings the hand-over in; start that one apply with the new script instead: `git fetch -q origin main && git show <product sha>:ops/apply-config.sh > ops/.apply-next.sh && bash ops/.apply-next.sh; rm -f ops/.apply-next.sh` (it checks out the product, sees the script changed and hands over to the checked-out one). A bind that fails (the backplane address before compose is up) is retried in the process while loopback serves. It listens on `127.0.0.1:8201` (Engineer jobs through their jail, the AI reviewer, and the computer launcher, which forwards its boxes' model calls with the box's run token; the gateway names that run at the launcher's `/whoami`) and `10.231.0.1:8201` (Codex in Paperclip with the run's own JWT, the source writers, the board's `/usage` pull), and, with the ci module on, `10.231.4.1:8201` (the CI runners' bridge: CI tokens only, see CI runners). Spend (spec §5.12): limits count real cost. A call goes ahead while the install's spend (`spend_day_usd`, a UTC day, default $50; `spend_month_usd`, a UTC calendar month, default $1000) and the task's spend (`task_usd`, default $20; a chat or routine task: per UTC day) are below their limit, so one call may take a limit past it; its output limit is bounded to what the tightest limit's room buys at the model's price on OpenRouter's own models list (`GET /api/v1/models`, held in memory and refreshed hourly, the last good list kept on a failed refresh; an id OpenRouter doesn't list is refused), never under 1,024 tokens. It settles at what OpenRouter billed for it (the answer's `usage.cost`). A call past the install's limit gets HTTP 402 `cap_reached` and the owner is told once per limit, period and value; a call past a task's gets 402 and the delegator is told once; there is no off switch and no card. Raise a limit in Settings (the owner's). Ledger: `data/kernel/kernel.db` (`calls`); the old `data/gateway/usage.db` is merged in at every start while it exists (idempotent) and otherwise left alone. If it is down, no model call is made (`systemctl --user status aidenhq-gateway`, `journalctl --user -u aidenhq-gateway`).
- **Agent memory** (the `memory` module): `memory_note` writes the agent's own memory document in the kernel at once (`data/kernel/memory/agents/<key>.json`, kernel `memory.ts`); a job's handbook and the chat lane read it each time. The agent page's Handbook tab shows it (Memory). To change one agent's memory, ask that agent to remember or forget something. The apply imports each agent's legacy memory file from the instance repo once (`ops/memory-move.ts`, before the kernel restarts); a one-time script in `ops/` cancels the old inbox tasks, by hand. Turning the `memory` module off removes the tools and the section (the documents stay on the data volume).
- **Advisor and fan-out** (`modules/tasks/connections/tasks-mcp/src/models.ts`): `advisor_ask` (every Codex agent; GPT Sol, 5 calls per run) and `fanout_map` (granted per agent; up to 25 items on DeepSeek Flash) call the gateway's `/advisor` and `/fanout` routes with the run's own credential, billed to its run. Engineer jobs consult the same advisor with `aidenhq advise "<brief>"` (on the job's own credential; 5 per job). Both send `ADVISOR_MODEL` (models.ts). Not yet in agent computers. The kill switch below drops only the agents' tools; `aidenhq advise` stays (still under the gateway's limits). Kill switch: `settings.model_tools: off`, then apply.

## Health

- Paperclip's console listens on `127.0.0.1:3100` only: in `public` and `local` mode (and `tailscale`) reach it over an SSH
  tunnel, `ssh -N -L 3100:127.0.0.1:3100 <you>@<host>`, then `http://localhost:3100` (setup.md step 6).
- `scripts/healthcheck.sh`: read-only check of Paperclip, the board and each service; prints `ok` or `FAIL` per check.
- `scripts/verify-security.sh`: mechanical checks of the security criteria (token scoping, read-only endpoints,
  exposure). Run with the stack up.
- The board's Apps tab lists each app's health; the DevOps Engineer owns an unhealthy app and pages the owner only when
  it cannot fix it.
- The Fleet Steward (module `fleet-steward`): its service (`modules/fleet-steward/service/src`) runs the detector every
  `fleet_ops_interval_minutes`: from the kernel's job ledger (`/v1/work`) a run stuck past twice its timeout, an agent's last 3
  runs failed, or 3 runs in a day with no steps and no output; a task held for grading over a day; from apps-mcp (a module token
  holding `apps.read`) an app incident open over 15 minutes (or apps-mcp not answering for 15 minutes), a source with no good
  pass in an hour or failing for 15 minutes, an app's failing quality check and an agents-org pull request open over an hour
  without merging; and Alertmanager's alerts (one incident per firing alert, posted to `POST /alerts` and reconciled against its
  list each tick). It files one "Fleet Ops: check" task for the Steward (`POST /v1/tasks`, kernel.tasks; fixed text, never an
  incident's words) once per new incident and once on recovery, at most every 30 minutes unless one is critical. State is in
  `data/modules/fleet-steward/state.json`; the Steward reads it with `fleet_detector` (the proxy fences the answer, an alert's
  label text carries a second fence) and logs on the "Fleet issues" task (`log ·` lines). The same service serves the Coach's
  `coach_due` and `coach_evidence` and `fleet_generation_status` (the kernel's `/v1/work?generations=1`), and `/metrics`
  (`aidenhq_steward_incidents_open`, `aidenhq_steward_alerts_firing`). A routine whose last three kernel jobs all
  hard-failed (`failed` or `timeout`, counted from the jobs' `routine` in `GET /v1/work?agent=`) is paused by the detector itself
  (`POST /v1/routines/pause`, role `kernel.routines`, pause only; setup keeps a paused routine paused across applies) and the
  owner is told once (notify kind alert, dedupe key `routine-paused:<id>`; Aiden resumes it, and a resume starts a fresh
  count). Nothing is paused while the failures are fleet-wide (no agent finishing a job, or a 401 or 402 in a recent failure);
  the routine stays flagged. The `missed` group raises an active routine whose next schedule fire (`nextRunAt`, read with
  kernel.cp-read) is over 15 minutes overdue: Paperclip's scheduler has stopped.

- The Maintainer (the maintainer module's `maintainer-watcher` service, `modules/maintainer/service/src/watcher.ts`): every
  `maintainer_poll_minutes` (default 5; it reads `MAINTAINER_POLL_MINUTES`) the watcher asks
  github-mcp for the issues labelled since each repo's cursor on every repo in the github setting `maintainer_repos`
  (`[{ repo, label, trusted }]`; github-mcp holds the list, the watcher only its cursors) and files one
  task for the Maintainer per trusted issue (`POST /v1/tasks`, source `maintainer-issue:<repo>#<number>`: the same issue is
  never two tasks; the text names the repo and number only, never the issue's title). A label from anyone
  else is logged once and starts nothing; one repo's failed read holds up no other. Each repo's cursor and fired issues
  are in the watcher's data file (`data/modules/maintainer/state.json`), so a restart repeats and skips none. A fix is its merged PR, and
  the list grants no merge authority: product and official-modules PRs (and agents-org repos) merge on their approved
  card, while a PR on any other maintained repo goes through that repo's own GitHub review and its maintainers merge it.
  A fix PR closes its issue itself through `Fixes <owner>/<repo>#<n>` in its body (`aidenhq publish <owner/repo> <branch> --body-file <body> --fixes <owner>/<repo>#<n>`; `--fixes` needs a body file, since a publish without one keeps an existing PR's description). It reads the host's
  `generations.jsonl` read-only (`AIDENHQ_STATE_DIR`, its mirror in `board/` mounted at `/generations`) for the
  `fleet_generation_status` tool (now the fleet-steward service's, from the kernel): the current pin (the newest generation that got past validation) and the last 20
  generations, newest first. The watcher runs once the module's own token (`maintainer_token`, `MAINTAINER_TOKEN_FILE`) has its content; github-mcp lets that token open its one issue read (`/internal/maintainer/issues`, never `/mcp`) by asking the kernel's `/v1/whoami`, so the github module shares no secret with it. Each tick reads the token file again: the watcher logs "maintainer issue watcher waiting" until it is filled, then "maintainer issue watcher on", with no restart. With the maintainer module's
  `external_triage` on, the same read
  brings each repo's issues opened since its triage cursor with no fix label that our App didn't file (at most 10 per repo
  per tick, oldest first), and each files a triage task once (source `maintainer-triage:<repo>#<number>`), naming the repo and number only.
  The first look only sets the cursor to now; issues already open, and any a per-issue run missed, are the daily triage's.
  Those runs read a stranger's text before a trusted label, so they are capped a day per issue author on invalid issues (`triage_invalid_per_author_day`, default 5; an issue carrying the fix label or `feature-request`, the latter labelled by a trusted labeler, is valid and
  uncounted; per repo there is no cap); past it, the issue is held and triaged the tick a slot frees (the daily run has it after a day). A fix that a label leads to still passes the Engineer's gates, the AI reviewer and the merge checks.

- Monitoring (module `monitoring`, [docs/design/monitoring.md](design/monitoring.md)): Prometheus, node-exporter, cAdvisor,
  Alertmanager and Grafana. Every alert becomes a detector incident (group `alert`), so Fleet Ops works it; `CoreServiceDown`
  and `ApplyFailed` also send the chief of staff one line. Grafana is on `127.0.0.1:3131`; one-time on the host:
  `tailscale serve --bg --https=8444 http://127.0.0.1:3131` (no sudo: the user is tailscaled's operator) and set
  `grafana_root_url`. Sign in as `admin` with the vault's `grafana_admin_password`. Unit and container states come from the
  user timer `aidenhq-host-metrics` (`ops/host-metrics.sh`; apply installs it while the module is on), the gateway's from
  `data/monitoring/textfile/gateway.prom`. No sudo step.

## Backups

`scripts/backup.sh [output-dir] [--plain]` writes a directory `aidenhq-<timestamp>/` of `.tar.gz` parts (`.tar` with
`--plain`), each streamed straight to its file, with the whole data directory (Paperclip, the board, the accounts and their `auth.secret` (`data/kernel/auth`), the gateway ledger, apps-mcp, ops-mcp,
slack-live, the apps node's state), the kernel's job state dir, every `app-*` volume with its labels, the YAML config and
the instance repo as a git bundle. Every SQLite database is also copied online through SQLite's backup API, and
restore puts that copy over the file copy. Files are read through a container, so no sudo is needed. While Paperclip
runs, its live database is left out and its hourly dumps carry it; for a complete Paperclip database, stop the stack
first. A Postgres volume in use (the warehouse's `pgdata`) is skipped; its nightly dump volume is copied. The secret
vault and the notes vault are not included. The backup holds `auth.secret`, so it is mode 0700. It refuses to start
unless the output filesystem has 1.2 times the sources' size plus 20 GB free (a full root disk crashed Paperclip's
Postgres on 2026-11-16). Each successful apply prunes unused images older than 48 hours and caps the build cache at 20 GB (least recently used
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
ceiling is 40 GB, not the prune's 20 GB target: a working prune leaves the fleet's ordinary cache on the 20 GB line (a
29.9 GB peak in the five hours to 2026-11-22T12:45Z), so a 20 GB judgement failed every ordinary run after 2026-11-22;
40 GB is above that peak and still catches a prune that did nothing (an uncapped store held 104 GB), while disk pressure
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
`state_dir` (default `~/.local/state/aidenhq-runner`) is the **kernel's live job state** despite its old name: never delete it
(deleting it on 2026-11-22 failed every Engineer job with EACCES until it was restored). The kernel's disk sweep (`kernel/src/workspaces.ts`, every 15 minutes) removes each
of those folders, and check folders a dead kernel left in `checks/`, once nothing live uses it (no running job, no box not yet released) and its task has been done or
cancelled for a day, or it has been idle for 3 days whatever the task's state (a resumed task clones again and starts a fresh
session). When a disk is over 80% used the limits drop to a day idle and closed at all. Docker is bounded by
`prune-docker.timer` (Backups above); Paperclip's dumps, journald (its default cap), `~/checkpoints` (the last generations)
and the skill runtimes are bounded where they are made. `DiskSpaceLow` (80%) and `DiskNearlyFull` (95%) file Fleet Ops
tasks for the Fleet Steward; neither tells the owner.

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
goes to the AI reviewer (the `modules/ai-reviewer` module, policy `modules/ai-reviewer/service/security/policy.md`), Tier 2 to the
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
  repository (merges.ts), each only at the head its record bound, once every named check has passed there. The `design-review` status is advisory:
  it never holds a merge (owner, 2026-11-23). In either queue a red check whose Actions job never judged the commit
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
- Writer passwords are generated secrets (`warehouse_src_<source>_password`, made by compile). Writers connect lazily and
  retry each pass, so a role created after they started is picked up without a restart.
- The DevOps Engineer checks `src_meta.ingest_run` on each heartbeat and posts a source stale for over an hour to the
  "Fleet issues" task (its handbook, "Shared sources").
- Slack's gap sync needs the owner's user token of the Slack live app in `slack_live_user_token` (scopes in
  `modules/slack/module.yaml`); without it src_slack gets live events only.
- Each pass writes `src_meta.ingest_run` (source, scope, rows, error; `status` holds a non-error marker, e.g. `retired`
  for a security target whose replacement was scanned). src_docs has two scopes: `drive` (code) and
  `summaries` (OpenRouter, the root `openrouter_key`; model `DOCS_SUMMARY_MODEL`, default `~deepseek/deepseek-flash-latest`,
  ZDR). Without the key it stores metadata only.
- Confluence pages are `src_jira.confluence_pages` (jira-mcp; ingest_run source `jira`, scopes `confluence` and
  `confluence_summaries`, model `CONFLUENCE_SUMMARY_MODEL`, else `DOCS_SUMMARY_MODEL`). To check the Atlassian tool
  parameters it uses: `docker compose exec jira-mcp node dist/src/probe.js` (schemas), or with a tool name and JSON args
  to make one read call.

## Security module

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
findings already held under that id reconcile; an image nothing can read or fit is a `targets.tsv` line naming the id and
the error, never a silent gap), the product and instance checkouts and each
app's deployed source, into `data/modules/security/sbom/current/`. The host target scans `/` without the homes (`./home/**`,
`./root/**`), procfs, the container stores and this instance's own checkouts: a clone, task worktree or tool cache there
belongs to another project's dependency tree, and no apt upgrade or `ops/vm/pins.json` clears it, so it would be permanent
noise beside the packages the operator can fix; `/usr`, `/opt`, `/etc` and `/var/lib/dpkg` stay in it. `targets.tsv`
records the checkout's git HEAD for `repo:product` and `repo:instance`, and the scanner copies it to each target's
`src_meta.ingest_run` row. The pass writes into `data/modules/security/sbom/.work` on `/` and keeps each target's
archive in `data/modules/security/sbom/.archives` until its scan. Every image is saved under the lock, from a reference
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
largest image on every pass (2026-11-23: the set's 17 GB image was skipped every pass though each wave could hold it). A
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
rather than another build's packages under the old target. On 2026-11-21 two such scan containers wrote ~142 GB in three hours and `/` reached 81%.
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

## CI runners (modules/ci)

App repos' CI (`modules/ci/template`: jobs `tests` and `code-review`; `code-review` skips the review and passes on a
change under 20 added plus deleted lines with no sensitive path; `package-lock.json`, which the supply-chain job validates, is not counted, but a change that adds a package, changes a version or source, or adds an install script is sensitive, while other lockfiles are counted and always sensitive; an agent's screenshots under `.aidenhq/out/` are not counted, its json and txt reports are; a head whose patch is unchanged since a green review of the same branch and base ref, on a base that only moved forward, reuses that verdict) runs on our own GitHub Actions runners,
`runs-on: [self-hosted, aidenhq]`, registered to the fleet org (`github_fleet_org`). The product repo's CI
(`.github/workflows/`) runs on the same kind of runner, registered to the product repo's org (below). Each
`aidenhq-ci-runner@<n>` user unit (fleet org) or `aidenhq-ci-runner@<org>-<n>` unit (another org) runs
`ops/ci-runner.sh`: it asks the kernel for a one-hour registration token (`ops/ci-runner-token.ts [org]`: `POST
/v1/codehost/runner_token` with the ci module's `ci_token`; the code host mints it as the owner, whose sign-in needs
`admin:org`, and answers only that token), then
`docker compose run --rm ci-runner`: a new container that registers ephemerally, takes one job, exits and is removed;
the unit then starts the next, at once (`Restart=always`, `RestartSec=1`). A refused token (the sign-in missing
`admin:org`, GitHub unreachable) backs off instead: `ops/ci-runner.sh` writes that unit's delay (1 second, doubling to a
minute) and exits, and the unit's `ExecStartPre` (`ops/ci-runner-backoff.sh`) waits it out before the next attempt. The
minute is a hard cap: a longer `ExecStartPre` wait would outlast systemd's 90-second timeout. The next token that mints
clears the delay, and a marker more than 15 minutes old (a drain, an outage) is dropped rather than served, so a
persistent refusal retries slowly rather than hot-looping while a clean job exit still starts the next runner
immediately. Because the wait runs before `ExecStart`, a unit backing off is `activating` rather than `active`. The
marker sits under the host's data dir, which `ops/lib/data-dir.sh` resolves from the unit environment alone -- the apply
writes each unit's `EnvironmentFile=` (`~/.config/aidenhq-ci-runner.env`, `~/.config/aidenhq-host-metrics.env`) from the
host's own `.env`, so the runner and the exporter never read a settings file themselves. A relative value is the
checkout's and a leading `~` is the home directory, with a trailing slash dropped but a lone `/` kept, so the marker is
the same file `ops/host-metrics.sh` exports its backoff series from. The marker is written beside itself and renamed
into place, so the exporter never reads a half-written file, and the exporter only reports a marker for a runner unit
systemd still has enabled or still has running: a runner retired at the cap (disabled and stopped) does not keep the alert
pending, while one disabled with `systemctl --user disable` but left running still retries under its restart policy and
keeps its series. The missing permission also
reaches the owner: a codehost op's `needs_owner` answer is recorded
as connection state, so it lands in the owner's digest (the GitHub card's own row comes from the sign-in's granted
scopes), a 2xx op clears a full cause, and two warnings in `modules/monitoring/prometheus/rules.yml` cover the loop:
`CiRunnerRestartLooping` on a unit that keeps restarting, and `CiRunnerBackoff` on a unit whose persisted wait has sat
at the one-minute cap for ten minutes, which the host-metrics timer writes as `aidenhq_unit_backoff` from the runner's
own marker (the wait itself, so a scrape that misses the brief active intervals between backoffs still alerts; the rule
holds while the wait is at the cap and its `for` is the ten minutes, so a wait that has since cleared raises nothing).

Nothing carries between jobs. The container has no host mounts, no docker socket and none of the instance's secrets; it
sits on `aidenhq-ci` (system unit `aidenhq-ci-net`: the public Internet and, on the host, only the model gateway's CI
listener `10.231.4.1:8201`; no LAN, tailnet, other host ports or other containers). Limits per runner: 4 CPUs, 8 GB.

**Code review spend (the model gateway).** The template's `code-review` job needs no model key: on our runners
(`AIDENHQ_GATEWAY_URL`, set on the runner container) it asks GitHub for its OIDC token (`id-token: write`, that job only)
and trades it at the gateway's `POST /ci/token` for an opaque CI token that lives 2 hours. The gateway
(`kernel/src/gateway/ci.ts`) checks GitHub's signature and that the job is a `pull_request` run of the repo's own
`.github/workflows/ci.yml` for that PR, on a self-hosted runner in the fleet org; each run attempt trades its token
once. The repo and PR come from that signed token, and the answer names the review model and effort
(`settings.ci_review_model`). The CI token works only on the CI listener, only for `responses` (and `chat/completions`
for repos on the older template) with `settings.ci_review_model` or `settings.ci_review_models`, no fallbacks, plugins,
server tools or stored responses, zero data retention forced, under the install's spend limit (a refusal fails the review, no retry). Each call goes out while the limit is not used up
and settles at what was billed (a Responses stream at its `response.completed`); a cut stream keeps its input estimate.
Every call lands in the ledger as kind `ci-code-review` with `<owner>/<repo>#<pr>` and the head the job sent (advisory):
the Costs tab's "App CI code review" line. Revoke: removing the `ci` module refuses every CI token at once.
The reviewer is codex with codex review's guidelines (`.github/code-review.ts`, pinned `@openai/codex`), at the model's effort (critical paths
too), one higher (xhigh) only with the `deep-review` label or text addressed to a reviewer. codex runs with its shell off: the
runner container can't give it its sandbox (bubblewrap needs user namespaces, which Docker and the host's AppArmor refuse
there), so its only tools are `.github/review-tools.ts`, a stdio MCP server that reads the PR's tree and git history
(diff, log, show, blame, read a file, list files, search; for TypeScript and JavaScript definition, references and
diagnostics from a pinned typescript-language-server, with no dependencies installed and type acquisition off) and
nothing else: nothing of the PR runs, writes or connects, and its
environment holds only the CI token (never the job's GitHub tokens). It runs from an empty directory with a config the
job writes (hooks, plugins and apps off), so nothing in the PR is loaded as codex config or instructions; a PR that adds
`.codex/`, `codex.toml` or `AGENTS.override.md` fails the check, and AGENTS.md is a critical path. Its answer must match
an output schema: anything else is no verdict, which passes the check with a comment saying so ("Code review: no verdict on
`abc1234` (not blocking)"; the system fails open rather than stalls, owner ruling 2026-11-21, replacing the fail-closed ruling of
2026-11-17). A run without a verdict (a provider error, a timeout, an answer that isn't a review) gets one
retry when time is left (an incomplete review is not retried); a gateway refusal (bad token, our spend cap) isn't retried. The review target of 2,000 counted lines is
advisory: past it, a run without a verdict says the change is large and suggests stacked PRs. Findings that did come out still
decide (high or critical block). A run without a verdict records no baseline for the next push's delta review, so the next
push reviews the whole PR. A package-lock.json change that adds a package, changes a version or source, or adds an install script is a
critical path, and the reviewer gets a summary of it. Its scripts and the house rules (`.github/code-review-rules.md`) come
from the base commit. Its brief: the house rules, the app's critical paths and its AGENTS.md (base commit), and the PR's
title and description fenced as data, so it judges scope. P0 and P1 findings block (critical, high); P2 and P3 are listed.
A same-repo PR can edit the workflow and spend up to the install's spend limit on the allowed models: the limit and scope are the
boundary, not the job name. Instances without the gateway (no `AIDENHQ_GATEWAY_URL`) use the repo secret
`OPENROUTER_API_KEY` instead; where the gateway is on, delete that secret from the app repos (an edited workflow could
read it).

**Register (once).**
1. GitHub: with `ci` in `modules:` (step 3), the GitHub card on the board asks for `admin:org`: press **Reconnect** and
   allow it. You must be an owner of each org the runners register in.
2. Fleet org → Settings → Actions → Runner groups → Default: allow private repositories (and public if any). No model
   secret: code review spends through the gateway (above), whose `settings.ci_review_model` (default
   `~deepseek/deepseek-flash-latest:high`) picks the model and effort. Off the gateway: the variable `CI_REVIEW_MODEL`.
3. Instance repo: add `ci` to `modules:` in `instance.yaml`; deploy (`aidenhq-apply --wait`).
4. On the VM (sudo, once): `sudo install -m0755 ops/vm/computer-net.sh /usr/local/sbin/aidenhq-computer-net && sudo install
   -m0644 ops/units/aidenhq-ci-net.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable
   --now aidenhq-ci-net` (`ops/vm/setup.sh` does this on new hosts).
5. A run of `ops/setup.sh` with `CI_RUNNERS=2` (its config or the environment) starts that many; or by hand:
   `cp ops/units/aidenhq-ci-runner@.service ~/.config/systemd/user/ && systemctl --user daemon-reload &&
   systemctl --user enable --now aidenhq-ci-runner@1 aidenhq-ci-runner@2`. Check: the org's Settings → Actions →
   Runners lists `aidenhq-<container id>` idle; `journalctl --user -u aidenhq-ci-runner@1`.

CI health on demand (queue time, red rate, slow and failing jobs, merged-PR flakes, both repos): `node scripts/ci-report.ts [--hours 24]`.

**The product repo's org.** The product workflows' heavy jobs can overflow to `[self-hosted, aidenhq]` (below).
`image-scan` builds nothing (a build would run a PR's RUN steps on our runner, and the runner has no Docker): the grype
baked into the runner image scans each changed image's directory (lock files) and the digest-pinned base images its
Dockerfile names (`scripts/supply-chain/image-scan.ts` reads the Dockerfile as text), so packages RUN steps install are
not covered there; the security module's scans of deployed images cover them. A base image's files a Dockerfile replaces
or never copies out (node's bundled npm, the Alpine packages of a stage only partly copied) are owner-approved entries in
`.github/image-scan-exceptions.yaml`, read from the base commit. A PR from a fork is routed to `ubuntu-latest` instead of
our runners (where image-scan fails: no grype). That routing lives in the workflow file the PR itself carries, so it is
not the boundary: the org's runner group is. To serve the product org:
1. You are an owner of that org, and AidenHQ's sign-in is allowed there (an org that restricts OAuth apps shows it on the
   GitHub card).
2. The org → Settings → Actions → Runner groups: a group limited to the repos the runners serve (the `ci_runner_repos`
   setting), named in the instance's `settings.ci_org_runner_group`. Another org's units register only into that group
   and refuse to start without the setting, so they never land in the org's Default group (all repositories). Allow
   public repositories on it only for repos that require approval for all outside collaborators (below).
3. On the VM: `systemctl --user enable --now aidenhq-ci-runner@<org>-1 aidenhq-ci-runner@<org>-2` (the org's login as
   in its URL, e.g. `aidenhq-ci-runner@acme-1`). Check: the group's runners list them idle.

**The public Aiden-HQ repos (AidenHQ, aidenhq-distro).** Their CI runs on GitHub-hosted runners first.
In the product's ci.yml the first job (`checks`) counts the hosted jobs this repo's other runs hold (queued or running) and
sends the heavy jobs (the packages shards and board) to `[self-hosted, aidenhq]` only when that count is 12 or
more (the free plan runs ~20 at once), the repository variable `CI_SELF_HOSTED` is `true`, and the run is a push to main or
a same-repo PR (never a merge train: it holds PRs that may come from forks); any API error keeps them hosted. That routing
lives in the workflow file the run carries, so it is no boundary. The boundaries are: *Require approval for all outside
collaborators* (a fork's workflow runs only after a maintainer approves it), the org runner group (only these repos), and
the runner's job-started hook (modules/ci/runner/job-started.*, baked into the image read-only, run under `env -i`): it
fails any job, before checkout, whose repository is not in the fleet org or the `ci_runner_repos` setting, or whose event
is not a push or workflow_dispatch on the default branch, a schedule, or a pull_request from the same repository (no fork
PRs, merge trains, merge_group, pull_request_target, issue_comment, workflow_run, release or repository_dispatch). The
runner starts the hook with an environment of its own (the github and runner contexts), never the job's `env:`, so a
job-level `BASH_ENV` or `NODE_OPTIONS` does not reach it. To enable: the owner's sign-in with `admin:org` on the
Aiden-HQ org; a runner group there limited to the two repos with *Allow public repositories* on, named in
`settings.ci_org_runner_group`; a product at or after the hook; on the VM `systemctl --user enable --now
aidenhq-ci-runner@Aiden-HQ-1 … aidenhq-ci-runner@Aiden-HQ-4` (four run today, owner 2026-11-22: the host was overloaded at six); then the repo variables
(Settings -> Secrets and variables -> Actions -> Variables): `CI_SELF_HOSTED` and `CI_SELF_HOSTED_RUNNERS` (the number of runners, 4). Unset it to go back to hosted only.
To scale down, `systemctl --user disable --now` each instance above the new count (and `reset-failed` it): a unit that is
only stopped stays enabled, so `ops/ci-runner-units.sh` restarts it and a failed one keeps alerting.
aidenhq-distro can adopt the same routing in its ci.yml later.

A push runs about 21 jobs (the test matrix is 18), each in a fresh container that installs Node and its packages: roughly
10 minutes on two runners. Jobs for one org never take another org's runners.

**Rotate.** Nothing long-lived on the runner: each job's registration token is minted fresh by the code host (revoking
the GitHub sign-in stops new ones; Reconnect restores them). Upgrade the runner by bumping the base image in `modules/ci/runner/Dockerfile`; GitHub stops accepting
runners some weeks after a newer release, so bump when the org's runners page warns.

**Scale.** One unit per concurrent job: `systemctl --user enable --now aidenhq-ci-runner@3`, or `disable --now` one to
shrink. Every unit is up to 4 CPUs and 8 GB while it runs a job, whichever org it serves: keep the total at 2-4 on a VM of
the size docs/setup.md suggests (e.g. 2 for the product org, 1-2 for the fleet org). The enabled instances are what the config
declares runs, and an apply starts every declared one that systemd reports failed: `Restart=always` alone reaches systemd's
start limit and leaves a unit failed with nothing to clear it, so `ops/ci-runner-units.sh` resets and starts those (and the
ones a drain record names) after everything else. A drain (`node scripts/fleet-pause.ts pause`) stops them without
cancelling a job under it, and its resume -- or an apply, or `ops/ci-runner-units.sh` on its own -- clears each unit's
start limit before starting it, so a stopped unit never stays start-limited and failed. Stop all: `systemctl --user stop 'aidenhq-ci-runner@*'` (a running job
is cancelled; GitHub retries nothing, so re-run it).
