# Sandboxing agents

What contains an agent's code and secrets, as built. Paperclip runs nothing: the kernel runs every agent job in a gVisor
agent computer (a box). What stops an injected prompt from misusing a granted tool is not a sandbox but grants checked in
code (`kernel/src/proxy.ts`), tiered approvals ([approvals.md](approvals.md)) and per-tool limits. The sandbox protects
against code the agent runs reaching the host, and against secrets sitting next to the agent. Egress from boxes to the
public Internet is open by owner policy, so no tier alone stops exfiltration through tools or web search.

## Tiers

| Tier | What runs there | Box image |
|---|---|---|
| Crew job (profile `crew`) | every agent's job that isn't an Engineer: chief of staff, triage, designers, reviewers | `agent-base` (browser, `agent-browser`, app starter, design system), or the agent's own `image:` |
| Engineer job (profile `engineer`) | an Engineer turn: the task's repositories cloned by its box (`aidenhq clone`), tests, installs | `engineer` |
| Check job (profile `check`) | a repo's checks, the reviewer eval, a module's contract kit, the CI code review | `engineer`, credential-free |
| Apps | agent-built services, deployed through apps-mcp | Docker containers under apps-mcp's policy, not boxes |
| Module services | a module's containers (`services:`) | compose, `isolation:` below |

The image a job gets is frozen at admission (`kernel/src/admission.ts`: `image:` wins, else crew `agent-base`, engineer
and check `engineer`). `scripts/computers.ts` builds the images (`browser` is the base of both) tagged by content hash;
an agent may name only `agent-base` or `engineer`. An Engineer's `image:` must be `engineer`. No repo code runs on the
host: a repo's checks are check jobs.

## A box

`services/computer/launcher.ts` (systemd user unit `aidenhq-computers`, on the host) creates each box with
`docker run --runtime=runsc` (gVisor) on the `aidenhq-computers` network, with `--memory`/`--memory-swap` the limit,
`--cpus`, `--shm-size` 1g and `--pids-limit` 1024 (`dockerRunArgs` in `services/computer/lib.ts`).

- **Credentials.** A box's only credential is its job token (`ahqj_`), minted by the kernel (`kernel/src/boxes.ts`),
  authority frozen at admission, revocable. The box's env file is built from an allowlist (`JOB_ENV_NAMES`). The model key
  and every connection's key stay outside: the box reaches the model and connections only through the launcher's
  gateway (`10.231.2.1:8200`), which passes calls to the kernel's model gateway and proxy with the token; the kernel
  checks grants. The OpenRouter key never reaches a box.
- **Network.** `ops/vm/computer-net.sh` isolates the network: no traffic between boxes (`enable_icc=false`), and an
  nft table that drops anything addressed to the host (its LAN, tailnet and bridge addresses) except the launcher's
  gateway port. Boxes keep the public Internet.
- **Mounts.** The task workspace, an out folder, the per-task Codex home, read-only guard hooks, the engine module
  (read-only) and the npm cache every job box shares (`npm_config_cache`: npm's content-addressed store, each package
  checked against its integrity hash on read; a job's own `node_modules` and build output stay in its task folder). The
  shared cache is writable by every job box, so one task's box could plant metadata another task's lockfile-less
  `npm install` reads: the same trust as the agents themselves (own agents are trusted; the box is the boundary). `repo-checkout` is mounted only for a job whose roles include it. A check box gets only its snapshot (no
  `.git`, no credentials; read-only when the recipe says so) and its out folder.
- **Codex inside.** The box is the boundary, so Codex's own sandbox is off (`danger-full-access`, approval `never`;
  [codex-openrouter-engine.md](codex-openrouter-engine.md)). A job whose agent sets `web_search: disabled` gets no web search.
- **Lifecycle.** The kernel owns the box: it asks the launcher (`POST /job`, bearer `launcher_kernel_key`), renews the
  lease every 5 minutes (the launcher's lease is 15), and releases it when the job ends; a kernel restart re-adopts from
  the job rows. A box with a lapsed lease is destroyed. One box per task, leased to one job at a time (the lease is the job
  id and a generation, kept in the launcher's `jobs.json` and the job row, so a late renew or release of an earlier job
  never touches the next one's). A released box is parked for the task's next job: its token is revoked, it is restarted
  (nothing the job started runs on; files and mounts stay) and its env file and out folder are cleared. The task's next job
  leases it when its `docker run` line and mounted folders are the same (`compatKey`: image, engine, roles, the very
  workspace and Codex home folders), else it goes and a new box starts. A job that never ran, or asked for its workspace to
  go (`aidenhq cleanup`), destroys its box. A parked box goes after 30 minutes idle (`WARM_MS`). Check jobs use
  `POST /check`, one box per run, always destroyed.
- **Pool.** `settings.computers_max` (1 to 64; unset, the host's RAM in GB divided by 1.5, 4 to 64, worked out at compile
  time: boxes mostly wait on model calls and use 0.3 to 0.45 GB each) is how many agent jobs run at once, and
  `settings.check_computers_max` (1 to 64, default 32) how many check jobs (code review, CI checks) do: a check's box mostly
  waits on remote model calls (about 250 MB, no CPU). Compile writes both to `config/computers.json` (`max`, `checks`); the
  launcher's pool is their sum and the kernel admits each kind against its own (`kernel/src/pool.ts`), so neither kind takes
  a box from the other. New work of a kind at its number waits, queued and never failed, until something of its own kind
  ends. A check waiting for a box reads `waiting: true` on `GET /v1/checks/:id`, and code review shows its run as `waiting`,
  not `running`. Past the launcher's pool the least recently used idle box is evicted; none idle, a job waits for the next
  tick. Limits per box are 6g memory (`AIDENHQ_COMPUTERS_MEMORY`; gVisor counts in-box tmpfs and `/dev/shm` against it) and
  2 CPUs (`AIDENHQ_COMPUTERS_CPUS`), ceilings rather than reservations. Size the pool to the host's memory with no swap, and
  `computers_max` at least the sum of box agents' `max_parallel`.


## Module isolation

A module or agent declares `isolation: trusted` (default), `code-exec` or `untrusted` (`scripts/modules.ts`). An
untrusted module may not declare connections or services, and its agents may have no roles and no write tools on any
connection (compile fails otherwise); an agent can't opt out of its module's `untrusted`. `scripts/compiler/authority.ts`
ranks `untrusted` < `code-exec` < `trusted` when judging authority changes. `engineering` is `code-exec`.

## Apps

`modules/apps-platform/apps-mcp/src/policy.ts` runs on the resolved compose and refuses host-level options (privileged,
host network, docker and tailscaled sockets, devices, extra capabilities and the like), injects `no-new-privileges` and
`cap_drop: ALL`, and rewrites networks and ports. An app joins only the shared networks its registry entry names with
`connects`, and gets secrets as files. See [access.md](access.md) and [app-identity.md](app-identity.md).

## Verification

`scripts/verify-security.sh` on the host after exposure changes checks module containers, published ports and shared apps.
