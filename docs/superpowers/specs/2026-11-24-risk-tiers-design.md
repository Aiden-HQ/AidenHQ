# Risk tiers: one risk call per PR, read by code review, ship and CI

Status: design for build, 2026-11-24. Owner decisions are marked **(owner)**; everything else is the designer's call. Builds on
the ship spec (`2026-11-24-ship-design.md`) and lands after #1687 (ship approval) and #1688 (code review's Fleet page).

## Why

Three places judge how risky a PR is, each in its own way:

- **ship's `safe` block** decides AI approval: line and file caps, a deny list, generated files without their source;
- **the CI template's reviewer** decides whether to skip a tiny PR and how hard to look: a built-in regex, the app's
  `.github/code-review-critical` file and the `deep-review` label;
- **code review** has one set of combos per repo, the same for a one-line typo fix and a change to the auth layer.

The result is a cheap PR paying for a deep review, an auth change getting the same review as a typo, and three lists of
"sensitive paths" that drift apart.

**Goal (owner).** Each PR gets one tier from cheap, deterministic facts. Code review picks its combos, models and rounds
by tier. Ship picks approve and merge by tier. CI picks its review depth by tier. One definition, one place to edit it.

## Fixed by the owner

- The tier comes from the code touched, the change size, the repo's own class and other cheap facts. No model call.
- Per tier: auto-merge on or off, how many review rounds, which review models.
- Plain settings with presets, no hard floors, per repo. Every setting is on its module's Fleet page, with help.
- One way: tiers replace ship's `safe` block, the CI template's `CRITICAL_GLOBS` and the `deep-review` label.
- Simplicity first: facts with thresholds and globs, first-match rules. No arbitrary expressions, no OR or NOT.
- Ship has no `review_rounds`. Review and fix cycles are code review's `push_rounds`.

## Non-goals

