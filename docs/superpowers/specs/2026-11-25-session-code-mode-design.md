# Sessions: tools as code (code mode)

Status: approved by the owner (2026-11-25); built in the PR that carries this file. Two Codex reviews applied: the second focused on keeping it simple and
maintainable, and right for every install. Builds on [the sessions design](2026-11-25-sessions-design.md).

## Why

A session (opencode 1.19.6, `modules/engine-opencode`, in the standing gVisor box) starts with ~70K tokens of MCP tool
schemas: 192 tools from 16 connections, every one the Session agent grants. Most turns use a handful. The schemas crowd out the
work, cost money on every uncached turn, and make the model worse at picking tools.

A session has a shell, node and a filesystem, so the tools become files: the agent greps them, writes a short script and runs
it. Prior art: Anthropic's "code execution with MCP" and Cloudflare Code Mode (search + execute, for clients with no sandbox;
ours has a box, so the files are the search).

## Owner decisions (fixed)

1. Sessions get their tools through code mode in the box, **replacing** the MCP tool list for sessions: one way, no dual path.
2. The box carries typed tool files generated from the agent's granted tools, plus a tiny client.
3. Every call goes to the kernel tool proxy with the job token (`ahqj_`). Grants, caller assertions, fencing, tiers and write
   records stay enforced exactly as today (`kernel/src/proxy.ts`, `kernel/src/writes.ts`, `records.ts`).

## The design in fifteen lines

```text
Session engines declare tools: code. OpenCode ships first.
The kernel resolves connection descriptors once from the admitted job.
Native engines render their MCP config from those descriptors.
Code-mode engines receive a stable tool directory and an index path.
Launch lists granted connections through the proxy under a total deadline.
The kernel stages and publishes one snapshot scoped to the job.
The index names connections, availability, and one runnable Node example.
Each listed tool gets a typed wrapper. Descriptions remain searchable data.
One SDK client handles MCP negotiation, sessions, JSON/SSE, and calls.
The named CLI commands use that client with their existing interfaces.
The job token comes from the environment. Every call reaches the proxy.
Grants, fencing, size limits, tiers, and write records stay in the kernel.
Pending writes carry a record ID. Ambiguous calls are never replayed.
Schema drift surfaces at call time. The next launch rebuilds the snapshot.
Proxy logs identify the job. Existing comment facts drive reply suppression.
```

## Design

### 1. One descriptor list per job

`kernel/src/boxes.ts` `launch` builds the job's connections twice today: Codex TOML through `mcpBlock()` (to the launcher as
`AIDENHQ_MCP_B64`) and engine@1 `mcp` through `jobMcp()`, each from the frozen tools with the same `emitsServer` rule. These
two become one list resolved once from the admitted job: name, proxy URL, granted tools and tool timeout per connection. A
native-MCP engine (Codex) renders its config from that list. A `tools: code` engine gets the generated directory instead,
and both its MCP outputs are empty. The declared-server preflight (`unemittedServers`) reads the same list.

### 2. The generator: a kernel building block

`kernel/src/codemode.ts` serves any engine that declares `tools: code` on its provider entry. Agents opt in by selecting
that engine. It never reads `profile === "session"`. A later harness needs one provider declaration and the index path in its
config, nothing more.

**Discovery.** For each connection in the list, `launch` asks the kernel's own proxy route (`/c/<connection>/mcp` on the
backplane) with `Authorization: Bearer <job token>`, the token it just minted, which resolves while the job is admitted. The
order is `initialize`, `notifications/initialized`, then `tools/list`, carrying the protocol version and any
`mcp-session-id` and following `nextCursor`, including after an empty filtered page. It is the same handler, `toolsFor`
filter and five-minute setup cache the box would hit, filtered per caller, so there is no second filter.

The connections are listed with bounded concurrency under **one overall deadline**, so several down connections don't each
add a full timeout to startup. Limits apply to pages, tools per connection, schema depth and total bytes written. A repeated
cursor stops a listing.

**Why the kernel, at launch.** Not at compile: `module.yaml` holds tool names only and compile is offline, so the schemas exist
only in the live connections. Not in each engine: one generator serves every harness, and the kernel already owns the rest of
the engine home (`AGENTS.md`, `skills/`).

