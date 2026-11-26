# Visual UI review, phase 1: design review on request Implementation Plan

> **Suggested workflow:** superpowers:subagent-driven-development (recommended) or superpowers:executing-plans, one task at a time, the steps tracked as checkboxes (`- [ ]`).

**Goal:** The UI Reviewer, asked by the owner, Aiden or another agent, opens an app at every width and theme, measures it,
and returns a ranked design review, with a rendered before|after for each of the top fixes that a pairwise check confirms.
A code-review repo review can run the same scan as the `ui.scan` option and publish it to Primer.

**Architecture:**

| Concern | Owner (one each) |
|---|---|
| Capture, coverage queue, page list, measurements (design and motion), rule checks, model calls, pairwise check | the engine `ui-review` (agent-base image), rewritten as a TypeScript package on Playwright over the image's Chrome |
| Judgment: which app, how to run it, reading the router, picking and implementing fixes, writing the report | the UI Reviewer (one agent, one skill `design.ui-review`) |
| Runs, evidence (report and cited images), retention | the design module's new service `design` (its connection `design`, tools `design_*`) |
| The unattended scan of a repo at a commit | code-review's `ui.scan` option: a token-free capture check (`code-review-ui`) then a model check over its report (`code-review-ui-review`), report to Primer |
| Taste | universal NEVER/INSTEAD rules in the product; the owner's positive preferences and references in the instance repo |

The engine decides nothing about taste: it captures, measures and asks the model with the prompts it ships; the agent runs
it, adds fixes, and reports. The check-job path runs the same engine commands with no agent.

**Tech Stack:** TypeScript on Node 24 (`.ts` run directly), `playwright-core` 1.65.1 (the version the app starter pins for
`@playwright/test`) driving `/opt/chrome/chrome` over CDP, `axe-core` (pin with `scripts/supply-chain/best-version.ts`),
`node:sqlite` and `node:test` in the design service, the kernel's model gateway (OpenRouter ids).

**Spec:** `docs/superpowers/specs/2026-11-26-visual-ui-review-design.md` (PR #1889). Evidence:
`aidenhq-alpha/aidenhq-instance#20`, merged: `docs/product-history/research/2026-11-26-visual-ui-review/` (01 bugs,
discovery and logins; 02 design critique and the board's top 10; 03 taste stack and the NEVER-rules draft; owner taste
ground truth). The spike's scripts and planted-bug set (`design/cap.mjs`, `judge/capture.mjs`, `planted.diff`,
`answer-key.md`, `routes.json`, `design/allpages.txt`) are not in that PR: Task 0 copies them into the same instance folder
under `spike-code/` before any lane starts.

**Builds on #1876 as merged.** Assumed from it (verify before starting; each line is a precondition, not work here):
- `ui-review` has the route check (app not-found fingerprint, blank routes, dead controls on a second click from
  `about:blank`), the one readiness wait (no `networkidle`), inner-scroll steps, the frozen clock init script and the
  "Look at these first" before|after section. Phase 1 ports these into the package, unchanged in behaviour.
- The automatic per-PR UI review is gone: no `modules/github/service/src/design-review.ts`, no `design-review` role or
  `commit_status_set` grant in `modules/design/module.yaml`, no `design_review` wait reason in `modules/github/service/src/flow.ts`
  / `merge-gate.ts`, no design-review check in `kernel/sdk/src/checks.ts`, nothing in `services/board/web/src/ui/TaskState.tsx`
  or `modules/tasks/skills/delegate-work/SKILL.md`.
  Check: `git grep -nE 'design-review|design_review' origin/main -- modules kernel services scripts` prints nothing.
- The UI Reviewer's handbook describes an on-request designer, not a PR gate.

  As of `origin/fix/ui-review-spike` 702a1a9 the second and third items are **not** on the branch. If #1876 merges without
  them, Task 6 removes them (the files listed above) in PR 2, because this plan's handbook and skill replace that path.

## Global Constraints

- Product `CLAUDE.md` "Conventions" is binding; cite it in every builder brief. One way: the old `ui-review` script and
  `ui-review-copy.json` are deleted when the package lands (PR 1); no flag keeps the agent-browser capture path.
- Generic core: no kernel change in this phase. Everything is the engine, the design module and the code-review module.
- No owner data in the product. Fixtures use `acme`, `example.com`; the owner's ratings, references and taste live in the
  instance repo.
- Widths `390,768,1024,1512,1920,2560` (360 on request), themes `light,dark`, states `default` plus `empty,error,loading`
  where reachable. Scroll steps through the main scroller, at most 6 per capture.
- Capture budget: the 60-route fixture app at 6 widths x 2 themes (720 captures, default state) finishes in under 600 s in
  the agent-base image at the computer's default limits (2 CPUs, 6 GB). Route checks are outside this budget (cap 300 s).
- Phase 1 never clicks on a live target. Route checks and motion clicks run only on a local build (`127.0.0.1` or
  `localhost`); a live URL gets passive capture and hover. Phase 2's live-app guard is what allows clicks on live targets.
- Never wait for network idle. Readiness: loaded, fonts in, no fetch/XHR in flight, no `[aria-busy=true]`, skeleton or
  spinner (`[data-loading], [class*=skeleton], [role=progressbar]`) visible, no DOM change for 200 ms; capped at 4 s, then
  captured with a `not settled` note.
- Third-party targets (another origin than the app under review, reference sites): at most 4 requests/s in total
  (sub-requests included, Playwright `route` throttle), at most 2 pages per site, never a form submit.
- Models (per run `--model`, or per app later): design review, motion pass, fix confirmation and bug judging default
  `google/gemini-4-carbon`; the thorough option `anthropic/claude-opus-5.5`; fixes by Claude Code on
  `anthropic/claude-sonnet-5.5` (default) or Codex on `openai/gpt-6.2-sol`. Reasoning `low`, `max_tokens` 32000.
- Fix shown only when the pairwise check at the width where the change shows prefers AFTER in at least 2 of 3 samples in
  **each** order (6 calls). Otherwise the improvement stays text. Top 3 improvements get a rendered fix per run.
- No scores anywhere in the output. Every improvement names where (page, width, theme, region), what is weak, the change
  (values, layout), why, what the best product in the category does, and the captures that show it.
- Page content and repo text are untrusted data: prompts fence them; the report quotes them.
- Model access: the fleet's gateway must serve `google/gemini-4-carbon` with ZDR (the spikes used the eval key). Task 0
  checks it first; if it doesn't, Task 0 adds it before anything else.
