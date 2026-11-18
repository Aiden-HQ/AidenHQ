# Operations

## Apply, upgrade, rollback

`ops/apply-config.sh [<instance commit sha>]` is the whole apply, run on the host from the product checkout. It is the
locked entry point: it opens `data/apply.lock` at that fixed path (before `.env` is read, so nothing the apply reads
decides what it locks), holds the lock on fd 9 and execs `ops/apply-config-work.sh`, which takes no lock of its own. One
apply runs at a time; a second one exits at once with `another apply is running` rather than queueing behind a whole
apply. The lock is held across the hand-over to a newer script too. A land (the runner applying an approved change) reads
that refusal as "wait": it tries the apply again once `data/apply.lock` is free, waiting up to 15 minutes, and reports the
wait plainly when the lock does not clear in that time, instead of the change as failed.

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
5. runs `node scripts/compile.mjs`, builds agent computer images, runs `ops/compose-recreate.sh`, and
   `node scripts/paperclip-setup.mjs`;
6. schedules a runner restart when runner code changed.

`ops/compose-recreate.sh` is the compose step. It stops before building, dumping or removing anything when the config
lists no services; dumps the warehouse first, when this host runs one (a fresh file created exclusively under `umask 077`
in a `0700` directory, so a taken name is skipped rather than truncated and the dump is `0600`; an older dump is never
rewritten, only has its mode tightened, and only the newest two are kept, the rest removed); builds every image;
recreates only the services whose image, compose config or mounted secret content moved; removes compose's leftovers for
services this config dropped, never a CI job's runner; and retries once for the daemon's two races (a removal already in
progress, a container name still in use). A recreate that was killed leaves its half-made replacement behind (compose
creates it as `<12hex>_<project>-<service>-1` and renames it only once the old one is gone); each pass removes those,
never a running one, before deciding what moved, so a retry never trips on "name already in use". A service still left
`created` at the end is started. It prints one line per service saying what became of it: `recreated`, `kept`, or
`leftover cleaned`.

An apply that dies mid-run (killed, its shell gone) leaves its generation `pending`, or `failed` before the auto-revert
ran. It is finished like a failed health check (the snapshot put back, the last known good re-applied) by whichever comes
first: the dying shell's own exit trap, the next apply (before it does anything else; it holds the lock, so nothing else is
applying), or at boot the oneshot user unit `aidenhq-apply-recover` (`ops/apply-config.sh --recover`, installed by apply
and setup). The dead pair is then held like any failed one: `--retry` from the owner's shell applies it again. A dead
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
retry after a daemon race from starting it a second time.

Each phase prints one line, `apply timing: <phase> <seconds>s`, and a total; run by the installer (`AIDENHQ_PROGRESS_BASE` set), setup and the apply also print `AIDENHQ_PROGRESS=<n>/<total> <percent>% <step> ~<minutes left>` as each phase starts (`ops/lib/progress.sh`; the phase tables, with estimated seconds, sit in `ops/setup.sh` and `ops/apply-config-work.sh`); setup prints its own sections on one
`setup timing:` line. A cached image build costs a few seconds; a changed one is the real build (the board's tsc and vite
build is about 17s). Setup's Paperclip calls run four at a time.

