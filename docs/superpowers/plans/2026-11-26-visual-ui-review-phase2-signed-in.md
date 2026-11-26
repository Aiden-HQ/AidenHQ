# Visual UI review, phase 2: signed-in review, clicking pass and verified bugs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The UI Reviewer reviews apps behind a sign-in (any stack, and AidenHQ's own apps), works their flows by clicking
like a person, and reports only bugs it reproduced, without login material ever reaching the model or a fork's code.

**Architecture:**

| Concern | Owner |
|---|---|
| The login ladder (supplied → repo-aware least-privilege → sign-up with Mailpit → throwaway auth patch), the session check, the live-app guard | the engine (`ui-review login`, `ui-review capture --session`, `browser.ts` guard) |
| Releasing a supplied login to a box process, never to the model or a fork run | the design service's job tool `login`, reached through one new generic kernel route |
| AidenHQ apps | the kernel's test-user session, widened from one agent key to a role and to a per-run live-app mode, served by the gate's test listener (per-request signed member identity) |
| Which agent may do it | roles: `ui-login` (design), `app-tester` (apps-platform); never agent keys |
| Clicking pass, reproduction | the agent (Codex with agent-browser's `dogfood` skill, attached to the engine's browser), the engine's `flows` and `repro` |

**Tech Stack:** as phase 1, plus Mailpit (pinned binary in agent-base), agent-browser's `dogfood` skill (pinned commit),
Chrome DevTools Protocol `Fetch` domain (through Playwright's CDP session) for the guard.

**Spec:** `docs/superpowers/specs/2026-11-26-visual-ui-review-design.md` ("Logins and live apps", "Bugs"). Builds on
phase 1 (`docs/superpowers/plans/2026-11-26-visual-ui-review-phase1-design-review.md`) as merged and on #1876 (see phase 1's
header for what is assumed from it).

## Global Constraints

- Phase 1's Global Constraints apply (builder brief rules, tests in the agent-base image, one way, no owner data).
- **Security review before switch-on** (Conventions): the job-tool route, the widened test session, the listener's new
  network reach and the login release each get a written review in the PR body, every finding fixed with a test. The
  gate's and the kernel's changes are security gates: they enforce from day one (no observe mode).
- Login material (passwords, TOTP seeds, session cookies, handoff codes, Mailpit links) is read only by `ui-review` box
  processes: never printed, never written to `report.*`, `queue.json`, logs or evidence, never a tool result.
- A check box stays credential-free: `ui.scan-signed-in` uses only the rungs that need no secret (repo-aware, sign-up,
  auth patch on a local build).
- Live-app mode per run: `read` (default for any target not built locally) allows `GET`/`HEAD` only; `test-write` allows
  writes except `DELETE` and paths matching
  `/(delete|destroy|remove|purge|archive|cancel|refund|pay|checkout|billing|invite|send|transfer|publish|deploy)/i`;
  `any` allows everything. A local throwaway build defaults to `any`.
- Least privilege: a repo-aware session uses a seed or created user that is not an admin; when the repo only offers an
  admin, the run says so in its notes and proceeds read-only.
- Clicking pass: 20 minutes and $3 per app per pass at most; it works the coverage queue's flows, never free roam.
- A bug is reported only when `repro` reproduced it twice in fresh contexts; everything else is dropped or a design note.

## Review Focus

1. **A session that dies mid-run** (expiry, a logout link clicked, a server restart): each capture whose final URL or title
   matches the recorded login page is redone after one re-login; a second loss marks the rest `failed: session ended`.
   Test: Task 3 `session check`.
2. **A supplied login asked for by a task that isn't the design module's pass for that app** (an on-request PR review, a
   fork PR, another app's pass, a finished pass): refused with a reason, no material in the answer. Test: Task 2.
3. **A destructive control in read or test-write mode** (Delete, Pay, Send invite, a `sendBeacon` POST): the request is
   aborted at CDP, listed under "Blocked requests", the page is captured as it stands. Test: Task 3 `guard`.
4. **A sign-up that needs CAPTCHA or SMS**: the rung stops at once with `sign-up needs a CAPTCHA/SMS`, the ladder moves on.
   Test: fixture route `/signup-captcha` in Task 3.
5. **A clicking pass that wanders or stalls** (Codex stops after 2 minutes, or loops on one page): the driver's flow list is
   the brief; the agent re-runs the pass on the flows still unvisited once; unvisited flows are listed in the report.
   Covered by Task 5's acceptance run (manual: agents' behaviour is judged by using it).

