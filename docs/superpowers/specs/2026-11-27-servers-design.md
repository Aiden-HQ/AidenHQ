# Server Manager — technical spec

Companion to the design doc "Server Manager: an agent that maintains your servers over SSH". The design doc says what
the agent does and for whom; this spec says how it is built. Where the two disagree, this spec is wrong and gets fixed.

Status: reviewed by Codex on 2026-11-27 (three passes, not build-ready → buildable; §16), and ready for the owner.
Nothing is built from it until he says ready.

## 0. Venue

This is an **official module of the product**, not a local module of one instance: `modules/server-manager/` in this
repo, alongside the others. It follows `modules/AGENTS.md` in full, and CLAUDE.md's "Conventions". It is generic: no
hostnames, addresses, keys, user names or instance data anywhere in the module, its docs, its tests or its examples. An
instance turns it on the way it turns on any other module; nothing in this build touches one instance's config.

Scope, as decided by the owner (2026-11-27): Ubuntu LTS and Debian stable only, one apt adapter done well; typed
operations only — check, patch, reboot — with no arbitrary commands and no ad hoc service restarts; one approval record
per server maintenance run; the warehouse out of the execution path; the existing named-secret entries reused rather than
a new vault feature.

## 1. What ships, and in what order

Three pieces of work, in this order.

1. **This document**, through the Codex design review, before any code. That review has run (2026-11-27, three passes,
   not build-ready → buildable) and its findings are folded in; §16 lists each blocker and what changed because of it.
2. **The board's named-secret entries, extended** (`modules/board` + `kernel`): multiline values, and refusing to clear an
   entry that something still references. Small, reviewed on its own merits, and the only change to an existing path.
3. **The `server-manager` module**: service, page, three operations, one distro adapter, one warehouse row per server,
   agent and skill.

Each is its own PR, in that order. The module needs (2) for reusable keys; (2) is small enough that a reviewer sees it
once, on its own.

**Explicitly not in this build:** arbitrary commands, ad hoc service restarts, the Red Hat family, SUSE, Fedora,
CentOS Stream, Alpine, Arch, CVE matching of our own, action rows in the warehouse, per-package approvals, a second
history anywhere. §15 lists what comes later.

## 2. Module layout

```
modules/server-manager/
  module.yaml
  README.md                  the four sections modules/AGENTS.md asks for
  agents/server-manager/AGENTS.md   mission and teammate block (frontmatter)
  skills/maintenance/SKILL.md       how-to: read a report, read a record, what to do when a run fails
  service/
    Dockerfile               Node only, pinned by digest
    src/main.ts              MCP server, page tools, scheduler and executor
    src/ssh.ts               transport: key from the map, pinned host key, timeouts
    src/apt.ts               the one adapter: read, plan, revalidate, install
    src/execute.ts           a patch or reboot inside its record; services and boot ID around it
    src/reboot.ts            need detection, quiet window, consent binding, come-back proof
    src/schedule.ts          per-server due slots, coalescing, durable dedupe, timezone and DST
    src/status.ts            one sanitized row per server
    src/page.html            the Servers page (module view, shared page kit)
  schemas/                   strict JSON Schema per write kind
  test/                      fixtures, safety cases, the page's own test
```

The service is one container. Compile names it `server-manager-ssh` (its key in `services.run` is `ssh`), and it is the
only thing in the fleet that holds a server's private key or talks to a server.

## 3. `module.yaml`, declared

- `requires: [board, warehouse]` — the page point and the map secret come from board; the status row is warehouse's
  point. Requiring the warehouse does not put it in the execution path (§8).
- `contributes.board.pages`: one entry, `{ id: server-manager, title: Servers, icon: shield, order: 40, connection:
  server_manager, view: "ui://server-manager/page", tools: [ server_manager_config, server_manager_status,
  server_manager_check, server_manager_patch, server_manager_reboot, server_manager_host_key_reset ], settings:
  [ servers_machines ], secret_maps: [ { secret: servers_keys, keys_from: "servers_machines[].key", fields: [ { name:
  private_key, label: "Private key", kind: key, maxLength: 4096 } ] } ] }`. The page's settings list is what the page may
  propose; the owner's
  Save outside the frame is the gate. `icon` must be one of the board's own enum (`shield` is), and `view` must start
  `ui://server-manager/`.
- `contributes.warehouse.sources`: `src_servers`, with a `servers` view (§8).
- `roles.requests: [ kernel.tasks, kernel.wake ]` — the service files a task for the agent and wakes it when a run needs
  a judgement (§13). It declares no role of its own.
- `secrets.provided: [ { name: servers_keys, setup: { label: "SSH keys", pattern: "^\\{[\\s\\S]*\\}$", help: "Added
  from this page's Sign-ins panel; never shown again." } } ]` — the JSON map the Sign-ins panel writes one key into
  (§7). The pattern accepts any JSON object: the map is multi-line from the first key on, so a single-line pattern would
  refuse every real key.
