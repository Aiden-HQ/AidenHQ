# Sessions on the board

Long-lived coding harnesses (opencode) on the always-on computer, each held by one task. The board lists them, starts them and
opens their terminal. The module is [modules/sessions](../../modules/sessions/README.md), the harness
[modules/engine-opencode](../../modules/engine-opencode/README.md).

## How a session runs

A session is one task held by the `session` agent (profile `session`), run as one long-lived kernel job in the standing session
box: one container shared by every session, each with its own folder and lease.

- **Identity and spend.** The credential is the job's `ahqj_` token (valid a year); spend is keyed by the task, and the creator
  account is recorded on it.
- **Long-lived.** A session job has no hard deadline, and dispatch does not stop it for lack of progress. Ending a session stops
  its process group in the box (`/job/release`); the box is never restarted for it.
- **Writes run at once.** The `session` role on the job's frozen authority makes its writes Tier 0 (`kernel/src/tier.ts`);
  code's hard refusals, the owner's veto and `autonomy: off` still apply (`tier.ts` checks autonomy before the session role,
  so with autonomy off a session's writes wait for the owner like anyone else's), and every write is a kernel record. A
  session's merge files the `github.merge` record, the one merge path.
- **Wakes.** Waiting is a kernel wake (a comment, a timed wait, a watched event), never a loop in the harness; an idle session
  uses no tokens.
- **Harness.** `engine-opencode` drives `opencode serve` over its HTTP API, with the TUI in tmux behind ttyd and opencode's own
  web UI for phones. Aiden has no session tools: a session is a task, so it delegates and comments like for any agent.

## Pages

- `#/tasks/sessions`: Active and Ended lists. A row has the state (Working, Waiting, Starting, Stopped, Failed), the title with its
  task id and repository, what it is doing (its own column from 1400px wide), who started it, spend and age. "Show more" pages through ended
  sessions. A fresh install shows what a session is and one button, "Start a session".
- `#/tasks/sessions/<identifier>`: the console (a real terminal through ttyd, or the harness's web view; a phone opens on the web
  view) beside the facts and the task thread, which also takes a message that wakes the
  session. On a narrow screen the parts are a switch: Session, Thread, Details.
- Start: name, first instruction, optional repository. It uses the board's ordinary task path (`api.create` then
  `api.addAgent` with the Session agent, whose Paperclip id `/api/sessions` returns). The agent's part of the task is the
  session, so Start opens that one, and the signed-in account is its creator.

## States

| State | What shows |
| --- | --- |
| loading | row skeletons |
| first install | the empty state above |
| starting | "Starting" with a pulsing dot; the console says the computer is preparing its folder |
| working | green dot; the terminal is live |
| waiting | blue dot; "Asleep, using no tokens" and its last words; the terminal is live |
| stopped / failed | the console shrinks to a note; failed also gets a banner with the cause; the thread stays readable |
| someone else's | the console says who started it; the thread is readable |
| terminal unreachable | the pane probes the proxy every 4s (it can't see the sandboxed frame's own socket): "Retrying" (one or two misses), then "Offline" with Reconnect; the frame reloads itself when the link returns |

The console stays dark in both themes (`--term-*` tokens). Everything else is the board's kit.

## Access

Opening is two steps. `POST /api/sessions/<task>/open` (board sign-in) passes `mayOpen`: the account that created the task, or
for an agent-made task the creator of its nearest person-made ancestor (the board's `authored` record; a failed Paperclip read
is a 502, never "someone else's"). It returns paths `/sessions/<task>/<token>/term/` and `/web/`, where the token is an HMAC
of the task and an expiry (10 minutes; the console re-mints on every reload, and a probe that gets a 401 reloads the frame).

`/sessions/<task>/<token>/…` (HTTP and WebSocket) is authorised by that token alone, never by the board cookie. Harness content
(ttyd's page, opencode's web UI, anything a process in the box serves) must not run with the board's origin: responses carry
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-downloads` (an opaque origin, even when the page
is opened on its own for the phone), the board frames them in an iframe with the same `sandbox` and never `allow-same-origin`,
only an allowlist of upstream headers is kept (no cookies, no Clear-Site-Data, no CSP; a redirect stays under the proxy path), and the requests' `Origin: null` is allowed because the token is the credential. The
board adds its key (`computer_session_key`) for the launcher, which adds the box-side credentials
(`services/computer/session-proxy.ts`). Neither credential reaches the browser.

The phone link is the page's own address (`#/tasks/sessions/<identifier>`), so a phone signs in first and then lands on the session.