## Lanes and PRs

| Lane | Tasks | Parallel with | PR |
|---|---|---|---|
| K Kernel and gate | 1 | E, C, D | 1 `feat(kernel): module job tools and role-based test sessions with a live-app mode` |
| D Design service | 2 | K, E, C | 2 `feat(design): signed-in UI review: login ladder, live-app guard, clicking pass, verified bugs` |
| E Engine | 3 | K, D, C | 2 |
| C Clicking pass and bugs | 4 | K, D, E | 2 |
| R `ui.scan-signed-in` | in Task 3 Step 6 | | 2 |
| Integration | 5 | after all | |

PR 1 merges first (the kernel route and the listener), then PR 2. Interfaces between lanes are fixed below, so lanes
build against them in parallel and meet at integration.

---

### Task 1: Kernel job tools for modules; role-based test sessions with a mode (lane K)

**Files:**
- Modify: `services/computer/launcher.ts` (its box gateway forwards `POST /v1/jobtools/module/<module>/<op>` as it forwards
  `/v1/jobtools/<cmd>` today), `kernel/src/backplane.ts` (route `POST /v1/jobtools/module/:module/:op`), `kernel/src/jobtools.ts`
  (`moduleTool`), `scripts/modules.ts` (compile `providers.jobtools: { url, auth, ops: [..] }` into `modules.json`),
  `scripts/test/…` (compile refuses an op not listed)
- Modify: `kernel/src/test-session.ts` (`TEST_SESSION_AGENTS` deleted: the agent must hold role `app-tester`;
  `mint({ app, task, agent, mode, minutes })` with `mode: "read" | "test-write" | "any"`, `minutes` <= 60, default 15;
  the session row stores `mode`), `kernel/src/backplane.ts` (`POST /v1/jobtools/test-session { app, mode, minutes }` with
  the job's own token, beside the existing canary path), `modules/apps-platform/module.yaml` (declares role `app-tester`;
  the red-teamer gets it, so the canary keeps working)
- Modify: `modules/apps-platform/gate/test-listener.ts` (per request: the session's `mode` decides the methods and the
  dangerous-path refusal of the Global Constraints; a refused request answers 403 `blocked by live-app mode`; the minted
  identity's `methods` claim is the mode's list), `ops/vm/computer-net.sh` (boxes on `10.231.2.0/24` may reach
  `10.231.6.1:3132`, the test listener, and nothing else new), `docs/design/access.md` ("Test-user sign-in": role, mode,
  the computers network)
- Test: `kernel/test/test-session-route.test.ts`, `kernel/test/jobtools-module.test.ts`, `modules/apps-platform/gate/test/test-listener.test.ts`

**Interfaces (Produces):**
- `POST /v1/jobtools/module/:module/:op` (a kernel job's own token, body ≤ 16 KB) → the module's answer (≤ 64 KB). The kernel
  POSTs `{ op, body, caller: { agent: string; roles: string[]; task: string; task_module: string | null; task_source: string | null } }`
  to the module's `providers.jobtools.url` with the module's key. `task_module`/`task_source` are read from the task's
  markers only when the control plane's `createdByAgentId` is empty and the module marker is the only one (`modtasks.ts`
  `ownTask` rules). 404 for an op the module doesn't list.
- `POST /v1/jobtools/test-session { app, mode, minutes }` → `{ handoff: string /* one-time URL on <app>.canary.localhost:3132 */, expires: string }`.