- `generated_secrets: [ server_manager_token, server_manager_service_key ]`.
- `connections.server_manager`: `url: http://server-manager-ssh:8103/mcp`, `auth: server_manager_service_key`,
  `returns: untrusted`, `tool_timeout_sec: 1800`, `setup: "Built in: nothing to connect."`, with its tools tagged:

  | Tool | Tag | Who holds it |
  |---|---|---|
  | `server_manager_check` | `read` **and** `named` | the page, and any agent granted it by name (a key and a private host, so `read` alone must not hand it out) |
  | `server_manager_config` | `read` | the page, the agent |
  | `server_manager_status` | `read` | the page, the agent |
  | `server_manager_patch` | `write`, filed as `server-manager.patch` by the service | the page (the owner's own filing); the agent has no grant |
  | `server_manager_reboot` | `write`, filed as `server-manager.reboot` by the service | the page; the agent has no grant |
  | `server_manager_host_key_reset` | `write` | the page only; never granted to any agent |

  A page tool is called by the view directly, so it cannot be one a write kind routes (compile refuses a page listing a
  routed tool). Instead each write kind declares `tools: []`, and the module's own service files the record itself — the
  kernel lets a module file its own kinds — so the page's "install now", a scheduled run and the agent's own path all
  file the same `server-manager.patch` record and go through the same tier, executor and audit trail.
  `server_manager_check` is not any kind's tool: it is a read (§6).
- `providers.executor`: `{ url: http://server-manager-ssh:8103/aidenhq/v1/executor, auth: server_manager_service_key }`.
- `validate: { post: http://ssh:8103/validate, auth: server_manager_service_key }` — the module's own check of a settings
  change and of a key's clear (§7). Its host is the service's key in `services.run` (`ssh`), not the compose name:
  `scripts/modules.ts` `checkEntries` refuses a `validate.post` whose hostname is not one of `services.run`'s keys, while
  `kernel/src/net.ts` resolves either name to the same container.
- `writes:` two kinds (§6).
- `settings:` `servers_machines` (a list, `entry: name`), the one setting (§9). It carries a comment above it in
  `module.yaml`: `scripts/modules.ts` `requireDocs` refuses an official module's setting without one, and that comment
  is what the board and the owner's Claude show as the field's help.
- `services: { data: true, run: { ssh: { build: ./service, port: 8103, tmp: 16m, egress: true, links: [sources],
  data: ["state:/data"], secrets: [ servers_keys ], env: {...} } } }`. `links: [sources]` is the warehouse's network and
  is reachable only through `scripts/modules.ts` `LEGACY_LINKS`, a closed list a test pins: this build adds
  `server-manager: { until: "3g", to: ["sources"] }` to it and updates that test. The status writer's login is the same
  kind of change: `generated_secrets` gains `warehouse_src_servers_password`, and `ops/warehouse-sources.sh` and
  `modules/warehouse/apps/warehouse/sources.sql` each gain `src_servers` beside the sources they create today (the SQL's
  `FOREACH` array, its `set_config` lines, and the script's `for s in …` list).
- `data_version: 0` — the data dir's format, migrated forward only.
- `agents.server-manager`: `skills: [ server-manager.maintenance, tasks.delegate-work ]`, `department: platform`,
  `model: ~deepseek/deepseek-flash-latest`, `timeout_sec: 1200`,
  `paperclip_tasks: [ task_current, task_get, task_comments, task_comment, task_block, task_finish, task_list,
  task_approvals ]`, `server_manager: [ server_manager_config, server_manager_status, server_manager_check ]`,
  `apps: [ web_view, app_view ]`, and `heartbeat: 4` as the backstop for a
  missed wake. Its `teammate:` block lives in its `AGENTS.md` frontmatter, not here: a product module's teammate is
  declared there (`modules/AGENTS.md` "Teammates").

## 4. The SSH service

One container, `server-manager-ssh`, on `:8103`, with the module's own network plus its egress network.

- `egress: true` — agent computers cannot reach private ranges; this service must, because the servers it manages are
  usually private.
- `secrets: [servers_keys]` — the map is mounted as a file (`/run/secrets/servers_keys`). The service reads it on every
  use and never writes it; only the board's Sign-ins panel and the kernel's `save_secret` write it.
- `data: ["state:/data"]` — the module's data dir, holding `known_hosts/` and the durable due-slot records (§11).
  `data_version: 0`; a format change is a forward-only migration at startup, with the version bumped in the same PR.
- `tmp: 16m` — apt writes nothing here, but ssh's own `ControlPath` and any temp key must never hit a read-only root.
- `read_only` stays at its default (true), `user` at `owner`, and no `privileged` and no host mount: nothing in this
  module reads the host it runs on.
- Env: `SERVERS_STATE_DIR=/data`, `SERVERS_KEYS_FILE=/run/secrets/servers_keys`, `SERVERS_TOKEN_FILE` and
  `SERVERS_SERVICE_KEY_FILE` (the two generated secrets), `SERVERS_MACHINES` (`${settings.servers_machines}`), and
  `AIDENHQ_KERNEL_URL`.

Transport rules, all in `ssh.ts`:

- **Key by name, at connect time.** The machine's `key` names one entry of the map; its `private_key` field is written to
  a mode-0600 file inside the container's tmpfs, used for that one connection, and unlinked in a `finally`. It is never
  logged, never returned by a tool, never put on a command line, never in a record, and every error string is scrubbed of
  it and of the command's environment.
- **Pinned host key, and what the first pin really is.** `StrictHostKeyChecking=yes` against
  `/data/known_hosts/<machine>`. The **first** connection records whatever key the host presents (`accept-new` for that
  one connection, then a verify that it is now pinned), and the first run's report states the fingerprint it pinned in
  full — so the owner can compare it with the console of whoever runs that machine, without being asked to. That is
  trust-on-first-use, and this spec says so plainly rather than implying the first connection is verified: between the
  module and a machine nobody has connected to before, a man-in-the-middle could present its own key.
  Two things bound that, and one closes it for anyone who wants it closed:
  - a **changed** key refuses the run, marks the machine `host-key-changed`, and only the owner's explicit reset
    re-pins it (§10), so a key is pinned once and a swap is loud;
  - a machine entry may carry `expected_fingerprint`; when it does, the first connection must match it or the run
    refuses before anything runs. Empty is the default (no step for the owner, per his decision of 2026-11-26), and
    setting it is one paste for an owner who has the fingerprint from the provider;
  - every run reports the fingerprint it used, so a mismatch is visible in the record rather than only at connection
    time.

  The reason the default is not "ask the owner to confirm the first fingerprint" is the owner's own instruction: no
  step for him, minimum interaction. The residual risk is stated here, on the page and in the first report instead of
  being left implicit.
- **Batch, always.** `BatchMode=yes`, no password prompt ever, no agent forwarding, no X11, no port forwarding, no TTY.
  A host that needs a password is `no-passwordless-sudo` or `login-refused` in the report, never a prompt.
- **Bounded.** Connect 15 s, read commands 120 s, install 1500 s, reboot wait 900 s polling every 5 s. A tool call's
  ceiling is the kernel's `tool_timeout_sec: 1800`, so an install that would exceed it stops and reports rather than
  being cut off mid-transaction.
- **One connection per run**, never pooled across machines: a failure is always attributable to one host.

## 5. The adapter: Ubuntu LTS and Debian stable

One adapter, `apt.ts`, behind a small interface (`detect`, `read`, `plan`, `install`) so a later family is one more file
and not a branch. It answers four questions in one read pass — *what is upgradable*, *which of those are security
updates*, *is a reboot needed*, *which services are running* — and knows how to install a named set.

| | Detect | Security classification | Reboot needed | Services |
|---|---|---|---|---|
| Ubuntu LTS | `ID=ubuntu`, `VERSION_ID` an even-year `.04` | A package is security when its candidate comes from a security suite — the suite on the candidate's source entry ends `-security` (`jammy-security`), read from `apt-cache policy`; apt's `Origin:` is `Ubuntu` and never ends that way, so origin is not the test. Cross-checked with `ubuntu-security-status --format json` when present, which also reports ESM-apps packages the suite test cannot see | `/var/run/reboot-required` | systemd |
| Debian stable | `ID=debian`, `VERSION_CODENAME` a released stable | The same suite test (`bookworm-security`, or `stable-security` when the source names the release as `stable`); apt's `Origin:` is `Debian` | `/var/run/reboot-required` | systemd |
| Anything else | — | Not attempted | — | — |

- **Honest limit, in every report:** a fix backported into a normal archive is not flagged as security. That is a
  property of the source, not something the module can invent, and the report says so once rather than pretending.
- **Anything else is unsupported.** The machine is listed `unsupported`, no action runs on it, and the page says why. No
  probing, no best-effort. Ubuntu interim releases and Debian testing/unstable are reported unsupported, not run on a
  guess.
- **The adapter never writes outside `install`.** `detect`, `read` and `plan` are read-only; a plan is a proposal, and
  §12's revalidation is what makes it safe to execute.

## 6. Operations, write records and consent

Two typed kinds, and a read. There is no command path and no service-restart path in this build.

| Kind | What it does | Floor | Tier as filed |
|---|---|---|---|
| `server-manager.patch` | Installs the revalidated set — `security` or `full` — on one machine | 0 | 0, or the owner's own card where the instance runs `autonomy: off` |
| `server-manager.reboot` | Reboots one machine | 0 | 0 inside the quiet window; **`plan` raises to 2 when the machine is "ask me first"** |

**A check is a read, not a write kind.** `server_manager_check` is a read tool on the module's own connection: it opens
one SSH session, reads package state, the security set, the reboot flag, disk on `/` and `/boot`, uptime, boot ID and
the running units, and returns them. It changes nothing on the host, so it files no record — the platform's rule is that
a *write* is what needs an approval record, and a read needs none. Tagging it as a write kind to get a record would be
the wrong trade: it would put a record in the path of an hourly read on every machine.

The read is still held tightly, because it is not an ordinary read: it uses a key and opens a connection to a private
host. It is tagged **`named`** on the connection, so `server_manager: read` does not hand it out — only a grant that
names `server_manager_check` reaches it, which is the pattern the github module uses for its issue reads. The page's
"check now" calls the same tool. Its answer carries the readout; the last readout is also what §8's status row
publishes.

**No model in the loop, and why that is the right call here.** A scheduled patch files a record and runs; it does not
wait on the AI reviewer, because the owner's design has patching land inside the quiet window with no step for him, and
a reviewer in the path would add a model call to every run and could refuse a routine patch for reasons nobody sees
until it is late. What makes a Tier 0 patch safe is not a reviewer but the typed kind and §11: one machine, apt only,
the package set re-derived at execute time and compared with the record's hash, disk checked on `/` and `/boot`, pins
respected, no release upgrade, services compared before and after. The record and its outcome are the audit trail
either way — a Tier 0 record is filed, decided and reported like any other.

Where an instance runs `autonomy: off`, every patch becomes the owner's card. That is that setting working as
designed, not a fault in this module, and the page says so when it is on.

Each kind has a strict JSON Schema in `schemas/` (`additionalProperties: false`, every field required and typed), so a
malformed request is refused at filing, not at execution.

**One record per run, not per package.** A patch record names the machine, `security` or `full`, the machine's reboot
policy, its pinned host-key fingerprint, and a hash of the exact package set. The packages that actually changed go in
the record's outcome. The service files the record itself through the kernel (`kernel.tasks`/write filing); the agent is
not in the loop, and a run needs no model.

**A reboot gets its own record** when it does not happen inside the run that needed it: an "ask me first" machine, or a
reboot deferred to the quiet window's start.

**Consent is bound and it expires.** For an "ask me first" machine the reboot record raises to Tier 2 in `plan` — the
owner's own decision, never the AI reviewer's. The record names:

- the machine, by name and by its pinned host-key fingerprint;
- the *pending reboot id*: a hash of the boot ID it expects to leave, the running kernel, the installed versions of the
  packages that put it there, and the installed kernel awaiting the next boot.

Approving it authorises exactly that reboot on exactly that machine. `execute` re-derives the pending reboot id at the
moment it reboots and refuses if it no longer matches, so a second update, a manual reboot or a different machine can
never ride an old approval. Consent **expires 12 hours** after it is granted; after that the pending reboot is dropped
and reported, never held open.

**What comes back from a machine is data.** Package lists, changelogs and service logs are quoted in a report and never
treated as an instruction, however they are worded. The connection's `returns: untrusted` is the declaration of that.

## 7. Keys: the existing named-secret map, extended

**Reuse what exists.** `board.pages.secret_maps` already gives a module a page-edited map of names to values: the board
renders a Sign-ins panel outside the module frame, the owner types each value there, and the kernel's `saveKey` merges
that one entry into the JSON map and writes the vault file in place. The module reads the map on each use, and a stored
value never comes back to a browser, a tool or a log.

Reading the current code (2026-11-27), that path already has most of what is needed, and one gap that the earlier draft
of this spec got wrong:

- `kernel/src/module-secrets.ts` `saveKey` merges one key under a lock and takes a `check` callback, which
  `kernel/src/auth-api.ts` wires to the module's own `validate:` hook with the entry alone (`{ <key>: <entry> }`).
- **But it calls that check only when an entry is being written**: `if (entry) await check(...)`. A **clear** (`entry`
  null) never reaches the module, so a module cannot refuse one today, however it answers. That is the gap: the one
  case this module needs guarded is the one the hook does not see.
- And the **shape** does not fit SSH keys: `saveKey` refuses any field value over 300 characters, and `secretFits` caps
  a whole pasted secret at 300 too. The board's Sign-ins panel renders `kind: text | password | totp` only, as a
  single-line input.

So the platform change is five small, specific things, in `modules/board` and the kernel — the shared path, not a
private trick inside one module (`modules/AGENTS.md`: a new building block goes in the schema and the board, for every
module):

1. **A new field kind, `key`, in `modules/board/schemas/pages.json`**, with an optional `maxLength` on a field
   (an integer, 1 to 65536). The panel's `SecretMap` type in `services/board/src/module-views.ts` gains `key` and
   `maxLength?`, and `services/board/web/src/SecretMaps.tsx` renders `key` as a textarea (`<textarea rows={6}>`,
   `spellCheck={false}`, `autoComplete="off"`): today it renders every kind but `text` as `type="password"`, so without
   that line a `key` field is a single-line hidden input and a pasted key cannot be checked by eye. `key` is not
   hidden: the value is never read back either way, so hiding buys nothing and makes a bad paste impossible to see.
2. **A per-field cap the kernel can see.** The kernel knows a secret only as `SetupField` (`kernel/src/admin.ts`), so
   compile (`scripts/modules.ts`) carries each map secret's declared fields — `{ name, kind, maxLength }` from the page's
   `secret_maps` — into the compiled setup entry. Then `saveKey` caps each entry value at its declared field's
   `maxLength` (300 when the field is not declared, so every other module is unchanged); a whole-map paste through
   `save_secret` parses the JSON and applies the same per-field caps, with a 64 KB total; and `auth-api.ts`'s request
   cap (`value` at most 1000 characters, 4000 when `key` is set) rises to 64 KB for a secret that declares fields,
   because the request cap is below the declared field cap once JSON escaping is counted, and a whole-map paste
   (`value` with no `key`) is capped at 1000 characters and cannot hold even one key. The map's own JSON is still
   validated against the `setup:` pattern.
3. **The check runs on a clear too.** `saveKey` calls `check` with the key and a null entry when an entry is being
   removed; `auth-api.ts` passes that through as `{ secret: { name }, key }` with no value; and
   `kernel/src/module-validate.ts` gains an optional `key` on `ValidateInput` and forwards it, since today it forwards
   only `secret.name` and `value`. A module that answers `{ ok: false }` refuses the clear; so does one whose hook cannot be
   asked (unreachable, timed out, or answering nonsense), because a cleared key cannot be read back — a clear fails closed.
   A module with no hook clears as it does today; a written value still goes ahead unchecked when its hook cannot be asked.
4. **The hook's answer is not a new branch.** `server-manager.validate` answers for `servers_keys`: a clear of a key a
   machine still names is refused with a message naming the machines; a replace is allowed, because that is how a key is
   rotated. The rule stays with the thing that knows what "in use" means, which is the module.
5. **The board's route, which sees the value first.** `services/board/src/app.ts`'s page-secret handler caps every
   submitted value at 300 (`z.record(z.string(), z.string().max(300))`) and trims every field but a `password`
   (`f.kind === "password" ? v : v?.trim()`), both before the kernel is called. It takes the caps from the page's
   declared fields — `z.string().max(declared maxLength, 300 when undeclared)` per field, and a 64 KB body — and it
   keeps a `key` field's whitespace exactly, like a `password`: an OpenSSH key's trailing newline is part of the file,
   and trimming it is how a valid key becomes an invalid one. `text` and `totp` still trim.

Each of those gets a test in the named-secret PR: a `key` field over 4096 refused, a `key` field with newlines stored
whole, a three-kilobyte key pasted whole is stored and read back, a map paste over 64 KB is refused, a key over its
declared `maxLength` is refused by the board's route before the kernel is called, a key field's trailing newline
survives the panel route byte for byte, and a `text` field is still trimmed; a clear refused by a module that answers
no, a clear allowed when nothing references the key, and a clear still working for a module with no `validate:` hook.

**Verified, not assumed.** The code facts above (`if (entry) await check(...)`, and the 300-character cap in three
places (`saveKey`, `secretFits`, and the board's page-secret route in `services/board/src/app.ts`), and the board
route's trim of every field but a `password`) were read in the product repo at `main` on 2026-11-27, and they are what
the first PR changes. If any has moved by then, the PR follows the code, not this paragraph.

In this module: `setup:` declares one secret (`servers_keys`, the JSON map); the page declares its `secret_maps` entry
with `keys_from: servers_machines[].key`, so a key's name is exactly what a machine entry holds; the SSH service mounts
the map's file read-only and looks a key up by name at connect time. Nothing else about the vault changes.

## 8. The status row: one per server, for reading

**The warehouse is not in the execution path.** Settings live in the module's declared settings; current state lives in
the service's data dir; the history of what changed lives in the kernel's records (§6). Patching keeps working during a
warehouse outage, and there is one audit trail rather than two.

What is published is one **sanitized latest-status row per machine**, through the module's `contributes.warehouse.sources`
entry the way `modules/security` publishes `src_security`:

```
contributes:
  warehouse.sources:
    - schema: src_servers
      about: "src_servers.servers (one sanitized status row per machine) / fleet"
      views:
        - { name: servers, time: updated_at }
        - { name: fleet, time: updated_at }
```

- No key names, no key material, no addresses, no user names, no action rows, no package lists.
- `security_known = false` when the host cannot classify; on both supported families it can, so this is a guard rather
  than an expected state.
- Written at most once per run, after the run, from what the run saw. A failed publish is logged and skipped: it never
  fails or delays a patch.

Readers — the chief of staff, Security Watch, any page — query it. **Nobody asks the agent for a number the warehouse
holds**, and nothing in a run waits on the warehouse.

## 9. The Servers page, and a quiet start

**Quiet start** (`docs/design/quiet-start.md`, `modules/AGENTS.md` "The owner's experience"): installing the module
schedules nothing. No machine, no check, no run. A machine's first scheduled check is its first interval after the owner
adds and enables it.

The page is a module view (`docs/design/board-ui.md` "Modules"), served by the `server_manager` connection, laid out as
`modules/AGENTS.md` "Settings pages" says: grouped by what the owner wants done, one row per setting, one control kind,
plain-language summaries, Advanced collapsed.

- **Machines list:** one row per machine — name, distro, pending, security (or "unknown"), reboot needed, disk, last
  check, state. Each row's summary line is built from its own settings.
- **Add / edit a machine:** name, address, port, user, key (picked from the map), schedule (security interval, weekly
  day and time), reboot policy, quiet window. One editor, one Save.
- **Keys:** the board's Sign-ins panel, outside the frame, so a key's value never enters the module's HTML.
- **Actions:** *check now* calls the `server_manager_check` read tool and files **no** record (§6) — it only reads.
  *install security now* and *full update now* file the same `server-manager.patch` record a schedule would, with
  `mode: security` or `mode: full`.
- **The page's tools**, and who else holds each: `server_manager_config` and `server_manager_status` (read; the agent
  holds both), `server_manager_check` (read, `named`; the agent holds it by name), `server_manager_patch` and
  `server_manager_reboot` (write, filed by the service as their kinds; the page only — the agent has no grant, so a
  patch always comes from a schedule or the owner's click), and `server_manager_host_key_reset` (write; the page only,
  never any agent). The two the page calls that are the owner's own action verify the caller is the owner's signed-in
  session, not an agent's assertion, the way Ship's and Maintainer's config tools do.
- **Settings:** `servers_machines`, an `entry:` list, is the whole per-machine configuration; one page save is one
  settings change, as `settings-changes.md` wants. Its entries, exactly:

  The setting is a **list**, not an object wrapping one: `servers_machines` holds the entries directly, which is what
  the board's `keys_from: servers_machines[].key` walks and what `settings-changes.md` compares per entry. Declared in
  `module.yaml` as a list of maps, with `entry: name` naming the field each entry is identified by:

  ```yaml
  # The servers this module maintains, one entry each. An entry is the whole of that server's configuration: its
  # address, the vault key it signs in with, when to check and patch it, and whether it may reboot on its own.
  servers_machines:
    default: []
    entry: name
    pattern: '^[a-z0-9][a-z0-9-]{0,31}$'
    writers: [ owner ]        # the page's Save is the owner's; no agent holds a write to it
  ```

  Each entry is one object. Compile checks the field `entry: name` names against this setting's `pattern`, so a machine
  name that is not lowercase letters, digits and `-` is caught at compile wherever the entry was written — the page, an
  agent's settings change, or the instance file by hand: the compile warns and the setting falls back to its empty default,
  so a bad name never reaches a service. The module's `validate:` hook checks a whole entry against the schema below, on
  the page's Save and on an agent's settings change, and its refusal is shown under the field:

  ```jsonc
  {
    "type": "object",
    "additionalProperties": false,
    "required": ["name", "address", "user", "key"],
    "properties": {
      "name":         { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,31}$" },
      "address":      { "type": "string", "pattern": "^[A-Za-z0-9.:\\[\\]-]{1,253}$" },
      "port":         { "type": "integer", "minimum": 1, "maximum": 65535, "default": 22 },
      "user":         { "type": "string", "pattern": "^[a-z_][a-z0-9_-]{0,31}$" },
      "key":          { "type": "string", "pattern": "^[a-z0-9][a-z0-9_-]{0,62}$" },
      "enabled":      { "type": "boolean", "default": true },
      "expected_fingerprint": { "type": "string", "pattern": "^(SHA256:[A-Za-z0-9+/]{43})?$", "default": "" },
      "security_minutes": { "type": "integer", "minimum": 15, "maximum": 1440, "default": 60 },
      "weekly_day":   { "enum": ["mon","tue","wed","thu","fri","sat","sun"], "default": "mon" },
      "weekly_time":  { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$", "default": "03:00" },
      "reboot_policy":{ "enum": ["auto","ask"], "default": "auto" },
      "quiet_start":  { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$", "default": "03:00" },
      "quiet_end":    { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$", "default": "05:00" }
    }
  }
  ```

  Two different fields, two different jobs, and nothing uses one where the other belongs:

  - **`name`** identifies the machine. It is the key `entry: name` diffs on, the machine column of the status row, and
    how a record, a report and the page's list all name it. It never changes after a machine is added: renaming is
    remove-and-add, and the page says so.
  - **`key`** is only the lookup into the `servers_keys` map: `keys_from: servers_machines[].key` walks each entry's
    `key` to list which key names may exist, and `server-manager.validate` walks the same field to answer "is this key
    still used by a machine". It carries no meaning outside the vault.

  Several machines may share one `key`; that is the point of naming keys at all. `address` never carries a user or a
  URL, so the SSH target is always built as `user@address` with `-p port`, never parsed out of a string.

  Times are wall-clock in the instance's `timezone`, and a window that ends before it starts wraps midnight (23:00–01:00
  is a real window, and §12's DST rule applies to both ends). The defaults above are the "Open decisions" answers in the
  design doc, so a new machine needs four fields filled in — name, address, user, key — and nothing else.

- **`servers_keys`, the map's shape.** A JSON object of key name → `{ private_key }`, written only by the Sign-ins
  panel. Its `setup:` pattern is `^\{[\s\S]*\}$` (any JSON object; the map is multi-line from the first key on, which
  is why a single-line pattern cannot be used). One entry, as the kernel stores it:

  ```json
  { "laptop-2019": { "private_key": "-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----\n" } }
  ```

  `private_key` is the only field. The panel writes it whole (Set and Replace both write the whole entry), so a paste
  either lands complete or is refused.

## 10. Re-pinning a changed host key

A changed key stops the work: the run refuses before it connects, the machine is `host-key-changed` on the page, and the
agent is woken with the old and the new fingerprint. Nothing re-pins automatically.

`server_manager_host_key_reset` takes the machine and the fingerprint the owner was shown, refuses if the live key is
not that one any more (so a stale click cannot pin a third key), and writes the new pin. It is the owner's own call from
the page; the agent never has it.

## 11. Update safety

Rules `execute.ts` enforces, in order, before it installs anything:

1. **Refresh, then revalidate into an exact `pkg=version` list.** `apt-get update`, then re-read the upgradable set and
   recompute the list, **with the versions in it**. For `security` the list is the subset whose candidate comes from a
   security suite (the suite on its source entry ends `-security`); for `full` it is every upgradable package. Either
   way the list is a set of `name=version` pairs, never a category apt would interpret again, and its hash is compared
   with the record's. A mismatch stops the run and files a new record: what gets installed is what this last read
   showed, never what the preview showed.

   **The exact command, and why it is that one.** `apt-get install --only-upgrade -y <name>=<version> …` with the
   revalidated list. Not `apt-get upgrade`, which takes *every* upgradable package and so cannot express "security
   only"; not `apt-get dist-upgrade`. `--only-upgrade` means apt will not add a package the host did not already have.
   Before it runs, the same call is simulated (`apt-get -s install --only-upgrade …` with the identical list) and the
   simulation must show **no package outside the list installed, upgraded, removed or downgraded**; if it does, the run
   stops and reports which ones, because the plan is not what it claimed. That check is what makes the record's hash
   mean something: the hash covers the whole list, and the simulation proves the list is the whole change.
2. **Non-interactive, bounded.** `DEBIAN_FRONTEND=noninteractive`, `-y`, `-o Dpkg::Options::=--force-confdef`,
   `--force-confold`, and a timeout. A prompt that would still block is a failure, not something to answer.
3. **Disk first, both places.** Refuse to start if free space on `/` or on `/boot` is under the larger of 1 GB and twice
   the download estimate from `apt-get --print-uris` over the identical list. (`apt-get -s` prints no `Need to get` line on
   a real host — it prints the plan and the summary counts and nothing about bytes — so it proves the plan and never
   supplies the estimate.) An estimate apt did not print is a refusal, not a zero. Report the numbers. A full `/boot`
   turns a kernel update into a machine that does not come back.
4. **A broken state is not patched over.** If `dpkg --audit` reports an interrupted run, `dpkg --configure -a` is itself
   a write: it happens inside this approved run, or the run stops and reports the broken state for the owner to decide.
   The audit must have completed successfully; a denied or failed `dpkg --audit` is a refusal, never a clean database.
   The audit is read-only and runs as the SSH user, so the passwordless sudo grant is needed for APT, not for this check.
5. **Respect pins.** `apt-mark showhold` entries are never upgraded, and are named in the report as held.
6. **Never a release upgrade.** The `--only-upgrade` install above, never `dist-upgrade`, and no `do-release-upgrade`.
   If the set would move the release — a `libc6` or `base-files` jump across a codename — stop and report rather than
   install it.
7. **Snapshot services.** Record running units before (`systemctl list-units --type=service --state=running`) and compare
   after. A unit that was running and is not now is flagged at the top of the report and **not** restarted.
8. **Package hooks are not the quiet window.** An install can restart a service through its maintainer scripts at
   whatever hour the run happens. When a unit's start time moved during the run, the report says so and names it.
9. **Wait for the lock.** `-o DPkg::Lock::Timeout=600` plus `flock` on `/var/lib/dpkg/lock-frontend`, so a concurrent
   unattended-upgrades run is waited out rather than failed on.
10. **Coexist with unattended-upgrades.** Detect (`systemctl is-enabled unattended-upgrades`,
    `/etc/apt/apt.conf.d/20auto-upgrades`). When it is on, stay out of its way and say so in the report; **never disable
    it**. When it is off, this module does the work. An absent unit is off; a probe that failed to answer is a refusal, not a skip.
11. **Prove the reboot.** Read `/proc/sys/kernel/random/boot_id` before and after. SSH answering is not proof; a reboot
    is done only when the boot ID changed. If it did not change within 900 s, the run fails and reports it.
12. **Recheck the window immediately before rebooting**, not when the run started. The final read of the reboot state (the
    installed versions the pending id binds) and the reboot command itself take the dpkg lock non-blocking, so a package
    writer active at that moment makes the run refuse and wake the owner instead of rebooting a state the approval did not cover.

## 12. Schedules and reliability

- **The owner's timezone, DST defined.** Due times are computed in the instance's `timezone` setting. A run that would
  land in a skipped hour runs at the first real time after it; one that would land in a repeated hour runs once, on the
  first occurrence. Weekly slots walk local calendar dates, never elapsed 24-hour periods.
- **Missed runs coalesce.** A run missed while the service or the board was down runs once when it is back, then the
  schedule resumes. Missed hours are never replayed one by one.
- **Two due at once are one run.** A weekly pass and an hourly check in the same slot run once, as the larger (full
  patch) with the check's read included.
- **One run per machine at a time, durably.** Due slots are recorded in the data dir, keyed `<machine>:<kind>:<slot>`,
  before the run starts and marked done after. The SDK executor's dedupe is in memory and does not survive a restart, so
  this record is the durable one: a service restart cannot start the same slot twice.
- **Reconcile before retrying.** After an SSH drop or a service restart, re-read package state and the boot ID before
  deciding anything. A run interrupted mid-install is resolved from the host's actual state — `dpkg --audit`, then §11 —
  never repeated blind.
- **No agent run for scheduled work.** The service does check, patch and reboot itself. The agent is woken only for
  something that needs a judgement.

## 13. When the agent runs

Scheduled work needs no model run, and no reviewer sits in its path (§6): the service files, executes and reports the
record itself. The agent is woken, with the machine and the evidence on its task, when:

- a run failed (unreachable, login refused, no passwordless sudo, lock timeout, install error, reboot not proven);
- a machine's host key changed;
- a service that was running stopped after an install;
- a reboot was dropped because its consent expired;
- the owner asks it something.

Each run: read the evidence from the records, report what happened in plain words, say what it did not do and why, and
stop on that machine. It does not retry with a variation and it does not invent a fix. A write only ever happens through
the three typed kinds, never from a judgement call.

Its handbook is the mission and the done condition; `skills/maintenance/SKILL.md` is the how-to: how to read a record,
how to read a failed run, what a good report contains, and the one rule that matters — never type a command at a machine.

## 14. Testing

- **Fixtures, not live hosts, for the logic.** Recorded `os-release`, `apt-cache policy`, `apt-get -s` and unit lists for
  Ubuntu LTS and Debian stable, plus one unsupported host to prove the refusal → the adapter's answer is asserted:
  upgradable set, security set, reboot flag, service list.
- **Safety cases, each a test:** held package untouched; release upgrade refused; low disk on `/` and on `/boot` refused;
  stale plan (hash mismatch) stops the run; lock contention waited out; unattended-upgrades detected and not disabled; a
  service that stopped is reported and not restarted; a reboot without a changed boot ID fails; a changed host key
  refuses the run; an expired or mismatched reboot consent is refused at revalidate; a clear of a key still in use is
  refused; a key field over 4096 characters is refused.
- **Records:** one per run, carrying the machine, kind, policy, host-key fingerprint and package hash; the outcome carries
  the packages that changed and the services before and after.
- **Schedules:** DST skip and repeat, missed-run coalescing, two-kinds-in-one-slot, and a restart mid-slot (durable
  dedupe) each a test.
- **The install command itself:** one test asserting the exact argv (`install --only-upgrade -y name=version …`) and that
  the `-s` simulation's output is parsed for anything outside the list — an added package, a removal, a downgrade — and
  refuses when it finds one. This is the test that keeps "security only" honest.
- **The page** gets the board's own module-view test (`services/board/test/module-views.test.ts` is the pattern), and the
  Sign-ins panel's `key` field one test of its own.
- **One live smoke test** on a throwaway Ubuntu container in CI for the exact commands the adapter runs. It is the only
  test that touches a real `apt`; every other one is a fixture.
- **CI:** the module's own area in `.github/ci/areas.json`, so a change to it runs its suite.

## 15. Later, when someone needs it

- **More distro families**, one adapter at a time: Red Hat family (`dnf updateinfo --security`, `needs-restarting -r`),
  SUSE (`zypper list-patches --category security`, `zypper needs-rebooting`), Fedora and CentOS Stream (weekly-only,
  since neither classifies), Alpine (its own security database matched in module code, OpenRC rather than systemd), Arch
  (`arch-audit`).
- **A typed "restart a named service"**, with the unit name on the record.
- **Arbitrary commands**, only if the typed set proves too narrow — with the exact-text record, bound to one machine and
  re-derived at revalidate.
- **Security Watch handing its server findings to this inventory**, which needs Security Watch to know about it first.
- **`src_servers` next to Security Watch's own source**, if a reader wants them joined; the module's own source is the
  right place until then.

## 16. Codex review

Run 2026-11-27, three passes, on this document. It started as **not build-ready** and ended **buildable**.

**Blockers it found, and what changed:**

- **First connection trusted the host key blindly.** True, and the earlier text implied otherwise. §4 now states
  trust-on-first-use plainly, adds an optional `expected_fingerprint` per machine that must match when set, keeps the
  "changed key stops everything until the owner resets it" rule, and reports the fingerprint used in every run. The
  default stays "no step for the owner", which is the owner's own instruction; the risk is now written down instead of
  being hidden behind "pinned".
- **A Tier 1 patch would put a model in every scheduled run.** Correct, and it would have stalled a nightly patch behind
  a reviewer. §6 now files patch and reboot at Tier 0, keeps the Tier 2 raise for an "ask me first" reboot, and says why
  the safety comes from the typed kind and §11 rather than from a reviewer.
- **The module could not refuse clearing a key in use.** Verified in the code: `saveKey` calls the module's check only
  when an entry is written (`if (entry) await check(...)`), so a clear never reached it. §7 now names that gap and the
  change that closes it, instead of assuming the hook already covered it.
- **`security` and `full` could not both work.** `apt-get upgrade` takes everything, so "security only" was
  unimplementable. §11 now installs an exact `name=version` list with `--only-upgrade`, simulates it first and refuses if
  the simulation shows any package outside the list, and the record's hash covers that whole list.
- **A check filed a record for a read.** §6 now makes `server_manager_check` a `named` read tool with no record, and §9
  matches it: "check now" reads, the two patch buttons file records.
- **The settings shape did not match `keys_from`.** §9 now declares `servers_machines` as the list itself (`entry: name`),
  and spells out that `name` identifies the machine while `key` is only the vault lookup.

**Verified against the product, not assumed:** the `saveKey` clear gap, the 300-character cap in `module-secrets.ts` and
`secretFits`, the `text | password | totp` field kinds and the panel component that renders them, `requireDocs`
refusing an official module's undocumented setting, and the `read | write | destructive | named` tool tags.

**Found later, on this spec's own pull request (2026-11-27), and fixed in a follow-up:** the panel's field had to be
named `private_key`, the name the service reads, not `key`; security classification had to read the candidate's suite
rather than apt's `Origin:`, which is `Debian` or `Ubuntu` and never ends `-security`, so nothing would ever have
counted as a security update; and §9's `address` pattern had four backslashes where it needs two, so it did not
compile.
A second pass, on that follow-up's own review, found three more: the field declaration carried no `maxLength`, so the
`key` kind would have fallen back to 300 characters and refused a real key; the board's page-secret route caps every
value at 300 and trims every field but a `password`, so it would have refused the key and stripped its trailing newline
before the kernel saw either; and one sentence in §7 still gave a false reason (a request cap of 1000) for raising the
kernel's limit, when the cap is 4000 with a key set. And a third pass, mine, found that the page could not list the
patch and reboot tools at all: a view cannot call a tool a write kind routes, so those kinds declare no routed tools
and the service files its own records.

**Left to the build, not to the review:** the page's icon and order, the exact wording of a failed run's report, and
whether `expected_fingerprint` should ever default to anything but empty. All three are in §17.

**A build-blocker pass against `main` (2026-11-27), and what changed:** the `validate` hook's `post` must name the
`services.run` key (`ssh`), not the compose name `server-manager-ssh`, because compile refuses any other host while the
kernel resolves both to the same container (§3); the connection needs `tool_timeout_sec: 1800`, because the kernel's
proxy otherwise cuts a tool call at 300 s, below the install's 1500 s bound (§3, §4); `links: [sources]` and the
status writer's `warehouse_src_servers_password` login are platform touches — a closed `LEGACY_LINKS` list plus two ops
files — rather than something a module can declare alone (§3); each `warehouse.sources` entry needs `time` on every view,
so the old example would not have validated (§8); and the agent's grants must carry the five tools a heartbeat requires
(`task_list`, `task_comments`, `task_approvals`, `task_comment`, `task_finish`), or compile refuses the heartbeat (§3).
`servers_machines` now declares its own `pattern`, so compile checks a machine name on every path, a hand edit of the
instance file included, which the `validate:` hook alone could not.

## 17. What is still open

- The page's icon and order: `shield`, 40, is a placeholder that reads well beside Security; the UI review settles it.
- The exact report layout for a failed run. This spec fixes what a report must contain (machine, what was attempted,
  what the host actually did, what was not done and why, the fingerprint used); the wording is the agent's, and the
  onboarding examples settle it.
- Whether `expected_fingerprint` should ever default to something other than empty. Empty is the owner's decision
  (no step for him); this spec would rather the field exist and be empty than not exist.
