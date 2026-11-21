# Code review lenses: one-off repo reviews and a catalog of ready-made reviewers

The owner approved this direction on 2026-11-21 and 2026-11-22, after five research passes. The research is in the instance
repo at `docs/product-history/research/2026-11-21-code-review-lenses-and-repo-audits.md`.
Status: design, waiting for the owner's review.

## Intent

Today `code-review` reviews pull requests for correctness, using four engines.

The owner wants two things added. The first is general reviewers beyond bug-finding: security, maintainability and
performance. The second, and the main use, is a **one-off review of a whole repository** at a chosen commit.

A run's options come from a large menu of trusted, ready-made reviewers. These are vendor harness commands, upstream skills
and plugins, and standalone tools. The owner's earlier bake-off showed that Claude's and Codex's own harnesses beat
hand-written ones, so we wire up what exists and write no reviewer prompts of our own.

Success looks like this. The owner (or anyone with a fresh install) asks Aiden, or presses **New repo review** on the board,
for `org/repo`. The ticked options run, and a markdown report lands in Primer, shared with them. The report gives a verdict,
findings by lens with evidence, coverage, cost, and a fix prompt they can paste. Continuous PR review gains the same lenses
as options.

## Goals

- There are two **modes** in one module.
  - **Continuous** (today): each PR open or push on a followed repo produces a GitHub review.
  - **One-off**: one repo at a commit produces a Primer report. The commit defaults to the head of the default branch, and
    any commit can be given.
- There are four **lenses**: correctness, security, maintainability and performance. Each lens has a menu of **options** for
  each mode. Recommended options are ticked by default.
- An option shows only when the repo's stack fits, for example knip only for JS/TS repos.
- **Out-of-the-box only.** An option runs an upstream command, skill, plugin or tool as shipped, pinned to a version. Our
  code is limited to:
  - running the option in the box;
  - mapping its output to findings;
  - deduplicating;
  - reporting or posting.
- **Trust bar.** An option qualifies only if all of these hold:
  - it is published by its vendor or a known company or organisation, or it has at least 1k stars;
  - it was active in the last 3 months;
  - it carries an accepted licence: permissive, or AGPL/CC-BY-SA run unmodified.
- deepsec decides by itself whether to set up or scan. A first run sets it up and opens a setup PR.
- A one-off report is one Primer document per repo. Each re-run adds a version.

## Non-goals

- Fixing code. Reviews find problems; fix work goes to engineers through tasks as today, using the report's fix prompt.
- Scheduled one-off reviews. Following a repo with one-off reviews (re-running on a schedule) comes after the first runs
  prove useful.
- Replacing today's engines or gating. Mandatory combos and the merge gate stay as they are, and new options never gate.
- Running against live production systems: no pentests and no live databases.

## Anti-goals

- Hand-written reviewer prompts, skills or harnesses. If no trusted ready-made option exists for a gap, the gap stays and
  the report says so.
- Untrusted repos on the menu: 0-star projects, no licence, or a paid backend required.
- A report that reads as clean when coverage was partial.
- Cost that piles up across overlapping options.

## Approaches considered

1. **Extend `code-review` with modes, lenses and an option catalog (chosen).** This reuses the credential-free box, the
   engines, the findings store, the spend ledger, the board's Reviews page and the Reviewer Manager. One-off reviews add a
   target and a report. Continuous reviews gain options.
2. **A new `repo-audit` module.** This gives a cleaner product boundary but duplicates the box, the engines, the findings
   store and spend handling, which breaks the "one way" convention.
3. **One module per lens.** This is the most duplication. Vendors do package security separately, but each of them runs the
   same pipeline inside.

## Decided

### Modes and the run request

The run request is one JSON shape, used by the board, the Reviewer Manager (`code_review_run`) and settings:

```json
{
  "mode": "one_off",
  "target": { "repo": "org/app", "commit": "<sha, optional>" },
  "options": ["sec.quick-scan", "sec.deepsec", "maint.knip", "perf.linters"],
  "combo": { "model": "<openrouter id>", "effort": "medium" },
  "run_usd": 50
}
```

- For continuous mode the target is `{ repo, pr }`. A followed repo's `on_open` and `on_push` keep their combo lists and gain
  an `options` list.
- If the request gives no commit, the service resolves the default branch's head once, when the run starts. That SHA is the
  one recorded and shown everywhere.