- [ ] **Step 1: Write the failing tests:**
```ts
test("module job tool forwards the caller and the task's module source", async () => {
  const r = await post("/v1/jobtools/module/design/login", { app: "acme" }, { job: "ui" });
  assert.deepEqual(design.lastCall.caller, { agent: "ui-reviewer", roles: ["ui-login"], task: T, task_module: "design", task_source: "design:pass:acme:r1" });
  assert.equal((await post("/v1/jobtools/module/design/nope", {}, { job: "ui" })).status, 404);
});
test("a test session needs the app-tester role and carries its mode", async () => {
  assert.equal((await post("/v1/jobtools/test-session", { app: "tracker", mode: "read" }, { job: "no-role" })).status, 403);
  const ok = await post("/v1/jobtools/test-session", { app: "tracker", mode: "read", minutes: 60 }, { job: "tester" });
  assert.match(ok.json.handoff, /^http:\/\/tracker\.canary\.localhost:3132\/\.auth\/handoff\?code=/);
});
test("the listener enforces the session's mode per request", async () => {
  assert.equal((await viaListener("POST", "/api/items", { mode: "read" })).status, 403);
  assert.equal((await viaListener("DELETE", "/api/items/1", { mode: "test-write" })).status, 403);
  assert.equal((await viaListener("POST", "/api/items/1/publish", { mode: "test-write" })).status, 403);
  assert.equal((await viaListener("POST", "/api/items", { mode: "test-write" })).status, 200);
  assert.deepEqual(app.lastIdentity.methods, ["GET", "HEAD", "POST", "PUT", "PATCH"]);
});
```
- [ ] **Step 2:** Run `cd kernel && npm test` and `cd modules/apps-platform/gate && npm test`; expected FAIL.
- [ ] **Step 3:** Implement. Keep `app_page_canary` working through the same `mint` (mode `test-write`, 15 minutes).
- [ ] **Step 4:** Run both suites and `npm run typecheck`; expected PASS. Regenerate `kernel/contract.lock.json` (new routes
  `experimental`).
- [ ] **Step 5:** Security review in the PR body (the five questions in Task 5 Step 1), commit
  `feat(kernel): module job tools and role-based test sessions with a live-app mode`.

### Task 2: The design service: apps, passes and the login release (lane D)