- Per-tier lenses or catalog options (later).
- Learning tiers from outcomes (reverts per tier come from ship's metrics later; the owner then edits the rules).
- Tiers for repo reviews (a whole tree at a commit). Tiers are about PRs.

## 1. Tiers

There are four tiers, a fixed set:

| Tier | Rank | Meaning |
|---|---|---|
| `skip` | 0 | No review at all. Reached only through a rule (the default: a writer's `no-review` label). |
| `trivial` | 1 | A small change by a member. One cheap review. |
| `standard` | 2 | Everything else. |
| `sensitive` | 3 | Sensitive paths, outsiders, big changes, critical repos. The strongest review. |

The set is fixed, not user-defined. That keeps the Fleet pages, the CI mapping, ship's per-tier grid and the rank used for
"most cautious" and loosening simple. A repo that wants fewer tiers points rules at fewer of them.

The rank orders tiers by caution. **Most cautious** is `sensitive`. Wherever a tier is unknown, the reader uses `sensitive`.

Naming: these are *risk tiers* and are always named (`trivial`). The kernel's write tiers are numbered (Tier 0, 1, 2) and
stay a separate thing.

## 2. Facts

The classifier sees only these facts. Each is cheap, and each is computed from the PR's own change: GitHub's diff from the
merge base to the head (`pulls/{n}/files`), never a push's delta. A base merge that leaves the PR's own change alone
therefore yields the same facts.

| Fact | Value | Computed from |
|---|---|---|
| `lines` | Substantive lines changed: additions plus deletions over every file except generated files and lockfiles | The PR's files list. Generated files and lockfiles are recognised by the built-in lists from `recipe/scope.ts` (`GENERATED`, `LOCKS`), which move into the classifier as their one definition. Tests and docs count: AGENTS.md, SKILL.md and handbooks are instructions. |
| `files` | How many files count toward `lines` | Same list. |
| `paths` | Every changed path, including a rename's old path and generated files | Same list. A rule's `paths` matches when any path matches any of its globs. |
| `author` | `member`, `bot` or `outsider` | The PR's author: the instance's own GitHub App is `member`; any other `*[bot]` login is `bot`; GitHub's `author_association` `OWNER`, `MEMBER` or `COLLABORATOR` is `member`; anyone else is `outsider`. No extra API call: the PR read carries both fields. |
| `labels` | The PR's labels | The PR read. A label that would *lower* the tier counts only when someone with write access added it (below). |
| `base` | The base branch name | The PR read. |
| `repo_class` | `critical`, `standard` or `sandbox` | The repo's code review entry (default `standard`). |

**Unreadable facts.** A files list that GitHub can't give whole (over 3,000 files, or a failed read) gives no facts. The
PR is then `sensitive`, with the reason. This replaces `safe.ts`'s 300-file cap with GitHub's own limit for the files list.

**Labels that lower a tier.** The classifier is run twice, with the labels and without them. If the labels lower the tier,
code review reads the PR's label events (a new github internal read, the timeline call `labelEvents` already makes, without
the maintained-repo restriction) and keeps only the labels whose latest `labeled` event is by a login with write access
(code review's existing `permission()` check, the same rule as `aiden review` commands). Events by the instance's own App,
or any other bot, never count: an agent can't skip its own review. It then classifies again with the trusted labels only.
The timeline is read only in that case, so most PRs cost no extra call. A label that raises the tier always counts.

## 3. Rules

A repo's rules are an ordered list. The first rule whose conditions all hold names the tier. The last rule has no `when`
and catches the rest.

```yaml
rules:
  - { when: { repo_class: critical }, tier: sensitive }
  - { when: { repo_class: sandbox }, tier: trivial }
  - { when: { labels: [no-review] }, tier: skip }
  - { when: { author: bot, only_paths: [<manifests>, <lockfiles>] }, tier: standard }
  - { when: { paths: [<sensitive>] }, tier: sensitive }
  - { when: { author: outsider }, tier: sensitive }
  - { when: { labels: [deep-review] }, tier: sensitive }
  - { when: { lines_max: 0 }, tier: sensitive }
  - { when: { lines_min: 600 }, tier: sensitive }
  - { when: { author: member, lines_max: 10, files_max: 20 }, tier: trivial }
  - { tier: standard }
```

**Conditions.** Each is a fact with a value; a rule's conditions all hold (AND). A list value is "any of": a glob list or a
label list. There is no OR across facts and no NOT. Each fact may appear once in a rule.

| Condition | Holds when |
|---|---|
| `lines_min: n` / `lines_max: n` | `lines >= n` / `lines <= n` |
| `files_min: n` / `files_max: n` | `files >= n` / `files <= n` |
| `paths: [globs]` | any changed path matches any glob |
| `only_paths: [globs]` | every changed path matches some glob (and there is at least one) |
| `author: member\|bot\|outsider` | the author is that kind |
| `labels: [names]` | the PR has any of these labels (lowering ones only when trusted, §2) |
| `base: [globs]` | the base branch matches any glob |
| `repo_class: critical\|standard\|sandbox` | the repo's class is that |

Globs are `node:path`'s `posix.matchesGlob`, matched case-sensitively against repo-relative paths.

**Validation.** Every rule has a known `tier`, every condition is known and well typed, the last rule has no `when`, and no
other rule lacks one. An invalid list refuses the repo's entry whole, with the message, as config.ts does today.

**The default rules** (shown above) carry over what the three old lists meant:

- `<sensitive>` merges the CI regex (`.github/**`, `**/Dockerfile*`, `**/package.json`, `**/AGENTS.md`,
  `**/AGENTS.override.md`, `**/CLAUDE.md`, `**/.codex/**`, `**/codex.toml`, and `**/*auth*`, `**/*secur*`, `**/*token*`,
  `**/*session*`, `**/*permission*`, each as a file and as a folder) with ship's `safe.deny` (lockfiles, test and lint
  config, `**/CODEOWNERS`, `**/migrations/**`, `**/*.tf`, `infra/**`, `**/.env*`, `**/config/**`, `**/docker-compose*`).
- `<manifests>` and `<lockfiles>` are the manifest and lockfile names the classifier already knows (`package.json`,
  `go.mod`, `Cargo.toml`, `pyproject.toml`; `LOCKS`).
- `lines_max: 0` is a PR with no substantive line: it changes only generated files, lockfiles, binaries or renames. That is
  ship's "generated files without their source" (decision 29) and most of CI's "a binary file is critical", in one fact.
- `no-review` is the break glass: a writer's word that this PR needs no review. Bots and agents can't use it (§2).

## 4. Settings

### Code review (the `code_review` setting)

A repo entry gains `repo_class`, `rules` and `by_tier`. They replace `on_open`, `on_push` and `push_rounds`, which move
under each tier. `drafts`, `forks`, `ignore` and `max_nits` stay per repo.

```yaml
code_review:
  repos:
    - repo: acme/api
      repo_class: standard        # critical | standard | sandbox
      # rules: [...]              # omitted: the default rules
      by_tier:                    # each tier omitted, or a field omitted, takes the preset's
        sensitive: { on_push: [{ engine: codex-native, model: openai/gpt-6.2-sol, effort: medium, mandatory: true }] }
      drafts: false
      forks: manual
```

**The preset** (what an omitted tier or field takes):

| Tier | `on_open` | `on_push` | `push_rounds` |
|---|---|---|---|
| `skip` | none | none | 0 |
| `trivial` | codex · `~deepseek/deepseek-flash-latest` · medium, mandatory | none | 0 |
| `standard` | codex · `~deepseek/deepseek-flash-latest` · medium, mandatory | codex-native · `openai/gpt-6.2-sol` · low, mandatory | 1 |
| `sensitive` | codex-native · `openai/gpt-6.2-sol` · medium, mandatory; claude-code · `anthropic/claude-sonnet-5.5` · medium, mandatory | codex-native · `openai/gpt-6.2-sol` · low, mandatory | 2 |

`standard` is today's `REPO_DEFAULTS` with `mandatory` on. Mandatory is the preset's default because ship approves only on a
verdict that covers the head, and a tier with no mandatory combo has none (§7). A repo that wants advice-only reviews turns
`mandatory` off per combo, as today.

**`rules` is whole.** A repo either omits it (the default rules) or gives the full list. Partial rule edits would need a
merge semantics nobody can read; the Fleet page edits the full list (§10).

**`by_tier` merges per field** over the preset: `by_tier.sensitive.push_rounds: 3` changes only that.

**Validation per tier** is today's per repo: at most four combos a moment, and a mandatory `on_push` combo needs a mandatory
`on_open` one in the same tier.

**Gated, defined per tier.** Two compiled lists replace today's one (`scripts/modules.ts` `codeReviewGated`):

- `GITHUB_REVIEW_GATED` (the merge queue asks code review's verdict): a repo where **any** tier has a mandatory combo.
- `code_review_mandatory` (the kernel's `ai_review_code: unless_code_review_mandatory` skips the AI reviewer): a repo where
  **every tier but `skip`** has a mandatory combo. Otherwise a `standard` PR on a repo that gates only `sensitive` would pass
  neither the AI reviewer nor code review.

### Ship (the `ship` setting)

A repo entry, and `defaults`, gain `by_tier`. It replaces the repo-level `approve`, `merge` and `safe`.

```yaml
ship:
  repos:
    acme/api: { preset: cautious, by_tier: { trivial: { approve: on } } }
```

| Field | Values | Meaning |
|---|---|---|
| `by_tier.<tier>.approve` | `off`, `observe`, `on` | `observe`: the report says what ship would do. `on`: the App approves when the evidence holds (§7). `safe` and `all` are gone: the tier is the class. |
| `by_tier.<tier>.merge` | `off`, `ready` | `ready`: merge when every gate passes. |

**Presets:**

| Tier | `cautious` | `full` |
|---|---|---|
| `skip` | approve `off`, merge `ready` | approve `on`, merge `ready` |
| `trivial` | approve `observe`, merge `ready` | approve `on`, merge `ready` |
| `standard` | approve `observe`, merge `ready` | approve `on`, merge `ready` |
| `sensitive` | approve `off`, merge `ready` | approve `on`, merge `ready` |

`cautious` keeps today's `approve: observe` for everything that could be approved, so the bpn-api pilot runs as planned.
`merge: ready` everywhere keeps pr-watch parity: today every fleet PR merges once its gates pass, and an unwatched fleet repo
(no tier, so `sensitive`) still does. Turning on real approvals per tier is the owner's move (§9).

## 5. Classification: when, where, and what is recorded

**Who classifies.** Code review, the one owner of the rules. The pure function `classify(facts, rules) → { tier, rule }` lives
in `kernel/sdk/src/tiers.ts` with the fact helpers and the default rules, and `scripts/sync-shared.ts` copies it into code
review's service (`src/aidenhq-sdk/tiers.ts`) and into the CI template (`.github/tiers.ts`, MIT like the rest of it).

**When.** Code review's poll already reads every open PR of a watched repo each tick (head, labels, author come in that
read). It classifies a PR when its head, its label set or the repo's tier settings (a hash) changed since the last
classification. A new head therefore always re-classifies, and so does a label added at the same head.

**Before any trigger.** The poll classifies first, then calls `trigger()`, so the first review of a head already uses its
tier's combos. The files read is one paginated call per new head (GitHub's PR files list, up to 3,000 files).

**The PR's tier ratchets up.** Each head has its own *head tier*. The PR's *tier* is the most cautious head tier it has had.
A trimmed PR keeps the reviewers it already has, and their findings still gate. This is what keeps review simple: going up
queues the higher tier's opening review once, and going down never queues anything. The exception that isn't one: `skip`
is reached only before the PR's first review, since after that the PR's tier is already higher.

**Stored.** A `tiers` table in code review's database: `(repo, number, head, head_tier, tier, rule, facts, labels, config, at)`.
Runs gain a `tier` column, so cost and findings per tier come out of the runs table for later analysis.

**Recorded.** The flow fact `pr.tier` (declared in `modules/code-review/module.yaml` `facts:`), subject the PR, version
`<head>:<tier>`, data `{ head, head_tier, tier, rule, facts }`. It is for the report, flow metrics and the Fleet Steward;
nothing gates on reading it.

**Served.** Code review's `GET /v1/verdict` (ship and the merge queue already call it with their module tokens) adds
`tier: { head, head_tier, tier, rule, why } | null`. `null` means this head isn't classified yet, or the repo isn't watched.
Ship then treats the PR as `sensitive` for that pass. Ship never reads the fact store.

## 6. Code review uses the tier

**One small seam.** `tierCfg(repo, tier)` resolves a repo entry and a tier into today's `Repo` shape (`on_open`, `on_push`,
`push_rounds`, plus the repo-level fields). `trigger()`, `missing()`, `gateRuns()`, `capped()`, `verdict()`, the `aiden
review` command and #1687's `fresh()` take that instead of the repo entry. Everything else in the engine stays.