- The `combo` supplies the model and effort for options that call a model. It does not apply to deterministic tools.
- `run_usd` is one shared cap per run, covering every option, every retry and every box. The default is **$25** and the maximum
  is **$150** (owner, 2026-11-22). The form marks high-cost options.

### The option catalog

There is one catalog file, `modules/code-review/catalog.yaml`, the single source for the board, the tools and the recipe.
Each entry has these fields:

| Field | Meaning |
|---|---|
| `id` | Stable id, for example `sec.deepsec`. |
| `lens` | `correctness`, `security`, `maintainability` or `performance`. |
| `modes` | `one_off`, `continuous`, or both. |
| `recommended` | Default-on, per mode. |
| `kind` | `tool` (a deterministic CLI), `skill` (an upstream skill or plugin run in a harness) or `engine` (a standalone LLM tool such as deepsec, Codegenie or the existing engines). |
| `source` | Upstream repo, pinned version or commit, and licence. |
| `run` | The command, or for a skill, the harness (`claude-code` or `codex`) and the skill invocation. |
| `when` | Stack detection: file globs evaluated on the snapshot, for example `package.json`, `go.mod`, `**/*.sol` or `migrations/**`. |
| `output` | `sarif`, or a named mapper for the tool's JSON, or `findings`, where the harness restates the skill's own findings in our schema, as the claude-code engine does today. |
| `runs_code` | Whether the option installs dependencies or executes repo code. Shown to the user. |
| `cost` | `free`, `low` or `high`. Shown when a run starts. |

Every upstream skill, plugin and tool is installed into the review image at **build time**, pinned. Nothing is downloaded
when a run starts. This follows the supply-chain rule: pinned, and at least 7 days old.

### The first catalog

★ marks recommended. "Continuous" means it runs on the change, with project-scoped tools comparing diagnostics between the
base and the head.

**Correctness**

| Option | Upstream (licence) | One-off | Continuous |
|---|---|---|---|
| Type and lint bug checks: `tsc --noEmit`, typescript-eslint `strict-type-checked`, oxlint | microsoft/TypeScript, typescript-eslint, oxc (Apache/MIT) | ★ | ★ |
| codex-native review | openai/codex `codex exec review` (Apache) | pilot | ★ |
| Claude Code `/code-review` | Claude Code (built-in) | pilot | ★ |
| Codegenie | 0xPolygon/codegenie (MIT) | | ✓ |
| `ce-code-review` (correctness, reliability, adversarial personas) | EveryInc/compound-engineering-plugin (MIT) | pilot | ✓ |
| Codex adversarial review | openai/codex-plugin-cc (Apache) | | ✓ |
| silent-failure-hunter, pr-test-analyzer | anthropics/claude-plugins-official pr-review-toolkit (Apache) | | ✓ |
| Gemini code-review extension | gemini-cli-extensions/code-review (Apache) | | ✓ |
| API breaks: `oasdiff breaking`, `buf breaking` | oasdiff, bufbuild/buf (Apache) | | ★ when an OpenAPI or proto file changes |
| Workflow errors: actionlint | rhysd/actionlint (MIT) | ✓ | ★ when a workflow changes |
| Test suite with race detection (runs code) | go test -race and equivalents | ✓ | ✓ |
| Variant analysis (siblings of a known bug) | trailofbits/skills (CC-BY-SA, unmodified) | ✓ | |

**Security**

| Option | Upstream (licence) | One-off | Continuous |
|---|---|---|---|
| Quick scan: gitleaks, osv-scanner, govulncheck, zizmor, trivy fs+config | gitleaks (MIT), google/osv-scanner (Apache), golang/vuln (BSD), zizmor (MIT), trivy (Apache) | ★ | ★ on what changed |
| deepsec | vercel-labs/deepsec (Apache) | ✓ | ✓ (`--diff`, once set up) |
| Cloudflare security audit | cloudflare/security-audit-skill (MIT) | ★ | |
| Codex Security `cs scan` | openai/codex-security (Apache) | hidden until verified | hidden until verified |
| Claude Code `/security-review` | Claude Code (built-in) | | ✓ |
| Trail of Bits audit skills: audit-context-building, insecure-defaults, sharp-edges, fp-check, differential-review | trailofbits/skills (CC-BY-SA, unmodified) | ✓ | ✓ (differential-review) |
| Anthropic threat-model and vuln-scan skills | anthropics/defending-code-reference-harness (unmaintained) | ✓ | |
| Smart contracts: solidity-auditor + slither | pashov/skills (MIT), crytic/slither (AGPL, unmodified) | ★ when Solidity is present | ★ on changed `.sol` |
| LLM apps: garak | NVIDIA/garak (Apache) | ✓ when the app embeds a model | |
| Agent skills and MCP servers in the repo: SkillSpector | NVIDIA/skillspector (Apache) | ✓ | ✓ |
| Added plugins | Pinned plugins the owner adds, each meeting the trust bar (see below) | ✓ | ✓ |