The kernel side is `GET /v1/work?sessions=1` and `?session=<task>` (`kernel/src/work.ts sessions()`, board key): a session is
the newest job of a task whose agent's grants have profile `session`; running is "the gateway billed a call in the last two
minutes", waiting is alive and idle.

## Development

`node web/dev/mock-api.ts` serves the page with `?sessions=full|fresh|off|error` and a fake terminal and web view
(`?term=up|down|flaky`). Terminal and web view are not proxied with a matching Origin under `bun run dev:web`, so only
their first GET works there. Screenshots at 1512, 1920, 2560, 1024, 768 and 375, light and dark, are in `sessions/`.

## Follow-ups

- Watches ("Asleep until PR #412 merges"): the sessions service keeps them in its own database, which the kernel can't read, so the
  page shows the agent's last words instead. A feed of armed watches (facts or a kernel read) would bring the line back.

## Code mode: tools as files

A session's connections are not an MCP tool list. An engine that declares `tools: code` (engine-opencode; compile requires
`state: task` with it and that every engine a session agent can select declares it) gets one file per granted tool, and the agent
greps them and calls them from a script. Every call still reaches the kernel tool proxy with the job token, so grants, fencing,
tiers and write records apply unchanged.

- **Generation** (`kernel/src/codemode.ts`, at launch). The kernel lists each granted connection through its own proxy route as
  the job (same handler, grant filter and setup cache), under one 20 s deadline with bounded concurrency and limits on pages,
  tools, schema depth and bytes. It stages the tree privately and publishes it to the job's engine home, visible in the box at
  `/engine-state/<task>/aidenhq-tools/` (not `tools/`, which opencode loads as native tools). The snapshot is rebuilt at every
  launch; between launches a removed tool gets the proxy's refusal, a changed schema the module's argument error, and a new tool
  appears at the next launch.
- **Layout.** `README.md` is the index (the agent's instructions name it beside `AGENTS.md`): how to call, one runnable `node`
  example and each connection with its tool count and state (available, incomplete, unavailable). Per tool,
  `<connection>/<tool>.ts` is a typed wrapper of fixed text (an SDK import and one `call`) and `<tool>.json` holds the wire names,
  description and input schema, so upstream text never enters executable code or the startup instructions. Names map to
  collision-safe paths (`[a-z0-9_-]`, a hash suffix on a change or clash). A connection that missed the deadline gets
  `UNAVAILABLE.md` and a `codemode.unavailable` log, and is retried at the next launch; a generator error fails the launch
  (`codemode-failed`).
- **Client** (`kernel/sdk/src/tools-client.ts`, copied into the engineer image as `/opt/aidenhq/lib/tools.ts` by
  `scripts/sync-shared.ts`; the `aidenhq` CLI's `task`, `tasks` and `advise` use it too). It posts to
  `$AIDENHQ_GATEWAY_URL/c/<connection>/mcp` with `X-Agent-Key: $AIDENHQ_RUN_TOKEN`, reads JSON or SSE, and resolves to
  `{ text, images }` (images saved under `/tmp`). A call is sent once and never replayed: a timeout can mean the write happened.
  The timeout is the connection's `tool_timeout_s + 30`.
- **Errors** throw `ToolError { connection, tool, code, message }` for a refusal (`tool-unlisted`, `no-grant`, `method-refused`),
  a tool error or a transport failure. A write the proxy marks pending (`x-aidenhq-pending: <record id>`) throws `ToolPending`
  when it waits on a decision; a Tier 0 write still running is waited on (`GET /v1/writes/<id>`, up to 10 minutes, its outcome
  fenced like a live answer).
- **Untrusted text** is fenced at the proxy as before and handed back as it came; the README asks the agent to keep the fence.
- **Reply and logs.** A turn's last words are posted on the task unless the job already commented on it in that turn: the check
  reads the `task.commented` fact (carrying the job id) in the turn's interval (`kernel/src/jobs.ts`). Proxy logs carry the job id.
- **New installs.** The default bundle has sessions and engine-opencode, so a first session gets code mode with no setting: its
  folder holds `paperclip_tasks`, `sessions`, each granted optional connection whose module is installed, and, for a signed-out
  vendor connection, wrappers for its last-seen tool names whose calls say how to reconnect. Nothing is generated until a session starts.
