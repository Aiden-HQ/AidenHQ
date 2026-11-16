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
in a `0700` directory, so a taken name is skipped rather than truncated and the dump is `0600`; older dumps keep their
bytes and only have their mode tightened); builds every image; recreates only the services whose image or compose config
moved; removes compose's leftovers for services this config dropped, never a CI job's runner; and retries once for the
daemon's two races (a removal already in progress, a container name still in use). It prints one line per service saying
what became of it: `recreated`, `kept`, or `leftover cleaned`.

Each phase prints one line, `apply timing: <phase> <seconds>s`, and a total; setup prints its own sections on one
`setup timing:` line. A cached image build costs a few seconds; a changed one is the real build (the board's tsc and vite
build is about 17s). Setup's Paperclip calls run four at a time.

It is idempotent. The Platform Engineer runs it for you after you approve a change.

- **Upgrade the product:** merge to product `main`, bump `product: <sha>` in the instance repo, commit and push, apply.
- **Roll back:** revert the instance commit (or set `product:` to the earlier sha), push, apply again.
- **After changing a connection service:** nothing; apply rebuilds its image and recreates it. Force-recreate
  (`docker compose up -d --force-recreate <svc>`) only after changing a file it reads once at start outside compose (a
  secret such as a rotated token): running it after every apply restarts those services a second time for nothing.
