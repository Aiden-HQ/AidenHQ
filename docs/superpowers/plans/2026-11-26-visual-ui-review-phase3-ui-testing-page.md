# Visual UI review, phase 3: the "UI testing" Fleet page Implementation Plan

> **Suggested workflow:** superpowers:subagent-driven-development (recommended) or superpowers:executing-plans, one task at a time, the steps tracked as checkboxes (`- [ ]`).

**Goal:** The owner lists apps on one Fleet page, picks per app how it is tested (URL or repo, login, models, spend mode,
live-app mode, schedule), and gets each app's design review as one refreshed GitHub issue with verified bugs as their own
issues (or a board report without a repo), with runs, before|after images and recordings on the page.

**Architecture:**

| Concern | Owner |
|---|---|
| The page, per-app settings, Run now / Stop, run history, images and recordings | the design module's view `ui://design/page` on its `design` connection (phase 1's service) |
| When a pass starts (on request, after a deploy, 24/7), one active pass per app, coverage resume | the design service's scheduler (`passes.ts`, phase 2's `startPass`) |
| The per-app daily cap | the design service's scheduler: it reads what the app's passes billed today from the kernel and starts no pass at the cap; each pass is bounded by the existing `task_usd`. The gateway keeps the install's one spend limit, unchanged |
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
- Per-app daily cap: `day_cap_usd` (default 5, at most 100), per UTC day, enforced by the scheduler, never by a new gateway
  limit (the owner keeps one spend limit, the install's). Before starting a pass it sums what today's pass tasks of that app
  billed: `GET /v1/work?task=<id>` (role `kernel.work-read`, which the design module requests) gives each ended job's
  `cost_usd` from the gateway ledger. With one active pass per app, every earlier pass of the day has ended when the
  scheduler looks, so no new kernel read is needed. A pass that starts below the cap runs to its own end, bounded by the
  existing `task_usd` (default 10): the day can overshoot the cap by at most one pass. The install's day and month limits
  still apply on top.
- Spend mode per app: `scan` (capture, design review, no fixes, no clicking), `standard` (default: plus top-3 rendered
  fixes and one clicking pass), `thorough` (the review on `anthropic/claude-opus-5.5`, top-5 fixes, two clicking passes).
  Models per app override any of `design`, `fixes`, `clicking` (OpenRouter ids).
- One editor per setting: `ui_testing` and the `ui_logins` paste field leave the generic module settings screen in this
  change; the page is their only editor.
- Board UI follows `docs/design/board-ui.md`; screenshots at 1512x982, 1920x1080, 2560x1440, 1024, 768 and 390, both themes.
- Issues: one "design improvements" issue per app, refreshed in place (marker `<!-- aidenhq-ui:design:<app> -->`), never a
  second; one issue per verified bug, never refiled while one with its marker is open, its marker
  `<!-- aidenhq-ui:bug:<app>:<sha256(page + "\n" + kind + "\n" + selector) first 12> -->` built from the page, the bug's
  kind and its repro's last step's selector, never the model's free-text title (so rewording the title refiles nothing).
  The design store remembers each issue's number by marker; a known number is updated (and reopened if closed), never
  searched for again. Images live on the board (the fleet has no image host on GitHub, and a page view can't be
  deep-linked): each issue names the run (`run r-…`) and points at the UI testing page, where runs are listed and found by
  id, and carries the fix diffs as text.
- Recordings: opt-in per app (`recording: true`), only of clicking-pass flows, VP8 webm, at most 2 minutes, and **at most
  6 MB as a file**, so its base64 (×4/3, plus padding) is at most 8 MB, the size `design_evidence_put` takes per call: the
  encoder targets ~320 kbps (`-b:v 320k`, a 2-minute flow ≈ 4.8 MB) and the recorder stops encoding and cuts the flow's clip
  when the file passes 6 MB, so `--record`'s output always fits one `design_evidence_put`. A recording put in its own
  call, never bundled with the other evidence. Test: a 2-minute flow yields a webm whose file is ≤ 6 MB and whose base64
  length is ≤ 8 MB.

## Review Focus

1. **Two triggers at once** (a deploy event while a 24/7 pass runs, the owner's Run now during an after-deploy pass): one
   pass; the second answers `already running`. Test: Task 1 `one active pass`.
2. **The cap reached during a pass**: the pass runs to its own end (bounded by `task_usd`, its partial report and queue
   saved), and the scheduler starts no further pass that day, from the ledger's billed cost alone. Test: Task 1 `cap`.
3. **An app removed or renamed while a pass runs**: the pass finishes or fails on its own; the scheduler never starts one
   for a name not in `ui_testing.apps`; the issue markers keep the old name's issue untouched. Test: Task 1 `removed app`.
4. **GitHub not connected, or the repo unreachable / issues disabled**: the report stays on the page (board report) and on
   the pass task, the run records `issues: unavailable: <reason>`; nothing retries in a loop. Covered by the skill and
   Task 5's acceptance run.
5. **A huge app on 24/7** (hundreds of pages): passes resume the coverage queue where the last stopped, so successive passes
   cover new pages instead of redoing the first ones; a full cycle starts over. Test: Task 1 `resume`.

## Lanes and PRs

| Lane | Tasks | Parallel with |
|---|---|---|
| S Scheduler and triggers | 1 | P, B |
| P The page | 2 | S, B |
| B Board building block | 3 | S, P |
| R Recordings, issues, skill | 4 | after S |
| Integration | 5 | after all |

One PR, `feat(design): UI testing page with per-app settings, schedules, issues and recordings`, merged after phase 1's
engine acceptance gate. It spans design, apps-platform (the event), the kernel's task listing, board (`secret_maps`, one
icon) and the schema; split by area only if it passes ~2k lines (then board + schema first). Lanes may build while
phase 1 is still in review.

---

### Task 1: Scheduler, triggers, one active pass, resume (lane S)

**Files:**
- Modify: `modules/design/module.yaml`:
  - `ui_testing.apps[]` entries gain `schedule: on-request|after-deploy|always` (default `on-request`), `day_cap_usd` (default 5),
    `spend: scan|standard|thorough` (default `standard`), `models: { design?, fixes?, clicking? }`,
    `live_mode: read|test-write|any` (default `read`), `recording: false`; `depth` and `mode` of `design_pass_start` default from them;
  - roles requests `kernel.work-read` (billed cost per task), and `kernel.tasks` reading lists closed tasks too
    (`GET /v1/tasks?source=…&status=closed`, `kernel/src/modtasks.ts` `list`): the cap sums a day's closed passes, not only
    the open ones;
  - `subscribes: { apps: { kinds: [app.deployed], resources: { setting: ui_testing, path: "apps[].name" } }, "github?": { kinds: [push], resources: { setting: ui_testing, path: "apps[].repo" } } }`
    (`github?`: optional, so the module compiles on an install without GitHub; a compile test without it);
  - `requires: [board]` (for the page).
- Modify: `modules/apps-platform/module.yaml` (the `apps` connection lists `events: { kinds: [app.deployed] }`; requests
  `kernel.events`), `modules/apps-platform/apps-mcp/src/deploy.ts` (after a deploy recorded `healthy`, one
  `POST /v1/events { connection: "apps", kind: "app.deployed", resource: <app>, id: <the deploy's write record id>, data: { sha } }`
  (the event log dedupes on `(connection, id)`: a retry of one deploy is one event, a redeploy of the same sha another); a failed
  send is logged, never the deploy's failure)
- Modify: `kernel/src/modtasks.ts` (`GET /v1/tasks?source=` lists a module's own source family too: a source starting
  `<that module>:`, beside the release module's `release:instance:`, with `status=closed` covering done and cancelled tasks
  as well as the open set; test in `kernel/test/modtasks.test.ts`: design lists `design:pass:` tasks open and closed, and is
  refused `github:` ones)
- Modify: `kernel/src/work.ts` (`GET /v1/work?task=` answers `billed: { day, cost_usd }[]`, the confirmed `calls` rows by
  `task_subject` and UTC day; test in `kernel/test/work.test.ts`: a closed task's job costs still appear)
- Create: `modules/design/service/src/schedule.ts`; modify `passes.ts`, `store.ts` (unique partial index
  `runs_active ON runs(app) WHERE kind = 'pass' AND status = 'running'`), `main.ts` (a 60 s tick; the feed cursor as code-review's)
- Test: `modules/design/test/schedule.e2e.test.ts`

**Interfaces (Produces):**
- `startPass(app: string, why: "request" | "deploy" | "always", o?: { depth?; mode?; model? }): { run: string; task: string } | { refused: "already running" | "cap reached today" | "unknown app" }`
  (the one entry: `design_pass_start`, the tick and the feed all call it); files the module task with
  source `design:pass:<app>:<run>` (so a day's pass tasks of an app are listed by source).
- `design_pass_stop { app }`: **stops the job, then closes the task, and only then frees the slot.** `POST /v1/tasks/:task/close`
  alone only writes the control plane's task record (`kernel/src/modtasks.ts:75–85`); it stops no box, so marking the run
  `stopped` on that call would free the unique slot while the pass still clicks and spends. The stop is the kernel's job-stop
  path (`DELETE /v1/jobs/:job`, the run's live job, as the module that dispatches it: `kernel/src/jobs.ts` `stop`), awaited
  until the job's state is `cancelled`/`done`; then the task is closed as `cancelled`; only then does the `runs_active` row
  leave `running` (`stopped`). If the job has not exited within 60 s the run stays `running` (slot held, "stopping") and the
  next tick tries again; the slot is never freed while a job of the pass is live. Test: Stop during a clicking pass files no
  second pass on Run now, and `fixtureServer.writes` stops growing.
- Resume: `design_run_finish` stores the pass's `queue.json` in its evidence; the task text names the previous run so the
  skill runs `ui-review capture --resume` from it; a queue with nothing left starts a new cycle.
- Cap: `startPass` reads the **gateway ledger**, not the task's jobs: the kernel's `GET /v1/work?task=<id>` gains
  `billed: { day: string; cost_usd: number }[]`, the confirmed spend of that task's jobs from the `calls` table by
  `task_subject` and UTC day (the same `settled` rows `work.ts` `since()` sums, `kernel/src/work.ts:130–136`). A task's job
  rows carry no cost (`work.ts:42,76–79`), and `/v1/tasks?source=` lists only open tasks (`kernel/src/modtasks.ts:110–123`),
  so a job-row sum would miss every closed pass: the ledger read has neither gap, a closed task's `calls` rows included.
  `startPass` lists the app's pass tasks filed today **and closed today** (the module's own source family, closed ones
  included: `GET /v1/tasks?source=design:pass:<app>:&status=closed`), reads each one's `billed` for the current UTC day, and
  refuses with `"cap reached today"` once the sum reaches `day_cap_usd`, until the UTC day changes; nothing depends on the
  agent reporting it. Test: a pass bills $5.10 (the ledger's `calls`), its task closes, and the next tick files none.
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
});
test("always runs back to back until the cap, then waits a day", async () => {
  settings({ apps: [{ name: "acme", url: U, schedule: "always" }] }); await tick(); finishRun(last()); closeTask(last());
  kernel.billed(tasks.filed[0].id, [{ day: today(), cost_usd: 3.0 }, { day: today(), cost_usd: 2.1 }]);   // the ledger's confirmed spend
  await tick(); assert.equal(tasks.filed.length, 1); clock.nextUtcDay(); await tick(); assert.equal(tasks.filed.length, 2);
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

### Task 2: The page `ui://design/page` (lane P)

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
  assert.deepEqual(pick(o.apps[0], ["name", "today_usd", "login"]), { name: "acme", today_usd: 1.2, login: false });   // today_usd: the same sum the scheduler uses
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

### Task 3: The `secret_maps` page building block (lane B)

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

### Task 4: Issues, board report fallback, recordings, skill (lane R)

**Files:**
- Modify: `modules/design/module.yaml` (ui-reviewer grants `github?: [github_whoami, github_issue_read, github_search_issues, github_issue_create, github_issue_update]`
  and `design: [..., design_issue_note]`; the `design` connection lists `design_issue_note` as a write tool),
  `modules/github/connections/github-mcp/src/{github.ts,main.ts}` (`github_issue_update` gains `body`, a whole-issue body
  replacement: the tool's input schema and its `updateIssue` send `PATCH base { body }` when `body` is given. Today the tool
  takes state, labels and assignees only, `modules/github/connections/github-mcp/src/main.ts:476–493`, so a refreshed
  design issue could not have its report replaced, only commented; the plan's "refreshed in place" needs the write. The body
  goes through `withFooter(body, agent)` as `create`'s does, so the refresh keeps the agent's signature and no stale report
  survives. Test: a second pass's `github_issue_update` changes the issue body and creates no second issue),
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
`design_run`. Skill's issue steps (positive how-to): a known number for the marker → `github_issue_update` its `body` (and
state `open`); no known number → search once for the marker (`github_search_issues repo:<r> is:issue "<marker>"`, open or
closed) and adopt what it finds, else `github_issue_create`; then `design_issue_note` at once, before anything else. Labels
are optional and never a prerequisite: create asks for `ui-design` (or `ui-bug` for a bug) **only when the repo has that
label** (the tool refuses a missing label, `modules/github/connections/github-mcp/src/github.ts:418–426`, and a create
without `labels` posts fine, `github.ts:612–614`), else creates the issue with no label and says so in the run's notes.
No repo, or GitHub not connected, or a refused write: the run's page is the report (`design_run_finish` stores it) and the
pass task's comment links it.

- [ ] **Step 1: Write the failing tests:**
```ts
test("issue bodies carry the markers and never an image URL outside the board", async () => {
  const { design, bugs } = await issueBodies(fixtureRunDir, { app: "acme", runUrl: "https://board.example.com/#/fleet/ui-testing", run: "r1" });
  assert.match(design, /<!-- aidenhq-ui:design:acme -->/); assert.match(design, /1\. .+\n.+Change:/);
  assert.ok(bugs.every((b) => /<!-- aidenhq-ui:bug:acme:[0-9a-f]{12} -->/.test(b)));
  assert.ok(!/!\[[^\]]*\]\((?!https:\/\/board\.example\.com)/.test(design));
});
test("two titles for the same bug give one marker", async () => {
  const a = issueBodies(runWith(bug({ page: "/items", title: "Archive does nothing", steps: [{ click: "text=Archive" }] })));
  const b = issueBodies(runWith(bug({ page: "/items", title: "Archive button is a no-op", steps: [{ click: "text=Archive" }] })));
  assert.equal(markerOf(a.bugs[0]), markerOf(b.bugs[0]));
});
test("a recorded flow is a short VP8 webm", async () => {
  const f = await recordFlow(fx("/"), [{ click: "text=Settings" }, { wait: "1000" }], { out });
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", f]).toString());
  assert.equal(probe.streams[0].codec_name, "vp8"); assert.ok(Number(probe.format.duration) <= 120);
  assert.ok(statSync(f).size <= 6e6); assert.ok(readFileSync(f).toString("base64").length <= 8e6);   // fits one design_evidence_put
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

### Task 5: Integration and acceptance (once)

- [ ] **Step 1:** Merge lanes; `node scripts/ci-local.ts`; engine tests in the image; board `tsc -p tsconfig.build.json`;
  Codex review of each PR; fix every important finding. Security review lines in the PR body for `secret_maps` (values
  never read back, only the owner's board session writes them) and for the event route (apps-platform may send only
  `app.deployed` on `apps`).
- [ ] **Step 2:** Deploy once for the phase, after the PR merges. Acceptance: add the board and Roadmap Keeper on the page (Roadmap Keeper
  `after-deploy`, cap $5); Run now on the board → one design issue with a run link, verified bugs only, today's spend shown;
  a Roadmap Keeper deploy starts one pass; a second Run now answers "already running"; set cap $0.50 and see `cap reached`
  and no further pass that day; screenshots of the page at the six widths in both themes.
- [ ] **Step 3:** Remove worktrees and branches.

## New installs

The page shows its empty state; nothing runs until the owner adds an app, and every app starts `on-request`. Without
GitHub, reports stay on the page. Without the apps platform's event (an older apps-platform), `after-deploy` works only for
repo apps (pushes to the default branch). The per-app cap costs nothing when no app sets a schedule.

## Self-review

- Spec coverage: the Fleet page in the design module (3), per-app settings URL/repo, login, models, spend mode, live-app
  mode (1, 2, 3), on request by default with after-deploy + daily cap and 24/7 opt-in (1), one active pass per app (1), the
  cap in the scheduler from the ledger's billed cost (1), coverage queue resume (1), issues via the github connection, one
  refreshed design issue per app plus verified bug issues, board report fallback (4), recordings (4).
- Gaps decided here: images are linked on the board, not embedded on GitHub (the fleet has no binary write to GitHub);
  "spend mode" is defined as the three depth presets above; the spec's "cap enforced in the gateway" became a
  scheduler check over the gateway's ledger (owner, 2026-11-26: one spend limit), so a day can overshoot by one pass.
- Types: `startPass`, `UiApp` (`ui_testing.apps[]`), the pass source `design:pass:<app>:<run>` and the issue markers match
  across Tasks 1-4.
- Folded in from Codex's review of the plan: reconciling passes whose worker died, the scheduler reading the ledger's
  billed cost instead of the agent's report, an optional `github?` subscription, one
  event id per deploy, the board's real Save envelope, and issue numbers kept in the store instead of trusting search.