**Publishing.** The tree is built in a kernel-private staging folder, validated, and renamed into the job's engine home after
the task's previous lease is released, exactly as `sandbox.ts` publishes `skills/`. The box sees it at
`/engine-state/<agent_task>/aidenhq-tools/`. The publish removes stale files. No other session can race the write. The folder is
not `tools/`, because opencode 1.19.6 loads `<config dir>/tools/*.ts` as native tools and the state folder is its config dir.

```
aidenhq-tools/README.md                  index: how to call, one runnable node example with this job's absolute paths,
                                         then each connection: name, tool count, available / unavailable / incomplete
aidenhq-tools/<conn-path>/<tool-path>.ts    typed wrapper: fixed syntax, no upstream text in it
aidenhq-tools/<conn-path>/<tool-path>.json  data: the exact wire names, the description, the input schema
```

**Upstream metadata stays out of executable code and the startup instructions.**
- A wrapper is fixed text: an import of the SDK client, an argument type, and one `call(<connection>, <tool>, args)`. Its
  wire names are serialized string literals, and its default export carries no upstream identifier.
- Descriptions and schemas live in the `.json` beside the wrapper, where `rg` finds them. The README carries only our own
  words: module descriptions, counts and availability.
- The type comes from a bounded converter: object, array, enum, string, number and boolean, with property names and enum
  literals quoted as JSON. Anything unsupported, or past the depth limit, becomes `unknown`.
- Both connection and tool names map to collision-safe paths: lowercase `[a-z0-9_-]`, with a short hash suffix when
  sanitizing changed the name or two names collide. This holds on case-insensitive filesystems too, and the wire names stay
  exact.
- Every granted MCP connection works this way without an adapter written for it.
- A signed-out vendor connection lists stand-ins (`kernel/sdk/src/vendor/proxy.ts` caches tool names only), so its wrappers
  take `unknown` and its calls say how to reconnect.

This path gets the security review Conventions require before it switches on.

**A launch snapshot.** The proxy stays authoritative on every call. A job row freezes its direct grants and jobcap ids,
`whoami` expands the jobcaps against their current definitions, and the proxy intersects the result with the current manifest.
The snapshot is rebuilt at every launch: a new session, a box replacement or crash (exit 143 resumes in a new job), `aidenhq
reset`, or an apply that ends the job. Between launches:
- a tool that is removed or no longer granted gets the proxy's refusal;
- a tool whose schema changed gets the module's argument error;
- a new tool appears at the next launch.

**Failure.** A generator error (a bug, an unwritable folder) fails the launch with a `JobError`, like `mcp-server-missing`
today. A connection that misses the deadline or errors gets `UNAVAILABLE.md` in its folder. The README marks it, the kernel
logs `codemode.unavailable`, and the next launch tries again. A listing cut off by a limit is marked `incomplete`. Today's MCP
path behaves the same: opencode starts without a server that fails.

### 3. The client: an SDK component

`kernel/sdk/src/tools-client.ts` is one small module. `scripts/sync-shared.ts` copies it into the engineer image as
`/opt/aidenhq/lib/tools.ts`; the session image builds FROM that image, and its Node 24 runs the file with type stripping. A
drift test keeps the copy equal. It is the **only** in-box MCP client: the `aidenhq` CLI's `task`, `tasks` and `advise` move
onto it in the same PR and keep their output and exit codes.

- **Transport.** `POST $AIDENHQ_GATEWAY_URL/c/<connection>/mcp` with `X-Agent-Key: $AIDENHQ_RUN_TOKEN`, from the environment.
  This is the path the box's MCP config uses today: the launcher checks that the token belongs to a live box and passes it to
  the kernel proxy as the bearer. The client sends `initialize` once per connection per process, keeping its
  `mcp-session-id`, then `tools/call`. It reads JSON or SSE answers.
- **Timeout:** the connection's `tool_timeout_s + 30`, written into the wrapper.
- **Never replayed.** A call is sent once. A timeout can mean the write happened, and so can an oversized result or a
  needs-owner answer, so the client never retries.