**Maintainability**

| Option | Upstream (licence) | One-off | Continuous |
|---|---|---|---|
| Dead code: knip, vulture + ruff, Go deadcode, cargo-machete | webpro-nl/knip (ISC), vulture (MIT), ruff (MIT), golang/tools (BSD), cargo-machete (MIT) | ★ | ✓ on changed files |
| Duplication: jscpd | kucherenko/jscpd (MIT) | ★ | ✓ |
| Architecture: improve-codebase-architecture | mattpocock/skills (MIT) | ★ | |
| fallow (dead code, duplication, complexity, architecture) | fallow-rs/fallow (MIT) | ✓ | |
| code-modernization: architecture-critic, modernize-assess | anthropics/claude-plugins-official (Apache) | ✓ | |
| Boundaries: dependency-cruiser, madge, import-linter (when contracts exist) | MIT, MIT, BSD | ✓ | ✓ |
| Health map: scc + git churn hotspots | boyter/scc (MIT) | ✓ | |
| Comment drift: comment-analyzer | pr-review-toolkit (Apache) | | ✓ |
| Broken internal doc links: lychee `--offline` | lycheeverse/lychee (MIT/Apache) | ✓ | ✓ |

**Performance**

| Option | Upstream (licence) | One-off | Continuous |
|---|---|---|---|
| Linters: ruff PERF, clippy perf, rubocop-performance, squawk | astral-sh/ruff, rust-clippy, rubocop, sbdchd/squawk (MIT/Apache) | ★ | ★ on changed files and new migrations |
| Postgres best practices | supabase/agent-skills (MIT) | ★ when Postgres is present | ✓ |
| React/Next best practices | vercel-labs/agent-skills react-best-practices (MIT, per its skill file) | ★ when React is present | ✓ |
| MongoDB query optimizer | mongodb/agent-skills (Apache) | ✓ when a local database can run | |
| Web vitals: web-perf + Chrome DevTools LCP/memory (runs code) | cloudflare/skills, ChromeDevTools/chrome-devtools-mcp (Apache) | ✓ when the app serves locally | |
| Bundle budgets: size-limit, Lighthouse CI | ai/size-limit (MIT), GoogleChrome/lighthouse-ci (Apache) | ✓ | ✓ |
| Framework skills: django-perf-review, react-native-best-practices, dotnet performance agent | getsentry/skills (Apache), callstackincubator/agent-skills (MIT), dotnet/skills (MIT) | ✓ by stack | ✓ by stack |
| N+1 detectors in the test run (runs code) | bullet, prosopite, laravel-query-detector (MIT) | ✓ by stack | |
| Profile the test suite: py-spy, pprof (runs code) | benfred/py-spy (MIT), google/pprof (Apache) | ✓ | |
| Benchmarks, base against head (runs code) | the repo's own, plus hyperfine or benchstat | | ✓ when benchmarks exist |
| Index advisor: dexter (runs code) | ankane/dexter (MIT) | ✓ when Postgres and HypoPG can run locally | |

**Left out:**
- qlty: BUSL, with an exclusion for AI review services.
- Codeflash: BSL.
- getsentry/warden: FSL.
- The Anthropic `claude-security` plugin: proprietary.
- CodeQL: its licence allows only public repos.
- Semgrep registry rules: restrictive licence.
- CodeRabbit, Qodo, Endor, Socket, snyk agent-scan and promptfoo code scan: they need vendor accounts or a hosted backend.
- Strix: a live pentest, not code review.
- Repos with 0 stars or no licence.

**Added plugins.** The owner can add a Claude Code plugin to the catalog by repo and pinned commit (for example a company's
private security plugins). Each one is checked against the trust bar and appears as one option under the lens it declares.
A marketplace itself is never a checkbox.

