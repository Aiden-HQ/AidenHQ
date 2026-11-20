# Connect on First Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The owner's process: lanes run in parallel subagents, then one integration test + review pass (Task 10). There are no per-task review gates.

**Goal:** when a connection that only the owner can fix is missing, the owner gets the one Connect link in their own conversation, but only if they asked for the work. Background work gets one deduped digest line. Agents see which connections are down. The task resumes by itself after Connect. Account recovery stops depending on Telegram.

**Architecture:** connections answer one structured `needs_owner` tool result, built by a shared, import-free SDK helper. The vendor proxy gives this answer to every vendor connection, and google and github call the helper by hand. The kernel's tool proxy reads that answer before fencing. A new `kernel/src/connection-state.ts` records the down state, works out whether the owner asked (by walking the task chain), and then does one of two things:
- **Owner asked:** sends one message and records the calling task as waiting.
- **Background:** queues one digest line a day.

Either way it answers the agent with fixed text. The board tells the kernel when a sign-in completes. The kernel then clears the state and opens a `connected` wake for each waiting task. The dispatcher's prompt lists the connections that are down. `ops/setup.sh --reset` prints the reset link, and the Telegram credential path is deleted.

**Tech Stack:** TypeScript on Node 24 (`.ts` specifiers), node:sqlite (kernel.db), node:test (kernel), vitest (board, modules), MCP SDK.

**Spec:** `docs/superpowers/specs/2026-11-20-connect-on-first-use-design.md`

## Global Constraints

- **Base.** Build after PR #1104 (#1065, "act on GitHub as the owner") has merged. Base the branch on `origin/main` from after that merge, in your own worktree: `git -C AidenHQ worktree add <scratchpad>/wt-<lane> -b <branch> origin/main`.
  - Never `git stash`. Never `git add -A`. Never check out a branch in the main checkout.
  - All lanes land in one PR: `feat(setup): connect on first use`.
- **Conventions.** Follow the product CLAUDE.md "Conventions": one way, delete old paths in the same PR, minimal tests (a few end-to-end ones), and a security review of new paths before they switch on.
- **Causes.** `cause` is one of `not_connected | expired | scope | sso | restricted`.
  - `unreachable` and `rate_limited` stay plain errors.
  - The kernel reads any unknown cause as `not_connected`, keeping its detail.
- **Keys.** State is keyed by the **module name**, the connection's `module` (`google`, `github`, `slack`), never by a connection key such as `google_workspace` or `github_official`. A module's `board.signins` id is that module's name. Task 7 adds a compile assertion for this.
- **Need key.** `needKey = <module>:<cause>[:<org>|:<scope>]`. It is the notify `dedupe_key` (`connect:<needKey>`) and the state row's key.
- **Partial causes.** `scope`, `sso` and `restricted` are partial: the connection works, so a later successful call never clears them, and the preamble doesn't list them.
  - Their wait lasts 24 h (`idle.wait` with `on` only), so the task retries daily.
  - Full causes (`not_connected`, `expired`) wait 7 days, until Connect wakes them.
- **Owner-fixable only.** Untrusted text stays data. The kernel uses no module text in the agent's answer.
  - `detail` is capped at 200 characters, with whitespace collapsed, and is only ever shown to the owner.
  - A module `url` is honoured only for `sso` and `restricted`, and only as an `https:` URL. It goes to the owner, never to agents.
- **Links.** Every link the kernel builds is `<board origin>/connect/<module>`. The board origin is main.ts `boardOrigins[0]` (`BOARD_LAN_URL`, else `http://localhost:3121`). The board route decides where that lands for each mode (Task 7); the kernel never builds a `#/` link.
- **Agent text.** The agent gets fixed kernel text, unfenced:
  - Owner asked: `<Label> isn't connected (<cause words>): the owner has the link. Don't retry; this task is woken when it is connected. End your turn.`
  - Background: `<Label> isn't connected (<cause words>): it is in the owner's digest. Skip this source for now and carry on.`