**Going up mid-life.** A trivial PR gets a push that makes it sensitive:

1. The poll classifies the new head; the PR's tier becomes `sensitive`.
2. `missing()` already queues "a gated repo's open head missing a mandatory reviewer". It now compares against the PR's
   tier: the head gets that tier's `on_open` batch as a full review of the PR (moment `open`), once.
3. Later pushes get `sensitive`'s `on_push`, up to its `push_rounds` (counting the PR's push rounds so far, as today).

**The verdict per tier.** `verdict()` judges the head against its PR tier's mandatory combos:

- A tier with mandatory combos: as today.
- A tier with none (`skip`, or a tier set to advice only): no reviewer to wait on. The verdict is `pass` unless an important
  finding from an earlier mandatory run is still open: those always gate.
- `evidence()` (#1687) answers `kind: none` for such a head, so ship knows there is no review to approve on.

**Repos code review doesn't watch** get no tier. That is the same as today: no verdict, no gating.

## 7. Ship uses the tier

- `judge()` reads `tier` from the verdict answer and the repo's `by_tier[tier]`. `approve: on` approves when the verdict
  passes and covers the head (completed, or carried, as #1687 does). `observe` reports it. `off` says "tier `sensitive`:
  approval is off". A tier with no mandatory review (`kind: none`) is never approved: "tier `skip` has no review to approve
  on". No tier on the head: `sensitive`.
- `merge` comes from `by_tier[tier].merge`; `decide` takes it instead of the repo-level field.
- `safeClass`, its test/docs/manifest lists and the 300-file cap go. The report's "risk facts" line shows the tier, the rule
  that matched and the facts.
- **Carry-over.** A verdict carries to a later head when the PR's own change is the same (`carries()`, a base merge or only
  generated paths regenerated) **and** the verdict's `tier` names the same tier at both heads. A base-merge-only head
  re-classifies the same, because the facts come from the PR's own diff over its merge base. A regenerated lockfile can
  change `paths` (and so the head tier); the PR's tier only ratchets, so the worst case is a higher tier, a fresh review
  under its combos, and no carry.
- `loosens()` gains per tier: `approve` raised (`off` < `observe` < `on`), `merge` raised (`off` < `ready`). The `safe.*`
  checks go.

## 8. CI uses the tier

The CI template's reviewer runs in an app repo's Actions job. It can't call code review, and most app repos aren't watched by
code review at all. So it classifies the PR itself with the same function and the same rules:

1. **Rules.** The gateway's `POST /ci/token` answer, which already carries the review model and effort from settings, adds
   `tiers: { rules, repo_class, self }`: the repo's code review rules and class if it has an entry, else the default rules,
   plus the instance App's bot login (so the fleet's own PRs are `member`). The compile writes the per-repo table next to
   `ci_review_model`; the kernel only looks up `claims.repo` in it. Without the gateway (a repo using its own OpenRouter
   secret) the template's copy of the default rules applies.