### Gaps, said plainly

- **No trusted ready-made reviewer reads a whole tree for correctness.** Every LLM reviewer reviews diffs. One-off
  correctness is therefore the deterministic checks, plus three **pilots**:
  - codex-native with the empty tree as base;
  - Claude Code `/code-review` with the empty tree as base;
  - `ce-code-review` with the empty tree as base ref.

  The first build measures the pilots on two of our repos for coverage, accepted findings and cost. A pilot is starred only
  if it really covers the tree.
- **No trusted backend performance skill exists outside Django and .NET.** Go, Rust, Node, JVM and Rails get only the
  deterministic tools.

### deepsec: set up or scan

- `.deepsec/` exists at the commit → the run scans: `scan` + `process` + `revalidate` for one-off runs, or
  `process --diff <base>` for continuous runs.
- `.deepsec/` is missing → the run sets up in the box (`init`), which writes the repo summary, config and generated matchers,
  then scans. The service opens a **setup PR** adding only the files deepsec means to be committed. Later runs reuse that
  PR's files until it merges. "Force set-up" re-runs set-up and updates the PR.
- deepsec state (`DEEPSEC_DATA_ROOT`) lives in the run's temp directory. Its spend cap is `run_usd`. Its model goes through
  the gateway on its pi backend's OpenAI-compatible route.
- The setup PR is the module's first write that changes a repository. It goes through the github module's code host
  operations as a kernel write record at Tier 1, so the AI reviewer reads the diff. This is the owner-approved exception to
  "a review never pushes": it is setup, not a fix. It is PR-only on repos outside the agents org.

### Reports in Primer

- A one-off run publishes one markdown document per repo, titled `Repo review: org/repo`. Each run adds a version named
  after the commit and date. The document holds:
  - the verdict;
  - findings by lens, each with severity, file and line, evidence, which option found it, and a fix brief;
  - coverage: options run, options skipped and why, and any failures or timeouts;
  - cost;
  - a fix prompt to paste into Claude Code or Codex.
- Code renders the document; the model never writes it. The service publishes it through primer-mcp as a kernel write
  record at Tier 1, the same way code review's GitHub posts are filed today. It is shared only with the requester. Security
  findings describe live weaknesses, so wider sharing is the requester's choice afterwards.
- The board's Reviews page lists one-off runs next to PR reviews and links to each report. Findings are kept in the module's
  SQLite like PR findings, and their outcomes (fixed or dismissed) feed the stats.

### The box