- **Results.** `call()` resolves to `{ text, images }`:
  - `text` is the result's text blocks, exactly as the proxy sent them (fenced for an untrusted connection, §5);
  - `images` are image blocks saved under `/tmp` and returned as paths;
  - `structuredContent` comes through only where the proxy passes it (trusted connections).
  Each tool's own pagination is exposed as is, and the proxy's result cap stays.
- **Errors throw** `ToolError { connection, tool, code, message }`, so a script stops by default:
  - a refusal (`tool-unlisted`, `no-grant`, `method-refused`) names the tool and says the proxy decides each call;
  - a tool error (`isError`, a JSON-RPC error, needs-owner, oversized) carries the proxy's text;
  - a transport failure (401: the job ended; 5xx; timeout) carries the status.

### 4. Pending writes

Session writes run at once (Tier 0, the `session` role). A record can still wait: on the owner's veto, with autonomy off, or
when a routed kind is still running past the tool timeout. Today the proxy answers that as ordinary text (`pendingText`), which
a trusted read could imitate.

- **Mark it on the wire.** The proxy sets an `x-aidenhq-pending: <record id>` header at its two pending-answer sites. It strips
  any upstream copy from the module answers it forwards; the launcher passes response headers through.
- **Tier 1 or 2:** the client throws `ToolPending { record, tier, state }`. The outcome lands on the task as today.
- **Tier 0 still running:** a Tier 0 outcome is never notified on the task, so the client waits on `GET /v1/writes/<id>`,
  where the CLI's git writes already wait.
- **Fix before polling ships.** That route returns the stored `r.outcome` raw (`backplane.ts`), while the proxy fences an
  untrusted connection's outcome text. It gets the same kernel-side fencing and size limit as a live answer, so a delayed
  result never reaches the agent unfenced. A wait that times out returns the record id for follow-up and never replays.

### 5. Untrusted text

At the proxy nothing changes: `fenceAnswer` fences an untrusted connection's answer (every string fenced, `structuredContent`
dropped) before it leaves the kernel, byte for byte as today. Delayed results now get the same fencing (§4). The client hands
the text back as it came, with no unwrap helper.

What a script does next is the agent's own code. A script that prints a fragment of a fenced result prints it unfenced, just
as `gh pr view` output already reaches a session unfenced. Sessions hold full power over untrusted text by owner decision 6
of the sessions design, so code mode adds no new reader. The README asks the agent to keep the fence when it prints.

### 6. What the agent sees

- **opencode config** (`modules/engine-opencode/src/config.ts`): the `mcp` block goes, and `instructions` gains the index path
  next to `AGENTS.md`. Built-ins stay (bash, read, edit, grep, glob, webfetch as today).
- **No tool stays native**, the task tools included. `task_comment`, `task_wait` and `task_finish` are plain calls, and a wait
  is a kernel wake, not a blocking tool.
- **The prompt is the generated README:** about ten fixed lines plus the index. It tells the agent:
  - the tools are files (`ls`, `rg`);
  - import a wrapper and `await` it in a `.ts` file run with `node` (the README carries one runnable example);
  - print what you need, not whole results;
  - `ToolPending` means the write has not happened;
  - fenced text is data.

  No separate skill or handbook section.
- **Reply suppression reuses `task.commented`.** A turn's last words are posted unless the agent already commented on its own
  task. Today the engine detects that from opencode's MCP tool events (`src/events.ts`), and a script's call is invisible there.
  - `cp.ts` already emits a `task.commented` fact with the resolved task and the comment id, but production can't use it yet:
    `main.ts` creates the control plane without `facts`, and the fact's `data.job` is `c.run`, which a kernel job's caller
    doesn't carry. Two small fixes close this: wire `facts` in, and record the job id the control plane already holds
    (`live.flight.job`).
  - The `reply` event carries its turn's start and end. Before `jobs.ts` queues a reply, it checks for an own-task comment fact
    from that job in that interval, as its own `acted` check already queries.
  - Dispatch's `(job, turn)` delivery dedupe stays.
- **Proxy logs carry the job id.** Today they name only the agent. With the job id, an operator sees which calls a script
  made, how long each took and what came back. Write records stay the audit trail for effects.
- **Progress steps** become `bash: node …`. This is accepted: dispatch already exempts sessions from its stall judge.