2. **Facts.** The job already has the diff (`git diff --numstat` from the merge base) and the PR event (author, labels, base).
3. **Labels in CI only raise.** CI can't tell who added a label, so it classifies with and without the labels and takes the
   more cautious of the two. A `no-review` label therefore never skips CI's review; `deep-review` still raises it.
4. **Depth by tier**, fixed in the template:

   | Tier | CI review |
   |---|---|
   | `skip`, `trivial` | none (a full-PR run only; a delta review always runs, as today) |
   | `standard` | `ci_review_model`'s model and effort |
   | `sensitive` | the same model, one effort higher (what `deep-review` did) |

   The brief's "critical paths" line becomes one line naming the tier and the rule that matched.
5. **Stays as is:** the reviewer-addressed text bump (one effort higher), the codex-config refusal, the package-lock summary
   for the reviewer, and fail-open on no verdict.

## 9. Who edits, and loosening

**Code review's settings.** The Reviewer Manager writes `code_review` through reviewed settings changes, and `code_review_
configure` already sends combo, push-round and ignore changes to the owner. Rules now decide auto-merge, so these also go to
the owner: any change to a repo's `rules` or `repo_class` (other than to `critical`), any combo or `push_rounds` change in
`by_tier`, and turning a combo's `mandatory` off. Raising `push_rounds` or adding a combo is more spend; lowering them is less
review. Both are the owner's, as today.

**Ship's settings.** `loosens()` per tier as above; adding a repo stays owner-only (decision 10).

**The Fleet pages save as the owner**, so their edits apply directly; the same validation runs.

## 10. Fleet pages

**Fleet → Reviews** (code review's module view, #1688) owns the tier rules and the per-tier review. Per repo:

- **Repo class:** critical, standard or sandbox. Help: "Critical: every PR gets the strongest review and ship never
  approves on its own. Sandbox: every PR is trivial."
- **Tier rules:** an ordered table, one row per rule: its conditions as chips and its tier. Add, remove, move up or down,
  "Reset to default". The last row is fixed ("everything else") and only its tier is editable. Each condition has help in
  plain words ("Lines: changed lines, not counting generated files and lockfiles").
- **Review per tier:** four cards (Skip, Trivial, Standard, Sensitive), each with today's combo pickers for "When a PR
  opens" and "On each push" and the number of push reviews. Skip's card says "no review" and has no pickers.
- **Read-only:** each open PR's tier and the rule that matched, with its facts on hover.

**Fleet → Ship** owns per-tier approve and merge. Per repo: on or off, the preset, and a four-row grid (tier × approve,
merge). Help on each cell, for example: "Approve: on. When code review passes this PR's head, the App approves it." A note
under the grid: "PRs on repos code review doesn't watch count as sensitive." Each adopted PR shows its tier and rule.

Neither page edits the other's settings. The Ship page links to the Reviews page for the rules.

## 11. Migration: one shape, no shims

**Old shapes are refused with a message**, never read:

- code review: a repo entry with `on_open`, `on_push` or `push_rounds` at its top level: "on_open, on_push and push_rounds
  are per tier now: by_tier.<tier>.on_open … (see the Reviews page)".
- ship: `approve`, `merge` or `safe` at a repo or `defaults` level: "approve and merge are per tier now:
  by_tier.<tier>.approve / merge; safe is gone: the tier rules (code review) say what is small and safe". `approve: safe`
  or `approve: all` get the same message.

**The instance updates in the same rollout.** The instance commit that bumps the product pin also converts `code_review`
(the compile refuses the old shape, and the old product would ignore `by_tier` and drop the product repo's gate, so the two
change together). Aiden-HQ/AidenHQ keeps its owner-settled combos verbatim, in every reviewed tier:

```yaml
code_review:
  repos:
    - repo: Aiden-HQ/AidenHQ
      repo_class: standard
      by_tier:
        # owner 2026-11-21/23: the settled combos, the same in every tier until the owner picks per-tier ones
        standard: &settled
          on_open:
            - { engine: claude-code, model: anthropic/claude-haiku-5.5, effort: medium, mandatory: true }
            - { engine: codex-native, model: openai/gpt-6.2-sol, effort: medium, mandatory: true }
          on_push:
            - { engine: codex-native, model: openai/gpt-6.2-sol, effort: low, mandatory: true }
          push_rounds: 1
        trivial: *settled
        sensitive: *settled
      drafts: false
      forks: manual
    # Its globs were .github/code-review-critical (read no more): CI classification only, no code review runs.
    - repo: aidenhq-alpha/roadmap-keeper
      rules:
        - { when: { paths: [src/identity.ts, src/aidenhq-identity.mjs, src/access.ts, src/domain/roadmap-service.ts,
            src/web/view-model.ts, src/web/record.ts, web/src/pages/record.tsx, src/store/memory.ts, src/store/postgres.ts,
            src/store/types.ts, src/admin-routes.ts, web/src/pages/admin.tsx, src/agent-route-guard.ts, src/api/agent.ts,
            src/api/agent-read.ts, src/api/agent-writer.ts, "migrations/*", src/config.ts, app.json] }, tier: sensitive }
        # …then the default rules, written out
      by_tier: { skip: {}, trivial: { on_open: [] }, standard: { on_open: [], on_push: [] }, sensitive: { on_open: [], on_push: [] } }