- **After changing runner code:** `ops/apply-config.sh` sends `systemctl --user kill --kill-whom=main -s SIGUSR2 aidenhq-runner`: the runner takes nothing new, exits as soon as nothing is half done (a reply being posted, a publish, an apply), and systemd starts it again 5s later. Running agent jobs are not touched (`KillMode=process`; each runs in its own process group, writing its log and exit status under the runner's state dir): the new runner adopts them, keeps their `aidenhq` tools working (same helper port and token) and reports each turn once. A plain `systemctl --user restart aidenhq-runner` does the same. A job that died while no runner was up (no exit status) resumes in the same session. apply-config installs the unit (and daemon-reloads) when `ops/units/aidenhq-runner.service` changes.

- **The model gateway** (`kernel/src/gateway`, user unit `aidenhq-kernel`): every model call goes through it, and it alone reads `openrouter_key`. apply-config installs and starts the unit before compose and setup, and restarts it only when `kernel/src/gateway` or its unit changed. A host whose apply-config predates the hand-over (step 3) runs its old script for the apply that brings the hand-over in; start that one apply with the new script instead: `git fetch -q origin main && git show <product sha>:ops/apply-config.sh > ops/.apply-next.sh && bash ops/.apply-next.sh; rm -f ops/.apply-next.sh` (it checks out the product, sees the script changed and hands over to the checked-out one). A bind that fails (the backplane address before compose is up) is retried in the process while loopback serves. It listens on `127.0.0.1:8201` (runner jobs through their jail, the AI reviewer, the intake, and the computer launcher, which forwards its boxes' model calls with the box's run token; the gateway names that run at the launcher's `/whoami`) and `10.231.0.1:8201` (Codex in Paperclip with the run's own JWT, the source writers, the board's `/usage` pull), and, with the ci module on, `10.231.4.1:8201` (the CI runners' bridge: CI tokens only, see CI runners). Ledger: `data/gateway/usage.db`. Kill switch for caps: `settings.spend_caps: off`. If it is down, no model call is made (`systemctl --user status aidenhq-gateway`, `journalctl --user -u aidenhq-gateway`).
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

- Monitoring (module `monitoring`, [docs/design/monitoring.md](design/monitoring.md)): Prometheus, node-exporter, cAdvisor,
  Alertmanager and Grafana. Every alert becomes a detector incident (group `alert`), so Fleet Ops works it; `DiskNearlyFull`
  and `CoreServiceDown` also send the owner one line. Grafana is on `127.0.0.1:3131`; one-time on the host:
  `tailscale serve --bg --https=8444 http://127.0.0.1:3131` (no sudo: the user is tailscaled's operator) and set
  `grafana_root_url`. Sign in as `admin` with the vault's `grafana_admin_password`. Unit and container states come from the
  user timer `aidenhq-host-metrics` (`ops/host-metrics.sh`; apply installs it while the module is on), the runner's and the gateway's from
  `data/monitoring/textfile/{runner,gateway}.prom`. No sudo step.

## Backups

`scripts/backup.sh [output-dir] [--plain]` writes a directory `aidenhq-<timestamp>/` of `.tar.gz` parts (`.tar` with
`--plain`), each streamed straight to its file, with the whole data directory (Paperclip, the board with its accounts and `auth.secret`, the gateway ledger, apps-mcp, ops-mcp,
slack-live, the apps node's state), the runner's state dir, every `app-*` volume with its labels, the YAML config and
the instance repo as a git bundle. Every SQLite database is also copied online through SQLite's backup API, and
restore puts that copy over the file copy. Files are read through a container, so no sudo is needed. While Paperclip
runs, its live database is left out and its hourly dumps carry it; for a complete Paperclip database, stop the stack
first. A Postgres volume in use (the warehouse's `pgdata`) is skipped; its nightly dump volume is copied. The secret
vault and the notes vault are not included. The backup holds `auth.secret`, so it is mode 0700. It refuses to start
unless the output filesystem has 1.2 times the sources' size plus 20 GB free (a full root disk crashed Paperclip's
Postgres on 2026-11-16). Each successful apply prunes build cache and dangling images older than 48 hours.

`scripts/restore.sh <backup>` refuses to run while containers or the runner are up, and moves existing state aside
(`.pre-restore-<stamp>/`) rather than deleting it. It leaves an app volume that already exists alone. A new host can be
built from a backup with `ops/setup.sh --restore`. Off-host, nightly: [operations/migrate-host.md](operations/migrate-host.md#10-backups-off-host).

Moving a running instance to another host (drain, cold copy, tailnet names, rollback): [operations/migrate-host.md](operations/migrate-host.md).

## Run-history pruning

Paperclip has no pruning of its own and long run history exhausts memory. `ops/prune-runs.sh` deletes run logs and
`heartbeat_run_events` older than `PRUNE_DAYS` (default 30); the `prune-runs.timer` unit runs it weekly. Enable it
with `systemctl --user enable --now prune-runs.timer`.

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
`APPS_URL_BASE` in `.env` to its address.

## Tiered approvals

Design: [design/approvals.md](design/approvals.md).

The instance setting `autonomy` (`off` | `tier0` | `full`; docs/configuration.md) decides who approves. Code tiers each
write from verified state (`services/runner/src/tiers.mjs`): Tier 0 runs at once with an audit row on the board, Tier 1
goes to the AI reviewer (`services/runner/src/review.mjs`, policy `modules/core/security/policy.md`), Tier 2 to the
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
  board and runner only) and `watcher_decide_key` (the owner's Claude watcher: same endpoint and header as the owner
  channel, `x-owner-key`, stamped `watcher`). A watcher's no is a real veto on that action for the task; to close a stale
  or duplicate card without vetoing, it rejects by id with `"stale": true` (stamped `stale:watcher`, never a veto).
- Before `autonomy: full`, run the planted eval on the host and require 100%:

```sh
cd ~/aidenhq && OPENROUTER_API_KEY="$(cat ~/.config/aidenhq/openrouter_key)" node services/runner/scripts/reviewer-eval.mjs
```

- Pause: set `autonomy: off` and apply (a settings change: the AI reviewer and a second reviewer decide it; or edit the
  grants table on the host for an immediate stop).

## Shared sources

Slack, GitHub, Jira, meeting notes and Drive documents are ingested once into the warehouse (`src_slack`, `src_github`,
`src_jira`, `src_meetings`, `src_docs`; design: [design/sources.md](design/sources.md)). The writers
are slack-live-mcp, github-mcp, jira-mcp, ops-mcp (meeting notes in full, from the vault) and google-workspace-mcp (the
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
  `modules/owner-channel/module.yaml`); without it src_slack gets live events only.
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
source, into `data/security/sbom/current/`. The scanner matches a new batch within the hour (or daily anyway) and fires
Security Watch's webhook when anything changed. On demand: `ops/security-sbom.sh`, then
`docker compose exec security-scanner node dist/src/main.js once`.

To enable, before adding `security` to the instance's modules:

```sh
cp ops/units/aidenhq-security-sbom.service ops/units/aidenhq-security-sbom.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now aidenhq-security-sbom.timer
systemctl --user start aidenhq-security-sbom   # first batch; also creates data/security/sbom as you (not root)
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

App repos' CI (`modules/core/templates/ci`: jobs `tests` and `code-review`; `code-review` skips codegenie and passes on a
change under 20 lines with no sensitive path) runs on our own GitHub Actions runners,
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
once. The repo and PR come from that signed token. The CI token works only on the CI listener, only for
`chat/completions` with the models in `settings.ci_review_models` and no fallbacks, plugins or server tools, under CI's
own caps (`ci_review_repo_day_usd`, `ci_review_day_usd`; always on, whatever `spend_caps` says; a refusal fails the
review, no retry). Every call lands in the ledger as kind `ci-code-review` with `<owner>/<repo>#<pr>` and the head the job
sent (advisory): the Costs tab's "App CI code review" line. codegenie has no base-URL option, so the job loads a small
preload that sends its OpenRouter calls to the gateway. Revoke: `settings.ci_review: off` refuses every CI token at once.
A same-repo PR can edit the workflow and spend up to its repo's day cap on the allowed models: the cap and scope are the
boundary, not the job name. Instances without the gateway (no `AIDENHQ_GATEWAY_URL`) use the repo secret
`OPENROUTER_API_KEY` instead; where the gateway is on, delete that secret from the app repos (an edited workflow could
read it).

**Register (once).**
1. GitHub App: add the organization permission *Self-hosted runners: Read and write* in the App's settings (GitHub →
   the agents org → Settings → Developer settings → GitHub Apps → the App → Permissions), save, then accept the new
   permission on each installation (every org that installed the App is asked). New Apps get it from the manifest.
2. Agents org → Settings → Actions → Runner groups → Default: allow private repositories (and public if any). No model
   secret: code review spends through the gateway (above). Optional variable `CODEGENIE_MODEL` (default
   `openrouter/~deepseek/deepseek-flash-latest`; `openrouter/deepseek/deepseek-v4-flash-0731` gets codegenie's DeepSeek
   routing workaround if the `~` alias misbehaves: add it to `settings.ci_review_models` first).
3. Instance repo: add `ci` to `modules:` in `instance.yaml`; deploy (`ops/apply-config.sh`).
4. On the VM (sudo, once): `sudo install -m0755 ops/vm/computer-net.sh /usr/local/sbin/aidenhq-computer-net && sudo install
   -m0644 ops/units/aidenhq-ci-net.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable
   --now aidenhq-ci-net` (`ops/vm/setup.sh` does this on new hosts).
5. `cp ops/units/aidenhq-ci-runner@.service ~/.config/systemd/user/ && systemctl --user daemon-reload &&
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

A push runs about 21 jobs (the test matrix is 18), each in a fresh container that installs Node and its packages: roughly
10 minutes on two runners. Jobs for one org never take another org's runners.

**Rotate.** Nothing long-lived to rotate: each job's token is minted fresh from the App key (to rotate the App key, generate a new private key in the App's settings and replace
`github-app/key.pem` in the vault). Upgrade the runner by bumping the image tag in `modules/ci/compose.yaml`; GitHub stops accepting
runners some weeks after a newer release, so bump when the org's runners page warns.

**Scale.** One unit per concurrent job: `systemctl --user enable --now aidenhq-ci-runner@3`, or `disable --now` one to
shrink. Every unit is up to 4 CPUs and 8 GB while it runs a job, whichever org it serves: keep the total at 2-4 on a VM of
the size SETUP.md suggests (e.g. 2 for the product org, 1-2 for the agents org). A drain (`node scripts/fleet-pause.mjs pause`)
stops them without cancelling a job under it, and its resume -- or an apply, or `ops/ci-runner-units.sh` on its own -- clears each
unit's start limit before starting it, so a stopped unit never stays start-limited and failed. Stop all: `systemctl --user stop 'aidenhq-ci-runner@*'` (a running job
is cancelled; GitHub retries nothing, so re-run it).