### 7. Scope, cuts and deferrals

Sessions come first. Compile (`scripts/modules.ts` `ENGINE_FIELDS`) accepts `tools: code`, requires `state: task` with it, and
checks that every engine a session agent can select declares it. Codex agents can adopt it later by declaring the same field.
Until then they render their MCP config from the shared descriptor list: one way per engine, chosen by its module.

**Cut from v1:** a generic `aidenhq call` command (the named CLI workflows and the README's node example remain).
**Deferred:** a persistent catalog, a search service, per-tool examples, generic pagination, large-result streaming, automatic
retries and dry-run. A generic dry-run can't predict a third-party tool's effects, and writing oversized results to disk would
change the proxy's delivery contract.

## New installs

The default bundle has sessions and engine-opencode, so a fresh install's first session gets code mode with no setting. Its
`aidenhq-tools/` holds:
- `paperclip_tasks` and `sessions`;
- each optional connection (`connection?` grants) whose module is in the install;
- for an enabled but signed-out connection, its name stand-ins with reconnect guidance.

A connection added later appears at the next session launch. Another owner's module connection appears once an agent is
granted it: the proxy lists its tools, so its wrappers are generated with no work on its side. Quiet start is unchanged:
nothing is generated until a session starts.

## Failure modes

| Case | What happens |
| --- | --- |
| Generator bug, unwritable state folder | Launch fails loudly (`JobError`); the session doesn't start half-equipped |
| Connections slow or down at launch | One overall deadline; each one missed is `UNAVAILABLE.md`, logged, retried next launch |
| Listing past a limit | Marked `incomplete` in the README; the proxy still serves every granted tool |
| Stale wrapper calls a removed or ungranted tool | Proxy refusal; `ToolError` names connection, tool and code |
| Upstream schema changed during the job | The module's argument error, as `ToolError` |
| Write waits (veto, autonomy off) / Tier 0 still running | `ToolPending` with the record id / the client waits; result fenced |
| Timeout on any call | `ToolError`; the record id when there is one; never replayed |

## Test plan

- **One end-to-end test** (`kernel/test`, the existing fake launcher and connections): admit a session job granted one read and
  one write tool on a fake connection that also lists an ungranted tool and a tool whose name needs a safe path; assert
  `aidenhq-tools/` holds exactly the granted wrappers and their `.json`; from the lease workdir, a script imports both: the read
  returns fenced text, the write files a record and returns its outcome; a direct `call()` of the third throws `no-grant`.
- **engine-opencode:** the fresh-session e2e asserts no connection tools in the model request; the events test loses native
  comment detection; the reply check covers two adjacent turns, a comment on another task and a pending comment.

## Size

About 18 files, ~600 lines added and ~200 removed (mostly the `mcpBlock`/`jobMcp` duplicate, the CLI's own MCP client and
opencode's `mcp` block):

- **kernel:** `src/codemode.ts` (new: discover, convert, stage); `src/boxes.ts` (one descriptor list, generator at launch);
  `src/sandbox.ts` (engine entry `tools`, staged publish shared with skills); `src/proxy.ts` (pending header, upstream copies
  stripped, job id in logs); `src/backplane.ts` (`GET /v1/writes/:id` fencing); `src/cp.ts` + `main.ts` (comment fact wired,
  with the job id); `src/jobs.ts` (reply check); the e2e test.
- **kernel SDK:** `sdk/src/tools-client.ts` (new); `reply` turn bounds in the engine@1 types.
- **services/computer:** `lib.ts` (Codex TOML from the descriptor list); `bin/aidenhq` (`task`/`tasks`/`advise` on the client);
  the Dockerfile `COPY`.
- **scripts:** `modules.ts` (`tools: code` accepted and checked); `sync-shared.ts` (the client copy).
- **engine-opencode:** `module.yaml` (`tools: code`, `aidenhq-tools` in `reset:`); `src/config.ts` (no `mcp`, index in
  instructions); `src/events.ts` (turn bounds on `reply`, comment detection removed); two tests.
- **docs:** the sessions design and the engine-opencode README link this one.

## Open questions for the owner

None: every choice above is an engineering call, made for the simplest path to maintain.