**Files:**
- Modify: `modules/design/module.yaml`:
  - setting `ui_apps` (list of `{ name: "^[a-z][a-z0-9-]{1,30}$", url, repo?: "owner/name", aidenhq_app?: boolean }`, default
    `[]`, edited on the generic module settings screen until phase 3 moves it to the page);
  - secret `ui_logins` (`setup:` a JSON map `{ "<app>": { "login_url", "username", "password", "totp_secret"? } }`, pasted in
    the module's secret field);
  - `providers.jobtools: { url: http://design:8099/jobtools, auth: design_service_key, ops: [login] }`;
  - roles: declares `ui-login`; requests `kernel.tasks`;
  - ui-reviewer: `roles: [repo-checkout, ui-login, app-tester]`, grants `design_apps`, `design_pass_start`.
- Modify: `modules/design/service/src/{main.ts,store.ts,mcp.ts}`, create `modules/design/service/src/{passes.ts,jobtools.ts}`
- Test: `modules/design/test/login-release.e2e.test.ts`

**Interfaces:**
- Consumes: `/v1/tasks` (kernel.tasks, phase 1's service token), Task 1's forwarded `caller`.
- Produces:
  - `runs` gains `depth TEXT /* scan|signed-in|tester */, mode TEXT, source TEXT`; `kind` gains `pass`.
  - `startPass(app: string, why: "request", o: { depth; mode?; model? }): { run: string; task: string } | { refused: string }` in
    `passes.ts`: the one function that files a pass (phase 3's scheduler calls it too).
  - `design_pass_start { app: string; depth: "scan" | "signed-in" | "tester"; mode?: "read" | "test-write" | "any"; model?: string } → { run, task }`:
    files one module task for the holder of role `ui-login` (source `design:pass:<app>:<run>`, fixed text naming the app,
    depth, mode and model) against the app's configured `url`, or its repo's default branch; never a PR head.
  - `design_apps {} → { apps: { name, url, repo?, aidenhq_app, login: boolean }[] }` (whether a login is set, never its value).
  - Job tool `login { app }` → `{ login_url, username, password, totp?: string /* the current code, never the seed */ }`,
    released only when: the caller holds `ui-login`; `task_module === "design"` and `task_source === "design:pass:<app>:<run>"`
    for that `app`; that run is the app's active pass (status `running`); the app has a login. Every other case: 403 with
    the reason, nothing else.

- [ ] **Step 1: Write the failing test:**
```ts
test("a supplied login reaches only the app's own pass", async () => {
  const { run } = await call("design_pass_start", { app: "acme", depth: "signed-in" });
  const ok = await jobtool("login", { app: "acme" }, caller({ source: `design:pass:acme:${run}` }));
  assert.equal(ok.username, "reviewer@example.com"); assert.ok(!("totp_secret" in ok));
  for (const c of [caller({ source: null, module: null }),                        // an on-request or PR task
                   caller({ source: `design:pass:other:${run}` }),               // another app's pass
                   caller({ source: `design:pass:acme:${run}`, roles: [] })])     // no ui-login role
    assert.equal((await jobtoolRaw("login", { app: "acme" }, c)).status, 403);
  finishRun(run); assert.equal((await jobtoolRaw("login", { app: "acme" }, caller({ source: `design:pass:acme:${run}` }))).status, 403);
  assert.ok(!JSON.stringify(await call("design_apps", {})).includes("hunter2"));
});
```
- [ ] **Step 2-4:** FAIL, implement, PASS (`cd modules/design/service && npm test`).
- [ ] **Step 5:** Commit `feat(design): app list, passes and the supplied-login job tool`.

### Task 3: The engine: login ladder, session check, live-app guard, Mailpit (lane E)

**Files:**
- Create: `services/computer/images/agent-base/ui-review/login.ts`, `guard.ts`
- Modify: `browser.ts` (`launch({ mode, origins })` installs the guard), `capture.ts` (`--session state.json`, the session
  check), `main.ts` (`login` subcommand; `capture --session --mode`), `report.ts` ("Blocked requests", "Session")
- Modify: `services/computer/images/agent-base/Dockerfile` (Mailpit `v<pinned>` binary, sha256-checked, at
  `/usr/local/bin/mailpit`; release ≥ 7 days old, date in the comment)
- Fixture: `services/computer/test/fixtures/ui-app/` gains `/login` (password + TOTP), `/signup` (email link via SMTP to
  Mailpit), `/signup-captcha`, `/admin-only`, a session that expires after 30 s, and Delete/Pay buttons
- Test: `services/computer/test/ui-review.e2e.test.ts`
- Modify: `modules/code-review/service/src/catalog.json` (`ui.scan-signed-in`, same as `ui.scan` plus "signs in with the
  repo's own seed or test user, or by signing up"), `modules/code-review/recipe/ui.ts` (`signedIn` from the option: the
  Codex step also produces `.aidenhq-ui/state.json` through `ui-review login repo|signup`, never `supplied`)

**Interfaces (Produces):**
- `ui-review login supplied --app <app> --out state.json`: calls `POST $AIDENHQ_GATEWAY_URL/v1/jobtools/module/design/login`
  with `AIDENHQ_RUN_TOKEN` (the launcher forwards it to the kernel, Task 1), signs in, writes Playwright storage state; stdout is only `signed in (supplied) at <login path>`.
- `ui-review login form --url <login url> --user <u> --password-file <f> [--totp-file <f>] --out state.json` (the repo-aware
  rung: the agent found or created the user).
- `ui-review login signup --url <signup url> --out state.json`: starts Mailpit on `127.0.0.1:1025` (SMTP) and `:8025` (API)
  unless running, signs up as `ui-review+<run>@example.test`, follows the link or enters the code from the newest mail;
  stops with the reason on a CAPTCHA (`iframe[src*=captcha]`, `[class*=captcha]`, `g-recaptcha`, `h-captcha`) or a phone field.
- `ui-review login aidenhq --app <app> --mode <m> --out state.json`: `POST /v1/jobtools/test-session`, opens the handoff,
  writes state for `<app>.canary.localhost:3132`; Chrome is launched with `--host-resolver-rules="MAP *.canary.localhost 10.231.6.1"`.
- Every login writes `state.json` plus `state.meta.json` `{ rung, loginPath, loginTitle, origin }` (no secret).
- `Report` (phase 1's `types.ts`) gains `blocked: { method: string; path: string; page: string }[]` and
  `session?: { rung: "supplied" | "form" | "signup" | "aidenhq" | "patch"; relogins: number }`.
- Guard: `--mode read|test-write|any` (default `read` unless the target is `127.0.0.1`/`localhost`); CDP `Fetch.enable` for the
  target origins; a refused request fails with `BlockedByClient` and is recorded `{ method, path, page }`.
- Session check: after each capture, a final URL whose path is `loginPath`, or a visible password input with the login
  title, means the session is gone: one re-login with the same rung (supplied, form, aidenhq), then `failed: session ended`.

- [ ] **Step 1: Write the failing tests:**
```ts
test("form login captures signed-in pages and notices a dead session", async () => {
  await login("form", { url: fx("/login"), user: "member", passwordFile: pw, totpFile: totp, out: st });
  const r = await runCapture(fx("/"), { session: st, pagesFile: signedInPages });
  assert.ok(r.captures.every((c) => !c.url.endsWith("/login")));
  assert.ok(r.notes.some((n) => /re-signed in/.test(n)));                 // the 30 s expiry was crossed once
  assert.ok(!readdirSync(out, { recursive: true }).some((f) => readFileSync(join(out, f)).includes(PASSWORD)));
});
test("sign-up through Mailpit works and CAPTCHA stops the rung", async () => {
  await login("signup", { url: fx("/signup"), out: st }); assert.ok(existsSync(st));
  await assert.rejects(login("signup", { url: fx("/signup-captcha"), out: st2 }), /CAPTCHA/);
});
test("the guard blocks writes in read mode and destructive paths in test-write", async () => {
  const r = await runCapture(fx("/danger"), { mode: "read", clickAll: true });
  assert.ok(r.blocked.some((b) => b.method === "POST")); assert.equal(fixtureServer.writes, 0);
  const t = await runCapture(fx("/danger"), { mode: "test-write", clickAll: true });
  assert.ok(t.blocked.some((b) => /\/pay/.test(b.path))); assert.ok(fixtureServer.writes > 0);
});
```
- [ ] **Step 2-4:** FAIL, implement, PASS (Task 1 Step 4 command of phase 1).
- [ ] **Step 5:** Commit `feat(computer): ui-review login ladder, session check and live-app guard`.
- [ ] **Step 6:** `ui.scan-signed-in`: extend phase 1's `repo-review.test.ts` case: the option starts `code-review-ui` with
  `option: "ui.scan-signed-in"`, and the recipe's spec carries no login field (assert the spec's keys equal phase 1's).
  Commit `feat(code-review): ui.scan-signed-in`.

### Task 4: Clicking pass, reproduction and verified bugs (lane C)

**Files:**
- Create: `services/computer/images/agent-base/ui-review/{flows.ts,repro.ts}`, `prompts/flows.md`, `prompts/repro-judge.md`
- Modify: `services/computer/images/agent-base/Dockerfile` (agent-browser's `dogfood` skill at a pinned commit into
  `/opt/aidenhq/skills/dogfood`, its licence beside it), `modules/design/skills/ui-review/SKILL.md` (sections "Signing in",
  "Clicking pass", "Bugs"), `modules/design/agents/ui-reviewer/AGENTS.md` (one line: bugs are reported only once reproduced)
- Test: `services/computer/test/ui-review.e2e.test.ts`

**Interfaces:**
- Consumes: the coverage queue and route-check results (phase 1), `state.json` (Task 3).
- Produces:
  - `ui-review flows <dir> --out flows.md [--personas <file>]`: the coverage driver: per page its key controls (from the
    route check's controls and the feature map's `shows`), grouped into flows of at most 6 steps, each with the persona
    and what should happen; ends with "write each finding to clicks.json as `{ kind: "friction" | "bug", page, width, title, steps: Step[], saw, expected }`".
  - `type Step = { open: string } | { click: string } | { fill: [string, string] } | { press: string } | { wait: string }`
    (selectors are Playwright locators: `role=button[name="Save"]`, `text=…`, CSS).
  - `ui-review repro <clicks.json> --out <dir> [--session state.json] [--mode m]`: each `bug` replayed twice, each in a
    fresh context, before|after captures around its last step, one judging call (`prompts/repro-judge.md`, Carbon) per
    replay; `verified = both replays show it`; writes `bugs` into `report.json` (only verified ones) and `friction` items
    into the design review's input for the consolidation step.
- The skill's clicking pass: `ui-review browser start --session state.json --mode <m>` (prints the CDP port), then
  `codex exec -m openai/gpt-6.2-sol -c model_reasoning_effort=low -C <workdir> "<dogfood skill> + flows.md + attach with agent-browser --cdp <port>" < /dev/null`
  for at most 20 minutes, then once more on unvisited flows; then `ui-review repro`.

- [ ] **Step 1: Write the failing test** (fixture has a dead "Archive" button and a filter that clears itself on reload):
```ts
test("repro keeps only bugs that happen twice", async () => {
  const r = await repro(fx("/"), clicksWith([deadArchive, reloadClearsFilter, notABug]), { model: "fake/judge" });
  assert.deepEqual(r.bugs.map((b) => b.title).sort(), ["Archive does nothing", "Filter lost on reload"]);
  assert.ok(r.bugs.every((b) => b.verified && b.repro!.length > 0 && b.captures.length >= 2));
});
test("flows lists every page's key controls with a persona", async () => {
  const md = await flows(capturedFixtureDir); assert.match(md, /#\/settings/); assert.match(md, /Persona:/);
});
```
- [ ] **Step 2-4:** FAIL, implement, PASS.
- [ ] **Step 5:** Commit `feat(design): clicking pass with dogfood and reproduced bugs`.

### Task 5: Security review, integration and acceptance (once)

- [ ] **Step 1: Security review** (written in PR 1's and PR 2's bodies, each answer pointing at a test):
  1. Can any task other than the design module's own pass for that app get a supplied login? (Task 2 test)
  2. Can a fork's code run while a supplied login is in the box? Passes run only on the app's URL or its default branch;
     on-request PR reviews never get a login (Task 2 test); check boxes never carry one (Task 3 Step 6 test).
  3. Can an agent without `app-tester` mint a test session, or a session outlive its task or 60 minutes? (Task 1 tests)
  4. Can a read-mode session write? (Task 1 listener test; Task 3 guard test)
  5. Can login material reach a report, a log, a tool result or evidence? (Task 3 grep assertion)
- [ ] **Step 2:** Merge lanes; `node scripts/ci-local.ts`; engine tests in the image; Codex review of each PR; fix findings.
- [ ] **Step 3:** Deploy PR 1, then PR 2. Acceptance on TEST tasks: (a) a signed-in pass on Roadmap Keeper through
  `design_pass_start` (`aidenhq_app: true`, mode `read`): pages render signed in, no write reaches the app; (b) a local
  build of an app with a seed user (repo-aware rung), clicking pass on, expected at least one reproduced bug or none, never
  an unverified one; (c) a public demo app with a supplied test account in `ui_logins`.
- [ ] **Step 4:** Remove worktrees and branches.

## New installs

Nothing new is on: `ui_apps` is empty and no login is set, so signed-in passes need the owner to add an app (and, for a
supplied login, paste it). AidenHQ apps need `settings.edge.test_user` naming them, as for the canary; without it the
AidenHQ rung answers "no test user for <app>" and the ladder moves on. Hosts upgraded from an older install must re-run
`ops/vm/computer-net.sh` (apply prints this, as it does for the canary network).

## Self-review

- Spec coverage: login ladder in order (Task 3), session check (3), login material never reaching the model (3, 5),
  supplied login withheld from fork-PR runs (2, 3 Step 6), repo-aware least-privilege session (3 and the skill), Mailpit
  sign-up (3), auth patch last (the skill's "Signing in": a throwaway patch in the local build of an owner's repo, after the
  other rungs fail, never pushed), AidenHQ apps by per-request signed member identity (1), live-app mode with request-level
  enforcement (1, 3), clicking pass with dogfood (4), verified bugs (4), `ui.scan-signed-in` (3 Step 6).
- The widened test session changes a rule `docs/design/access.md` states ("never widened by a setting: the agent key list"):
  it is widened in code from a key to a role, reviewed in Task 5. The app list stays the owner's `settings.edge.test_user`.
- Types: `Step`, `state.meta.json`, `design_pass_start` and the job tool's `caller` match between Tasks 1-4.