Module data (spec §6.4.1): before an apply switches, it stops the containers of each module it touches that has
`services.data: true` (its code, its compose services with their settings, or its `data_version` changed) and archives `data/modules/<module>/` to
`~/checkpoints/gen-<n>/<module>.tar` (as root in a pinned container, so root-owned files come along; the archive is the
owner's, `0600`). Without room for it (1.2 times the dirs plus 20 GB, as `scripts/backup.sh`) the apply is refused and the
containers start again. The newest two `gen-*` snapshots are kept. A failed health check puts the whole snapshot back
before the last known good starts. `ops/rollback.sh <n>` puts back only modules whose `.data_version` marker is above the
`data_version` generation `n` declared, each from the earliest snapshot after `n`, and refuses when that snapshot was
pruned. A restore unpacks into a fresh sibling folder and swaps it in, so a module never has half its old data.
`data/kernel/`, the vault, Paperclip's database and live Postgres clusters are never in a snapshot; `scripts/backup.sh`
covers them.

It is idempotent. The Platform Engineer runs it for you after you approve a change.

- **Upgrade the product:** merge to product `main`, bump `product: <sha>` in the instance repo, commit and push, apply.
- **Roll back:** revert the instance commit (or set `product:` to the earlier sha), push, apply again. That rolls back
  code, not module data. `ops/rollback.sh <n> [--plan]` goes back to apply generation `n`
  (`~/.local/state/aidenhq/generations.jsonl`) with the data it needs (above); `--plan` prints the shas and each module
  whose data it would restore, with the time that data goes back to.
- **After changing a connection service:** nothing; apply rebuilds its image and recreates it. A rotated compose secret
  is picked up the same way on the next apply. Force-recreate (`docker compose up -d --force-recreate <svc>`) only after
  changing a file a service reads once at start that is not a compose secret (a bind-mounted config, for example):
  running it after every apply restarts those services a second time for nothing.
- **After changing runner code:** `ops/apply-config.sh` sends `systemctl --user kill --kill-whom=main -s SIGUSR2 aidenhq-runner`: the runner takes nothing new, exits as soon as nothing is half done (a reply being posted, a publish, an apply), and systemd starts it again 5s later. Running agent jobs are not touched: the kernel runs them (`kernel/src/jobs.ts`), each in its own process group writing its log and exit status under the runner's state dir; the new runner follows them again through `GET /v1/jobs/:id`, keeps their `aidenhq` tools working (same helper port and token) and reports each turn once. A plain `systemctl --user restart aidenhq-runner` does the same.
- **After changing kernel code:** apply-config restarts `aidenhq-kernel` (SIGTERM; `KillMode=process`): the kernel stops following its jobs (offsets saved in `data/kernel/kernel.db`) and exits; the next kernel adopts every job whose shell is still that run (pid and its `.exit` file name) and reports one that died while no kernel ran as lost, which the runner resumes in the same session. apply-config installs the unit (and daemon-reloads) when `ops/units/aidenhq-runner.service` changes.

- **The model gateway** (`kernel/src/gateway`, user unit `aidenhq-kernel`): every model call goes through it, and it alone reads `openrouter_key`. apply-config installs and starts the unit before compose and setup, and restarts it only when `kernel/src/gateway` or its unit changed. A host whose apply-config predates the hand-over (step 3) runs its old script for the apply that brings the hand-over in; start that one apply with the new script instead: `git fetch -q origin main && git show <product sha>:ops/apply-config.sh > ops/.apply-next.sh && bash ops/.apply-next.sh; rm -f ops/.apply-next.sh` (it checks out the product, sees the script changed and hands over to the checked-out one). A bind that fails (the backplane address before compose is up) is retried in the process while loopback serves. It listens on `127.0.0.1:8201` (runner jobs through their jail, the AI reviewer, the intake, and the computer launcher, which forwards its boxes' model calls with the box's run token; the gateway names that run at the launcher's `/whoami`) and `10.231.0.1:8201` (Codex in Paperclip with the run's own JWT, the source writers, the board's `/usage` pull), and, with the ci module on, `10.231.4.1:8201` (the CI runners' bridge: CI tokens only, see CI runners). Spend (spec §5.12): each call reserves its worst case at the model's declared price (`modules/models-openrouter`; an unpriced model is refused) against its run, task and agent-day caps (grants `caps`, default $2 / $10 / $30) before it is sent, with its output limit cut to what the tightest cap has left; it settles at max(what OpenRouter reported, tokens × price). A call that would pass a cap gets HTTP 402 and the owner a `raise_cap` card; there is no off switch. Ledger: `data/kernel/kernel.db` (`calls`); the old `data/gateway/usage.db` is merged in at every start while it exists (idempotent) and otherwise left alone. If it is down, no model call is made (`systemctl --user status aidenhq-gateway`, `journalctl --user -u aidenhq-gateway`).
- **Agent memory** (`agent_memory`): `memory_note` writes to the agent's own inbox task; the Librarian's daily pass curates it into `agents/<key>/memory.md`, landed by an apply card. To clear one agent's memory, apply a change that empties its file. Kill switch: `agent_memory: off`.
- **Advisor and fan-out** (`modules/tasks/connections/tasks-mcp/src/models.mjs`): `advisor_ask` (every Codex agent; GPT Sol, 5 calls per run) and `fanout_map` (granted per agent; up to 25 items on DeepSeek Flash) call the gateway's `/advisor` and `/fanout` routes with the run's own credential, billed to its run. Engineer jobs consult the same advisor with `aidenhq advise "<brief>"` (the runner's helper, `services/runner/src/advise.ts`, on the job's own credential; 5 per job). Both send `ADVISOR_MODEL` (models.mjs). Not yet in agent computers. The kill switch below drops only the agents' tools; `aidenhq advise` stays (still under the gateway's caps). Kill switch: `settings.model_tools: off`, then apply.

