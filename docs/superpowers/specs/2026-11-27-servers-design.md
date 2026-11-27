# Server Manager — technical spec

Companion to the design doc "Server Manager: an agent that maintains your servers over SSH". The design doc says what
the agent does and for whom; this spec says how it is built. Where the two disagree, this spec is wrong and gets fixed.

Status: draft for the Codex design review. Nothing is built from it until the owner says ready.

## 1. What ships, and in what order

Two changes, because one of them is not this module's to invent.

1. **Platform primitive: named secrets in the vault** (`modules/board` + kernel + vault). A module may declare a secret
   *namespace* and let the owner add any number of named entries from its page. Today a module's secrets are fixed
   `setup:` fields — one value each, declared in `module.yaml`. Reusable SSH keys need N named values, so this is a
   building block every module gets, designed in §6.
2. **The `servers` module** (this one): service, page, write kinds, distro adapters, warehouse source, agent handbook.

Server Manager cannot ship before (1). If the owner wants it sooner, the fallback is one fixed key field per module and
no key reuse — which contradicts what he asked for, so it is not the plan.

Both are product-repo work (`Aiden-HQ/AidenHQ`), generic: no hostnames, IPs, keys or instance data.

## 2. Module layout

```
modules/servers/
  module.yaml
  README.md
  agents/server-manager/AGENTS.md
  skills/maintenance/SKILL.md
  service/
    src/main.ts            MCP server + page tools + executor endpoint
    src/ssh.ts             transport: key from vault, pinned host key, timeouts, one session per action
    src/distro/            one adapter per family (§4)
    src/plan.ts            read → plan → exact package set
    src/execute.ts         apply a plan, record before/after services
    src/reboot.ts          detection, quiet-window scheduling, come-back wait
    src/inventory.ts       writes src_servers
    src/schedule.ts        per-server next-run computation
    src/page.html          the Servers page (module view, shared page-kit)
  schemas/                 strict JSON Schema per write kind (§5)
  test/                    one fixture per distro family, plus safety cases (§11)
```

