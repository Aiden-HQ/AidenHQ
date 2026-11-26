# Visual UI review, phase 3: the "UI testing" Fleet page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner lists apps on one Fleet page, picks per app how it is tested (URL or repo, login, models, spend mode,
live-app mode, schedule), and gets each app's design review as one refreshed GitHub issue with verified bugs as their own
issues (or a board report without a repo), with runs, before|after images and recordings on the page.

**Architecture:**

| Concern | Owner |
|---|---|
| The page, per-app settings, Run now / Stop, run history, images and recordings | the design module's view `ui://design/page` on its `design` connection (phase 1's service) |
| When a pass starts (on request, after a deploy, 24/7), one active pass per app, coverage resume | the design service's scheduler (`passes.ts`, phase 2's `startPass`) |
| The per-app daily cap | the kernel's model gateway: a generic per-key daily budget a module declares and stamps on the tasks it files |
| "A deploy happened" | apps-platform's new `app.deployed` event and the github change feed's `push`, read through `subscribes:` |
| Issues | the UI Reviewer through the github connection (`github_issue_create`, `github_issue_update`: AI-reviewed writes) |
| Login secrets per app | a new generic page building block, `secret_maps`, drawn by the board outside the frame into the vault |

**Tech Stack:** as phases 1-2; the board (React, its kit and tokens), MCP Apps views (`docs/design/board-ui.md` "Modules").

**Spec:** `docs/superpowers/specs/2026-11-26-visual-ui-review-design.md` ("Front doors, triggers, outcomes", "Models").
Builds on phase 1 and phase 2 as merged (the `design` service, `runs`, `design_pass_start`, `startPass`, `ui_testing.apps`, `ui_logins`,
the `login` job tool, the engine's `--resume`, `browser start`, `flows`, `repro`), and on #1876.

## Global Constraints

- Phases 1-2 Global Constraints apply.
- Quiet start: every app defaults to `schedule: on-request`. `after-deploy` and `always` are the owner's opt-in per app.
- Never automatic on a PR, push to a branch other than the default, or change: `after-deploy` reacts only to a healthy
  AidenHQ deploy of that app or a push to its repo's default branch.
- One active pass per app (a unique index, not a check in code paths). A pass asked for while one runs answers
  `already running: <run>`.
- Per-app daily cap: `day_cap_usd` (default 5, at most 100), in the gateway's reservation accounting (settled plus in
  flight), per UTC day, with the gateway's existing admission rule (a call goes ahead while spent and held are below the
  cap, its output bounded to the room left; at or over it, `402 cap_reached`). The scheduler reads the app's spend from the
  kernel (Task 1) and starts no pass once it is at the cap, until the next UTC day. The install's day and month limits still
  apply on top, and so does `task_usd` (default 10): one pass is one task, so a single pass stops at
  `min(task_usd, the cap's room)`; `always` runs more passes until the day cap.
- Spend mode per app: `scan` (capture, design review, no fixes, no clicking), `standard` (default: plus top-3 rendered
  fixes and one clicking pass), `thorough` (the review on `anthropic/claude-opus-5.5`, top-5 fixes, two clicking passes).
  Models per app override any of `design`, `fixes`, `clicking` (OpenRouter ids).
- One editor per setting: `ui_testing` and the `ui_logins` paste field leave the generic module settings screen in this
  change; the page is their only editor.
