# Code review lenses: implementation plan

> **For agentic workers:** this plan runs as parallel lanes (owner's working style: build the lanes, then test and review
> once at the end). Each lane builds in its own git worktree off `origin/main`, never in the main checkout, and never runs
> `git stash`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One-off whole-repo reviews at a commit with selectable, ready-made options in four lenses, a report published to
Primer, deepsec's set-up-or-scan with a setup PR, and the same options for continuous PR review.

**Architecture (revised after Codex's simplification review):** One JSON catalog lists every option. One run lifecycle for
both modes: the existing runs, reviews and findings tables, `kernelRunner` and the `/reviews` API gain a PR-or-tree target. One
recipe has two check profiles: `code-review-tools` (token-free, the selected tool options) and the existing `code-review`
(one metered check per model option, in sequence, under the shared cap). Primer accepts a report submission and files its own
`publish` write. The deepsec setup is one reviewed write, `code-review.setup`.

**Tech stack:** TypeScript on Node 24 (`.ts` run directly), node:test, SQLite (`node:sqlite`), the existing kernel check jobs,
the code host ops and write records.

**Spec:** `docs/superpowers/specs/2026-11-22-code-review-lenses-design.md`

## Global constraints

- Out-of-the-box only: every option runs an upstream command, skill, plugin or tool as shipped. We write no reviewer prompts.
  The only model-facing text we add is the existing "restate the findings in our JSON" step.
- Trust bar: each option is published by its vendor or a known organisation, or has at least 1k stars; it was active in the
  last 3 months; and its licence is accepted (permissive, or AGPL/CC-BY-SA run unmodified).
- Pins: every tool, skill and package is pinned to a version at least 7 days old (today 2026-11-22, so published on or
  before 2026-11-14), unless the newer version is a security fix.
- Spend: `run_usd` defaults to 25 with a maximum of 150, as the run's total across checks. A single check stays at most
  100 (the compiler's existing ceiling). Only the timeout limit rises, to 180.
- Model options run in sequence. Each job's `budget_usd` is `run_usd` minus what the run has already spent.
- The model token never reaches tool or repo processes: tools are spawned with a token-free environment.
- Codex Security is in the catalog with `hidden: true` until verified.
- Out of v1 (the box has no Docker): the MongoDB optimizer, dexter, web vitals, Lighthouse CI, and N+1 detectors that need a
  database.
- Every PR is squash-merged with a Conventional Commit title. Run the touched suites (`modules/code-review`, `services/board`
  with `npx tsc -p tsconfig.build.json --noEmit`, `services/computer`, `scripts`, `kernel`, `modules/github`, `modules/primer`) before merging.

## Review focus

1. **A huge repo or a monorepo.** A tool's output runs to tens of thousands of findings. Expect it capped per option, with the
   rest counted, and the report under Primer's 80,000-character limit. Lane B tests the mapper cap; lane D tests the
   renderer's size cap.
2. **A tool missing for the stack or crashing.** Expect the option listed under coverage as failed with its stderr tail, the
   run to carry on, and the verdict to be `incomplete`, never `clean`. Lane B and lane D test this.
3. **The cap is spent mid-run.** Expect the remaining model options to be skipped, each listed with the reason "run cap
   spent". Lane D tests this.
4. **The default branch moves during a run.** Expect the run to keep the SHA it resolved at start, with the report naming it.
   Lane D tests this.
5. **deepsec when the setup branch already exists, or the PR already merged.** Expect existing files to be reused with no
   second PR, and a scan, not a set-up, once `.deepsec/` is on the commit. Lane C tests this.

---

### Lane R1: the catalog, the tools profile, limits and image tools (sonnet)

**Files:** create `modules/code-review/catalog.json`, `modules/code-review/recipe/catalog.ts` (shared by recipe and service),
`modules/code-review/recipe/tools.ts` (the tools runner) and `modules/code-review/recipe/sarif.ts` (one SARIF reader plus small
adapters for knip, jscpd, vulture and scc). Modify `modules/code-review/module.yaml` (`check_jobs.code-review-tools`: no
`model:`, timeout 180; `code-review`: `model.max_usd: 100`, timeout 180), `scripts/modules.ts` (raise only the timeout limit
to 180), `kernel/src/checkjobs.ts` (a plain check also gets `AIDENHQ_RESULT`, if it
doesn't today) and `services/computer/images/engineer/Dockerfile` (the tools, pinned).

**Interfaces (produces):**
- `catalog.json`: `[{ id, lens, modes, recommended, kind: "tool"|"skill"|"engine", source: { repo, version, licence }, run: { cmd?, harness?, skill?, engine? }, when: string[], output: "sarif"|"knip"|"jscpd"|"vulture"|"scc"|"findings", runs_code, cost, hidden? }]`
- `loadCatalog(text): Option[]` (throws on a bad entry) and `detect(paths, catalog, mode): { available: Option[]; recommended: string[] }`.
  `when` globs use the recipe's `globRe`, and an empty `when` means always.
- The tools check spec is `{ repo, commit, base?, options: json }`. It writes the existing `Review` shape (target `tree`, or
  the PR's base and head) with `option` and `lens` on each finding and `coverage.failed: {id, why}[]`. Each tool gets a
  20-minute timeout and a token-free env. The checkout is copied to `$TMPDIR/work`. Findings are capped at 200 per option,
  with the dropped count recorded.

Tests: `catalog loads; ids unique; recommended ⊆ modes; every entry has a version and licence`, `detect: package.json + go.mod
→ knip and govulncheck, not vulture`, `hidden never offered`, `sarif error→important, warning/note→nit, capped at 200`,
`failed tool → coverage.failed with stderr tail`, `tool env has no OPENROUTER_API_KEY`, and a compiler test for the new limits.

### Lane R2: tree mode, skill options, deepsec (sonnet)

**Files:** modify `modules/code-review/recipe/review.ts` (target `tree`: the merge base is the empty tree, with eligible
scope listed separately from actual coverage) and `recipe/engines.ts` (`skill:<id>` runs the installed upstream skill in
claude-code or codex, then restates its findings in the same session using the existing pattern). Create
`recipe/deepsec.ts`. Modify the engineer Dockerfile (the skills, plugins and deepsec, pinned).

**Interfaces:**
- A model option is one `code-review` check whose `combo.engine` is `skill:<option id>` or `deepsec`, with `spec.target` set
  to `tree` or `pr`. Each finding carries `option` and `lens`.
- `deepsec({ root, target, base?, model, budget_usd, scratch, setupFiles? })` returns `{ review, setup?: Record<path,string> }`.
  It scans when `.deepsec/INFO.md` exists or `setupFiles` is given, and runs `init` otherwise. `setup` holds only
  `.deepsec/{INFO.md,deepsec.config.ts,generated-matchers.ts,package.json}` and the lockfile. `DEEPSEC_DATA_ROOT` points into
  scratch, the pi backend goes through the gateway, and `--max-cost-usd` is set to `budget_usd`. Severity:
  CRITICAL/HIGH/HIGH_BUG → important, the rest → nit.

Tests: `deepsec scans with INFO.md, inits without`, `setup returns only the allowlisted paths`, `severity mapping`,
`tree mode: eligible scope ≠ coverage; a truncated run reports incomplete`.

### Lane S: the service: one lifecycle for both targets, the report, the setup write (opus)

**Files:** modify `modules/code-review/service/src/engine.ts` (a batch target is `{ pr }` or `{ tree, sha }`, with options and
cap; a forward-only migration bumps `DATA_VERSION`), `adapters.ts` (`checkSpec` for both profiles; the `code-review.setup`
executor), `config-tool.ts` (`code_review_run` accepts a tree target with options and `run_usd`), `api.ts` (`GET /catalog?repo=&commit=`;
`POST /reviews` accepts a tree target; `GET /reviews` lists both kinds) and `module.yaml` (write kind `setup`, Tier 1 floor,
schema `schemas/setup.json`; no new codehost commit grant). Create `service/src/report.ts` (render plus verdict) and
`service/src/primer-client.ts` (calls Primer's submission route).

**Interfaces:**
- Tree batch: resolve the commit once with `snapshot(HEAD)` when none is given. Run the tools check if any tool is selected,
  then each model option in sequence with `budget = run_usd - spent`. When the budget is ≤ 0, skip the option with "run cap
  spent". `run_usd` defaults to 25, min 1, max 150.
- Findings are stored per option observation, with the existing stable id. `display(findings)` groups the same lens, path
  and overlapping lines for the report only. Outcomes are per observation. A partial run never marks anything fixed.
- `verdict({ findings, coverage })` is blocked (an important security finding), concerns (any other important), incomplete
  (partial coverage, no important) or clean.
- `render(batch)` produces markdown of at most 78,000 characters, trimming nits first with a count. It holds the verdict,
  findings by lens, coverage, cost and the fix prompt. It is submitted to Primer (lane P) and served at
  `GET /reviews/:batch/report` for the board.
- deepsec setup: when a model check returns `setup`, file `code-review.setup` with `{ repo, base: sha, branch:
  "aidenhq/deepsec-setup", expected_tip: string|null, files }`. Its executor calls github's internal op (lane P). The
  next run reads the pending setup files through `snapshot` at the recorded branch tip.

Tests: `run_usd default 25, 151 rejected`, `commit pinned at start`, `spent cap skips with reason`, `display groups but storage
keeps both options`, `verdict cases`, `render ≤ 78000 with trimmed-nit count`, `second run passes the saved document id`,
`setup write filed once per branch tip; not refiled when PR exists`, `migration keeps existing PR runs readable`.

### Lane P: Primer report submission and github's setup op (sonnet)

**Files:** in `modules/primer/connections/primer-mcp/src/` add an authenticated internal route `POST /internal/report` for
code review. It is called with code review's service key, mirroring how github-mcp's `/internal/review` authenticates its
caller. It files Primer's own `publish` write record with the report as `content`, creates the document private to the
requester (the owner), and adds a version when `documentId` is given. First publication is serialised per repo key, so
concurrent runs share one document. In `modules/github/` add an internal op for code review's executor, `setup`: create or
update a branch with **one commit** of exactly the allowlisted `.deepsec/` files, on base `base` and only if the branch tip
equals `expected_tip`, then open or reuse its PR using github's existing PR code. Wire the module.yaml entries.

Tests: `report route rejects callers without the code-review key`, `first publish creates private doc; second adds version`,
`concurrent first publishes yield one document`, `setup op refuses paths outside the allowlist`, `setup op refuses when tip
moved`, `setup op reuses an open PR`.

### Lane E: board (sonnet)

**Files:** `services/board/src/reviews.ts` (proxy `GET /catalog`, `POST /reviews` with a tree target and
`GET /reviews/:batch/report`), `services/board/web/src/Reviews.tsx` (a **New repo review** form; tree batches in the list
with verdict and report link). Test in `services/board/test/` (extend the reviews tests).

- The form has: repo picker, commit (optional, placeholder "default branch head"), options grouped by lens (recommended
  pre-ticked; `runs code` and `high cost` tags), the combo picker, and a run cap ($25 default, up to $150).
- Tests: `admin-only POST`, `catalog proxied with repo`. Run `npx tsc -p tsconfig.build.json --noEmit`. Check the UI at 1512,
  1920 and 2560 widths and on mobile, following the UI-taste rules.

### Lane F: continuous options (after R1, R2 and S merge)

A repo's `on_open` and `on_push` gain `options: string[]`. A moment runs one tools check on the changed files (comparing
project diagnostics between base and head), posting only with findings, as a COMMENT. Each model option runs as its own run.
Options never gate. Changing `options` is owner-tier, like changing combos. Tests: `tools-only findings post once`,
`no findings → no post`, `mandatory verdict ignores option findings`.

### Lane G: insights, docs, security review (last)

Insights adds accepted unique findings per dollar for each option. Update `docs/design/code-review.md`, the README and the
`description:`. Security review of: the token-free tool runs, the setup write and op, Primer submission and privacy, and
repo code running in the box. Fix each finding with a test.

## Order

Lanes R1, R2, S, P and E start together, using the interfaces above. F and G come after they merge. Then one integration
pass: deploy, run a one-off review of `Aiden-HQ/AidenHQ` with the recommended options, read the Primer report, and fix
at the source.

## Fixes from Aiden's review of this PR (binding on every lane)

- The catalog is `catalog.json`. The tools check spec always carries `base`, set to the commit itself for a tree target,
  because the kernel requires every declared field.
- `runs_code` options are `tool` kind only, so repo code runs only in the token-free tools check. Model checks keep
  today's read-only policy. Fork PRs never run `runs_code` options.
- The finding cap: keep every important finding, cap nits at 200 and record the dropped count. `export-ignore` paths from
  `.gitattributes` are coverage gaps.
- deepsec scans when any `.deepsec/` file exists, and init runs only when none does. Setup adds missing files only and
  never overwrites. deepsec's cap is the check's `budget_usd`.
- Setup PR: code review calls the kernel's `/v1/codehost/setup` under a `codehost.setup` grant that lists the allowlisted
  paths.
  - The github module files its own Tier-1 `setup` write, with schema `modules/github/schemas/setup.json` (lane P), and
    executes it only when approved.
  - The branch is based on the default branch head. The full PR diff must hold only the allowlisted paths. Every org gets a
    branch plus a PR.
  - Lane S drops its own `code-review.setup` write kind.
- Primer creates the document private. Before each version it checks the audience, and starts a new private document if
  the old one was shared.
- Activation: everything new sits behind `code_review.lenses` (default false) until lane G's security review is done.
- Single-check cap: `max_usd` 100. The $150 maximum is the run total.