## Health

- `scripts/healthcheck.sh`: read-only check of Paperclip, the board and each service; prints `ok` or `FAIL` per check.
- `scripts/verify-security.sh`: mechanical checks of the security criteria (token scoping, read-only endpoints,
  exposure). Run with the stack up.
- The board's Apps tab lists each app's health; the DevOps Engineer owns an unhealthy app and pages the owner only when
  it cannot fix it.
- Fleet Ops (module `fleet-ops`): the board's detector (`services/board/src/fleet-ops.ts`) checks every
  `fleet_ops_interval_minutes` for a run stuck past twice its timeout, an agent's last
  3 runs failed, an app incident open over 15 minutes (or apps-mcp not answering for 15 minutes) a source with no good pass in an hour and an agents-org pull request open over an hour without merging (from the warehouse)
  (or failing for 15 minutes; apps-mcp's `/internal/sources`). It fires the "Fleet Ops: check" webhook once per incident
  and once on recovery (state in the board's store, meta `fleet_ops_detector`); Fleet Ops reads it from `fleet_status`
  → `detector` and logs on the "Fleet issues" task (`log ·` lines).
- Task rollover (always on, `services/board/src/rollover.ts`): every 10 minutes the board measures each open agent task's
  history; past ~600K characters (comments plus ~400 each for Paperclip's envelope), or once a run on it fails over the
  model's input limit, it moves the task to a successor (`… (continued from WOR-n)`: same agent, labels and parent, a link
  to the old task, the owner's unanswered messages re-posted, open sub-tasks moved) and closes the old one with no agent.
  Only the owner's own tasks move (made with the board key, by no agent, no source marker), so the successor keeps their
  origin. Writes to the old task follow the board's record (meta `task_rollover`), never description text: the board's own
  routes directly, the bridge (Telegram replies, its daily chat) through `GET /internal/successor/:id` (decide key only).
  Not moved while a run or a card is on it, nor graded, runner Engineer or agent-made tasks; the detector names such a task
  in its "runs failed" flag.

- The Maintainer (`services/board/src/maintainer.ts`): every `maintainer_poll_minutes` (default 5; the board reads
  `MAINTAINER_POLL_MINUTES`) the board asks
  github-mcp for the product issues labelled since its cursor and fires the "Maintainer: issue" webhook once per trusted
  issue, with `{{number}}` and `{{title}}`. A label from anyone else is logged once and starts nothing. Cursor and fired
  issues are in the board's store (meta `maintainer_issues`), so a restart repeats and skips none. It reads the host's
  `generations.jsonl` read-only (`AIDENHQ_STATE_DIR`, its mirror in `board/` mounted at `/generations`) for the
  `fleet_generation_status` tool: the current pin (the newest generation that got past validation) and the last 20
  generations, newest first. The watcher runs when both modules mount their files through `board_env`: the github module's
  `MAINTAINER_ISSUES_TOKEN_FILE` (`github_maintainer_issues_token`, which github-mcp takes on that one read and never on
  `/mcp`) and the maintainer module's routine webhook (`MAINTAINER_WEBHOOK_URL_FILE`/`_SECRET_FILE`). Setup writes the
  webhook after apply has started the board, so each tick reads the files again: the board logs "maintainer issue watcher
  waiting" until they are filled, then "maintainer issue watcher on", with no restart.

- Monitoring (module `monitoring`, [docs/design/monitoring.md](design/monitoring.md)): Prometheus, node-exporter, cAdvisor,
  Alertmanager and Grafana. Every alert becomes a detector incident (group `alert`), so Fleet Ops works it; `DiskNearlyFull`
  and `CoreServiceDown` also send the owner one line. Grafana is on `127.0.0.1:3131`; one-time on the host:
  `tailscale serve --bg --https=8444 http://127.0.0.1:3131` (no sudo: the user is tailscaled's operator) and set
  `grafana_root_url`. Sign in as `admin` with the vault's `grafana_admin_password`. Unit and container states come from the
  user timer `aidenhq-host-metrics` (`ops/host-metrics.sh`; apply installs it while the module is on), the runner's and the gateway's from
  `data/monitoring/textfile/{runner,gateway}.prom`. No sudo step.

## Backups

`scripts/backup.sh [output-dir] [--plain]` writes a directory `aidenhq-<timestamp>/` of `.tar.gz` parts (`.tar` with
`--plain`), each streamed straight to its file, with the whole data directory (Paperclip, the board, the accounts and their `auth.secret` (`data/kernel/auth`), the gateway ledger, apps-mcp, ops-mcp,
slack-live, the apps node's state), the runner's state dir, every `app-*` volume with its labels, the YAML config and
the instance repo as a git bundle. Every SQLite database is also copied online through SQLite's backup API, and
restore puts that copy over the file copy. Files are read through a container, so no sudo is needed. While Paperclip
runs, its live database is left out and its hourly dumps carry it; for a complete Paperclip database, stop the stack
first. A Postgres volume in use (the warehouse's `pgdata`) is skipped; its nightly dump volume is copied. The secret
vault and the notes vault are not included. The backup holds `auth.secret`, so it is mode 0700. It refuses to start
unless the output filesystem has 1.2 times the sources' size plus 20 GB free (a full root disk crashed Paperclip's
Postgres on 2026-11-16). Each successful apply prunes unused images older than 48 hours and caps the build cache at 40 GB (least recently used
first); `prune-docker.timer` does the same daily on a host that hasn't applied. Apply installs changed prune units.

`scripts/restore.sh <backup>` refuses to run while containers or the runner are up, and moves existing state aside
(`.pre-restore-<stamp>/`) rather than deleting it. It leaves an app volume that already exists alone. A new host can be
built from a backup with `ops/setup.sh --restore`. Off-host, nightly: [operations/migrate-host.md](operations/migrate-host.md#10-backups-off-host).

Moving a running instance to another host (drain, cold copy, tailnet names, rollback): [operations/migrate-host.md](operations/migrate-host.md).

## Run-history pruning

Paperclip has no pruning of its own and long run history exhausts memory. `ops/prune-runs.sh` deletes run logs and
`heartbeat_run_events` older than `PRUNE_DAYS` (default 30); the `prune-runs.timer` unit runs it weekly. Enable it
with `systemctl --user enable --now prune-runs.timer`.

Task workspaces (`~/aidenhq-work/tasks/<task>`): once a day the runner removes the workspace of every task closed (done or
cancelled) over 3 days ago, as `aidenhq cleanup` does: a workspace with uncommitted changes stays, and local branches are
kept in the runner's cache clones (`refs/kept/<task>/…`). A reopened task gets a fresh clone.

## Logs and debugging a run

- `docker compose logs -f <service>` for any service; `systemctl --user status aidenhq-runner` and
  `journalctl --user -u aidenhq-runner` for the runner.
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
Paperclip's `127.0.0.1:3100` is also allowed, but `ops/setup.sh` doesn't publish it): apply turns anything else off (`scripts/host-serve.mjs prune`) and `scripts/verify-security.sh` fails on it. apps-mcp writes the
node's serve config (`data/apps-edge/serve/serve.json`) from the registry and joins the node to each exposed app's
own network, where the app's port-publishing service answers as `edge-<app>` (an alias only the platform sets; an
app deployed before it is served after its next deploy). The node joins once with the vault's
`tailscale_apps_authkey` (a reusable, tagged, pre-authorized key; compile creates the file empty), then keeps its
identity in `data/apps-edge/state`. Until the key is there it waits, unjoined (`docker compose logs apps-edge`);
after adding it, `docker compose up -d --force-recreate apps-edge` (the key is read only at start). Set
`APPS_URL_BASE` in `.env` to its address. The node is the apps' door only in `tailscale` exposure with that key and
`APPS_URL_BASE` set (compile writes `config/apps-node`: `tailnet` or `none`): only then may an exposed, unshared app take
token-less callers as anonymous (`AIDENHQ_ANONYMOUS`, set at deploy, so redeploy apps after it changes). Without it every
app requires a signed identity and has no Open link (docs/design/app-identity.md).

## Tiered approvals

Design: [design/approvals.md](design/approvals.md).

The instance setting `autonomy` (`off` | `tier0` | `full`; docs/configuration.md) decides who approves. Code tiers each
write from verified state (`services/runner/src/tiers.mjs`): Tier 0 runs at once with an audit row on the board, Tier 1
goes to the AI reviewer (the `modules/ai-reviewer` module, policy `modules/ai-reviewer/service/security/policy.md`), Tier 2 to the
owner (Telegram card). Every record shows its tier, reason and `decided_by` on the board; a digest of what was decided
without the owner reaches Telegram once a day from 21:00.

- Agents-org PRs end merged: whenever the runner opens or pushes to a PR in an agents-org repo (not
  the product or instance repo), it requests the merge itself, and tiers each PR on its own. A head the runner itself
  pushed to a branch of that repo (any task's; `pushed_heads` in its state), with named checks green or still running on
  it, is Tier 0: it starts at once, even while the task's run goes on (merges are GitHub calls, not workspace changes),
  with an audit row. Each Tier 0 PR merges independently, checked every poll, as soon as its named checks are green on
  that exact head and GitHub can merge it: no order, gap or base-branch check, and no branch update after other merges.
  Green means every named check passed, GitHub's own rollup is green, `UNSTABLE` only from advisory checks, and no
  more than one page (100) of checks. A conflict (or "behind" under an up-to-date rule) is updated once, and the PR
  then merges only at GitHub's own update commit of that head (parents: the head and the base's current tip, signed
  by GitHub), once its checks pass there; any other new head is tiered again (a head the runner didn't push goes to
  the AI reviewer). Each PR is tiered on its own, and one still waiting for its first checks (up to five minutes after
  the push) doesn't hold the others. A card approved while such a queue runs takes over; the queue's waiting PRs are
  requested again and start once the card's queue ends. A PR with a failing
  check, an unresolvable conflict or a refused merge is reported once on the task and left; the others keep merging. A
  queue that finishes during the run sets the task's status only after the run ends. A fork's or anyone else's head
  goes to the AI reviewer; `.github/` changes, sensitive apps and missing checks are cards and red checks a comment, as
  before, once the run is over. Card-approved merges, and everything in the product and instance repos, still use the
  one-at-a-time queue with the base branch green before and after each merge. The `design-review` status is advisory
  except on a Tier 0 merge of a UI PR: there it must be `success`, and with no verdict 2 hours after the other checks went
  green the reviewer is asked once more, and then the merge is parked with a note on the task. In either queue a red check whose Actions job never judged the commit
  (cancelled, timed out, failed to start, or `code-review`'s own "failed"/"incomplete" comment on that head) is re-run
  once per check and head before the merge fails; a second failure, or any real failure beside it, is final. The re-run
  needs the GitHub App's Actions: write permission (`ops/github-app-setup.mjs`); without it the failure stands as before.
  A red check whose job ran **no step** and carries a failure annotation (GitHub refused to start it: billing, a spending
  limit, no runner) is the environment's, not the commit's: it is classified apart from a failed check, never sent to the
  Engineer to fix or rebase, and the head is never moved for it. It is re-run once at the same head; if it never starts
  again the merge stops with one receipt naming the check and GitHub's annotation, saying the head is not at fault and the
  change has to happen outside the repository. The product watcher classifies these the same way: such a check wakes no
  rebase, so no new head is minted and a green check set is never thrown away for one.

- Keys (generated by compile, in the vault): `reviewer_key` (the runner's: files Tier 1, records Tier 0, posts verdicts;
  board and runner only). The owner's Claude watcher is the host CLI `modules/channel-operator/bin/decide <id> approve|reject [--stale]`
  (module `channel-operator`, optional), which decides through the kernel's channel routes and stamps `watcher`. A watcher's no is a real veto on that action for the task; to close a stale
  or duplicate card without vetoing, it passes `--stale` (stamped `stale:watcher`, never a veto).
- Before `autonomy: full`, run the planted eval on the host and require 100%:

```sh
cd ~/aidenhq && OPENROUTER_API_KEY="$(cat ~/.config/aidenhq/openrouter_eval_key)" node modules/ai-reviewer/scripts/reviewer-eval.mjs
```

- Pause: set `autonomy: off` and apply (a settings change: the AI reviewer and a second reviewer decide it; or edit the
  grants table on the host for an immediate stop).

## Shared sources

Slack, GitHub, Jira, meeting notes and Drive documents are ingested once into the warehouse (`src_slack`, `src_github`,
`src_jira`, `src_meetings`, `src_docs`; design: [design/sources.md](design/sources.md)). The writers
are channel-slack, github-mcp, jira-mcp, ops-mcp (meeting notes in full, from the vault) and google-workspace-mcp (the
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
  `modules/channel-slack/module.yaml`); without it src_slack gets live events only.
- Each pass writes `src_meta.ingest_run` (source, scope, rows, error). src_docs has two scopes: `drive` (code) and
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
runs pinned syft over the host packages, every running image, the product and instance checkouts and each app's deployed
source, into `data/modules/security/sbom/current/`. The host target scans `/` without the homes (`./home/**`,
`./root/**`), procfs, the container stores and this instance's own checkouts: a clone, task worktree or tool cache there
belongs to another project's dependency tree, and no apt upgrade or `ops/vm/pins.json` clears it, so it would be permanent
noise beside the packages the operator can fix; `/usr`, `/opt`, `/etc` and `/var/lib/dpkg` stay in it. `targets.tsv`
records the checkout's git HEAD for `repo:product` and `repo:instance`, and the scanner copies it to each target's
`src_meta.ingest_run` row. The scanner matches a new batch within the hour (or daily anyway) and fires Security
Watch's webhook when anything changed. On demand:
`ops/security-sbom.sh`, then `docker compose exec security-scanner node dist/src/main.js once`.

To enable, before adding `security` to the instance's modules:

```sh
cp ops/units/aidenhq-security-sbom.service ops/units/aidenhq-security-sbom.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now aidenhq-security-sbom.timer
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
runner waits for it. Check with `systemctl status aidenhq-vault` and `mountpoint ~/.config/aidenhq`. If it is
locked, nothing that needs secrets starts. Recovery without the TPM: [ops/vault/README.md](../ops/vault/README.md).

## The runner unit

`aidenhq-runner` (`ops/units/aidenhq-runner.service`) is a systemd user unit running
`services/runner/src/main.mjs` as the AidenHQ user, configured by `config/runner.yaml`. It starts only once the vault is
mounted and restarts on failure. Other units: `aidenhq-computers` (the agent computer launcher, optional; a restart
never ends a run: boxes stay up, an agent's turn runs detached in its box and the plugin collects its result from the new
launcher; a new image applies from the next acquire) and
`aidenhq-transcripts.path` (meeting transcript watcher). Enable user units to survive logout with
`loginctl enable-linger <user>`.

## CI runners (modules/ci)

App repos' CI (`modules/ci/template`: jobs `tests` and `code-review`; `code-review` skips the review and passes on a
change under 20 added plus deleted lines with no sensitive path; `package-lock.json`, which the supply-chain job validates, is not counted, but a change that adds a package, changes a version or source, or adds an install script is sensitive, while other lockfiles are counted and always sensitive; an agent's screenshots under `.aidenhq/out/` are not counted, its json and txt reports are; a head whose patch is unchanged since a green review of the same branch and base ref, on a base that only moved forward, reuses that verdict) runs on our own GitHub Actions runners,
`runs-on: [self-hosted, aidenhq]`, registered to the agents org. The product repo's CI (`.github/workflows/`) runs on
the same kind of runner, registered to the product repo's org (below). Each `aidenhq-ci-runner@<n>` user unit (agents
org) or `aidenhq-ci-runner@<org>-<n>` unit (another org the App is installed on) runs
`ops/ci-runner.sh`: it mints a one-hour registration token on the host from the GitHub App
(`ops/ci-runner-token.mjs [org]`, installation token narrowed to `organization_self_hosted_runners`), then
`docker compose run --rm ci-runner`: a new container that registers ephemerally, takes one job, exits and is removed;
the unit then starts the next. Nothing carries between jobs. The container has no host mounts, no docker socket and none
of the instance's secrets; it sits on `aidenhq-ci` (system unit `aidenhq-ci-net`: the public Internet and, on the host,
only the model gateway's CI listener `10.231.4.1:8201`; no LAN, tailnet, other host ports or other containers). Limits
per runner: 4 CPUs, 8 GB.

**Code review spend (the model gateway).** The template's `code-review` job needs no model key: on our runners
(`AIDENHQ_GATEWAY_URL`, set on the runner container) it asks GitHub for its OIDC token (`id-token: write`, that job only)
and trades it at the gateway's `POST /ci/token` for an opaque CI token that lives 2 hours. The gateway
(`kernel/src/gateway/ci.ts`) checks GitHub's signature and that the job is a `pull_request` run of the repo's own
`.github/workflows/ci.yml` for that PR, on a self-hosted runner in the agents org; each run attempt trades its token
once. The repo and PR come from that signed token, and the answer names the review model and effort
(`settings.ci_review_model`). The CI token works only on the CI listener, only for `responses` (and `chat/completions`
for repos on the older template) with `settings.ci_review_model` or `settings.ci_review_models`, no fallbacks, plugins,
server tools or stored responses, zero data retention forced, under CI's own caps (`ci_review_repo_day_usd`,
`ci_review_day_usd`; a refusal fails the review, no retry). Each call reserves its worst case before it goes
out and settles at what was billed (a Responses stream at its `response.completed`); a cut stream keeps its reservation.
Every call lands in the ledger as kind `ci-code-review` with `<owner>/<repo>#<pr>` and the head the job sent (advisory):
the Costs tab's "App CI code review" line. Revoke: removing the `ci` module refuses every CI token at once.
The reviewer is codex with codex review's guidelines (`.github/code-review.mjs`, pinned `@openai/codex`), at the model's effort (critical paths
too), one higher (xhigh) only with the `deep-review` label or text addressed to a reviewer. codex runs with its shell off: the
runner container can't give it its sandbox (bubblewrap needs user namespaces, which Docker and the host's AppArmor refuse
there), so its only tools are `.github/review-tools.mjs`, a stdio MCP server that reads the PR's tree and git history
(diff, log, show, blame, read a file, list files, search; for TypeScript and JavaScript definition, references and
diagnostics from a pinned typescript-language-server, with no dependencies installed and type acquisition off) and
nothing else: nothing of the PR runs, writes or connects, and its
environment holds only the CI token (never the job's GitHub tokens). It runs from an empty directory with a config the
job writes (hooks, plugins and apps off), so nothing in the PR is loaded as codex config or instructions; a PR that adds
`.codex/`, `codex.toml` or `AGENTS.override.md` fails the check, and AGENTS.md is a critical path. Its answer must match
an output schema: anything else is no verdict, which fails the check. The gate is fail-closed (operator ruling 2026-11-17,
replacing #144's pass for PRs over 2,000 counted lines that got no verdict): no verdict fails the check whatever its size,
and past 2,000 counted lines the comment gives the size as the reason ("too large to review in one pass; split into PRs
under ~2,000 counted lines"). Only a confirmed provider error (HTTP 429 or 5xx, a dropped connection, seen in codex's events)
is transient and gets one retry. If the retry also fails, the check fails. A timeout or an answer that isn't a review is
never retried. A package-lock.json change that adds a package, changes a version or source, or adds an install script is a
critical path, and the reviewer gets a summary of it. Its scripts and the house rules (`.github/code-review-rules.md`) come
from the base commit. Its brief: the house rules, the app's critical paths and its AGENTS.md (base commit), and the PR's
title and description fenced as data, so it judges scope. P0 and P1 findings block (critical, high); P2 and P3 are listed.
A same-repo PR can edit the workflow and spend up to its repo's day cap on the allowed models: the cap and scope are the
boundary, not the job name. Instances without the gateway (no `AIDENHQ_GATEWAY_URL`) use the repo secret
`OPENROUTER_API_KEY` instead; where the gateway is on, delete that secret from the app repos (an edited workflow could
read it).

**Register (once).**
1. GitHub App: add the organization permission *Self-hosted runners: Read and write* in the App's settings (GitHub →
   the agents org → Settings → Developer settings → GitHub Apps → the App → Permissions), save, then accept the new
   permission on each installation (every org that installed the App is asked). New Apps get it from the manifest.
2. Agents org → Settings → Actions → Runner groups → Default: allow private repositories (and public if any). No model
   secret: code review spends through the gateway (above), whose `settings.ci_review_model` (default
   `~deepseek/deepseek-flash-latest:high`) picks the model and effort. Off the gateway: the variable `CI_REVIEW_MODEL`.
3. Instance repo: add `ci` to `modules:` in `instance.yaml`; deploy (`ops/apply-config.sh`).
4. On the VM (sudo, once): `sudo install -m0755 ops/vm/computer-net.sh /usr/local/sbin/aidenhq-computer-net && sudo install
   -m0644 ops/units/aidenhq-ci-net.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable
   --now aidenhq-ci-net` (`ops/vm/setup.sh` does this on new hosts).
5. A run of `ops/setup.sh` with `CI_RUNNERS=2` (its config or the environment) starts that many; or by hand:
   `cp ops/units/aidenhq-ci-runner@.service ~/.config/systemd/user/ && systemctl --user daemon-reload &&
   systemctl --user enable --now aidenhq-ci-runner@1 aidenhq-ci-runner@2`. Check: the org's Settings → Actions →
   Runners lists `aidenhq-<container id>` idle; `journalctl --user -u aidenhq-ci-runner@1`.

**The product repo's org.** The product workflows (`ci.yml`, `secrets.yml`) run every job on `[self-hosted, aidenhq]`.
`image-scan` builds nothing (a build would run a PR's RUN steps on our runner, and the runner has no Docker): the grype
baked into the runner image scans each changed image's directory (lock files) and the digest-pinned base images its
Dockerfile names (`scripts/supply-chain/image-scan.mjs` reads the Dockerfile as text), so packages RUN steps install are
not covered there; the security module's scans of deployed images cover them. A base image's files a Dockerfile replaces
or never copies out (node's bundled npm, the Alpine packages of a stage only partly copied) are owner-approved entries in
`.github/image-scan-exceptions.yaml`, read from the base commit. A PR from a fork is routed to `ubuntu-latest` instead of
our runners (where image-scan fails: no grype). That routing lives in the workflow file the PR itself carries, so it is
not the boundary: the org's runner group is. To serve the product org:
1. The App's installation on that org accepts *Self-hosted runners: Read and write* (GitHub → the org → Settings →
   GitHub Apps → the App → Configure; a pending permission request shows there).
2. The org → Settings → Actions → Runner groups → Default: private repositories only. Never allow public repositories
   here: a public repo's fork PRs could then reach the runners. Settings → Actions → General: leave *Run workflows from
   fork pull requests* (private repositories) off; if the repo ever goes public, require approval for all outside
   contributors.
3. On the VM: `systemctl --user enable --now aidenhq-ci-runner@<org>-1 aidenhq-ci-runner@<org>-2` (the org's login as
   in its URL, e.g. `aidenhq-ci-runner@acme-1`). Check: the org's Settings → Actions → Runners lists them idle.

**The public Aiden-HQ repos (AidenHQ, aidenhq-modules, aidenhq-distro).** Their CI runs on GitHub-hosted runners first.
In the product's ci.yml the first job (`checks`) counts the hosted jobs this repo's other runs hold (queued or running) and
sends the heavy jobs (packages, runner-unit, runner-flows, board) to `[self-hosted, aidenhq]` only when that count is 12 or
more (the free plan runs ~20 at once), the repository variable `CI_SELF_HOSTED` is `true`, and the run is a push to main or
a same-repo PR; any API error keeps them hosted. That routing lives in the PR's own workflow file, so it is no boundary.
The boundaries are: *Require approval for all outside collaborators* (a fork's workflow runs only after a maintainer
approves it), the org runner group (only these repos), and the runner's job-started hook (modules/ci/runner/job-started.*,
baked into the image read-only, run under `env -i`): it fails any job, before checkout, whose repository is not in the
agents org or the `ci_runner_repos` setting, or whose event is not push, workflow_dispatch, schedule, merge_group or a
pull_request from the same repository (no fork PRs, no pull_request_target). Residual: the runner starts the hook with
bash, so a job-level `BASH_ENV` could still run first; the approval requirement covers forks. To enable: the App on the
Aiden-HQ org with *Self-hosted runners: Read and write*; a runner group there limited to the three repos with *Allow public
repositories* on; the modules pin at or after the hook; on the VM `systemctl --user enable --now aidenhq-ci-runner@Aiden-HQ-1
aidenhq-ci-runner@Aiden-HQ-2` (up to 4, or move existing agents-org units); then the repo variable (Settings -> Secrets and
variables -> Actions -> Variables). Unset it to go back to hosted only. aidenhq-modules and aidenhq-distro can adopt the
same routing in their ci.yml later.

A push runs about 21 jobs (the test matrix is 18), each in a fresh container that installs Node and its packages: roughly
10 minutes on two runners. Jobs for one org never take another org's runners.

**Rotate.** Nothing long-lived to rotate: each job's token is minted fresh from the App key (to rotate the App key, generate a new private key in the App's settings and replace
`github-app/key.pem` in the vault). Upgrade the runner by bumping the base image in `modules/ci/runner/Dockerfile`; GitHub stops accepting
runners some weeks after a newer release, so bump when the org's runners page warns.

**Scale.** One unit per concurrent job: `systemctl --user enable --now aidenhq-ci-runner@3`, or `disable --now` one to
shrink. Every unit is up to 4 CPUs and 8 GB while it runs a job, whichever org it serves: keep the total at 2-4 on a VM of
the size docs/setup.md suggests (e.g. 2 for the product org, 1-2 for the agents org). The enabled instances are what the config
declares runs, and an apply starts every declared one that systemd reports failed: `Restart=always` alone reaches systemd's
start limit and leaves a unit failed with nothing to clear it, so `ops/ci-runner-units.sh` resets and starts those (and the
ones a drain record names) after everything else. A drain (`node scripts/fleet-pause.mjs pause`) stops them without
cancelling a job under it, and its resume -- or an apply, or `ops/ci-runner-units.sh` on its own -- clears each unit's
start limit before starting it, so a stopped unit never stays start-limited and failed. Stop all: `systemctl --user stop 'aidenhq-ci-runner@*'` (a running job
is cancelled; GitHub retries nothing, so re-run it).