`module.yaml` declares: `requires: [warehouse, board]`; `services:` the SSH service (§3); `settings:` the page defaults
(§8); `writes:` five kinds (§5); `connections: servers` (this module's own MCP); `board.pages:` the Servers page (§8);
`secrets.named: [{ namespace: ssh-keys, ... }]` (§6); `generated_secrets: [servers_token, servers_service_key,
warehouse_src_servers_password]`; `agents.server-manager` (handbook, grants, model).

## 3. The SSH service

One container, `servers-mcp`, port 8103, the only thing that ever holds a private key.

- `egress: true` — agent computers cannot reach private ranges; this service can.
- `secrets.state: true` — its own gocryptfs-backed state dir at `/state`, holding the named keys as files mode 0600
  (written by the vault primitive in §6, never by the agent).
- `data: ["servers:/data"]` — `known_hosts/`, the last inventory snapshot, per-server schedule state.
- `connects: [sources]` — Postgres, for `src_servers` only.
- Env: `SERVERS_STATE_DIR`, `SERVERS_DATA_DIR`, `SERVERS_TOKEN_FILE`, `SERVERS_SERVICE_KEY_FILE`,
  `AIDENHQ_KERNEL_URL`.
- Auth: the module's service key for kernel calls; a per-call agent assertion for MCP.

Transport rules, all enforced in `ssh.ts`:

- Key read from `/state/keys/<name>` at connect time, held in memory for that session only. Never logged, never returned
  by any tool, never in a task, never in an error string (errors are scrubbed of key material and of the command's
  environment).
- `StrictHostKeyChecking=yes` against `/data/known_hosts/<server>`. **First connection** records the key
  (`accept-new` for that one connection, then verify it is now pinned). **Changed key** → the action refuses, the server
  is marked `host-key-changed`, and the page offers an explicit owner action to accept the new key (§8).
- Batch mode: `BatchMode=yes`, no password prompt ever, no agent forwarding, no X11, no port forwarding, no TTY unless
  a command needs one (none do).
- Timeouts: connect 15 s, per-command 300 s, upgrade commands 1800 s, reboot wait 900 s with a 5 s poll. A tool call's
  ceiling is the kernel's `tool_timeout_sec: 1800`.
- One connection per action; no connection reuse across servers, so a failure is always attributable to one host.

## 4. Distro adapters

Each adapter answers four questions in one pass: *what is upgradable*, *which of those are security updates*, *is a
reboot needed*, and *which services are running*. It also knows how to install a named set and how to restart a service.

| Family | Detect (`/etc/os-release`) | Security classification | Reboot needed | Service manager |
|---|---|---|---|---|
| Debian | `ID=debian` | `apt-get -s upgrade` gives the upgradable set; a package is security when its candidate's origin ends `-security` (read per package from `apt-cache policy`). Honest limit: a backport in `bookworm` proper is not flagged. | `/var/run/reboot-required` | systemd |
| Ubuntu | `ID=ubuntu` | Same origin filter (`*-security`). Cross-check `ubuntu-security-status --format json` when present, which also reports ESM-apps packages the origin filter cannot see. | `/var/run/reboot-required` | systemd |
| RHEL, Rocky, Alma | `ID=rhel\|rocky\|almalinux` | `dnf updateinfo list --security --available` — repo errata, the authoritative answer where it exists. | `needs-restarting -r` (dnf-utils); else running vs newest installed kernel | systemd |
| CentOS Stream | `ID=centos`, `VERSION_ID` not a release | **No per-package flag.** updateinfo is empty or sparse; Stream publishes no errata the way RHEL does. Falls back to **weekly-only**, and every report says "security classification unavailable on this host". | `needs-restarting -r`; else kernel compare | systemd |
| Fedora | `ID=fedora` | Bodhi updateinfo is incomplete. Use it when it returns rows; when it returns none for a non-empty upgrade set, treat the host as weekly-only and say so — never label every update "security". | `needs-restarting -r`; else kernel compare | systemd |
| openSUSE, SLES | `ID=opensuse-*\|sles` | `zypper --non-interactive list-patches --category security` — patch categories are reliable here. | `zypper needs-rebooting` (exit 102) | systemd |
| Alpine | `ID=alpine` | apk has **no** security classification. Read Alpine's secdb JSON for the branch (`secdb.alpinelinux.org`) and match advisories against `apk version -v`. If the branch is not in secdb, weekly-only. secdb is fetched by the module, cached in `/data`, never by the agent. | `uname -r` vs the newest installed `linux-*` package | **OpenRC** (`rc-service`, `rc-update`) |
| Arch (optional) | `ID=arch` | `arch-audit` when installed; else weekly-only. | kernel compare | systemd |
| anything else | — | unsupported: reported by name, no action, no guessing | — | — |

**The rule that makes the table honest:** when a host cannot tell us which updates are security updates, we do not
invent an answer. The host is put on the weekly pass only, and the report states the reason in the same row. That is a
worse experience than a fake security count and a better one than a false alarm.

Distro detection failure, an unknown package manager, or a package manager that returns an unparseable shape → the
server is reported `unsupported` with the command's output (quoted as data, never as instructions) and no changes are made.

## 5. Write kinds, tiers and the audit trail

Every change is a kernel write record with a tier — the same path every other write takes. The agent has no side channel:
the SSH service refuses any action that is not carrying a claimed write record for that kind.

| Kind | Floor | What plan pins | What the card says |
|---|---|---|---|
| `servers.upgrade` | 1 | server, the exact package list with versions | "Install N updates on <server>" + the list |
| `servers.security_upgrade` | 0 | server, the exact security package list with versions | runs at once; still a record |
| `servers.restart` | 1 | server, unit name, the unit's current state | "Restart <unit> on <server>" |
| `servers.run` | 1 | server, **the exact command text**, the user it runs as, a hash of the text | the literal command, rendered as code, plus what it reads and changes |
| `servers.reboot` | 1, plan raises to 2 | server, the reason, the window it will use | "Reboot <server> at <time>" or "…and wait for your OK" |

`servers.run` is the riskiest thing here and is treated as such: the card shows the exact text that will execute, bound
to one server, and plan re-derives the hash at revalidate time so an edited command cannot ride an old approval. A
command that arrives with a different hash is a new request.

`servers.configure` (add/edit/remove a server, its schedule, its policy) is **not** a write kind: it is the owner's own
page action, filed through the kernel's settings path as his change (§8). An agent that wants to change a server's
schedule asks; it does not have the tool.

Secrets are never part of a write record: a key is written to the vault by the owner's page action (§6), and the record
of *that* is the vault primitive's own audit row — server, key name, fingerprint, when — never the key.

Audit trail: every write record already lands on the board with requester, task, digest, tier and outcome. On top of
that, `src_servers.actions` keeps the operational trail (§7): what was installed, how long it took, exit status, the
services that changed state, and the write record id that authorized it. So "who changed what on db-1" is one SQL
query, and the card is still the authority.

## 6. Named secrets — the generic building block

Today: a module declares `setup: { <key>: … }`, the board stores one value per key, the module's container reads it as a
file. Fixed count, fixed names, no reuse, no rotation story.

What this module needs: N named SSH keys, added by the owner, reused across servers, rotated, and refused-for-delete
while in use. That is generic — a Slack workspace per team, an API token per customer, a deploy key per repo all want
the same thing. So it goes in the schema for every module, not inside `servers`.

```yaml
secrets:
  named:
    - namespace: ssh-keys          # <module>.<namespace>; the module's own
      label: SSH keys
      fields: [private_key]        # one secret value per entry; more than one allowed
      max: 50
      usage: servers               # the module's own setting key that references entries, so delete can be refused
```

- **Storage:** one file per entry under the module's `secrets.state` dir, `<namespace>/<name>/<field>`, mode 0600,
  inside the gocryptfs view. The name is the entry's slug; the key is never in a filename.
- **Owner path:** the module's page tool (`servers_key_save`) hands the kernel a typed secret write; the kernel writes the
  file and returns only `{name, fingerprint, created_at}`. The value is never echoed, never in the page's state, never in
  a log line. The page clears the field on save.
- **Read path:** only the declaring module's service, via its own key filesystem. The agent has no tool that returns a
  secret, and the kernel refuses a read of another module's namespace.
- **Delete:** refused while any entry in `usage` still references the name — checked by the module's own check, so the
  rule lives with the thing that knows what "in use" means.
- **Rotation:** replacing an entry's value bumps `rotated_at`; consumers pick it up on their next read. No restart.
- **Audit:** `src_meta.secret_change` (namespace, name, field, fingerprint, actor, at) — never the value.
- **Not in v1:** passphrase-protected keys, key generation in the browser, per-entry ACLs.

This is a platform change: `modules/board/schemas/`, the vault writer, the kernel's secret path, the owner MCP. It is
reviewed on its own merits and the reviewer sees it as new authority (secrets) for every module that declares it.

## 7. The inventory: `src_servers`

The module's service writes a warehouse source, the way `security-scanner` writes `src_security`: own schema, own role
(`warehouse_src_servers_password`, generated), `connects: [sources]`, tables and views created at start, one
`src_meta.ingest_run` row per pass.

```
src_servers.servers      name, address, port, user, key_name, distro, distro_version, kernel, arch,
                         enabled, schedule (jsonb), reboot_policy, quiet_window,
                         last_check, last_ok, last_error, pending_updates, security_updates,
                         security_known (bool), reboot_needed, disk_pct, uptime_s, updated_at
src_servers.actions      id, server, action, write_id, started, finished, outcome,
                         packages (jsonb), services_changed (jsonb), exit_code
src_servers.keys         name, fingerprint, created_at, rotated_at, used_by (text[])
```

`security_known = false` is the honest flag from §4: the row has a package count and no security count, and every
reader sees why. Views: `src_servers.fleet` (one row per enabled server, current state) for Aiden and any app.

Readers: Aiden, Security Watch and any app query it with SQL. **Nobody asks the agent for a number the warehouse already
holds.** The agent reads the same tables when it needs to reason across servers, and the SSH service is the only writer.

## 8. The Servers page, and a quiet start

**Quiet start.** Installing the module schedules nothing. No server, no check, no run — a module that starts patching
the moment it is enabled is a module nobody dares enable. The first scheduled check for a server is its first interval
after the owner adds and enables it.

**The page** is the module's own Fleet page (the pattern the Maintainer and ship pages use), declared in `module.yaml`
and served as a module view; the generic module-settings screen keeps only advanced values. One editor per setting: a
server's schedule and policy are edited on the page, not in two places.

- List: one row per server — name, address, distro, pending, security (or "unknown"), reboot needed, last check, state.
- Add/edit a server: name, address, port, user, key (pick from the vault or add one), schedule (security interval,
  weekly day/time), reboot policy, quiet window.
- Keys: add, rotate, see usage, delete (refused while in use).
- Actions: check now, install security now, full update now, restart a service, run a command — each one opens the
  write card the agent would file, with the same text.
- Owner-only tools (never granted to the agent; each verifies `caller.kind === "owner"`): `servers_config` (read),
  `servers_configure` (settings change), `servers_key_save`, `servers_host_key_trust`, `servers_check_now`.
- Settings keys: `servers_machines`, `servers_weekly_day`, `servers_weekly_time`, `servers_security_minutes`,
  `servers_quiet_start`, `servers_quiet_end`. Per-server overrides live inside `servers_machines` entries (the
  `entry:` setting shape), so a page save is one settings change.

## 9. Update safety

Rules the executor enforces, in order, before it installs anything:

1. **Recover first.** On Debian/Ubuntu, if `dpkg --audit` reports an interrupted run, `dpkg --configure -a` before
   anything else. A half-configured system is not patched over.
2. **Respect pins.** apt holds (`apt-mark showhold`) and dnf versionlock (`dnf versionlock list`) are honoured: a held
   package is never upgraded, and it is named in the report as held.
3. **Never a release upgrade.** `apt-get upgrade`, never `dist-upgrade`; no `do-release-upgrade`; no `dnf
   system-upgrade`; no `zypper dup` to a new product. If the upgrade set would move the distro release, the run stops and
   reports it.
4. **Disk first.** Refuse to start if free space on `/` (and `/var` when separate) is under the larger of 1 GB and
   twice the download estimate. Report the numbers.
5. **Snapshot services.** Record every running unit before (systemd `list-units --state=running`, OpenRC `rc-status`),
   and after the install compare: a unit that was running and is not now is flagged at the top of the report and is
   *not* silently restarted.
6. **Wait for the lock, don't lose to it.** apt: `-o DPkg::Lock::Timeout=600` plus `flock` on
   `/var/lib/dpkg/lock-frontend`. dnf: its own lock with a bounded retry. zypper: retry on "System management is locked"
   with backoff. apk: `flock /lib/apk/db/lock`.
7. **Coexist with unattended-upgrades.** Detect it (`systemctl is-enabled unattended-upgrades`, plus
   `/etc/apt/apt.conf.d/20auto-upgrades`). When it is on, **stay out of its way**: it already installs security updates,
   our hourly check mostly finds nothing (which is correct and costs nothing), and the report says who is doing the work.
   Never disable it. When it is off, we do the work.
8. **Reboot detection** per §4's table, and reboot per that server's policy: automatic inside the quiet window (the
   default), or ask first. Outside the window, the automatic case waits for the window's start rather than rebooting at
   an arbitrary hour.

## 10. Why not Ansible

Ansible's `package`, `reboot` and `service` modules do cover every distro in §4, and check mode is a tempting dry run.
Reasons this module does not drive it:

1. **Python on every host.** Every Ansible module except `raw`/`script` needs Python 3 on the target. Minimal Debian,
   hardened images and Alpine frequently have none, so the module would have to install a package on every server before
   it could patch one — a bootstrapping change the owner did not ask for, on hosts chosen for being minimal.
2. **We still need our own transport.** Key custody, the pinned host key per server, and the refusal on a changed key are
   ours either way; Ansible's SSH plugin would be configured to do the same thing, so it is a dependency around code we
   keep.
3. **The read layer is ours either way.** Ansible cannot tell us which updates are security updates; that is §4's table,
   and it is the part that decides what runs when.
4. **The exact-command path must be a literal.** A reviewed command text bound to one server does not fit a playbook; the
   one place Ansible would help is the one place we must not abstract.
5. **Check mode is not the plan.** For package upgrades it reports "changed" without a trustworthy package list, so the
   plan would still come from the read layer and check mode would be a second, weaker opinion.

The cost we accept: we own the distro adapters. They are one file per family behind one interface, with a fixture test
per family (§11), and the action layer is swappable — if Ansible later earns its place, it replaces `execute.ts` behind
the same interface and nothing else moves.

## 11. Testing

- **Fixtures, not live hosts, for the logic.** Recorded `os-release`, package-manager output and unit lists per family
  (Debian, Ubuntu, RHEL, Rocky, Alma, CentOS Stream, Fedora, openSUSE, SLES, Alpine, Arch, unknown) → the adapter's
  answer is asserted: upgradable set, security set or `security_known=false`, reboot flag, service list.
- **Safety cases, each a test:** held package untouched; interrupted dpkg recovered; release upgrade refused; low disk
  refused; lock contention waited out; unattended-upgrades detected and not disabled; a service that stopped is
  reported and not restarted; a changed host key refuses the action.
- **One live smoke test on a throwaway container** per family, in CI, for the four commands the adapters actually run.
- **Write kinds:** a test per kind that the card text carries the exact package list or command text, and that a changed
  command hash is refused at revalidate.

## 12. What is still open

- Whether Security Watch should hand server findings to this module's inventory later (design doc, "No duplicated
  security work"). Not in this build.
- Whether the named-secrets primitive ships as its own PR before the module, or in the same release. Its own PR is
  cleaner: the reviewer sees new authority once, for every module that will use it.