- **Dropped behaviours** (the owner OK'd these or the spec names them; list them in the PR body):
  - The Telegram delivery of reset links (`deliverSecrets`, `credentials: true`).
  - github-mcp's own `kernelNotify` alerts. This includes alerts raised from background loops, which never pass the kernel proxy; the board's GitHub status card still shows those.
  - The `<x>_auth_unavailable`, `google_auth_failed` and `github_auth_unavailable` codes.

## Review Focus

1. **A trusted connection's answer used to stream straight through.** Now every `tools/call` answer is buffered so it can be read. Expect identical answers, minus nothing, for `returns: trusted` connections. Task 4 test: `a trusted connection's answer passes unchanged, and its needs_owner is still routed`.
2. **A connection that is still down, called again after the wait lapsed or from a second owner task.** Expect no second owner message (the `told` flag) and a new wait. Task 3 test: `a second hit on a told need records the wait and sends nothing`.
3. **A routine run the owner created, or a delegated child of a routine.** Expect background handling, with no message. Task 3 test: `a routine's run and its delegated child are background`.
4. **The owner connects while the agent's job is still running.** Expect the wake to stay open and start the next job after this one ends; it is not dropped. Task 3 test: `ok() opens a connected wake per waiting task and clears only that module's rows`, plus a Task 6 assertion that `connected` is in `RESUME`.
5. **A module answers `needs_owner` with a hostile `detail` or `url`** (a third-party module, or upstream text). Expect the agent to see none of it, the owner to see it capped and on one line, and any url other than an https url for sso or restricted to be dropped. Task 3 test: `a need's detail and url are constrained`.

---

## Lanes and dependencies

| Lane | Task | Depends on |
|---|---|---|
| A | 1. `needs_owner` contract + vendor proxy | none |
| A | 2. google-workspace-mcp + github-mcp on the helper | 1 (`needsOwner`) |
| B | 3. `connection-state.ts` | 1 (`Need`, `readNeed`); its Notice field comes from 5 |
| B | 4. Proxy hook, kernel routes, wiring, e2e tests | 3 |
| C | 5. owner-channel digest for kernel items (`batch`) | none |
| D | 6. Dispatch preamble + `connected` resume | the route shape in 4 (interface only) |
| E | 7. Board `/connect/<module>` + `/ok` on sign-in completion | the route shape in 4 (interface only) |
| F | 8. Recovery without Telegram | none |
| G | 9. Docs and skill clean-ups | none |
| — | 10. Integration | all |

Lanes A, C, D, E, F and G start at once. Task 1 is small, so lane B starts as soon as Task 1's `needs.ts` is committed.

---

### Task 1: The `needs_owner` contract and the vendor proxy

**Files:**
- Create: `kernel/sdk/src/vendor/needs.ts`. It is import-free and copied byte-identically beside each `proxy.ts`. *Call:* the spec says `kernel/sdk/src/needs.ts`, but the shared proxy imports its siblings relatively (`./oauth.js`), so the helper lives next to it.
- Modify: `kernel/sdk/src/vendor/proxy.ts`. These are the refusals in `buildServer`'s `CallToolRequestSchema` handler: the `!o.upstream || !auth.signedIn()` branch, and the sign-in branch of its catch.
- Modify: `scripts/sync-shared.ts`:
  - Add `needs.ts` to the vendor list (`["proxy.ts", "oauth.ts", "needs.ts"]`).
  - Add one extra copy to `modules/google/connections/google-workspace-mcp/src/aidenhq-sdk/needs.ts`.
- Modify: `.github/ci/areas.json` (the kernel/sdk path, if `scripts/test/ci-areas.test.ts` asks for it).
- Test: `kernel/test/needs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const OWNER_CAUSES = ["not_connected", "expired", "scope", "sso", "restricted"] as const;
  export type Cause = (typeof OWNER_CAUSES)[number];
  export type Need = { cause: Cause; detail: string; scope?: string; org?: string; url?: string };
  /** The tool result a connection answers when only the owner can fix it. */
  export function needsOwner(need: Need): { isError: true; content: [{ type: "text"; text: string }]; structuredContent: { error: "needs_owner"; need: Need } };
  /** The need in a tools/call result, if it is one; an unknown cause reads as not_connected. */
  export function readNeed(result: unknown): Need | undefined;
  ```
  `content[0].text` is `detail`, so an MCP client that drops structuredContent still reads a sentence.

- [ ] **Step 1: Write the failing tests** in `kernel/test/needs.test.ts`:
  - `needsOwner and readNeed round-trip`: `readNeed(needsOwner({cause:"scope", scope:"repo", detail:"x"}))` deep-equals the need. `readNeed({content:[]})` is `undefined`. `readNeed({isError:true, structuredContent:{error:"needs_owner", need:{cause:"weird", detail:"d"}}})?.cause === "not_connected"`.
  - `the vendor proxy answers needs_owner when not signed in`: start `createVendorProxy` with no upstream, then `tools/call`. `readNeed(result)?.cause === "not_connected"`. Use the existing vendor-proxy test harness if one exists (`grep -rln createVendorProxy kernel/test modules/*/connections/*/test`).
  - With `auth.status().state === "expired"` it answers `expired`.
  - An upstream error that is not about sign-in stays a plain `isError` with no `structuredContent`.
- [ ] **Step 2:** Run `cd kernel && node --test test/needs.test.ts`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement** `needs.ts` and the proxy change.
  - In the proxy, `notConnected()` stays as the `detail` text.
  - The cause is `expired` when `auth.status().state === "expired"`, else `not_connected`. An `AuthError` alone isn't "expired".
  - The tool-list stand-ins (`standIns()`) keep their description.
- [ ] **Step 4:** Run `node scripts/sync-shared.ts`, then `cd kernel && node --test test/needs.test.ts`, then `cd scripts && npm test`. Expected: PASS, with no shared-copy drift.
- [ ] **Step 5: Commit** `feat(sdk): the needs_owner answer, from the shared vendor proxy`, adding only the files above and the synced copies, by path.

### Task 2: google-workspace-mcp and github-mcp answer with the helper

**Files:**
- Modify: `modules/google/connections/google-workspace-mcp/src/main.ts`: the `run` wrapper (`google_auth_unavailable`, and `google_auth_failed` for a `GoogleAuthError`).
- Modify: `modules/github/connections/github-mcp/src/main.ts`: the `GitHubNeed` catch, the `createAccess({ auth, notify: kernelNotify(...) })` wiring and the `kernelUrl`/`codehostKey` constants that only notify uses. Also the `github_auth_unavailable` code from the `GitHubAuthError` catch.
- Modify: `modules/github/connections/github-mcp/src/client.ts`. Delete `kernelNotify` and `needKey`, the `notify` option, the `told` set and its use in `fail`. `background` stays only if `rate_limited` waiting still uses it. Keep `Need`, `needText`, `GitHubNeed`, and `needAnswer` for the two non-owner causes only.
- Modify: `modules/github/module.yaml`: drop `kernel.owner-notice` from `roles.requests` only if `grep -rn "v1/notify\|owner-notice" modules/github` shows nothing else uses it.
- Modify: `modules/github/connections/github-mcp/test/{client,github}.test.ts` (tests of deleted code go).
- Test: `modules/google/connections/google-workspace-mcp/test/` (the existing tool test file).

**Interfaces:**
- Consumes: `needsOwner(need: Need)` from `./aidenhq-sdk/needs.ts` (google) and `./vendor/needs.js` (github).
- GitHub mapping: `GitHubNeed.need` maps one to one. `org` and `scope` carry over. `url` carries only for `sso` and `restricted`. `detail = needText(need)`.

- [ ] **Step 1: Write the failing tests:**
  - google, `a tool with no Google account answers needs_owner not_connected`: `readNeed(result)?.cause === "not_connected"`.
  - google, `a refused refresh answers needs_owner expired`.
  - github, `an owner-fixable GitHubNeed answers needs_owner with its org and url`: `{cause:"sso", org:"acme", url:"https://github.com/orgs/acme/sso"}`.
  - github, `rate_limited stays a plain error`: no `structuredContent`.
- [ ] **Step 2:** Run `npm test` in each package. Expected: FAIL.
- [ ] **Step 3: Implement.** `grep -rn "auth_unavailable\|google_auth_failed\|kernelNotify\|needKey" modules` returns nothing afterwards (the deleted codes and the SKILL.md text are Task 9's).
- [ ] **Step 4:** Run `npm test && npm run typecheck` in both packages. Expected: PASS.
- [ ] **Step 5: Commit** `feat(google,github): answer needs_owner; delete github-mcp's own owner notice`.

### Task 3: `connection-state.ts`, the kernel's routing

**Files:**
- Create: `kernel/src/connection-state.ts`
- Modify: `kernel/src/escalate.ts`. Export `creatorTask(db, task)` (today a closure inside `createEscalate`) so there is one chain rule, and use it inside `createEscalate`.
- Test: `kernel/test/connection-state.test.ts`

**Interfaces:**
- Consumes:
  - `Need` and `readNeed` (Task 1).
  - `idle.wait(caller, {reason, on, until})` (kernel/src/idle.ts, unchanged).
  - `wakes.open({key, task, agent, cause, replaces})` (kernel/src/wakes.ts).
  - `ownerWroteAt` and `creatorTask` (escalate.ts).
  - `ownerVia` (relay.ts).
  - `Notice` with `batch?: true` (Task 5).
- Produces:
  ```ts
  export type Down = { connection: string; module: string; cause: Cause; since: string };
  export const CONNECTED_CAUSE = "connected"; // the wake cause; dispatch's RESUME words it (Task 6)
  export function createConnectionState(o: {
    db: DatabaseSync;
    idle: Pick<Idle, "wait">;
    wakes: Pick<Wakes, "open">;
    queue: (n: Notice) => void;                       // notify.queue
    issue: (id: string) => Promise<Issue | undefined>;  // the control plane, as escalate's
    comments: (id: string) => Promise<Comment[]>;       // newest first, limit 50
    agentName: (id: string) => Promise<string>;
    label: (module: string) => string;                  // "Google"; the module's display name, else the module
    connections: () => Record<string, Connection>;      // for down(): connection key -> module
    grants: () => Record<string, Grant | undefined>;
    boardUrl: () => string;
    now?: () => number; log?: Log;
  }): {
    /** A needs_owner answer for `who` on `module`: records, routes, and returns the agent's fixed text. */
    hit(who: Identity, module: string, need: Need): Promise<string>;
    /** The module connected: drops its rows, opens a `connected` wake per waiting task; returns how many it woke. */
    ok(module: string): number;
    /** Whether the module has a full-cause row (the proxy's cheap success check). */
    down(module: string): boolean;
    /** The agent's granted connections whose module has a full-cause row. */
    downFor(agent: string): Down[];
    /** Once per UTC day: one digest line per row that still has waiting tasks and wasn't reported today. */
    tick(): void;
  };
  ```
- Tables (created here, no migrations):
  - `connection_state(key TEXT PRIMARY KEY, module TEXT, cause TEXT, detail TEXT, url TEXT, since INTEGER, told INTEGER, reported_day TEXT)`
  - `connection_waits(module TEXT, task TEXT, agent TEXT, at INTEGER, PRIMARY KEY (module, task))`

What `hit` does:
1. Normalise `need`: collapse whitespace in detail and cap it at 200, and keep `url` only for sso or restricted, and only when it is `https:`. Upsert the row; `since` keeps its first value.
2. Find the root: follow `parentId ?? creatorTask(db, id)` up to 10 levels from `who.task`. A module caller or a missing task counts as background. The work is owner-asked when `ownerWroteAt(root, comments(root.id)) !== undefined`. This rule already makes a routine's own run background, because a routine's opening carries no chat marker.
3. **Owner asked:**
   - If the row isn't `told`, queue one Notice and set `told = 1` and `reported_day = today`. The Notice:
     ```ts
     { kind: "decision", text, task: root.identifier, dedupe_key: `connect:${key}`, ...via }
     ```
     `via` is `{ reply: { via, agent: agentName(root.assigneeAgentId), issue: root.id } }` when `ownerVia(root, comments)` is a channel, else `{ head: { agent, issue: root.id } }`.
   - `text` is: `<Label> needs you to <connect|reconnect|grant <scope>|authorize SSO for <org>|request access for <org>> so I can <what the task was doing: the task title, ≤80 chars>: <link>`. The link is `url` for sso and restricted, else `${boardUrl()}/connect/${module}`.
   - Then record the wait: `idle.wait({agent: who.agent, key: who.key, task: who.task}, {reason: \`waiting for the ${label} connection\`, on: \`${module} connection\`, ...(full ? { until: iso(now + 7d - 60s) } : {})})`.
   - Insert into `connection_waits`.
4. **Background:** if `reported_day !== today`, queue `{ kind: "digest", batch: true, text: "<Label> isn't connected (<cause words>): <link>", dedupe_key: \`connect:${key}\` }` and set `reported_day`.
5. Return the fixed text from Global Constraints.

What `ok(module)` does, in one transaction (`inTx`): select the waiters, delete the module's rows and waits, then for each waiter call `wakes.open({ key: \`connect:${module}:${task}:${t}\`, task, agent, cause: CONNECTED_CAUSE, replaces: \`wait:${task}:\`, author: "kernel" })`. The `replaces` prefix drops the timed wait's wake.

- [ ] **Step 1: Write the failing tests** with a fake `issue`/`comments`, an in-memory db and stub idle/wakes/queue:
  - `an owner-asked hit sends one decision with the board link and records a 7-day wait`:
    - `queue` was called once with `kind: "decision"`, `task: "WOR-1"` (the root, two levels up via `parentId`), `dedupe_key: "connect:google:not_connected"`, and text containing `http://board.example/connect/google`.
    - `idle.wait` got `until` about 7 days out.
    - The returned text starts with `Google isn't connected` and contains `the owner has the link`.
  - `a second hit on a told need records the wait and sends nothing`: `queue` was called once in total, and `idle.wait` twice.
  - `a background hit queues one batched digest line a day`: two hits on the same day queue once, with `batch: true` and `kind: "digest"`. A hit on the next day queues again. `idle.wait` is never called, and the text says `skip this source`.
  - `a routine's run and its delegated child are background`: the root has no chat marker and no owner comment. `creatorTask` resolves the child.
  - `ok() opens a connected wake per waiting task and clears only that module's rows`: `wakes.open` is called with `cause: "connected"` and `replaces: "wait:<task>:"`. Afterwards `down("google") === false` and `down("github")` is unchanged.
  - `a partial cause waits a day and is not listed down`: for `scope`, `idle.wait` gets no `until` and `downFor` excludes it.
  - `a need's detail and url are constrained`: a 5 kB multi-line detail is stored at ≤200 chars on one line. An `http:` url, or a url on a `not_connected` need, is replaced by the board link. Neither appears in the agent text.
  - `tick lists a still-waiting connection once a day`.
- [ ] **Step 2:** Run `cd kernel && node --test test/connection-state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep it to one file. Cause words: `not connected`, `sign-in expired`, `missing the <scope> permission`, `<org> needs SSO authorization`, `<org> restricts outside apps`.
- [ ] **Step 4:** Run the test again, plus `node --test test/idle.test.ts test/review-loop.test.ts` (escalate's users). Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): connection state routes a missing connection to the owner or the digest`.

### Task 4: The proxy hook, the kernel routes and the wiring

**Files:**
- Modify: `kernel/src/proxy.ts`:
  - `createProxy` takes `needs?: () => Pick<ConnectionState, "hit" | "ok" | "down"> | undefined`. It is late-bound, like `replay`, because main.ts builds the proxy before notify, wakes and idle.
  - In the forward path, `rewrite` is `status < 300 && (method === "tools/list" || method === "tools/call" || !!rec)`. Every tools/call answer is buffered; notifications still pass for trusted connections, as today.
  - Inside the `mapMessages` callback, for the answer message (`m.id === reqId`), before `fenceAnswer`: capture `need = readNeed(m.result)`, else note `success = !m.error && m.result?.isError !== true`.
  - After mapping:
    - If there is a need, reply with a single `application/json` JSON-RPC result, `{ content: [{ type: "text", text: await needs().hit(who, conn.module, need) }], isError: true }`, unfenced (it is kernel text). A `rec` still gets `done(false, …)`.
    - Else, if `success && needs()?.down(conn.module)`, call `needs().ok(conn.module)`.
- Modify: `kernel/src/backplane.ts`:
  - Add the routes `{ method: "POST", path: "/v1/connections/:module/ok", auth: "board" }` and `{ method: "GET", path: "/v1/connections/down", auth: "module" }`, plus their header comment lines.
  - The GET requires the caller's roles to include `kernel.jobs` (the dispatcher) and takes `?agent=<id>`. It returns `{ down: Down[] }`.
  - The POST returns `{ woken: number }` and is `404` for a name that is no installed module.
- Modify: `kernel/src/main.ts`:
  - Build `connectionState` after `idle` (~line 443), with `boardUrl: () => boardOrigins[0]`.
  - Pass `needs: () => connectionState` to `createProxy`, using a `let` the way `replay` is done.
  - Run `every(() => connectionState.tick(), 10 * 60_000)`.
- Test: `kernel/test/connect-first-use.test.ts` (the two end-to-end tests the spec asks for, on `kernel()` and `moduleServer()` from `test/helpers.ts`).

**Interfaces:**
- Consumes: `createConnectionState` (Task 3) and `readNeed` (Task 1).
- Produces (for Tasks 6 and 7):
  - `POST /v1/connections/<module>/ok` with the board's key, which returns `{woken}`.
  - `GET /v1/connections/down?agent=<id>` with a module token holding role `kernel.jobs`, which returns `{down: [{connection, module, cause, since}]}`.

- [ ] **Step 1: Write the failing end-to-end tests:**
  - `owner-asked: Gmail missing → one message → connect → the task resumes`:
    - The fake control plane has the root WOR-1 with an owner comment, and the job's task WOR-2 as its child.
    - The `google` module server answers `needsOwner({cause:"not_connected", detail:"no account"})`.
    - Call `gmail_search` as the run on WOR-2. The answer text contains `the owner has the link`, and contains neither `<untrusted` nor `no account`.
    - `GET /v1/notify/take` (role kernel.notify) yields exactly one `decision` for `WOR-1`.
    - A second call yields no new message.
    - The task state of WOR-2 reads `waiting` / `agent_wait`.
    - `POST /v1/connections/google/ok` with the board key answers `{woken:1}`. The wake inbox holds an open `connect:google:…` row with cause `connected`, and no open `wait:` row.
  - `background: a routine run hits a missing connection → one batched digest line, no wait`: one taken message with `kind: "digest"` and `batch: true`, and the task state isn't `agent_wait`.
  - `a trusted connection's answer passes unchanged, and its needs_owner is still routed`.
  - `a successful call clears a full-cause state`: after a needs hit and then a success, `GET /v1/connections/down?agent=` is empty.
- [ ] **Step 2:** Run `cd kernel && node --test test/connect-first-use.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4:** Run `cd kernel && npm test && npm run typecheck`. Expected: PASS. `proxy.test.ts` passes unchanged.
- [ ] **Step 5: Commit** `feat(kernel): the tool proxy routes needs_owner; connection ok and down routes`.

### Task 5: owner-channel batches the kernel's digest items

**Files:**
- Modify: `kernel/src/notify.ts`: add `batch?: true` to `Notice` and its doc. It is set only by kernel code, never by `notice()` from a producer's body.
- Modify: `modules/owner-channel/connections/notify/src/main.ts`, in `take()`:
  - A taken message with `batch === true` goes to `queueDigest(store, { agent: "AidenHQ", text })` when `d.attention.digestHours.length`, and is then acknowledged.
  - With no digest hours, it goes through `notify()` as `kind: "fyi"`.
  - Its `dedupe_key` is honoured through the store, like `notify()`'s `dedupe:` keys.
- Modify: `modules/owner-channel/connections/notify/src/kernel.ts` (the taken message's type).
- Test: `modules/owner-channel/connections/notify/test/notify.test.ts`, or the test file that already covers `take`.

**Interfaces:** Produces `Notice.batch?: true` (consumed by Task 3).

- [ ] **Step 1: Write the failing test** `a kernel batch item joins the digest and is sent at the next slot, not at once`. Assertions: no `send` call at take; `flushDigest` at the next slot sends one message containing the line; the same `dedupe_key` taken twice the same day queues one line.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npm test && npm run typecheck` in the notify package, then `cd kernel && node --test test/notify.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(owner-channel): the kernel's batched lines go to the digest`.

### Task 6: The dispatch preamble and the `connected` resume

**Files:**
- Modify: `modules/dispatch/service/src/kernel.ts`: add `connectionsDown(agent: string): Promise<Down[]>`, which calls `GET /v1/connections/down?agent=`.
- Modify: `modules/dispatch/service/src/loop.ts`:
  - `RESUME.connected = "A connection this task was waiting on is now connected: retry what needed it"`.
  - Fetch `down` before `buildPrompt`. A failed read means `[]` (the preamble is a hint, never a gate).
- Modify: `modules/dispatch/service/src/prompt.ts`:
  - `PromptArgs.down?: Down[]`.
  - When it is non-empty, add a section to both the fresh and resumed prompts, before the request:
    ```
    ## Connections down
    - google_workspace: not connected since 2026-11-20 (the owner was told; skip its tools)
    ```
- Modify: `modules/dispatch/module.yaml`, only if its roles lack what `GET /v1/connections/down` checks (`kernel.jobs`; it already claims wakes).
- Test: `modules/dispatch/test/prompt.test.ts`, `modules/dispatch/test/loop.test.ts`

**Interfaces:** Consumes the `GET /v1/connections/down` shape from Task 4.

- [ ] **Step 1: Write the failing tests:**
  - prompt, `down connections are listed in fresh and resumed prompts`: both prompts contain `## Connections down` and `google_workspace: not connected since 2026-11-20`. With `down: []`, the section is absent.
  - loop, `a connected wake with no new words starts a resume run`: `words.task === "resume"`, and the job starts (not `drop`).
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dispatch): list down connections; resume on connected`.

### Task 7: The board: `/connect/<module>` and the `/ok` hook

**Files:**
- Modify: `services/board/src/app.ts`:
  1. Add `GET /connect/<module>` (`/^\/connect\/([a-z0-9-]{1,63})$/`), which needs a ready admin like the other connect paths (extend `isConnect`). It redirects with `302` to:
     - the module's sign-in `connect` path (`signIns.find(s => s.id === module)`);
     - else the module's setup flow `connect_url` (Google: `/google/connect`);
     - else `/#/setup/<module>`.
     The existing `handleSignIn` then words what can't work from this address (https-only vendors, loopback-only flows: `signInFailed`). *Call:* the per-mode wording of spec §4 lives there, not in the kernel's message.
  2. Add one helper, `connected(module: string)`, which runs `store.events.emit("connections")` and calls `kernel.connectionOk(module)`. It logs and swallows a kernel failure; the next successful tool call clears the state anyway. It replaces the bare `emit("connections")` at the sign-in completions:
     - `/google/callback` and `POST /api/google/finish` → `connected("google")`;
     - the sign-in callback in `handleSignIn` and `POST /api/sign-ins/:id/finish` → `connected(s.id)`;
     - device sign-in.
     Leave the organisations `onApplied` emit alone: it isn't a sign-in. First read app.ts around 1175–1196 and confirm that none of the emits there is a disconnect.
- Modify: `services/board/src/device-signin.ts`: `onSignedIn: (id: string) => void`.
- Modify: `services/board/src/records.ts`: add `connectionOk(module: string): Promise<void>` beside `connectionHealth`, as `POST ${k.url}/v1/connections/${module}/ok` with the board's bearer.
- Modify: `scripts/modules.ts`. A `board.signins` entry's `id` must equal its module's name: `fail("module <m>: a board.signins id is the module's name")`.
- Test: `services/board/test/` (the existing sign-in route test file), `scripts/test/modules.test.ts`

**Interfaces:** Consumes `POST /v1/connections/<module>/ok` (Task 4).

- [ ] **Step 1: Write the failing tests:**
  - `/connect/<module> sends a sign-in module to its Connect and google to /google/connect`: the `302` `location` is `/glean/connect`, then `/google/connect`, then `/#/setup/acme` for a flow-only module.
  - `a finished sign-in tells the kernel once`: after `POST /api/sign-ins/glean/finish`, the fake kernel saw `POST /v1/connections/glean/ok` once.
  - compile: `a board.signins id that isn't its module's name fails`.
- [ ] **Step 2:** Run `cd services/board && npx vitest run <file>` and `cd scripts && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `cd services/board && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run lint`, then `cd scripts && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(board): one Connect link per module; tell the kernel when a sign-in completes`.

### Task 8: Recovery without Telegram

**Files:**
- Modify: `kernel/src/accounts.ts`:
  - `reset(email)` returns `Promise<{ url: string | null }>`. It keeps `linkFor`, which builds on `adminUrl`, the admin listener's public name. The reset link is an admin-listener page, so that base is correct. A `null` url is a user in `access` mode.
  - Delete `outbox` and `takeResetLinks`.
- Modify: `kernel/src/auth-api.ts`: `op === "reset"` answers `200 { ok: true, url }`.
- Modify: `kernel/src/notify.ts`. Delete `secret`, `deliverSecrets`, the `owner_secrets` table creation and the header lines about credentials.
- Modify: `kernel/src/main.ts`. Delete the reset-link timer (the `takeResetLinks` / `notify.secret` / `deliverSecrets` block) and the comments naming them.
- Modify: `kernel/src/channels.ts` (`ModuleInfo.channel.credentials`), `scripts/modules.ts` (the `providers.channel.credentials` check and its output), `scripts/compiler/authority.ts` (the credentials authority line) and `modules/channel-telegram/module.yaml` (`credentials: true` and its comment).
- Modify: `ops/setup.sh`. In the `--reset` block, print the link: `operator reset … | node -e` is unavailable in a dry run, so read `.url` with the same tool `owner_link` uses. Print `Reset <email>: one-time link (72 hours): <url>`. When `url` is null, print that the account signs in through Cloudflare Access instead. Also fix the Telegram wording at the 409 messages (lines ~228, ~248) and in the header usage comment.
- Modify tests: `kernel/test/{operator,account-flows,notify}.test.ts`, `scripts/test/{modules,authority}.test.ts`. Tests of deleted code are deleted.

- [ ] **Step 1: Write the failing test:** `operator.test.ts` `the operator reset returns the one-time link and ends sessions`. The response is `200` with `url` matching `/\/auth\/set-password\?token=/`. Sessions are gone, and a second reset invalidates the first link.
- [ ] **Step 2:** Run `cd kernel && node --test test/operator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Afterwards `grep -rn "takeResetLinks\|deliverSecrets\|owner_secrets\|credentials: true" kernel scripts modules ops` returns nothing.
- [ ] **Step 4:** Run `cd kernel && npm test && npm run typecheck`, `cd scripts && npm test && npm run typecheck`, and `bash -n ops/setup.sh && ops/setup.sh --dry-run --reset a@example.com` (if dry-run runs off-host). Expected: PASS.
- [ ] **Step 5: Commit** `feat(setup): --reset prints the reset link; delete the Telegram credential path`.

### Task 9: Docs and skill clean-ups

**Files:**
- Modify: `modules/chief-of-staff/skills/research-tools/SKILL.md`. Drop the `glean_auth_unavailable` sentence, the `github_auth_unavailable` / `scripts/github-auth.sh` sentence and any other per-tool "reconnect" text. In their place, add one line: "A tool that answers that a connection isn't connected has already told the owner; follow its words."
- Modify: `docs/design/guided-setup.md` (~line 44, "never as a nag"). The rule becomes: background work never pings; the owner's own request gets the one Connect link in that conversation.
- Modify: `docs/setup.md` (~line 226): `--reset` prints the link on the server; Telegram is no longer needed.
- Modify: any other doc that `grep -rln "reset.*Telegram\|Telegram.*reset\|auth_unavailable" docs modules` finds, except `docs/superpowers/` history.

- [ ] **Step 1:** Make the edits. If a test asserts handbook text, run `cd scripts && npm test` and `cd services/computer && node --test test/*.test.ts` (both assert handbook text). Expected: PASS.
- [ ] **Step 2: Commit** `docs(setup): connect on first use, reset without Telegram`.

### Task 10: Integration, removal check and security review

- [ ] **Step 1:** Rebase every lane onto one branch, in dependency order (1, 2, 3, 5, 4, 6, 7, 8, 9). Stop on any conflict. List what the combined diff removes outside these files, to check for stale-base reverts.
- [ ] **Step 2:** Run `node scripts/sync-shared.ts`. Expected: no change.
- [ ] **Step 3:** Run every suite CI runs for this diff (`node scripts/ci-local.ts`), at least:
  - `cd kernel && npm test && npm run typecheck`
  - `cd scripts && npm test && npm run typecheck`
  - `cd services/computer && node --test test/*.test.ts`
  - `cd services/board && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run typecheck && npm run lint && npm run build`
  - `npm test && npm run typecheck` in `modules/dispatch/service` (or its package root), `modules/owner-channel/connections/notify`, `modules/google/connections/google-workspace-mcp`, `modules/github/connections/github-mcp` and each vendor connection whose `src/vendor/` changed.

  Expected: all PASS.
- [ ] **Step 4: Removal list.** This grep returns nothing outside `docs/superpowers/`:
  ```
  grep -rn "auth_unavailable\|google_auth_failed\|kernelNotify\|needKey\|takeResetLinks\|deliverSecrets\|owner_secrets\|github-auth.sh" --exclude-dir=node_modules .
  ```
- [ ] **Step 5: Security review** of the new paths (Conventions: "every new path gets a security review before it switches on"). Fix each finding with a test.
  - `POST /v1/connections/:module/ok` takes only the board's key. Its only effect is waking tasks that already wait; check that it can't create a wait or a message.
  - `GET /v1/connections/down` takes a module token with `kernel.jobs`, reveals only connection names, causes and dates, and never `detail` or `url`.
  - `needs_owner` from any module (third-party included):
    - The agent sees only kernel text.
    - The owner sees `detail` capped to one line.
    - `url` is used only for sso/restricted, and only as https.
    - `need.connection` is never trusted; the module comes from `conn.module`.
    - A module can't force a message for a task it isn't serving: `who` comes from the caller's own bearer.
  - Owner-asked detection reads only the control plane (as the owner key) and kernel provenance, never task text.
  - `/v1/operator/reset` now returns a credential. It is reachable only on the backplane with `board_operator_key` (root's vault). Confirm the link never reaches a log line, and that `ops/setup.sh` prints it only to the operator's terminal.
  - The board's `/connect/<module>` needs a ready admin, like the other connect paths, and redirects only to same-origin paths.
- [ ] **Step 6:** Open the PR, titled `feat(setup): connect on first use`. The body lists the dropped behaviours (Global Constraints) and the spec deviations (the Spec notes section below), and ends with the attribution line.

## Spec notes (calls made against the code)

- **Digest.** A kernel `kind: "digest"` message is sent at once (owner-channel runs `attend()` only for an agent caller), and its `dedupe_key` window is 10 minutes. So kernel items gain `batch: true` (Task 5), and the kernel's state row dedupes per day (`reported_day`, `told`).
- **Waking.** No shared `connect:<connection>` wake key exists. A wait is `wait:<task>:<until>`, and an `on`-only wait lasts 24 h. Tasks waiting on a connection are tracked in `connection_waits`, and `ok()` opens a `connect:<module>:<task>:<t>` wake with cause `connected` per task. Dispatch needs a `RESUME` entry for that cause, or it drops the wake.
- **Who builds the url.** The kernel can't know connect paths or modes, so it links `<board>/connect/<module>`, and the board redirects and explains each mode. A module's own url is kept only for GitHub's sso and restricted pages.
- **Names.** State is keyed by module. `google_workspace` belongs to module `google`, and `github` and `github_official` both belong to `github`.
- **Hand-written MCPs.** hubspot-mcp and slack-mcp already run on the shared vendor proxy, so only google-workspace-mcp and github-mcp call the helper.
- **Coverage.** The routing covers agent tool calls through `/c/<connection>/mcp`. Not covered:
  - kind-routed writes (executors);
  - approved-record replays and health probes (`callAs`);
  - slack_live's bot-token errors;
  - the chat lane's own prompt (it gets no preamble).
- **Two connections in one request** don't coalesce into one message. The agent ends its turn on the first one, and the second is reported after the first connects.
- **Partial causes** (scope, sso, restricted) never clear on a success. An sso fix on github.com has no `/ok` either, so those waits retry daily.
- **Reset link base.** The reset link is built on the admin listener's public name (`adminUrl`), not the board's, because `/auth/set-password` is served there.

## Riskiest task

Task 4. Buffering every `tools/call` answer changes the proxy's hot path for trusted connections. The async `hit` happens inside a response that is already being read. The late-bound wiring must not run before main.ts has built `idle` and `wakes`.