- One-off runs are a new check job, `repo-review`, with a larger cap (`max_usd` set by the catalog's high-cost options; the
  run's `run_usd` is the hard cap) and a longer timeout (3 hours). Continuous options run in today's `code-review` job.
- **Options may install dependencies and run the repo's code** (owner, 2026-11-21). The checkout is copied into the run's
  writable temp directory first. The network stays open.
- The model token never reaches repo processes. Deterministic tools and repo commands run with an environment that holds
  no token. Output is redacted for key-shaped text before anything is mapped, as today.
- Each tool runs once per run, even when two lenses list it. Findings from all options are merged by file, line and
  underlying issue, keeping every option that found them.
- A failed, timed-out or skipped option is listed under coverage. A run never reports clean when coverage was partial.

### Earning the stars

The board's Insights tab already tracks findings and their outcomes. It gains **accepted unique findings per dollar** for
each option. Recommended marks change by that measure, through a catalog PR, never automatically.

### Settled after the builder check (my calls, simplest to maintain)

- **Who gets the report.** Every admin is an owner, so "the requester" is the owner's Primer account. The report is
  filed as the primer module's existing `publish` write: `content` is the rendered markdown, and `documentId` is the
  repo's document from earlier runs, kept in code review's SQLite. Primer creates it as the owner, so no
  collaborator call is needed. There is no new write kind.
- **Runs and spend.** A one-off run is a sequence of check jobs that the service starts, the same way it starts a moment's
  combos today:
  1. One `repo-review` job runs every selected `tool` option in one box. These use no model token.
  2. Then one job per selected `skill` or `engine` option, one after another. Each job's `budget_usd` is `run_usd` minus
     what the run has already spent, so the shared cap holds exactly.
  3. Each job's billed cost, read from the ledger as today, is that option's cost.

  The recipe's `max_usd` is a fixed ceiling of 150, and `run_usd` is the real cap. The timeout is 180 minutes per job. A
  failed or timed-out job becomes a coverage gap, and the run carries on.
- **The image.** The tools are added to the existing `engineer` image, which already has Go, Rust, Python and Node.
  Engineers benefit from them too, and the kernel's image list doesn't change. The box has no Docker daemon, so options
  that need a database or a served app are **left out of v1**: the MongoDB optimizer, dexter, web vitals, Lighthouse
  CI, and the N+1 detectors that need a database. Options that run tests, profilers or benchmarks with no services stay.
- **The token and repo code.** Tool options and repo commands are spawned by the recipe with an environment that holds no
  token. Skill and engine options follow the existing per-engine rule: the harness scrubs its shell's environment
  (codex's `shell_environment_policy`, Claude Code's subprocess scrub). For deepsec, the token goes only in the
  environment variable its route names. The owner already accepted that a command can read the capped, time-limited token
  from the engine process.
- **Continuous options.** A continuous model option is a combo entry like today's, posting its own GitHub review as a
  comment. Tool options run together in one extra job, which posts one review only when it has findings. Nothing posted
  requests changes or gates a merge.
- **Findings.** One-off findings are keyed by repo, run and stable id. The stable id is today's function over the
  option, file and normalised title. A finding found again in a later run keeps its id and history. It counts as fixed
  when a later run of the same option, with full coverage, no longer reports it.
  - Dedupe across options is deterministic and needs no model call. Findings in the same lens and file whose lines
    overlap within 3 lines are merged, keeping every option that found them.
- **The verdict.** Computed in code:
  - **blocked**: an important security finding.
  - **concerns**: any other important finding.
  - **clean**: none, with full coverage.
  - **incomplete**: no important finding, but coverage was partial.
- **Vulnerability databases.** These are data, not code. osv-scanner, trivy and govulncheck fetch their databases when the
  run starts (the network is open). The supply-chain rule covers installed code only.
- **The default branch's head.** Resolved with the code host's `head` op, which needs a `fetch` grant on the snapshot repos.
- **The deepsec setup PR.** The box returns the committed `.deepsec/` files deepsec writes. The service commits them
  one file at a time with the code host's `commit` op onto a setup branch. Its grant names exactly those paths:
  `.deepsec/INFO.md`, `.deepsec/deepsec.config.ts`, `.deepsec/generated-matchers.ts`, `.deepsec/package.json` and its
  lockfile. It then opens the PR through the github module's typed PR path. Until the PR merges, the next run
  fetches the setup branch for those files.

## New installs

- The module stays idle and in the default bundle. Nothing runs until someone starts a one-off review or follows a repo.
- The catalog and the **New repo review** button show even when GitHub isn't connected. The button then explains that a
  repo snapshot needs the github or codehost-local module.
- Without Primer, a one-off report is shown on the board only, and the run says why.
- Options whose upstream needs a credential the box doesn't hold never appear. Options gated on a locally runnable app or
  database appear only when the repo's compose or test setup provides one.
- Another owner's plugins plug in through **Added plugins**, under the same trust bar.

## Left to the builder

- The catalog file's exact schema and its validator, plus one test that every entry has a source, a pinned version, a
  licence and a lens.
- Output mappers: one SARIF mapper covers gitleaks, osv-scanner, zizmor, trivy and others; small JSON mappers cover knip,
  jscpd, vulture and the rest.
- How a skill option is invoked in each harness, following the claude-code engine's existing pattern (run the skill, then
  restate its findings in our JSON in the same session).
- Whether the tools go in the `engineer` image or a dedicated review image, keeping either one small.
- Stack detection globs.
- The board form, and the fields `code_review_run` gains.
- The gateway check for Codex Security (where it sends data, and whether it accepts our gateway) before that option is
  enabled.
- A security review of the new paths before they switch on: setup PR writes, report publishing, and repo code running with
  the token held back.

## Build order

1. One-off mode end to end: the run request, the `repo-review` job, the quick scan, the maintainability tools, the
   performance linters and the Primer report.
2. deepsec (set up or scan, and the setup PR) and the Cloudflare audit skill.
3. The remaining one-off options, and pilots for whole-tree correctness, measured on two repos.
4. Continuous options added to `on_open` and `on_push`.
5. Insights: accepted unique findings per dollar for each option.