```

So the product repo behaves exactly as today except that a writer's `no-review` label now skips its review. Whether
trivial and sensitive should take cheaper and stronger combos there is the owner's call. The settings writer may expand the
YAML anchor; that is fine. roadmap-keeper's `.github/code-review-critical` file is deleted by a PR in that repo.
(`Dockerfile` and `.github/workflows/*` were in its file too and are in the default `<sensitive>` already.)

Ship has no instance entry yet, so its presets carry the change. Existing PRs are classified on the first poll after the
deploy; their earlier runs carry no tier and still gate as before.

## 12. Behaviour changes for the owner to confirm

Each is deliberate. Each needs the owner's OK before the build drops it (standing rule).

| Was | Now |
|---|---|
| CI skipped a PR under 20 lines with no critical path | CI skips `skip` and `trivial`: 10 lines or fewer and 20 files or fewer, by a member. PRs of 11 to 19 lines are now reviewed. |
| CI: a critical path got a normal-effort review; only `deep-review` got the higher effort | A `sensitive` PR gets the higher effort, critical paths included. More spend on those PRs (cents each at the default model). |
| CI: adding `deep-review` re-ran the review at once (the `labeled` trigger) | A label is read on the next run. The `labeled` trigger goes, so labelling no longer re-runs CI. |
| CI: any binary file made a PR critical | Only a PR with no substantive line (binary-only, generated-only) is `sensitive` by default. A binary next to code is judged by the code. |
| CI: a package-lock.json change that adds or changes a package was critical | Any lockfile change is `sensitive` (a superset), except a bot's manifest-and-lockfile-only PR, which is `standard`. |
| CI: an app's `.github/code-review-critical` file (from the default branch) | The repo's `rules` in its code review entry. One app has the file (roadmap-keeper), migrated above. |
| Ship: `safe` was 1,200 substantive lines and 50 files, not counting tests and docs | The trivial line is 10 lines and 20 files; 600+ lines is sensitive; tests and docs count. |
| Ship: a lockfile changed without its manifest was out of the safe class | A PR with no substantive line is `sensitive`; a lockfile beside any code change is judged by the rest. |
| Code review: newly watched repos got advice-only reviews (`mandatory: false`) | The preset's combos are mandatory, so newly watched repos are gated. Existing entries are explicit and unchanged. |

## 13. What gets deleted

- **code review:** repo-level `on_open`, `on_push`, `push_rounds` and `REPO_DEFAULTS` (now the per-tier preset) in
  `config.ts`; `openOnly()`/`gated()` per repo (now per tier); the single gated list in `scripts/modules.ts`; the board's
  moment pickers per repo in the Reviews view (now per tier); `GENERATED`/`LOCKS` in `recipe/scope.ts` (now the classifier's).
- **ship:** `safe.ts`'s `safeClass`, `TESTS`, `DOCS`, `MANIFESTS`, `COMPARE_CAP`; `settings.ts`'s `approve`, `merge`, `safe`,
  `APPROVE` values `safe` and `all`, their `CONTROLS` entries and `loosens()` lines; `review_rounds` if any copy of it is still
  on main.
- **CI template** (`modules/ci/template`, and the synced `modules/code-review/recipe/code-review.ts`): the critical-path
  regex and glob loop, `.github/code-review-critical`, `CRITICAL_GLOBS`, `DEEP` and the `deep` depth, the `labeled` trigger,
  the under-20-line skip, the brief's `critical` input; the `deep-review` branches in `codegenie-prior.ts` and
  `codegenie-gate.ts`; their cases in `scripts/test/ci-gate.test.ts`; the passage in `docs/operations.md` and `ci.yml`'s
  header.
- **settings:** `settings.ci_review_model`'s help line about "critical paths ... one effort higher" (reworded for tiers).

## 14. Build plan

Three lanes, after #1687 and #1688 merge. Lane 1 lands first; lanes 2 and 3 build against this spec in parallel and merge
after it.

**Lane 1: classifier and code review** (the biggest; one PR):

- `kernel/sdk/src/tiers.ts`: facts, rules validation, `classify()`, the default rules, `GENERATED`/`LOCKS`; synced to code
  review and the CI template.
- github internal reads for code review: the PR's files list (paginated) and its label events (no maintained-repo limit).
- `config.ts`: the new entry shape, the per-tier preset, old-shape refusals, `tierCfg()`.
- `engine.ts`: classify in `poll()` before `trigger()`, the `tiers` table and `runs.tier`, the ratchet, escalation through
  `missing()`, the per-tier verdict, `tier` and `kind: none` on `/v1/verdict`, the `pr.tier` fact.
- `scripts/modules.ts`: the two gated lists; `config-tool.ts`: the schema and the owner-approval list.
- The Reviews view: repo class, rules table, per-tier cards, each PR's tier.
- The instance commit (§11) with the pin bump.
- Tests: one end-to-end per path (a trivial PR reviewed by trivial's combo; a push that escalates to sensitive and gets its
  opening review; a writer's `no-review` skips and an App's doesn't), plus `classify()` on the default rules.

**Lane 2: ship** (after lane 1's verdict shape):

- `settings.ts`: `by_tier`, the presets, refusals, `loosens()`; `safe.ts` trimmed to `carries()` and `judge()` reading the
  tier; `decide`'s merge per tier; the report's tier line; the Ship page's grid.
- Tests: `judge()` per tier, and the carry-over refused when the tier differs.

**Lane 3: CI template** (after lane 1's `tiers.ts`):

- `ci.yml` and `code-review.ts`: classify with `.github/tiers.ts`, depth by tier, deletions (§13).
- The gateway's `/ci/token` answer and the compile's per-repo table.
- `docs/operations.md`; roadmap-keeper's file removed by a PR there.
- Tests: the existing `ci-gate.test.ts` cases rewritten for tiers (a trivial skip, a sensitive bump), no new suites.

Each lane runs the local Codex review before pushing and gets a security review of its new path (labels lowering a tier, the
CI rules table) before it switches on.

## 15. Not handled (fails loudly or cautiously)

- **Per-tier lenses, catalog options or `drafts`/`forks` per tier.** Repo-level, as today.
- **Rules per base branch beyond `base` globs.** Ship supports only the default branch anyway.
- **Case-insensitive globs.** The CI regex was case-insensitive (`auth` matched `Auth`); globs are not. The default list spells
  the common forms; a repo adds others.
- **A label that both raises and lowers in one PR.** When labels lower the tier, only trusted labels count, raising ones
  included if untrusted. It errs toward the trusted view.
- **Re-classifying closed or merged PRs.** Their tier stays what it was.
- **A settings change and the ratchet.** A loosened rule applies to new heads; a PR already at a higher tier stays there.