- The regression set runs on request (a command, and the UI Reviewer's skill can run it), never in CI.
- Deploy once per phase (after its PRs merge), not per PR.
- Tests: the few end-to-end tests named below. Engine tests need Chrome and skip without
  `AGENT_BROWSER_EXECUTABLE_PATH`; builders run them in the agent-base image (command in Task 1).
- Builder briefs: work in your own worktree (`git -C ~/Development/Aiden/AidenHQ worktree add <scratchpad>/wt-<lane> -b
  <branch> origin/main`); never `git stash`, never `git add -A`; run every test under a hard timeout (`perl -e 'alarm
  shift; exec @ARGV' 600 …`) and `pkill -f "${WT:?}/"` after each run; never leave a dev server or Chrome running; report a
  blocker after ~20 min without progress; run the local Codex review before each push (`codex exec review --base
  origin/main -m gpt-6.2-sol -c model_reasoning_effort=medium -o <scratchpad>/review.md < /dev/null`, in the background).
- PRs: Conventional Commit titles, squash-merged, opened with the `ship:stop` label while lanes integrate. No per-task
  review gate: lanes build in parallel, then one integration review and CI.

## Renamed and changed behaviour of `ui-review` (listed in PR 1's body; nothing is dropped)

| Today (#1876) | After PR 1 |
|---|---|
| `ui-review <url> …` runs capture and the route check together | `ui-review capture <url> …` and `ui-review routes <url> …`, two subcommands (a capture never waits on clicks) |
| `--modes light,dark`; widths 390,768,1280 | `--themes light,dark`; widths 390,768,1024,1512,1920,2560 |
| `--full` (whole page or scroll steps) | always scroll steps through the main scroller (at most 6) |
| `--no-routes` | gone: routes are their own subcommand |
| headless web vitals (LCP, CLS) as notes | kept as non-blocking notes, per capture at the widths it runs; layout shift during interactions is added (`Motion.shifts`) |
| "One system" and "Copy" notes | kept, inside `Measures` (`signatures`) and as notes (the copy word lists move to `copy.json`) |
| `--paths`, `--palettes`, `--wait-text`, `--commit`, `--baseline`, "Look at these first", "Already on this base", exit 1 on blocking findings, `<page>-<width>-<mode>.png` names and the `aidenhq` PNG stamp | kept unchanged (the grader reads the stamp: `modules/grading/service/src/grader/images.ts`) |
| feature-map.json in the working folder | kept; `--pages-file <file>` takes a `{"pages": [{path, shows}]}` page list in its place (the router read's output), and a same-shape `feature-map.json` beside it is what `--map <file>` pointed at |

## Review Focus

1. **A live app that never settles** (polling, a clock, a websocket feed): every capture still completes within the 4 s
   readiness cap and is marked `not settled`; the run never aborts. Test: fixture route `/live` in Task 1.
2. **An app whose page list is wrong or huge** (a router read listing 300 routes, query states, role-gated pages): the queue
   caps at 120 pages per run, keeps feature-map and router order, records the rest as `deferred`, and `--resume` takes them
   next. Test: Task 2 `resume`.
3. **A model answer that is not the JSON asked for, or cites a capture that doesn't exist**: one retry with the parse error,
   then that page's review is `failed` with the reason; an improvement citing an unknown capture is dropped. Test: Task 4
   fake model returns one malformed and one bad-citation answer.
4. **A fix that breaks the build or another width**: the fix is reverted, the improvement stays text with `fix: failed`
   and the build error's first line; the pairwise check judges only the width where the change shows, but the after
   capture of the other widths is taken and diffed, and any page whose pixels change by more than 0.1% outside the target
   page is listed as collateral. The loop is the skill's (agent judgment); its code parts are tested where they live: the
   baseline diff in Task 2 (`two runs with one baseline`), the check in Task 5; the loop itself in Task 10's acceptance run.
5. **A third-party reference site that refuses or rate-limits** (403, 429, a bot wall): the reference is skipped with the
   reason and the review proceeds with the remaining ones; request rate never exceeds 4/s. Test: Task 3 `refs`.

## File structure

```
services/computer/images/agent-base/ui-review/        the engine package (replaces the ui-review script)
  package.json, package-lock.json                     playwright-core 1.65.1, axe-core (exact pins)
  main.ts                                             CLI: capture | pages | routes | refs | review | fix-check
  types.ts                                            the report contract (every lane imports it)
  browser.ts                                          Chrome on a CDP port, Playwright contexts pool, politeness
  queue.ts                                            coverage queue (queue.json), resume
  pages.ts                                            page list: feature map > pages.json (router read) > links + sitemaps
  capture.ts                                          readiness, frozen clock, scroll steps, states, PNG stamp
  measure.ts                                          design measurements (in-page script + cross-page consistency)
  motion.ts                                           motion measurements (CSS, getAnimations, long frames, shifts)
  rules.ts                                            axe, overflow, page errors, failed loads (ported, non-taste)
  routes.ts                                           #1876's route check, ported unchanged
  model.ts                                            OpenRouter-compatible client (images, JSON, retry once)
  review.ts                                           design review, motion pass, bug judging, consolidation
  pairwise.ts                                         fix confirmation, both orders x 3
  report.ts                                           report.json + report.md
  prompts/{design,consolidate,motion,bugs,pairwise,router-read}.md
  rules/taste-never.md                                universal NEVER/INSTEAD rules (product)
  refs/{review-animations.md,krehel-polish.md,LICENSES}  MIT reference text for the motion pass, pinned
  refs/references.json                                reference URLs per page kind with their measured tokens (no screenshots)
  refs/fallback.json                                  the app starter's catalog, used only when a kind's URLs all fail
  copy.json                                           the copy check's word lists (was ui-review-copy.json)
services/computer/test/ui-review.e2e.test.ts          engine end-to-end tests (Chrome; skip without it)
services/computer/test/fixtures/ui-app/               the 60-route fixture SPA (generated routes, planted defects)
modules/design/service/                               evidence store + design_* tools (new)
modules/design/skills/ui-review/SKILL.md              how the UI Reviewer works (the one skill)
modules/design/eval/                                  regression set runner and neutral cases
modules/code-review/recipe/ui.ts, ui-review.ts       the ui.scan check jobs (capture, then review)
```

## Lanes and PRs

| Lane | Tasks | Parallel with | PR |
|---|---|---|---|
| 0 Access and spike code | 0 (model access check, spike scripts into the instance) | first, alone (an hour) | |
| 0 Contract | 1 (types, fixture, image wiring) | first, alone (half a day) | 1 |
| A Capture | 2 | B, C, D, E | 1 `feat(computer): ui-review engine on Playwright: fast capture, coverage queue, design and motion measurements` |
| B Measurements | 3 | A, C, D, E | 1 |
| C Review pipeline | 4, 5 | A, B, D, E | 2 `feat(design): the UI Reviewer's design review with rendered fixes and an evidence store` |
| D Design module | 6, 7 | A, B, C, E | 2 |
| E Code-review lens | 8 | A-D | 3 `feat(code-review): ui lens, ui.scan as a whole-repo check job reporting to Primer` |
| F Evaluation set | 9 | after C's prompts exist | 2 |

PR 1 updates every caller of the CLI in the same PR (Task 1 Step 6). **PR 1 merges first and alone, only after the engine
acceptance gate (Task 2b)**, because its tests skip in CI. After it, **PR 2 merges before PR 3**: PR 3's `ui.scan` recipe
runs `ui-review review`, which Task 4 builds in PR 2 (PR 1 ships its stub, which exits 2). PR 2 and PR 3 (and phases 2 and
3) may build in parallel, but PR 3 merges only once PR 2 is on `main`. Integration: one Codex review
of each PR plus CI, then the manual acceptance run (Task 10).

---

### Task 0: Model access and the spike's code (lane 0, before everything)

- [ ] **Step 1: Check the fleet's gateway serves Carbon with ZDR.** From an agent box (a TEST task) or the host with a job
  token: `curl -s "$AIDENHQ_GATEWAY_URL/api/v1/models?ids=google/gemini-4-carbon"` lists it, and one call
  (`POST $AIDENHQ_GATEWAY_URL/api/v1/chat/completions` with one small image, `reasoning: {effort: "low"}`) answers 200.
  Check the OpenRouter key's ZDR routing covers the model (the account's ZDR setting, and the provider OpenRouter picks
  for it is on its ZDR list). Expected: both pass. If either fails, this task adds it first, in the product
  (the gateway's model admission or provider routing, wherever the refusal comes from) or as the owner's one OpenRouter
  setting, and nothing else starts until the call passes.
- [ ] **Step 2:** Copy the spike's `design/cap.mjs`, `judge/capture.mjs`, `planted.diff`, `answer-key.md`, `routes.json` and
  `design/allpages.txt` from `/private/tmp/claude-501/-Users-mgupta-Development-Aiden/63342b03-a416-4700-bdb6-9ba5751e59ce/scratchpad/uispike` into the instance repo's
  `docs/product-history/research/2026-11-26-visual-ui-review/spike-code/` (one instance PR). The answer key is for scoring
  the acceptance gate only, never shown to a model.

### Task 1: The report contract, the fixture app and the image wiring (lane 0)

**Files:**
- Create: `services/computer/images/agent-base/ui-review/{package.json,package-lock.json,types.ts,main.ts}`
- Create: `services/computer/test/fixtures/ui-app/{server.ts,app.js}` (one HTML shell, hash router, 60 routes generated
  from a list, `/live` polls every 50 ms, `/scroll` scrolls inside a `main` container, `/planted` carries the Task 3 plants, `/clock` renders "2m ago" from
  `Date.now()`, `/danger` has Delete and Pay buttons that POST; the server counts writes)
- Modify: `services/computer/images/agent-base/Dockerfile` (replace the two `ui-review` COPY lines with
  `COPY ui-review /opt/aidenhq/ui-review`, `RUN cd /opt/aidenhq/ui-review && npm ci --ignore-scripts --no-audit --no-fund`,
  and a `/usr/local/bin/ui-review` shim `exec node /opt/aidenhq/ui-review/main.ts "$@"`; the build check launches Chrome
  through `playwright-core`)
- Delete: `services/computer/images/agent-base/ui-review` (the script), `ui-review-copy.json`
- Create: `services/computer/images/agent-base/ui-review/.gitignore` (`node_modules/`)
- Modify: `.github/ci/areas.json` (add `services/computer/images/agent-base/ui-review` to the `services/computer` suite's
  `paths`: `scripts/test/ci-areas.test.ts` requires a suite's imports to sit inside its paths; the `markdown` list stays)

**Interfaces (Produces; every later task imports these from `types.ts`):**
```ts
export type Theme = "light" | "dark";
export type State = "default" | "empty" | "error" | "loading";
export type Page = { path: string; shows?: string; kind?: PageKind; source: "feature-map" | "router" | "links" | "sitemap" };
export type PageKind = "dashboard" | "list" | "detail" | "form" | "settings" | "timeline" | "marketing" | "other";
export type QueueItem = { page: string; width: number; theme: Theme; state: State; status: "todo" | "done" | "failed" | "deferred"; tries: number; why?: string };
export type Capture = { page: string; width: number; theme: Theme; state: State; url: string; shots: string[]; settled: boolean; measures: Measures; motion?: Motion; rules: RuleHit[] };
export type Measures = {
  fonts: { size: number; weight: number; n: number }[]; colours: { value: string; n: number }[]; radii: string[]; shadows: string[];
  spacing: { values: number[]; offScale: number[] };                // offScale: values not on the 4px scale
  nearMisses: { a: string; b: string; dx: number }[];               // left edges 1-3px apart
  content: { width: number; viewport: number };                     // main content width vs viewport
  ctas: { label: string; filled: boolean; contrast: number; area: number }[];
  contrastFails: number; signatures: Record<"button" | "card" | "heading" | "input", string[]>;
};
export type Motion = {
  transitions: { property: string; duration: number; easing: string; n: number; examples: string[] }[];
  animations: { name: string; target: string; duration: number; easing: string; iterations: number; playState: string }[];
  hover: string[]; active: string[]; keyframes: { name: string; css: string }[]; longFrames: number[]; shifts: number[];
};
export type RuleHit = { rule: string; blocking: boolean; text: string };
export type Improvement = {
  rank: number; category: "polish" | "ease"; where: { page: string; width: number; theme: Theme; region: string };
  weak: string; change: string; why: string; best: string; captures: string[];
  fix?: { status: "shown" | "rejected" | "failed"; diff?: string; before?: string; after?: string; wins?: [number, number]; why?: string; collateral?: string[] };
};
export type MotionRow = { where: string; before: string; after: string; why: string; css: string };
export type Bug = { page: string; width: number; theme: Theme; title: string; evidence: string; captures: string[]; verified: boolean; repro?: string[];
  // A bug's stable identity for its issue marker (phase 3 keys on it, never on the model's title): its kind, and its repro's
  // last step's selector. `repro` (phase 2) fills both when it verifies the bug; a bug without them files no issue.
  kind?: "friction" | "bug"; selector?: string };
export type Report = { version: 2; target: string; commit?: string; frozenAt: string; model: string; coverage: { done: number; total: number; failed: number; deferred: number };
  captures: Capture[]; improvements: Improvement[]; motion: MotionRow[]; bugs: Bug[]; notes: string[]; cost_usd: number };
```

- [ ] **Step 1:** Write `types.ts` as above and `main.ts` dispatching the subcommands (each a stub that exits 2 "not built
  yet" until its lane lands). `ui-review --help` prints the six subcommands.
- [ ] **Step 2:** Write the fixture app (route list in `app.js`; `server.ts` serves it on a given port; neutral copy).
- [ ] **Step 3:** Wire the Dockerfile; build: `ops/computer-images.sh agent-base` (or `docker build` with the browser
  base). Expected: build passes the Chrome launch check; `docker run --rm aidenhq/computer-agent-base:current ui-review --help`
  lists the subcommands.
- [ ] **Step 4:** The command every engine test uses (put it in the test file's header comment). It tests the worktree's
  code, not the image's copy: the package's dependencies are installed into the mounted folder first.
  `docker run --rm --cpus 2 --memory 6g -v "$WT":/w aidenhq/computer-agent-base:current sh -c 'cd /w/services/computer/images/agent-base/ui-review && npm ci --ignore-scripts --no-audit --no-fund && cd /w/services/computer && perl -e "alarm shift; exec @ARGV" 900 node --test test/ui-review.e2e.test.ts'`
  Expected before any lane lands: the tests are skipped or fail with "not built yet"; with no Chrome (CI) they are skipped.
- [ ] **Step 5:** Commit `feat(computer): ui-review package skeleton, report contract and fixture app`.
- [ ] **Step 6 (at integration, still PR 1):** update every caller to the new CLI and words:
  `modules/design/agents/{ui-designer,ui-reviewer}/AGENTS.md` (the reviewer's commands only; its rewrite is Task 7),
  `modules/engineering/skills/build-app/SKILL.md`, `modules/fleet-steward/skills/fleet-review/SKILL.md`,
  `modules/apps-platform/design-system/{README.md,guidelines.md,review-checklist.md}`,
  `modules/apps-platform/starter/{AGENTS.md,README.md,test/app.test.mjs,public/theme.js,src/catalog/catalog.tsx}` (then
  `node scripts/sync-shared.ts` for the agent-base copies), `modules/engineering/test/evals/engineer/cases/app-header-brand-link.json`,
  `docs/configuration.md`, `docs/design/design-system.md`; delete `services/computer/test/fixtures/agent-browser-stub.cts` if
  nothing else uses it. Check: `git grep -nE 'ui-review (http|[^ ]+ --(modes|full|no-routes))' -- modules services docs ':!docs/superpowers'` prints nothing.

### Task 2: Capture, coverage queue, page list (lane A)

Start from the spike's capture code (`spike-code/cap.mjs`: Playwright on Chrome, five widths, concurrency, pacing, the
in-page stats; `spike-code/capture.mjs`: the board captures with the mock API) rather than from a blank file, and from
#1876's script for readiness, the frozen clock, inner scroll and the route check.

**Files:** `browser.ts`, `queue.ts`, `pages.ts`, `capture.ts`, `routes.ts`, `rules.ts`, `report.ts` (capture part);
test `services/computer/test/ui-review.e2e.test.ts`.

**Interfaces:**
- Consumes: `types.ts`.
- Produces:
  - `launch(o: { port?: number; politeness?: { origin: string; rps: number } }): Promise<{ cdp: string; browser: Browser; close(): Promise<void> }>`
    (Chrome started by the engine with `--remote-debugging-port`; `cdp` is the `ws://` endpoint an agent attaches to with
    `agent-browser --cdp <port>`; written to `<out>/browser.json`).
  - `pageList(base: string, o: { featureMap?: string; pagesFile?: string; crawl: boolean }): Promise<Page[]>`: the feature map
    when present, else `pages.json` (the router read the agent or recipe wrote), else a same-origin link crawl (depth 2, 120
    pages) plus `sitemap.xml` only when it answers `application/xml` or `text/xml`.
  - `openQueue(file: string, pages: Page[], o: { widths: number[]; themes: Theme[]; states: State[]; max: number }): Queue`
    with `next(): QueueItem | undefined`, `done(i, c: Capture)`, `failed(i, why)`, `counts()`; persisted to `queue.json`
    after each item; `--resume` reopens it.
  - `capture(ctx: BrowserContext, base: string, item: QueueItem, o: { out: string; frozenAt: string; commit?: string }): Promise<Capture>`.
  - Web vitals: LCP and CLS per capture as non-blocking notes, as today.
  - CLI: `ui-review capture <url> --out <dir> [--pages-file f] [--widths ..] [--themes ..] [--states ..] [--resume] [--baseline <dir>] [--commit sha] [--workers 4]`
    and `ui-review routes <url> --out <dir>` (the route check, now its own subcommand so a capture never waits on it; it
    exits 2 "route checks click: a local build only" for a non-local target until phase 2's guard). `--pages-file` is the
    only page-list flag: the router read's `{"pages": [{path, shows}]}` file, whose `shows` is the page's `shows`; the
    package has no `--map`.

Decisions the code must follow:
- Workers: `--workers` (default 4) Playwright contexts on one Chrome; one context per (width, theme), reused across pages.
- Frozen clock: `context.addInitScript` with #1876's `Date` proxy and request tracker; `frozenAt` is the baseline's when
  `--baseline`.
- States: `empty` routes same-origin JSON GETs through `route()` to `[]` for array bodies and `{}`-with-empty-arrays for
  objects; `error` answers them 500; `loading` delays them 10 s and captures at 400 ms. A state whose capture is
  pixel-identical to `default` is recorded as `not reachable` and its PNG dropped.
- Shots: viewport-sized steps through the largest overflowing scroller (#1876's `SCROLLER`), else full page capped at 6
  viewport heights. PNGs stamped as #1876 does (`aidenhq` text chunk).
- `--baseline`: per-capture pixel diff with `agent-browser diff screenshot` (as #1876 does; agent-browser stays in the
  image for agents); changed captures (>= 0.1%) go to "Look at these first" as today.

- [ ] **Step 1: Write the failing tests** in `ui-review.e2e.test.ts` (skip when `!process.env.AGENT_BROWSER_EXECUTABLE_PATH`):
```ts
test("capture covers 60 routes at 6 widths x 2 themes under 600 s", async () => {
  const t0 = Date.now(); const r = await runCapture(fixtureUrl, { widths: W6, themes: ["light", "dark"] });
  assert.equal(r.coverage.total, 720); assert.equal(r.coverage.done, 720); assert.ok(Date.now() - t0 < 600_000);
  assert.ok(r.captures.find((c) => c.page === "/scroll" && c.width === 1512)!.shots.length >= 2);
  assert.equal(r.captures.find((c) => c.page === "/live")!.settled, false);   // capped, not aborted
});
test("resume picks up a killed run without repeats", async () => {
  const p = startCapture(fixtureUrl, { out }); await waitForDone(out, 100); p.kill("SIGKILL");
  const r = await runCapture(fixtureUrl, { out, resume: true });
  assert.equal(r.coverage.done, r.coverage.total); assert.equal(new Set(r.captures.map(key)).size, r.captures.length);
});
test("two runs with one baseline show identical relative times", async () => {
  const before = await runCapture(fixtureUrl, { pages: ["/clock", "/planted"], widths: [1512], themes: ["light"] });
  await sleep(61_000); fixture.set("planted-title", "Changed");
  const after = await runCapture(fixtureUrl, { pages: ["/clock", "/planted"], widths: [1512], themes: ["light"], baseline: before.out });
  assert.deepEqual(after.lookFirst.map((c) => c.page), ["/planted"]);   // /clock unchanged: the clock is frozen
});
test("a live target is never clicked", async () => {
  const r = await runCapture(liveAlias + "/#/danger", { widths: [1512], themes: ["light"] });   // a non-local host name, mapped to the fixture
  await runRoutes(liveAlias + "/#/danger").catch(() => {});
  assert.equal(fixture.writes, 0); assert.ok(r.captures[0].motion);    // measured passively
});
test("the queue takes 120 pages and defers the rest", async () => {
  const r = await runCapture(fixtureUrl, { pagesFile: pages(300), widths: [1512], themes: ["light"] });
  assert.equal(r.coverage.done, 120); assert.equal(r.coverage.deferred, 180);
  const next = await runCapture(fixtureUrl, { out: r.out, resume: true }); assert.equal(next.coverage.done, 240);
});
```
- [ ] **Step 2:** Run (Task 1 Step 4 command). Expected: FAIL, `capture` exits 2.
- [ ] **Step 3:** Implement the interfaces above; port `routes.ts` and `rules.ts` from the #1876 script with the same
  findings and words (the `capture` subcommand calls `rules` per capture; `routes` stays separate).
- [ ] **Step 4:** Run. Expected: 3 pass; the timing test prints its wall time (record it in the PR body).
- [ ] **Step 5:** Commit `feat(computer): ui-review capture on Playwright with a resumable coverage queue`.

### Task 2b: Engine acceptance gate (lanes A and B, before PR 1 merges)

The engine's tests skip in CI (no Chrome), so PR 1 merges only on this measured run, recorded in its body (wall times,
counts, the scored table). Run it in the agent-base image built from the PR's head (Lima's Docker on the owner's Mac
works, or the image built locally), at 2 CPUs and 6 GB.

- [ ] **Step 1: Board matrix under 10 minutes.** The board built from `origin/main` with its mock API (the spike's setup:
  `spike-code/capture.mjs`), every page in `spike-code/allpages.txt` (the router's pages), 6 widths × 2 themes.
  Expected: `ui-review capture` finishes in under 600 s with `coverage.done == total`.
- [ ] **Step 2: No loading states in the shots.** Every capture is `settled` or carries the `not settled` note; a scan of
  the PNGs' pages for skeleton or spinner nodes at capture time (`[aria-busy=true]`, `[class*=skeleton]`, `[role=progressbar]`,
  recorded per capture) finds none.
- [ ] **Step 3: Planted bugs.** Apply `spike-code/planted.diff` to a second board checkout; capture it with `--baseline`
  the clean run, then `ui-review routes` on it. Score with `spike-code/answer-key.md` (scoring only): a planted bug counts
  when its page, width and theme are listed under "Look at these first" (B6 and B7, behaviour, when `routes` reports
  them). Expected: at least 8 of 10.
- [ ] **Step 4: Callers.** Every caller updated in Task 1 Step 6 runs: the starter's `test/app.test.mjs`, the build-app
  skill's and fleet-review skill's commands as written, the grader's stamp read
  (`modules/grading/test/app-captures.test.ts`). Expected: all pass.

### Task 3: Design and motion measurements, references (lane B)

**Files:** `measure.ts`, `motion.ts`, `refs/references.json`, `refs/fallback.json`, `refs/review-animations.md`, `refs/krehel-polish.md`,
`refs/LICENSES` (MIT texts, pinned upstream commits named in the file header), `main.ts` (`refs` subcommand); fixture
`/planted` route; test in `ui-review.e2e.test.ts`.

**Interfaces:**
- Produces: `measurePage(page: PwPage): Promise<Measures>`, `crossPage(caps: Capture[]): { component: string; variants: { signature: string; pages: string[] }[] }[]`,
  `measureMotion(page: PwPage): Promise<Motion>` and `ui-review refs <refs.json> --out <dir>`: captures each reference
  (1512 and 390, light) under the politeness cap and writes `refs.json` with `{ kind: PageKind; url; shots; tokens: { typeScale: number[]; rowHeight: number; radius: string; maxWidth: number } }[]`.
- `refs/references.json`: per `PageKind`, two or three public pages of well-known polished products, each
  `{ kind, url, product, tokens }` with the tokens measured when the list is written (by `ui-review refs --measure`), so a
  review has the numbers even when a page fails. Candidates to verify (each must load without sign-in and show that kind
  of screen): dashboard `ui.shadcn.com/examples/dashboard`, `stripe.com/payments`; list `ui.shadcn.com/examples/tasks`,
  `linear.app/changelog`; detail `ui.shadcn.com/examples/mail`; form and settings `ui.shadcn.com/examples/forms`,
  `vercel.com/docs`; timeline `linear.app/changelog`, `vercel.com/changelog`; marketing `stripe.com`, `linear.app`. The
  product ships URLs and numbers only: references are captured at run time under the politeness caps, never stored in
  the repo.
- `refs/fallback.json`: the app starter's catalog specimens per `PageKind` (served by the engine on a local port), used
  only for a kind whose every reference URL fails to load; the run's notes say so.

Decisions:
- Spacing: margins, paddings and gaps of visible boxes; `offScale` = values not divisible by 4 (2 allowed under 8px).
- Motion (measured, never from video): computed `transition-*` per element (grouped), `document.getAnimations()` with
  `playState === "running"` only (a finished animation held by `fill-mode` is excluded), `:hover`/`:active` rules and
  `@keyframes` read from same-origin stylesheets, `PerformanceObserver("long-animation-frame")` durations, and layout-shift
  values recorded while each of up to 5 controls is hovered (and, on a local build only, clicked; see Global Constraints).

- [ ] **Step 1: Write the failing test:**
```ts
test("measurements find the planted defects", async () => {
  const c = await captureOne(fixtureUrl + "#/planted", 1512, "light");
  assert.ok(c.measures.spacing.offScale.includes(13));                   // one 13px gap among 8/16/24
  assert.ok(c.measures.fonts.some((f) => f.size === 15));                 // one stray size among 12/14/16/20
  assert.ok(c.measures.colours.some((x) => x.value === "rgb(255, 0, 170)"));
  assert.ok(c.measures.nearMisses.length >= 1);                           // two cards 2px out of line
  assert.ok(c.motion!.transitions.some((t) => t.duration >= 600));        // the planted slow transition
  assert.ok(!c.motion!.animations.some((a) => a.playState === "finished"));
});
test("refs skip a refusing site, fall back to the starter for a dead kind, and keep to 4 requests/s", async () => {
  const r = await refs([{ kind: "list", url: thirdParty("/ok") }, { kind: "list", url: thirdParty("/429") }, { kind: "form", url: thirdParty("/403") }]);
  assert.equal(r.refs.filter((x) => x.kind === "list").length, 1); assert.match(r.notes.join("\n"), /429/);
  assert.equal(r.refs.find((x) => x.kind === "form")!.source, "fallback");
  assert.ok(thirdPartyServer.maxPerSecond() <= 4);
});
```
- [ ] **Step 2:** Run; expected FAIL. **Step 3:** Implement. **Step 4:** Run; expected PASS.
- [ ] **Step 5:** Commit `feat(computer): ui-review design and motion measurements and category references`.

### Task 4: The design review and the motion pass (lane C)

**Files:** `model.ts`, `review.ts`, `report.ts` (review part), `prompts/design.md`, `prompts/consolidate.md`,
`prompts/motion.md`, `prompts/router-read.md`, `rules/taste-never.md`; test with a fake model server in
`ui-review.e2e.test.ts`. No bug judging in phase 1: the spec's anti-goal is an unverified bug list, and a cold scan was ~35%
real in the spike. Bugs arrive in phase 2 with reproduction; until then `Report.bugs` holds only the rule checks'
blocking findings on a local build (the route check confirms each by a second click from a fresh page).

**Interfaces:**
- Consumes: `Capture`, `Measures`, `Motion` (Task 1), `refs.json` (Task 3).
- Produces:
  - `ask(o: { model: string; system: string; text: string; images: string[]; schema: object }): Promise<unknown>`:
    POST `${OPENROUTER_BASE_URL}/chat/completions` with `OPENROUTER_API_KEY`, images as `data:` URIs, `reasoning: { effort: "low" }`,
    `max_tokens: 32000`, `response_format: json_schema`; one retry that quotes the parse error; returns `cost_usd` from
    `usage.cost` into a run total.
  - `ui-review review <dir> [--model m] [--taste file] [--refs refs.json] [--top 10] [--brand file] [--max-usd n]` writes
    `improvements` and `motion` into `<dir>/report.json` and renders `report.md`; it stops calling the model once the run's
    `cost_usd` reaches `--max-usd` and reports what it has.
- Job boxes get the same two env names: `services/computer/lib.ts` job env adds `OPENROUTER_BASE_URL=$AIDENHQ_GATEWAY_URL/api/v1` (the launcher's model route) and
  `OPENROUTER_API_KEY=<the job's run token>` (both values already in the box as `AIDENHQ_GATEWAY_URL`/`AIDENHQ_RUN_TOKEN`;
  check boxes already have them). The engine reads only these two names.

Pipeline (code-owned order; the prompts own the judgment):
1. Group captures by `Page.kind`; per page one call with its 390, 1512 and 2560 light captures (first step), its dark
   1512, its `empty`/`error` states when reachable, its `Measures` as a compact table, the cross-page inconsistencies that
   involve it, the matching references (shots and tokens), `taste-never.md`, the `--taste` file, and the app's own design
   system or brand file when given. Output: up to 9 candidate improvements, each with all `Improvement` fields but `rank`.
2. `consolidate.md` (one call, text only): merge duplicates across pages, rank by impact, keep the top `--top`, drop any
   candidate whose `captures` don't exist in the run.
3. Motion pass (one call per page with motion data, text only): `Motion` + the two MIT reference texts; rows
   `Before/After/Why` with the CSS rule they come from; a row whose `css` is not found in the measured CSS is dropped.

`rules/taste-never.md` ships the universal rules from the spike's `DESIGN-RULES-NEVER.md`, in its
`NEVER <failure> → INSTEAD <fix>, because <reason>` form: rules 2 (without the gradient clause), 3, 4 (without
"generous padding"), 6, 7, 8, 9, 10, 11, 12. Rules 1 (pills read childish), 5 (more colour) and 13 (no mascots) are the
owner's taste: they go to the instance as positive preferences (Task 7). Each rule keeps its reason; a reason the spike
did not confirm is marked `(inferred)`.

- [ ] **Step 1: Write the failing test** (fake model: a local HTTP server answering canned JSON per prompt file name):
```ts
test("review ranks concrete improvements and drops bad citations", async () => {
  const r = await runReview(capturedFixtureDir, { model: "fake/m", base: fake.url });
  assert.ok(r.improvements.length >= 3 && r.improvements.length <= 10);
  for (const i of r.improvements) for (const k of ["weak", "change", "why", "best"] as const) assert.ok(i[k].length > 10);
  assert.ok(r.improvements.every((i) => i.captures.every((f) => existsSync(join(capturedFixtureDir, f)))));
  assert.equal(fake.calls("design").filter((c) => c.retry).length, 1);   // the malformed answer was retried once
  assert.ok(r.motion.every((m) => m.css.length > 0));
  assert.ok(!JSON.stringify(r).match(/"score"|\/10/));                    // no scores
});
```
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement. **Step 4:** Run; PASS.
- [ ] **Step 5:** Commit `feat(computer): ui-review design review and motion pass`.

### Task 5: Rendered fixes and the pairwise check (lane C)

**Files:** `pairwise.ts`, `prompts/pairwise.md`, `main.ts` (`fix-check`), `modules/design/skills/ui-review/SKILL.md`
(the "Show the fix" section, written in Task 7's file); test in `ui-review.e2e.test.ts`.

**Interfaces:**
- Produces: `fixCheck(o: { before: string; after: string; width: number; model: string; samples?: 3 }): Promise<{ wins: [number, number]; accepted: boolean }>`
  (`wins[0]` = AFTER preferred with AFTER shown second, `wins[1]` = with AFTER shown first; `accepted` = both >= 2) and
  the CLI `ui-review fix-check <before.png> <after.png> --width <w> [--model m]` printing that JSON.
- The fix loop is the agent's (skill text), using the engine: for each of the top 3 improvements, one at a time, in a
  throwaway copy of the repo: implement with `claude -p` (Sonnet) or `codex exec` (Sol), rebuild, `ui-review capture
  --pages-file <that page> --baseline <before dir>`, `ui-review fix-check` at `where.width`; accepted → keep the diff
  (`git diff`) and the before|after pair; rejected or a failed build → revert, record `fix.status`. Collateral: before
  judging, recapture every page at the target width and at 390 with `--baseline <before dir>`; each other page whose
  pixels change by >= 0.1% is listed in `fix.collateral` (a fix with collateral is shown with that list, never hidden).

- [ ] **Step 1: Write the failing test** (fake model biased to answer "first" for one pair, "second" for another):
```ts
test("fix-check needs AFTER in 2 of 3 in each order", async () => {
  const good = await fixCheck({ before: B, after: A, width: 1512, model: "fake/after-wins" });
  assert.deepEqual(good, { wins: [3, 3], accepted: true });
  const biased = await fixCheck({ before: B, after: A, width: 1512, model: "fake/always-first" });
  assert.equal(biased.accepted, false);                     // position bias never passes a fix
  assert.equal(fake.calls("pairwise").length, 12);
});
```
- [ ] **Step 2-4:** FAIL, implement, PASS.
- [ ] **Step 5:** Commit `feat(computer): ui-review fix-check (pairwise, both orders x 3)`.

### Task 6: The design module service: runs and the evidence store (lane D)

**Files:**
- Create: `modules/design/service/{Dockerfile,package.json,package-lock.json,tsconfig.json}`,
  `modules/design/service/src/{main.ts,store.ts,mcp.ts}` (copy the SDK files code-review uses: `aidenhq-sdk/caller.ts`,
  `fence.ts`, `kernel-client.ts`, kept identical by `scripts/sync-shared.ts`),
  `modules/design/test/store.e2e.test.ts`
- Modify: `modules/design/module.yaml` (`services.run.design` with `data: ["evidence:/data"]`, port 8099, its connection
  `design` with `auth: design_service_key`, `generated_secrets`), `.github/ci/areas.json` (a `modules/design` suite)
- Delete (only if #1876 merged without them; see the header), every hit of `git grep -nE 'design-review|design_review'`
  on `origin/main` today: `modules/github/service/src/design-review.ts`, `modules/github/test/design-review.test.ts`;
  their uses in `modules/github/service/src/{main.ts,service.ts,flow.ts,merge-gate.ts}`, `modules/github/test/ship-effects.test.ts`,
  `modules/github/module.yaml`, `modules/github/connections/github-mcp/src/{github.ts,main.ts,projects.ts}` (`commit_status_set`);
  the check in `kernel/sdk/src/checks.ts`, `kernel/sdk/test/checks.test.ts` and the synced copies
  (`modules/{github,grading,ship}/service/src/aidenhq-sdk/checks.ts`); `modules/design/{module.yaml,README.md}`,
  `modules/apps-platform/agents/app-maintainer/AGENTS.md`, `modules/tasks/skills/delegate-work/SKILL.md`,
  `scripts/verify-security.sh`, `services/board/web/{dev/mock-api.ts,src/ui/TaskState.tsx}`, and the docs
  (`docs/configuration.md`, `docs/design/codehost-local.md`, `docs/design/flow.md`, `docs/operations.md`). Check: the grep
  then prints only the spec and the plans.

**Interfaces (Produces; phases 2 and 3 extend these, never add a second store):**
- SQLite `/data/design.sqlite`: `runs (id TEXT PK, target TEXT, kind TEXT /* review|scan|pass */, app TEXT, task TEXT, model TEXT, status TEXT, started TEXT, ended TEXT, cost_usd REAL, report TEXT /* report.json */)`; files under `/data/evidence/<run>/`.
- Tools (read: `design_runs`, `design_run`, `design_image`, `design_evidence_put` and `design_run_finish` (both write only into the module's own store, so neither is a write record: the images and the report stay out of the kernel's records and approval arguments; owner, 2026-11-26); write: `design_run_start`):
  - `design_run_start { target: string; kind: "review"; model: string; app?: string } → { run: string }` (the caller's task from its assertion)
  - `design_evidence_put { run; files: { name: string; data: string /* base64 */ }[] }`: at most 8 MB per call, names
    `[\w.-]{1,120}\.(png|webp|json|md|diff)`, only the run's own caller agent
  - `design_run_finish { run; report: Report } → { url: string }` (the board link of the run, used from phase 3)
  - `design_runs { app?: string; limit?: number }`, `design_run { run }` (report + file list), `design_image { run; name } → { data, type }`
- Retention: evidence older than 30 days is deleted daily, except each app's latest finished run.

- [ ] **Step 1: Write the failing test:**
```ts
test("a run's evidence round-trips and expires", async () => {
  const { run } = await call("design_run_start", { target: "http://acme.example.com", kind: "review", model: "m" });
  await call("design_evidence_put", { run, files: [{ name: "home-1512-light.png", data: png64 }] });
  await call("design_run_finish", { run, report: minimalReport });
  assert.equal((await call("design_image", { run, name: "home-1512-light.png" })).data, png64);
  await assert.rejects(call("design_evidence_put", { run, files: [{ name: "../x.png", data: png64 }] }));
  clock.advance(31 * DAY); sweep(); assert.equal((await call("design_runs", {})).runs.length, 1); // latest kept
});
```
- [ ] **Step 2-4:** FAIL, implement, PASS (`cd modules/design/service && npm test`).
- [ ] **Step 5:** Commit `feat(design): runs and evidence store service`.

### Task 7: The UI Reviewer: handbook, skill, grants, taste in the instance (lane D)

**Files:**
- Create: `modules/design/skills/ui-review/SKILL.md`
- Modify: `modules/design/agents/ui-reviewer/AGENTS.md` (mission only: a professional product designer who reviews
  running apps on request; links the skill), `modules/design/module.yaml` (ui-reviewer: `skills: [design.ui-review,
  apps-platform.design-system, engineering.write-code, tasks.delegate-work]`, `connections.design: [design_run_start,
  design_evidence_put, design_run_finish, design_runs, design_run]`; the agent's own harness model stays #1876's Sol: the
  design-review models are the engine's, per call), `modules/design/README.md` (the four-part shape, New installs)
- Instance repo PR (`aidenhq-alpha/aidenhq-instance`): `modules/library/skills/owner-taste/SKILL.md` (the owner's positive
  preferences, positive only: Stripe polish, Linear crispness, more colour, rounded rectangles at a moderate 6-10px radius,
  compact layouts with little white space, prominent CTAs, a professional and restrained look; the "References" list of
  public pages per `PageKind`), granted with
  `overrides.agents.ui-reviewer.skills.add: [library.owner-taste]` in `instance.yaml`.

Skill sections (positive, how-to only): Run the app (repo: its AGENTS.md/README, seed or demo data, never a real
database; no repo: the URL); Page list (feature map, else read the router with `prompts/router-read.md` into
`pages.json`); Capture (`ui-review capture … --workers 4`, then `ui-review routes`); References (`ui-review refs` over
`refs/references.json` plus the owner-taste references); Review (`ui-review review --taste <owner-taste written to a file>
--model <the ask's model or the default>`); Show the fix (Task 5's loop, top 3); Report (one comment on the task: the
ranked improvements with their before|after images attached via `task_file_upload`; one PR comment for a PR ask;
evidence via `design_*`); Learning taste (every design correction the owner makes is distilled into `owner-taste` with
`self_change`: the rule, its reason, `(inferred)` when the reason is a guess); Regression set (on request: `node /opt/aidenhq/design-eval/run.ts <suite>`, the eval folder copied into the image beside the engine, results posted on the asking task).

- [ ] **Step 1:** In the skill, how `claude -p` and `codex exec` reach the gateway from a job box: the same base URL and
  run token the box's own harness uses (the launcher's `/api/v1/messages` route for Claude Code, `/api/v1/responses` for
  Codex), as the engineer image's `code-review/engines.ts` configures them in a check box. Then `node scripts/compile.ts`
  and `cd scripts && npm test`. Expected: the design module compiles with the
  new service, connection, skill and grants; handbook assertions in `services/computer` and `scripts` tests that named
  the old PR-gate text are updated in the same commit.
- [ ] **Step 2:** Commit `feat(design): the UI Reviewer as an on-request designer with the ui-review skill`.

### Task 8: Code-review `ui` lens: `ui.scan` (lane E)

**Files:**
- Modify: `modules/code-review/recipe/catalog.ts` and `modules/code-review/service/src/catalog.ts` (`LENSES` adds `"ui"`; the
  id pattern adds `ui`; `runs_code: true` is allowed for `kind: "engine"` with `run.engine: "ui-review"` **only because that
  engine's repo-code step is a separate, token-free check job** — the comment on the rule says so, and the `ENGINES` list
  still keeps `ui-review` out of PR combos; both validators change in the same commit. The reviewer's objection is exactly
  what this rule exists to prevent: `recipe/catalog.ts:63` today refuses `runs_code` for anything but a tool, and nothing
  in this change may let a token-bearing box run repo code)
- Modify: `modules/code-review/service/src/catalog.json` (one entry, below)
- Create: `modules/code-review/recipe/ui.ts` (the token-free capture step) and `modules/code-review/recipe/ui-review.ts`
  (the model step over its report)
- Modify: `modules/code-review/module.yaml` (two check jobs, because **the box that runs the repo's code must hold no model
  token**: `code-review-ui` runs the app and captures it, and `code-review-ui-review` reads the captures' text with the model):
  - `code-review-ui`: `dir: recipe`, `argv: [node, /aidenhq-out/recipe/ui.ts]`, `timeout_min: 60`, `title: the UI design scan`,
    `spec: { base: sha, run: text, option: text, model: text }`, `result: true`, `keep: true` (it keeps the bundle for the
    review step) and **no `model:` line** (the only form the compiler accepts besides `true`,
    `scripts/modules.ts:1727`: `model: false` is refused). So `checkEnv("result")` gives it neither `OPENROUTER_API_KEY` nor
    `OPENROUTER_BASE_URL` (`kernel/src/checkjobs.ts:176-179`).
  - `code-review-ui-review`: `dir: recipe`, `argv: [node, /aidenhq-out/recipe/ui-review.ts]`, `timeout_min: 20`,
    `title: the UI design review`, `spec: { base: sha, run: text, option: text, model: text, ui: input }`, `model: true`,
    `result: true`. It gets the run's model token and, like every code check, the head tree at `ws` (`kernel/src/checkjobs.ts:504`),
    plus the capture bundle as its input — but **nothing in it executes repo code**: no start script, no install, no repo
    config or skill loaded, only file text read as data (deepsec's rule, `deepsec.ts:10`).
  - `title` is required: `checkJobs` refuses a recipe without one (`scripts/modules.ts:1724`).
- Modify: `modules/code-review/service/src/engine.ts`:
  - `repoReview`: the effort check takes `UI_EFFORTS = ["low", "medium", "high"]` for `run.engine === "ui-review"`, as it
    takes `DEEPSEC_EFFORTS` for deepsec (`ui-review` is **not** added to `config.ts` `ENGINES`, so no PR combo can name it);
    `addTree(…, o.run.engine === "ui-review" ? "code-review-ui" : "code-review", null)` for `scope: repo` options;
  - `startTree`: profile `code-review-ui` starts the token-free capture check with `{ option, model }`; when it passes, the
    service reads its kept bundle (`GET /v1/checks/:check/kept`), uploads it (`POST /v1/checks/inputs`) and starts
    `code-review-ui-review` with that as `ui` — the same handoff deepsec's records use (`deepsec_data: input`). A capture that
    fails is the option's failure; a review that fails leaves the batch incomplete, never clean;
  - `treeCoverageOk`: a `code-review-ui` result needs `counts` like a review (pages eligible and captured).
- Modify: `modules/code-review/service/src/adapters.ts` (`checkSpec`: `code-review-ui` and `code-review-ui-review` → `{ base, run, option, model }`; the review step's `inputs` names the capture check's kept report, as deepsec's records travel),
  `seams.ts` (`ReviewSpec.profile` gains `code-review-ui` and `code-review-ui-review`; the review step's spec carries the
  bundle as `ui`, uploaded like deepsec's records; `Finding.ui?: { page: string; width: number; theme: "light" | "dark"; region: string; change: string; best: string }`),
  `report.ts` (`LENS_ORDER` gains `ui`; a "UI" section lists improvements ranked, then the rule checks' blocking findings)
- Test: `modules/code-review/test/repo-review.test.ts` (two cases: the capture-then-review chain, and the token split)

Catalog entry:
```json
{"id":"ui.scan","name":"UI design scan","description":"Runs the app from the repo, captures every page at six widths in light and dark, measures it and reviews it as a product designer: ranked improvements and suspected bugs.","lens":"ui","modes":["one_off"],"recommended":[],"kind":"engine","model":"google/gemini-4-carbon","effort":"low","scope":"repo","source":{"repo":"Aiden-HQ/AidenHQ","version":"ui-review@2","licence":"AGPL-3.0-only"},"run":{"engine":"ui-review","max_cost_usd":10},"when":["**/package.json"],"needs":"a web app with a package.json","output":"findings","runs_code":true,"cost":"high"}
```

`recipe/ui.ts` (**`code-review-ui`, the token-free box**: no `OPENROUTER_API_KEY`, no `OPENROUTER_BASE_URL` — the repo's code
runs here, so nothing here may hold a model token, the rule `recipe/tools.ts:3` and `deepsec.ts:10` state. It therefore runs
**no model at all**, not even the router read):
1. Start the app **without a model**: run the `start` script `package.json` declares (`npm start` / `pnpm start` / `yarn start`,
   else the framework's default), with `--host 127.0.0.1 --port 8080` where the framework takes them, else env
   `PORT=8080 HOST=127.0.0.1`, and wait for the port (180 s cap). If the repo declares no start script and the framework
   gives no default, the check **fails with `no start command: add a "start" script`** — it does not guess. Seed or demo data,
   when one is needed, comes from a `start` script the repo declares, never from a command a model wrote.
2. `ui-review capture http://127.0.0.1:8080 --out /aidenhq-out/ui` (its own page list: a same-origin link crawl plus
   `sitemap.xml`; a repo may supply `.aidenhq-ui/pages.json`, committed, for pages a crawl can't reach), then
   `ui-review routes http://127.0.0.1:8080 --out /aidenhq-out/ui/routes` (its `report.json` lands inside the capture folder,
   beside the captures' `report.json`; exit 1 means blocking findings, not a failure, exit 2 is a failed check). Capture and
   routes are measurement only: no model, no judgement. A route the check could not run is a note, never a rule hit.
3. It leaves a **bounded bundle** at `/aidenhq-out/keep` (`keep: true`) for the review step: a gzipped tar of the capture
   report plus the shots the review actually reads — per page its 390, 1512 and 2560 light captures and its 1512 dark, downscaled
   to a 1200 px long edge — and nothing else. That keeps it inside a check input (`INPUT_MAX`, 64 MB, one file: a keep'd file
   is one regular file, `kernel/src/checkjobs.ts:435-442`). When the bundle would exceed it, it drops pages from the tail of the
   queue and marks `coverage.incomplete` with how many, so the result is never silently partial. Its own result is the report
   in the tree-validator's shape. **No `Review` comes out of this box.**

`recipe/ui-review.ts` (**`code-review-ui-review`, the model box**: `model: true`, so it gets the run's capped token and the
gateway; its input is the bundle, and **it runs no repo code** — no `run.sh`, no install, no repo config):
1. It untars the bundle to `/aidenhq-out/ui` (a plain extract, no script from it, entries checked to stay under that folder),
   then `ui-review review /aidenhq-out/ui --model <spec.model>` with the product rules and `refs/references.json` (an unattended
   scan carries no owner taste; agent runs do). `review` folds each blocking route finding from the bundle's `routes/report.json`
   into the capture report's `rules` as a `RuleHit` (`blocking: true`), so `toReview` maps them like axe's and the page's own
   errors. What it opens is the bundle (the report's text and its PNGs) and, to name a file an improvement cites, that file's
   text from the tree — read as data, never executed, never a `package.json` script, never a build. So repo code **runs** in
   exactly one box, and that box has no token.
2. Result: a `Review` (`version: 1`, `target: "tree"`, `engine: "ui-review"`, the spec's model, effort `low`) that the
   tree validator accepts. `toReview(report, spec)` fills `repo` and `head` from the kernel-provided spec
   (`/aidenhq-out/spec.json` carries `repo` and `head` beside the recipe's fields, `kernel/src/checkjobs.ts:529` as
   `kernel/src/checkjobs.ts:50` says): the service refuses a result whose `repo` or `head` differ from the run's
   (`modules/code-review/service/src/engine.ts:823–826`), so both are always set, never left to the box:
   - `coverage: { reviewed: <captured page paths>, excluded: <failed or deferred page paths>, incomplete: null | "<why>", counts: { eligible: <pages listed>, reviewed: <pages captured> } }`,
     `withheld: { important: 0, nit: <improvements beyond the top 10>, pre_existing: 0 }`;
   - each improvement → `{ id: "ui-<rank>", severity: "nit", path: <the source file the change names, else the page path>, line: 0, title: weak, why, evidence: <the captures' names joined with ", ">, fix_brief: change, option: "ui.scan", lens: "ui", ui: {...} }`;
   - each blocking rule finding (local build: route check, page errors, axe) → `{ id: "ui-rule-<n>", severity: "important", … }`.
   The result stays under 256 KB (top 10 improvements, at most 20 rule findings). `--max-usd` is the option's
   `max_cost_usd`. No rendered fixes at scan depth; the Primer report is text (publish `content` is at most 80 KB of
   markdown and carries no images).

- [ ] **Step 1: Write the failing test** (fake kernel as `test/repo-review.test.ts` uses; `toReview(report, spec)` comes from
  `recipe/ui-review.ts`, the model step, and is the mapper the check's own box calls from a fixture `report.json` and the
  spec it gets (`{ repo, head }` beside the recipe's fields), not written by hand):
```ts
test("ui.scan captures in a token-free box, then reviews the text in a model box", async () => {
  const b = await svc.repoReview({ target: { repo: "acme/app", commit: SHA }, options: ["ui.scan"] });
  const [capture, review] = kernel.posts.filter((p) => p.path === "/v1/checks");
  assert.equal(capture.body.run, "code-review-ui");
  assert.ok(!("model" in capture.body) || capture.body.model !== true);   // the repo's code runs with no model token
  assert.deepEqual(Object.keys(capture.body.spec).sort(), ["base", "model", "option", "run"]);
  const spec = { ...capture.body.spec, repo: "acme/app", head: SHA };   // /aidenhq-out/spec.json adds these two
  kernel.finishCheck(capture, { result: captureReport(fixtureReport) }); await svc.tick();
  assert.equal(review.body.run, "code-review-ui-review");
  assert.equal(review.body.model, true);                            // the model reads only the kept bundle
  assert.deepEqual(Object.keys(review.body.spec).sort(), ["base", "model", "option", "run", "ui"]);   // the bundle, not code
  kernel.finishCheck(review, { result: toReview(fixtureReport, spec) }); await svc.tick();
  assert.equal(runOf(b.batch).status, "done");                      // the tree validator accepted it
  const md = await reportOf(b.batch);
  assert.match(md, /## UI/); assert.ok(md.indexOf("Widen the approvals grid") < md.indexOf("Compact the attention rail"));
  await assert.rejects(svc.repoReview({ target: { repo: "acme/app", commit: SHA }, options: ["ui.scan"], combo: { effort: "xhigh" } }), /takes an effort of low, medium, high/);
});
test("ui.scan carries a blocking route finding as an important ui-rule finding", async () => {
  const b = await svc.repoReview({ target: { repo: "acme/app", commit: SHA }, options: ["ui.scan"] });
  const [capture, review] = kernel.posts.filter((p) => p.path === "/v1/checks");
  kernel.finishCheck(capture, { result: captureReport(fixtureReportWithRouteFail) }); await svc.tick();
  kernel.finishCheck(review, { result: toReview(fixtureReportWithRouteFail, { ...review.body.spec, repo: "acme/app", head: SHA }) }); await svc.tick();
  assert.equal(runOf(b.batch).status, "done");
  assert.match(await reportOf(b.batch), /ui-rule-/);
});
```
- [ ] **Step 2-4:** FAIL, implement, PASS (`cd modules/code-review && npm test && npm run typecheck`).
- [ ] **Step 5:** Commit `feat(code-review): ui lens with ui.scan`.

### Task 9: The evaluation and regression set (lane F)

**Files:** `modules/design/eval/{run.ts,README.md}`, `modules/design/eval/degrade.ts`, `modules/design/eval/fixes/<case>/{patch.css,expect.json}`
(6 good + 6 bad fix cases on the app starter's catalog pages), `modules/design/eval/rated.example.json`;
no CI job: the set runs on request, by the command below or by the UI Reviewer (its skill's "Regression set" section),
whenever the prompt, a default model or the engine changes, with the capped eval key (`openrouter_eval_key`) by hand or
the fleet's gateway from an agent box
- Instance repo: `design/eval/rated.json` (the owner's order: Stripe ≈ shadcn > Linear > Monday ≈ Cal > Airtable ≈ Notion
  ≈ Raycast > Duolingo; the board poor; Roadmap Keeper weaker) and `design/eval/corrections/` (one case per owner correction).

**Interfaces:** `node modules/design/eval/run.ts degraded|fixes|references|calibrate|corrections [--model m] [--rated file] [--cases dir]`
prints one JSON line per suite and exits 1 below its bar.

Suites and bars (initial, from the spike; change only with the owner):
- `degraded`: 4 starter pages x 4 subtle degradations generated by `degrade.ts` (2-4px spacing jitter, one extra font
  size, one off-palette colour, a 2px misalignment): the reviewer picks the original in >= 15/16 and names the change in
  >= 12/16.
- `fixes`: each case is before|after at its width through `fixCheck`: good accepted >= 16/18 sample-orders, bad
  accepted <= 1/18.
- `references`: the same 7 board pages and 3 Roadmap Keeper pages reviewed twice, once with `refs/references.json` and once
  with `refs/fallback.json` only, everything else equal: reports specificity (share of improvements naming where and a
  concrete change), the share naming a token from the references, and, with `--rated`, rank agreement of each variant.
  It decides whether the URL list earns its cost; no bar until the first run.
- `calibrate` (instance, run by hand when the prompt or default model changes): the eval-only "rank these" request over
  the rated sites (2 pages each, politeness caps) and apps; Spearman rho of the reviewer's order vs `rated.json` >= 0.6, and
  the owner's own apps ranked below every reference site.
- `corrections` (instance): each case's expected improvement (where + change) appears in the top 10.

- [ ] **Step 1:** Write `run.ts` and the cases; run `degraded`, `fixes` and `references` once with the eval key on Carbon.
  Expected: the first two above their bars; `references` reported in PR 2's body; note cost (budget ~$3 a run).
- [ ] **Step 2:** Commit `feat(design): ui-review regression set (degraded copies, fix pairs, calibration)`.

### Task 10: Security review, integration and acceptance (all lanes, once)

- [ ] **Step 0: Security review** (Conventions: every new path, before it switches on), written in each PR's body with
  the test or code line that answers it:
  1. `ui.scan` runs the repo's code, and the model token is kept out of that box: `code-review-ui` declares no `model`, so
     `checkEnv("result")` gives it no `OPENROUTER_API_KEY`/`OPENROUTER_BASE_URL` (`kernel/src/checkjobs.ts:176-179`), and it
     runs no model at all; the token-bearing `code-review-ui-review` box gets the kept capture bundle and runs no repo
     code. This is the rule `recipe/tools.ts:3` ("credential-free box, with no model and no token at all") and
     `deepsec.ts:10` ("Repo code never runs here, and the model token never reaches it") already state — the earlier
     draft's "same exposure as `runs_code` tools" was wrong, since those tools have no token. Whole-repo reviews only,
     never a fork's PR head; spend is bounded by `max_cost_usd` (10) in the recipe and by the install's limits in the
     gateway.
  2. Job boxes gain `OPENROUTER_BASE_URL`/`OPENROUTER_API_KEY`: the same token already in the box as `AIDENHQ_RUN_TOKEN`,
     no new reach.
  3. The `design` connection: `design_evidence_put` writes only under the caller's own run (path names checked), 8 MB a
     call; the page-facing reads return only evidence of finished runs.
  4. Phase 1 never clicks on a live target (Task 2/3 code path; test: the `/danger` fixture captured as a live URL gets no
     POST).
- [ ] **Step 1:** Merge lanes into their PR branches; `node scripts/ci-local.ts`; the engine tests in the image (Task 1
  Step 4); Codex review of each branch; fix every important finding.
- [ ] **Step 2:** Deploy once, after the phase's PRs merge, then ask the UI Reviewer on a TEST task to review the board (built from `origin/main`
  with its mock API). Expected: capture under 10 min for the board's pages; a report whose top items include the spike's
  agreed board issues (fluid grids at 2560, the Fleet attention panel at 1512, stretched answer forms); at least one
  rendered before|after accepted; cost under $5.
- [ ] **Step 3:** Run `ui.scan` on a repo review of the app starter's repo copy; expected a Primer document with a UI section.
- [ ] **Step 4:** Remove worktrees and branches.

## New installs

The design module is in the default bundle: its service starts idle (no schedule, no spend). The UI Reviewer acts only
when asked. With no instance taste skill it uses the product's universal rules and the product's reference URLs. Without Primer,
`ui.scan`'s report stays on the Reviews page (code-review's existing behaviour when Primer is missing). Without GitHub,
on-request reviews work on any URL or `local/` repo.

## Self-review

- Spec coverage: capture/queue/page list (Tasks 1-2), measurements and motion on measured CSS (3), design review with taste
  rules and category references (4, 7), rendered fixes behind the pairwise check (5), Carbon default and per-run model
  (Global Constraints, 4), `ui.scan` to Primer (8), evidence store (6), regression set (9). Clicking pass, logins and
  verified bugs are phase 2; recordings and the page are phase 3.
- Phase split vs spec: the spec's phasing puts motion measurements in phase 3; this plan measures CSS and `getAnimations`
  motion in phase 1 (as the motion pass needs it) and leaves recording-derived motion to phase 3.
- Types: `Report`, `Improvement`, `Capture` are defined once (Task 1) and used unchanged in 4, 5, 6, 8.
- Decided here, beyond the spec: no bug judging until phase 2's reproduction (no unverified bug list); no clicks on live
  targets until phase 2's guard; the product ships reference URLs with measured tokens and captures them at run time
  (no third-party screenshots in the repo), the starter catalog only as a fallback, compared by the `references` suite; an unattended `ui.scan` carries the universal rules only (the
  owner's taste lives in the instance and reaches agent runs); `ui.scan` reports text to Primer (no images there); its
  repo-code box holds no model token and its model box runs no repo code (two check jobs, not one with both - the split
  the AI reviewer's merge objection required).
- Folded in from Codex's review of the plan: the `code-review-ui` profile wired through `checkSpec`, `addTree` and the tree
  validator with a complete result contract; collateral checked by recapturing every page at the target width.
- Owner decisions folded in (2026-11-26): web vitals stay as notes; the regression set runs on request, never in CI; one
  deploy per phase; Carbon access checked first; PR 1 merges alone after a measured acceptance gate.