- Board UI follows `docs/design/board-ui.md`; screenshots at 1512x982, 1920x1080, 2560x1440, 1024, 768 and 390, both themes.
- Issues: one "design improvements" issue per app, refreshed in place (marker `<!-- aidenhq-ui:design:<app> -->`), never a
  second; one issue per verified bug (marker `<!-- aidenhq-ui:bug:<app>:<sha256(page + "\n" + title) first 12> -->`), never
  refiled while one with its marker is open. The design store remembers each issue's number by marker; a known number is
  updated (and reopened if closed), never searched for again. Images live on the board (the fleet has no image host on
  GitHub, and a page view can't be deep-linked): each issue names the run (`run r-…`) and points at the UI testing page,
  where runs are listed and found by id, and carries the fix diffs as text.
- Recordings: opt-in per app (`recording: true`), only of clicking-pass flows, VP8 webm, at most 2 minutes and 8 MB each.

## Review Focus

1. **Two triggers at once** (a deploy event while a 24/7 pass runs, the owner's Run now during an after-deploy pass): one
   pass; the second answers `already running`. Test: Task 2 `one active pass`.
2. **The cap reached mid-pass**: the agent's next model call is refused, the pass ends `cap reached` with what it has
   (partial report published, queue saved for resume), and the scheduler waits for the next UTC day. Test: Task 1 and
   Task 2 `cap`.
3. **An app removed or renamed while a pass runs**: the pass finishes or fails on its own; the scheduler never starts one
   for a name not in `ui_testing.apps`; the issue markers keep the old name's issue untouched. Test: Task 2 `removed app`.
4. **GitHub not connected, or the repo unreachable / issues disabled**: the report stays on the page (board report) and on
   the pass task, the run records `issues: unavailable: <reason>`; nothing retries in a loop. Covered by the skill and
   Task 5's acceptance run.
5. **A huge app on 24/7** (hundreds of pages): passes resume the coverage queue where the last stopped, so successive passes
   cover new pages instead of redoing the first ones; a full cycle starts over. Test: Task 2 `resume`.

## Lanes and PRs

| Lane | Tasks | Parallel with | PR |
|---|---|---|---|
| G Gateway budgets | 1 | S, P, B | 1 `feat(kernel): per-key daily spend budgets a module declares` |
| S Scheduler and triggers | 2 | G, P, B | 2 `feat(design): UI testing page with per-app settings, schedules, issues and recordings` |
| P The page | 3 | G, S, B | 2 |
| B Board building block | 4 | G, S, P | 2 |
| R Recordings, issues, skill | 5 | after S | 2 |
| Integration | 6 | after all | |

PR 1 merges first. PR 2 spans design, apps-platform (the event), board (`secret_maps`, one icon) and the schema: one PR,
split by area only if it passes ~2k lines (then board + schema first).

---

### Task 1: Per-key daily budgets in the gateway (lane G)

**Files:**
- Modify: `kernel/src/gateway/lib.ts` (`Limit.scope` gains `"budget"`; `calls.budget TEXT`; table `spend_budget (subject TEXT PRIMARY KEY, n INTEGER, nano INTEGER)`
  kept by the same insert/update/delete triggers as `spend_task`, subject `<key>:<UTC day>`, counting every call that carries
  a budget; held rows counted like `heldTask`; `limits()` adds `{ scope: "budget", subject, cap }` when the caller's task has a
  budget with a cap; a refusal is the existing `402 cap_reached` with `scope: "budget"`, and tells the task's asker once per
  subject and value, as the task cap does)
- Modify: `kernel/src/modtasks.ts` and the `POST /v1/tasks` route (body `budget?: string`, which must be one of the filing
  module's declared keys, stored in `task_budgets (issue_id TEXT PRIMARY KEY, key TEXT)` in `kernel.db`; never a Paperclip
  label, so nothing else can set it)
- Modify: `kernel/src/backplane.ts` (`GET /v1/spend/budgets`), `scripts/modules.ts` (a module's `budgets: { <name>: { setting: <key>, path: "<list>[].<id field>", day_usd: "<field>" } }`
  compiles into `config/gateway.json` `budgets: { "<module>:<name>:<id>": <usd> }`), `kernel/src/gateway/lib.ts` reads it with
  `watched()` like the limits
- Test: `kernel/test/gateway-budget.test.ts`

**Interfaces (Produces):**
- A task filed with `budget: "design:ui-testing:acme"` puts every agent call on it under that key's daily cap.
- `GET /v1/spend/budgets` (a module's own token) → `{ budgets: [{ key, day: { spent, held, cap } }] }` for that module's
  keys only (`<module>:` prefix): the design service's scheduler and page read it.

- [ ] **Step 1: Write the failing test:**
```ts
test("a budget key caps its tasks' calls per UTC day, in flight included", async () => {
  budgets({ "design:ui-testing:acme": 1.0 });
  const a = await job({ task: T1, budget: "design:ui-testing:acme" }), b = await job({ task: T2, budget: "design:ui-testing:acme" });
  const held = await startStreaming(a, { maxOutput: BIG });            // reserves the whole room: held, not settled
  assert.equal((await call(b)).status, 503);                           // the cap is filled only by a call in flight: spend_held
  await held.settle(0.95);
  const c = await call(b); assert.equal(c.status, 200); assert.ok(c.grantedOutput < BIG);   // below the cap: goes ahead, output bounded to the room
  await c.settle(0.2);                                                 // one call may take it past the cap
  const r = await call(b); assert.equal(r.status, 402); assert.equal(r.json.error.type, "cap_reached"); assert.equal(r.json.error.scope, "budget");
  assert.equal(asker.told.length, 1);
  assert.deepEqual((await moduleGet("design", "/v1/spend/budgets")).budgets.map((x) => x.key), ["design:ui-testing:acme"]);
  clock.nextUtcDay(); assert.equal((await call(b, { reserveUsd: 0.1 })).status, 200);
  assert.equal((await post("/v1/tasks", { title: "x", role: "r", source: "s", budget: "other:thing" }, { module: "design" })).status, 400);
});
```
- [ ] **Step 2:** `cd kernel && perl -e 'alarm shift; exec @ARGV' 600 npm test -- test/gateway-budget.test.ts`; expected FAIL.
- [ ] **Step 3:** Implement. **Step 4:** Run the kernel suite and `npm run typecheck`; expected PASS. Regenerate
  `kernel/contract.lock.json`.
- [ ] **Step 5:** Commit `feat(kernel): per-key daily spend budgets a module declares`.

### Task 2: Scheduler, triggers, one active pass, resume (lane S)

**Files:**
- Modify: `modules/design/module.yaml`:
  - `ui_testing.apps[]` entries gain `schedule: on-request|after-deploy|always` (default `on-request`), `day_cap_usd` (default 5),
    `spend: scan|standard|thorough` (default `standard`), `models: { design?, fixes?, clicking? }`,
    `live_mode: read|test-write|any` (default `read`), `recording: false`; `depth` and `mode` of `design_pass_start` default from them;
  - `budgets: { ui-testing: { setting: ui_testing, path: "apps[].name", day_usd: day_cap_usd } }`;
  - `subscribes: { apps: { kinds: [app.deployed], resources: { setting: ui_testing, path: "apps[].name" } }, "github?": { kinds: [push], resources: { setting: ui_testing, path: "apps[].repo" } } }`
    (`github?`: optional, so the module compiles on an install without GitHub; a compile test without it);
  - `requires: [board]` (for the page).
- Modify: `modules/apps-platform/module.yaml` (the `apps` connection lists `events: { kinds: [app.deployed] }`; requests
  `kernel.events`), `modules/apps-platform/apps-mcp/src/deploy.ts` (after a deploy recorded `healthy`, one
  `POST /v1/events { connection: "apps", kind: "app.deployed", resource: <app>, id: <the deploy's write record id>, data: { sha } }`
  (the event log dedupes on `(connection, id)`: a retry of one deploy is one event, a redeploy of the same sha another); a failed
  send is logged, never the deploy's failure)
- Modify: `kernel/src/modtasks.ts` (`GET /v1/tasks?source=` lists a module's own source family too: a source starting
  `<that module>:`, beside the release module's `release:instance:`; test in `kernel/test/modtasks.test.ts`: design lists
  `design:pass:` tasks and is refused `github:` ones)
- Create: `modules/design/service/src/schedule.ts`; modify `passes.ts`, `store.ts` (unique partial index
  `runs_active ON runs(app) WHERE kind = 'pass' AND status = 'running'`), `main.ts` (a 60 s tick; the feed cursor as code-review's)
- Test: `modules/design/test/schedule.e2e.test.ts`

**Interfaces (Produces):**
- `startPass(app: string, why: "request" | "deploy" | "always", o?: { depth?; mode?; model? }): { run: string; task: string } | { refused: "already running" | "cap reached today" | "unknown app" }`
  (the one entry: `design_pass_start`, the tick and the feed all call it); files the module task with
  `budget: "design:ui-testing:<app>"`.
- `design_pass_stop { app }`: cancels the pass task (kernel `/v1/tasks/:task/close`) and marks the run `stopped`.
- Resume: `design_run_finish` stores the pass's `queue.json` in its evidence; the task text names the previous run so the
  skill runs `ui-review capture --resume` from it; a queue with nothing left starts a new cycle.
- Cap: each tick reads `GET /v1/spend/budgets`; an app whose `spent + held >= cap` today gets no new pass
  (`refused: "cap reached today"`) until the UTC day changes, whether or not its last pass reported anything.
- Reconcile: each tick lists the module's open pass tasks (`GET /v1/tasks?source=design:pass:`); a `running` run whose task
  is closed, cancelled or gone, or whose filing failed, becomes `failed: <why>` and frees the app. The queue a dead pass
  left is the last one `design_evidence_put` stored; the next pass resumes from it.

- [ ] **Step 1: Write the failing tests:**
```ts
test("one active pass per app", async () => {
  const a = startPass("acme", "request"); const b = startPass("acme", "deploy");
  assert.ok("run" in a); assert.deepEqual(b, { refused: "already running" });
});
test("triggers follow each app's schedule", async () => {
  settings({ apps: [{ name: "acme", url: U, schedule: "after-deploy" }, { name: "beta", url: U2, schedule: "on-request" }] });
  feed.push({ kind: "app.deployed", resource: "acme" }, { kind: "app.deployed", resource: "beta" }); await tick();
  assert.deepEqual(tasks.filed.map((t) => t.source.split(":")[2]), ["acme"]);
  assert.equal(tasks.filed[0].budget, "design:ui-testing:acme");
});
test("always runs back to back until the cap, then waits a day", async () => {
  settings({ apps: [{ name: "acme", url: U, schedule: "always" }] }); await tick(); finishRun(last());
  kernel.budgets({ "design:ui-testing:acme": { spent: 5.1, held: 0, cap: 5 } });             // the gateway's own numbers
  await tick(); assert.equal(tasks.filed.length, 1); clock.nextUtcDay(); kernel.budgets({}); await tick(); assert.equal(tasks.filed.length, 2);
});
test("a pass whose worker died frees the app, and the next one resumes", async () => {
  settings({ apps: [{ name: "acme", url: U, schedule: "always" }] }); await tick();
  const first = tasks.filed[0]; kernel.closeTask(first.id, "cancelled"); await tick();
  assert.equal(runOf(first).status, "failed"); assert.equal(tasks.filed.length, 2);
  assert.match(tasks.filed[1].description, new RegExp(`resume from ${runOf(first).id}`));
  settings({ apps: [] }); kernel.closeTask(tasks.filed[1].id, "done"); await tick(); assert.equal(tasks.filed.length, 2);
});
```
- [ ] **Step 2-4:** FAIL, implement, PASS (`cd modules/design/service && npm test`; `cd modules/apps-platform/apps-mcp && npm test` for the event).
- [ ] **Step 5:** Commit `feat(design): per-app pass scheduling with one active pass and resume`.

### Task 3: The page `ui://design/page` (lane P)

**Files:**
- Modify: `modules/design/module.yaml` (`contributes.board.pages: [{ id: ui-testing, title: "UI testing", icon: palette, order: 6, connection: design, view: "ui://design/page", tools: [design_overview, design_runs, design_run, design_image, design_configure, design_pass_start, design_pass_stop] }]`;
  the `design` connection's tool lists gain `design_overview` (read) and `design_configure`, `design_pass_stop` (write))
- Create: `modules/design/service/src/page.html` (one file: inline script and style, the MCP Apps bridge as code-review's
  `page.html` uses it, the board's tokens from the host context), `modules/design/service/src/overview.ts`
- Test: `modules/design/test/overview.test.ts`

**Interfaces:**
- `design_overview {} → { apps: { name, url, repo?, schedule, spend, live_mode, day_cap_usd, today_usd, login: boolean, active?: { run, started }, last?: { run, ended, status, improvements: number, bugs: number, coverage: { done, total }, cost_usd, issue_url? } }[] }`
- `design_configure { apps: UiApp[] }` returns the page-write contract `structuredContent._aidenhq.settings_change:
  [{ kind: "setting", key: "ui_testing", value: { apps } }]` (the owner's Save outside the frame files it), validated against
  the declared schema first.
- An app with `aidenhq_app: true` that `settings.edge.test_user.apps` doesn't name shows "Signed-in passes need this app in
  the test user's apps (Settings)": that list stays the owner's security choice, made where it is today.
- Layout (the board design system; the builder picks details): a list of apps (status, schedule, today's spend vs cap, last
  run summary, Run now); an app's detail: its settings form, its latest run (ranked improvements, each with its before|after
  images via `design_image`, the fix diff in a disclosure; verified bugs with their captures; motion rows; coverage), run
  history with cost, recordings as `<video>` from `design_image` data. Empty state: "No apps yet: add one by URL or repo".

- [ ] **Step 1: Write the failing test** (the tools the view calls; the view itself is judged by screenshots, as the
  Reviews page is):
```ts
test("overview reports each app's state and configure returns one typed change", async () => {
  seed({ apps: [acme, beta], runs: [finished("acme", { improvements: 7, bugs: 2, cost_usd: 1.2 })], todayUsd: { acme: 1.2 } });
  const o = await call("design_overview", {});
  assert.deepEqual(pick(o.apps[0], ["name", "today_usd", "login"]), { name: "acme", today_usd: 1.2, login: false });   // today_usd from GET /v1/spend/budgets
  assert.equal(o.apps[0].last.improvements, 7);
  const c = await call("design_configure", { apps: [{ ...acme, schedule: "after-deploy" }, beta] });
  const [change] = c.structuredContent._aidenhq.settings_change;
  assert.deepEqual(pick(change, ["kind", "key"]), { kind: "setting", key: "ui_testing" }); assert.equal(change.value.apps[0].schedule, "after-deploy");
  await assert.rejects(call("design_configure", { apps: [{ ...acme, day_cap_usd: 500 }] }), /day_cap_usd/);
});
```
- [ ] **Step 2-4:** FAIL, implement, PASS. Then use the page at the six widths in both themes with a seeded store and
  screenshot each (Conventions: fluid UI, checked at real sizes).
- [ ] **Step 5:** Commit `feat(design): the UI testing Fleet page`.

### Task 4: The `secret_maps` page building block (lane B)

**Files:**
- Modify: `modules/board/schemas/pages.json` (`secret_maps: [{ secret: string, keys_from: "<setting>[].<field>", fields: { name: string; label: string; kind: "text" | "password" | "totp" }[] }]`,
  at most 2; `icon` enum gains `palette`), `scripts/modules.ts` (compile checks `secret` is the module's own `setup:` secret
  and `keys_from` its own setting)
- Modify: `services/board/web/src/ModuleView.tsx` (a native "Sign-ins" panel under the frame: per key Set / Replace /
  Clear, values never shown back), the kernel's account op `save_secret` (the one secret writer; `services/board/src/setup-flows.ts`
  calls it as the signed-in admin) gains `key`: merge one key of a JSON-map secret, written in place as the vault
  requires (`kernel/src/auth-api.ts`), the icon `palette` in the board's icon set
- Modify: `modules/design/module.yaml` (`secret_maps: [{ secret: ui_logins, keys_from: "ui_testing.apps[].name", fields: [login_url, username, password, totp_secret] }]`
  on the page; the `ui_logins` field leaves the module settings screen)
- Test: `services/board/web/src/ModuleView.test.tsx` (the panel) and `scripts/test/modules.test.ts` (compile checks
  `secret_maps`), one case each

- [ ] **Step 1: Write the failing tests:**
```ts
test("a secret map sets one key without reading the others back", async () => {
  await setSecretKey("design", "ui_logins", "acme", { username: "u", password: "p" });
  assert.deepEqual(JSON.parse(vault("ui_logins")), { beta: existingBeta, acme: { username: "u", password: "p" } });
  assert.ok(!(await api.get("/api/pages/ui-testing")).text.includes("existing-beta-password"));
});
```
- [ ] **Step 2-4:** FAIL, implement, PASS (`cd services/board && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && npm run lint`).
- [ ] **Step 5:** Commit `feat(board): secret maps on module pages`.

### Task 5: Issues, board report fallback, recordings, skill (lane R)

**Files:**
- Modify: `modules/design/module.yaml` (ui-reviewer grants `github?: [github_whoami, github_issue_read, github_search_issues, github_issue_create, github_issue_update]`
  and `design: [..., design_issue_note]`; the `design` connection lists `design_issue_note` as a write tool),
  `modules/design/skills/ui-review/SKILL.md` (section "A UI testing pass": read the pass task; resume; run at the app's
  spend mode, models, live mode; publish evidence; issues as below; finish the task), `modules/design/README.md`
- Modify: `services/computer/images/agent-base/ui-review/browser.ts` and `main.ts` (`browser start --record <dir>`: CDP
  `Page.startScreencast` frames piped to `ffmpeg -f image2pipe … -c:v libvpx -b:v 1M` per flow, cut at 2 minutes; `capture`
  of a flow adds `shifts` and `longFrames` from that flow to `Motion`), `modules/design/service/src/store.ts` (`webm`
  allowed in `design_evidence_put`)
- Modify: `modules/design/service/src/{store.ts,mcp.ts}` (`issues` table, `design_issue_note`); test `modules/design/test/issues.test.ts`
- Create: `services/computer/images/agent-base/ui-review/issue.ts` and `ui-review issue-body <dir> --app <app> --run-url <url> --run <id>`:
  prints the design issue body (marker, ranked improvements with where/what/change/why/best, the fix diffs in `<details>`,
  the run link for images, coverage and date) and one body per verified bug (marker, steps, expected, saw, run link)
- Test: `services/computer/test/ui-review.e2e.test.ts` (issue bodies; a 10 s recorded flow)

Issue identity is kept by the design store: table `issues (app TEXT, repo TEXT, marker TEXT, number INTEGER, PRIMARY KEY (app, repo, marker))` (a changed repo
finds no number and starts afresh there),
written by the write tool `design_issue_note { app, marker, repo, number }` and listed in the pass task's text and
`design_run`. Skill's issue steps (positive how-to): a known number for the marker → `github_issue_update` its body (and
state `open`); no known number → search once for the marker (`github_search_issues repo:<r> is:issue "<marker>"`, open or
closed) and adopt what it finds, else `github_issue_create` (label `ui-design`, or `ui-bug` for a bug); then
`design_issue_note` at once, before anything else. No repo, or GitHub
not connected, or a refused write: the run's page is the report (`design_run_finish` stores it) and the pass task's
comment links it.

- [ ] **Step 1: Write the failing tests:**
```ts
test("issue bodies carry the markers and never an image URL outside the board", async () => {
  const { design, bugs } = await issueBodies(fixtureRunDir, { app: "acme", runUrl: "https://board.example.com/#/fleet/ui-testing", run: "r1" });
  assert.match(design, /<!-- aidenhq-ui:design:acme -->/); assert.match(design, /1\. .+\n.+Change:/);
  assert.ok(bugs.every((b) => /<!-- aidenhq-ui:bug:acme:[0-9a-f]{12} -->/.test(b)));
  assert.ok(!/!\[[^\]]*\]\((?!https:\/\/board\.example\.com)/.test(design));
});
test("a recorded flow is a short VP8 webm", async () => {
  const f = await recordFlow(fx("/"), [{ click: "text=Settings" }, { wait: "1000" }], { out });
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", f]).toString());
  assert.equal(probe.streams[0].codec_name, "vp8"); assert.ok(Number(probe.format.duration) <= 120); assert.ok(statSync(f).size <= 8e6);
});
test("a noted issue number wins over search", async () => {   // modules/design/test/issues.test.ts
  await call("design_issue_note", { app: "acme", marker: "aidenhq-ui:design:acme", repo: "acme/app", number: 41 });
  const { run, task } = await call("design_pass_start", { app: "acme", depth: "scan" });
  assert.match(tasks.byId(task).description, /aidenhq-ui:design:acme → acme\/app#41/);
  settings({ apps: [{ ...acme, repo: "acme/new" }] }); const t2 = (await call("design_pass_start", { app: "acme", depth: "scan" })).task;
  assert.doesNotMatch(tasks.byId(t2).description, /#41/);
});
```
- [ ] **Step 2-4:** FAIL, implement, PASS.
- [ ] **Step 5:** Commit `feat(design): UI testing issues, board report and recordings`.

### Task 6: Integration and acceptance (once)

- [ ] **Step 1:** Merge lanes; `node scripts/ci-local.ts`; engine tests in the image; board `tsc -p tsconfig.build.json`;
  Codex review of each PR; fix every important finding. Security review lines in PR 2's body for `secret_maps` (values
  never read back, only the owner's board session writes them) and for the event route (apps-platform may send only
  `app.deployed` on `apps`).
- [ ] **Step 2:** Deploy PR 1, then PR 2. Acceptance: add the board and Roadmap Keeper on the page (Roadmap Keeper
  `after-deploy`, cap $5); Run now on the board → one design issue with a run link, verified bugs only, today's spend shown;
  a Roadmap Keeper deploy starts one pass; a second Run now answers "already running"; set cap $0.50 and see `cap reached`
  and no further pass that day; screenshots of the page at the six widths in both themes.
- [ ] **Step 3:** Remove worktrees and branches.

## New installs

The page shows its empty state; nothing runs until the owner adds an app, and every app starts `on-request`. Without
GitHub, reports stay on the page. Without the apps platform's event (an older apps-platform), `after-deploy` works only for
repo apps (pushes to the default branch). The per-app budget costs nothing when no app sets a schedule.

## Self-review

- Spec coverage: the Fleet page in the design module (3), per-app settings URL/repo, login, models, spend mode, live-app
  mode (2, 3, 4), on request by default with after-deploy + daily cap and 24/7 opt-in (2), one active pass per app (2), the
  cap in the gateway's reservation accounting (1), coverage queue resume (2), issues via the github connection, one refreshed
  design issue per app plus verified bug issues, board report fallback (5), recordings (5).
- Gaps decided here: images are linked on the board, not embedded on GitHub (the fleet has no binary write to GitHub);
  "spend mode" is defined as the three depth presets above; the per-app cap is a new gateway limit beside the install's
  single limit, as the spec asks.
- Types: `startPass`, `UiApp` (`ui_testing.apps[]`), the budget key `design:ui-testing:<app>`, `GET /v1/spend/budgets` and
  the issue markers match across Tasks 1-5.
- Folded in from Codex's review of the plan: reconciling passes whose worker died, the scheduler reading the gateway's own
  budget numbers instead of the agent's report, the gateway's real admission rule, an optional `github?` subscription, one
  event id per deploy, the board's real Save envelope, and issue numbers kept in the store instead of trusting search.
