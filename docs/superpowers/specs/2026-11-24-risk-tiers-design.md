# Risk tiers: one risk call per PR, read by code review, ship and CI

Status: design for build, 2026-11-24. Owner decisions are marked **(owner)**; everything else is the designer's call. Builds on
the ship spec (`2026-11-24-ship-design.md`) and lands after #1687 (ship approval) and #1688 (code review's Fleet page).

## Why

Three places judge how risky a PR is, each in its own way:

- **ship's `safe` block** decides AI approval: line and file caps, a deny list, generated files without their source;
- **the CI template's reviewer** decides whether to skip a tiny PR and how hard to look: a built-in regex, the app's
  `.github/code-review-critical` file and the `deep-review` label;
- **code review** has one set of combos per repo, the same for a one-line typo fix and a change to the auth layer.

So a cheap PR pays for a deep review, an auth change gets the same review as a typo, and three lists of "sensitive paths"
drift apart.

**Goal (owner).** Each PR head gets one tier from cheap, deterministic facts. Code review picks its combos, models and rounds
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
- Label conditions (cut from the first release, §2). Learning tiers from outcomes (ship's revert metrics come later; the owner
  then edits the rules).
- Tiers for repo reviews (a whole tree at a commit). Tiers are about PRs.

## 1. Tiers

Four tiers, a fixed set:

| Tier | Rank | Meaning |
|---|---|---|
| `skip` | 0 | No review. Reached only through a rule the owner adds; the default rules never pick it. |
| `trivial` | 1 | A small change by a member. One cheap review. |
| `standard` | 2 | Everything else. |
| `sensitive` | 3 | Sensitive paths, outsiders, big changes, critical repos. The strongest review. |

The set is fixed, not user-defined: the Fleet pages, the CI mapping, ship's per-tier grid and the loosening rank stay
simple. A repo that wants fewer tiers points its rules at fewer of them.

Naming: these are *risk tiers* and are always named (`trivial`). The kernel's write tiers are numbered (Tier 0, 1, 2) and stay
a separate thing.

## 2. Facts

The classifier sees only these facts, each computed from the PR's own change: GitHub's PR files list (merge base to head),
never a push's delta. A base merge that leaves the PR's own change alone yields the same facts, and so the same tier.

| Fact | Value | Computed from |
|---|---|---|
| `lines` | Substantive lines: additions plus deletions over every file except generated files and lockfiles | The files list. Generated files and lockfiles are the built-in lists now in `recipe/scope.ts` (`GENERATED`, `LOCKS`), which move into the classifier as their one definition. Tests and docs count: AGENTS.md, SKILL.md and handbooks are instructions. |
| `files` | How many files count toward `lines` | Same list. |
| `paths` | Every changed path, a rename's old path and generated files included | Same list. |
| `author` | `member`, `bot` or `outsider` | The PR read: the instance's own GitHub App is `member`; any other `*[bot]` login is `bot`; `author_association` `OWNER`, `MEMBER` or `COLLABORATOR` is `member`; anyone else is `outsider`. No extra call. |
| `base` | The base branch name | The PR read. |
| `repo_class` | `critical`, `standard` or `sandbox` | The repo's code review entry (default `standard`). |

**A consistent snapshot.** The files list is read for one head and base: code review reads the PR (head, base, author,
`changed_files`), reads every page of its files, then reads the PR again. If the head or base moved, the snapshot is dropped
and the next poll tries again. GitHub's files list stops at 3,000 files: when `changed_files` is over 3,000 the snapshot is
accepted as is and the head is classified `sensitive` with the reason "too many files to read", without running the rules.
Otherwise the pages must hold exactly `changed_files` files, or the snapshot is dropped. Until a head has a snapshot it is
**pending** (§5), never guessed.

**No labels in the first release.** The gap proposal had `labels` (a writer's `no-review` → skip, `deep-review` → sensitive).
They are cut. A label that lowers the tier needs its provenance read from the timeline and checked against write access, CI
can't check provenance at all, so code review and CI would disagree on the same PR, and a `deep-review` rule would keep the
label the owner asked tiers to replace. Without labels every input is a fact about the code and the repo, and every consumer
gets the same tier. A label condition can be added later in code review, served to the others through the verdict (§5). Break
glass stays what it is today: a writer approves and merges by hand, or says `aiden review stop`.

## 3. Rules

A repo's rules are an ordered list. The first rule whose conditions all hold names the tier. The last rule has no `when`.

```yaml
rules:
  - { when: { repo_class: critical }, tier: sensitive }
  - { when: { author: bot, only_paths: [<manifests>, <lockfiles>] }, tier: skip }
  - { when: { paths: [<instruction files>] }, tier: sensitive }
  - { when: { author: member, only_paths: [<prose>] }, tier: standard }
  - { when: { paths: [<sensitive>] }, tier: sensitive }
  - { when: { author: outsider }, tier: sensitive }
  - { when: { repo_class: sandbox }, tier: trivial }
  - { when: { lines_max: 0 }, tier: sensitive }
  - { when: { lines_min: 600 }, tier: sensitive }
  - { when: { author: member, lines_max: 10, files_max: 20 }, tier: trivial }
  - { tier: standard }
```

**Conditions.** A rule's conditions all hold (AND). A list value is "any of" a glob list, the only OR there is. No OR across
facts, no NOT. Each fact appears at most once in a rule.

| Condition | Holds when |
|---|---|
| `lines_min: n` / `lines_max: n` | `lines >= n` / `lines <= n` |
| `files_min: n` / `files_max: n` | `files >= n` / `files <= n` |
| `paths: [globs]` | any changed path matches any glob |
| `only_paths: [globs]` | every changed path matches some glob (and there is at least one) |
| `author: member\|bot\|outsider` | the author is that kind |
| `base: [globs]` | the base branch matches any glob |
| `repo_class: critical\|standard\|sandbox` | the repo's class is that |

Globs are `posix.matchesGlob`, case-sensitive, on repo-relative paths; a dot-file or dot-folder matches like any other name
(`.github/**` covers `.github/.release.yml`). `repo_class` is only an input to the rules: what a
class means is whatever the rules say about it.

**Validation.** Every rule names a known tier and only known, well-typed conditions; the last rule has no `when` and no other
rule lacks one. An invalid list refuses the repo's entry whole with the message.

**The default rules** carry over what the three old lists meant:

- `<sensitive>` merges the CI regex (`.github/**`, `**/Dockerfile*`, `**/package.json`, `**/AGENTS.md`,
  `**/AGENTS.override.md`, `**/CLAUDE.md`, `**/.codex/**`, `**/codex.toml`, and `**/*auth*`, `**/*secur*`, `**/*token*`,
  `**/*session*`, `**/*permission*`, each as a file and a folder) with ship's `safe.deny` (lockfiles, test and lint config,
  `**/CODEOWNERS`, `**/migrations/**`, `**/*.tf`, `infra/**`, `**/.env*`, `**/config/**`, `**/docker-compose*`).
- `<manifests>` and `<lockfiles>` are the names the classifier already knows (`package.json`, `go.mod`, `Cargo.toml`,
  `pyproject.toml`; `LOCKS`).
- `sandbox` comes after the sensitive-path and outsider rules: a sandbox repo's PRs are trivial whatever their size, but a
  sensitive path or an outsider still makes a PR sensitive.
- Lockfiles have one rule: any changed lockfile is a sensitive path (it is in `<sensitive>`), so a PR touching one is
  `sensitive` whatever else it changes. The only exception is the rule above it: a bot's PR that touches only manifests and
  lockfiles (Dependabot) is `skip`: no review unless someone asks (owner, 2026-11-25).
- A member's change that is only prose (docs, plans, specs: `PROSE`) is `standard`, not `sensitive` for a keyword such as
  `token` or `session` in a path; a change to an instruction file (`AGENTS.md`, `CLAUDE.md`, `REVIEW.md`: `INSTRUCTIONS`) stays
  `sensitive` (owner, 2026-11-25: 30 of 41 PRs on one repo were sensitive on path keywords alone).
- `lines_max: 0` is a PR with no substantive line: only generated files, lockfiles, binaries or renames. That is ship's
  "generated files without their source" (decision 29) and most of CI's "a binary file is critical", in one fact.

## 4. Settings

### Code review (`code_review`)

A repo entry gains `repo_class`, `rules` and `by_tier`. They replace `on_open`, `on_push` and `push_rounds`, which move under
each tier. `drafts`, `forks`, `ignore` and `max_nits` stay per repo.

```yaml
code_review:
  repos:
    - repo: acme/api
      repo_class: standard        # critical | standard | sandbox
      # rules: [...]              # omitted: the default rules
      by_tier:                    # a tier or field omitted takes the preset's
        sensitive: { push_rounds: 3 }
```

**The preset:**

| Tier | `on_open` | `on_push` | `push_rounds` |
|---|---|---|---|
| `skip` | none | none | 0 |
| `trivial` | codex · `~deepseek/deepseek-flash-latest` · medium, mandatory | none | 0 |
| `standard` | codex · `~deepseek/deepseek-flash-latest` · medium, mandatory | codex-native · `openai/gpt-6.2-sol` · low, mandatory | 1 |
| `sensitive` | codex-native · `openai/gpt-6.2-sol` · medium, mandatory; claude-code · `anthropic/claude-sonnet-5.5` · medium, mandatory | codex-native · `openai/gpt-6.2-sol` · low, mandatory | 2 |

`standard` is today's `REPO_DEFAULTS` with `mandatory` on. Mandatory is the preset's default because ship approves only on a
review that covers the head, and a tier with no mandatory combo has none (§7). A repo that wants advice-only reviews turns
`mandatory` off per combo, as today.

**`rules` is whole**: omitted (the defaults) or the full list. **`by_tier` merges per field** over the preset. Validation per
tier is today's per repo: at most four combos a moment, and a mandatory `on_push` combo needs a mandatory `on_open` one in the
same tier.

**One parser.** `config.ts`'s `readConfig()` resolves presets and validates; the compile (`scripts/modules.ts`) and the Fleet
page's save call the same function (the compile imports it). The compile fails on an invalid entry or an old shape before it
writes anything, and derives everything below from the resolved entries, never from raw combos.

**Which repos are gated.** Two compiled lists replace today's one:

- `GITHUB_REVIEW_GATED` (the merge queue asks code review's verdict): **every watched repo**. It only says whom to ask; the
  verdict says per head whether a review is required (`requires_review`, §6) and whether the repo is watched at all (§5). So a
  watched repo whose tier has no mandatory combo (roadmap-keeper, §11) is told apart from an unwatched one, and findings still
  open from an earlier mandatory run keep gating after the owner removes the last mandatory combo.
- `code_review_mandatory` (the kernel's `ai_review_code: unless_code_review_mandatory` skips the AI reviewer): repos where
  **every tier the repo's rules can select** has a mandatory combo. A tier is selectable when some rule names it. So a repo
  whose rules can reach `skip` (or an advice-only tier) keeps the AI reviewer on its agents' pushes and PRs; otherwise a head
  in that tier would pass neither the AI reviewer nor code review. The default rules never select `skip`.

### Ship (`ship`)

A repo entry, and `defaults`, gain `by_tier`. It replaces the repo-level `approve`, `merge` and `safe`.

```yaml
ship:
  repos:
    acme/api: { preset: cautious, by_tier: { trivial: { approve: on } } }
```

| Field | Values | Meaning |
|---|---|---|
| `by_tier.<tier>.approve` | `off`, `observe`, `on` | `observe`: the report says what ship would do. `on`: the App approves when the evidence holds (§7). `safe` and `all` are gone: the tier is the class. Not offered for `skip`, which has no review to approve on. |
| `by_tier.<tier>.merge` | `off`, `ready` | `ready`: merge when every gate passes. |
| `unwatched` | `{ merge: off\|ready }` | A repo code review doesn't watch has no tiers; this is its merge. |

**Presets:**

| | `cautious` | `full` |
|---|---|---|
| `skip` | merge `ready` | merge `ready` |
| `trivial` | approve `on`, merge `ready` | approve `on`, merge `ready` |
| `standard` | approve `observe`, merge `ready` | approve `on`, merge `ready` |
| `sensitive` | approve `off`, merge `ready` | approve `on`, merge `ready` |
| `unwatched` | merge `ready` | merge `ready` |

`cautious` approves trivial PRs, observes standard ones and leaves sensitive ones to people **(owner, 2026-11-24)**.
`merge: ready` everywhere keeps pr-watch parity: today every fleet PR merges once its gates pass, watched or not. Turning on
more approvals per tier is a loosening, the owner's (§9).

## 5. Classification

**Who.** Code review, the one owner of the rules. The pure function `classify(facts, rules) → { tier, rule }`, the fact
helpers and the default rules live in `kernel/sdk/src/tiers.ts`; `scripts/sync-shared.ts` copies it into code review's
service (`src/aidenhq-sdk/tiers.ts`) and the CI template (`.github/tiers.ts`, MIT like the rest of the template).

**When.** Code review's poll already reads every open PR of a watched repo each tick. Its PR read gains `author_association`,
`changed_files` and the base sha. It classifies a PR when any input changed since the last classification: its head, its base
branch or sha, its author kind (from `author_association`, read every poll) or the repo's resolved tier settings (a hash). It
then calls `trigger()`, so a head's first review already uses its tier.

**Per head, no ratchet.** The tier is the current head's. A PR trimmed from sensitive to trivial is trivial; open important
findings from earlier mandatory runs still gate whatever the tier (the engine already keeps them across heads).

**Stored** on the PR's row in code review's database: `tier`, `rule`, `facts` and the inputs it was computed from: `head`,
`base`, `author` and `config` (the settings hash). Runs gain `tier` and
`policy` (§6), so cost and findings per tier come out of the runs table. No flow fact in the first release: nothing reads one,
and the verdict serves the tier.

**Served.** Code review's `GET /v1/verdict` (ship and the merge queue already call it) adds `tier`:

- `{ state: "classified", tier, rule, why }` for the asked head;
- `{ state: "pending" }` while that head has no snapshot yet (not polled, a moved snapshot, a failed read), **or whenever
  the stored inputs are stale**: the service's current settings hash differs from the stored `config`, or the caller's live
  read of the PR (the head, base and author it passes on `/v1/verdict`) differs from the stored inputs. A settings edit
  therefore makes every affected head pending at once, before the next poll re-classifies it;
- `{ state: "unwatched" }` when code review doesn't watch the repo.

Ship acts only on `classified` or `unwatched`, and honours `unwatched.merge` only on `unwatched`. On `pending` it waits, whatever the step: approve, enqueue or merge. A
pending head is never treated as some tier. Ship never reads the fact store.

## 6. Code review uses the tier

**One seam.** `tierCfg(repo, tier)` resolves an entry and a tier into today's `Repo` shape (`on_open`, `on_push`,
`push_rounds` plus the repo-level fields). `trigger()`, `missing()`, `gateRuns()`, `capped()`, `verdict()`, `aiden review` and
#1687's `fresh()` take it instead of the entry.

**The review policy.** A head's *policy* is a hash of its tier's mandatory combos (engine, model, effort, moment), the PR's
base branch and the repo's effective `ignore` globs: everything about *how* the PR is reviewed. It holds no tier name
**(owner, 2026-11-25: no needless spend)**: two tiers with the same mandatory reviewers share a policy, so a push that crosses
between them (Aiden-HQ/AidenHQ runs its settled combos in every tier) keeps its coverage and runs no new opening batch. It holds no commit:
which change was reviewed is the job of coverage and `carries()`, so a base merge that leaves the PR's own patch alone keeps
its policy and carries (§7). Each run records
the policy it ran under, and so does each `covered` row (the column exists). A head counts as covered, for the verdict and
for #1687's `evidence()`, only by runs and coverage under the head's current policy. So adding a mandatory model on the Fleet
page, removing an ignore glob, a retarget to another branch, or a head moving to a tier with other mandatory reviewers, asks
for a review under the new policy; old open important findings still gate.

**A policy change is its own branch**, ahead of the ordinary push trigger in `poll()`. The PR row keeps `policy_since`: the
first head of the PR's current run of heads under the current policy, reset whenever a head's policy differs from the one
before it. Until the PR has a *completed* full opening batch under the current policy **at `policy_since` or a later head**
(every mandatory `on_open` combo done or failed past its retries), the head gets
that batch with `full: true` (the whole PR from its merge base, never the last covered head), queued once per head and policy.
A push while that batch is queued supersedes it with the same batch at the new head, never with an `on_push` run. The same
check runs on an unchanged head after a settings edit. Going down (sensitive to trivial) costs one cheap
opening review; going up gets every opening reviewer of the higher tier over the whole PR (each only where the two tiers'
mandatory reviewers differ). Later pushes get the tier's `on_push`, up to its `push_rounds`, counted from `policy_since`. A PR
that leaves a tier for one with other reviewers and comes back therefore gets a new full opening review: a batch from its earlier stay never counts, and `gateRuns()` never falls back to it. `missing()` keeps its
job of filling a head with no mandatory run.

**The verdict per head.** `verdict()` judges the head against its tier's policy and adds `requires_review`:

- a tier with mandatory combos: as today, `requires_review: true`;
- a tier with none (`skip`, or advice-only): `requires_review: false`, `pass` unless an important finding from an earlier
  mandatory run is still open; `evidence()` answers `kind: none`;
- a pending head: `wait` ("classifying"), `requires_review: true`.

`productMergeEligible()` (the product repo's Tier 0 merge, which skips the AI reviewer) also requires `requires_review: true`
at planning and at execution: a head no mandatory review covered never takes that shortcut.

**Repos code review doesn't watch** get no tier and no verdict, as today.

## 7. Ship uses the tier

- **Approval.** `judge()` reads the verdict's `tier` and the repo's `by_tier[tier].approve`. `on` approves when the verdict
  passes and covers the head under its current policy (completed, or carried). `observe` reports it. `off` says "tier
  `sensitive`: approval is off". `kind: none` is never approved. `pending` waits.
- **Merge.** `decide` takes `by_tier[tier].merge` (or `unwatched.merge`) instead of the repo field, and reads the tier even
  when the PR needs no approval. The merge executor (`merges.ts`) sets `ship.review` from the verdict's `requires_review`, not
  from "the gate answered", so a skip-tier PR on a gated repo isn't held for an approval ship will never give.
- **At the effect.** github's final call to ship before an approve, a merge or an enqueue (today it re-checks the head and the
  adoption's generation) also asks for the current tier state and policy: an approve needs the tier's `approve: on` and a
  passing verdict covering the head; a merge or enqueue needs the tier's `merge: ready` (or `unwatched.merge` on an unwatched
  repo). The call passes github's live head, base and author, so stale inputs come back pending (§5): this catches an owner
  turning approve or merge off, or tightening the rules, while a write waits. Pending or unreachable is no.
- **App approvals carry their policy.** The approve record stores the policy it was issued under. At a merge or enqueue, an
  App approval counts only when its policy is the head's current one and the current tier has `approve: on`; otherwise ship
  first dismisses it (github's existing dismissal on a new head, now also on a policy change) and the PR needs an approval
  under the current policy (a human's, where approve is off). Human approvals are untouched. A tier change between tiers with
  the same mandatory reviewers keeps the policy, so an App approval stands where the new tier's approve is on too.
- **Carry-over.** A verdict carries to a later head when the PR's own change is the same (`carries()`: a base merge, or only
  generated paths regenerated) **and** both heads have the same policy. A base-merge-only head (an update from `main` for an
  up-to-date rule) moves the merge base but not the policy, and re-classifies the same because the facts come from the PR's
  own diff over its merge base: its verdict carries and no review runs. A regenerated lockfile can change `paths` and so the tier; then
  the policies differ and the new tier's opening review runs (§6). `carries()` keeps its completeness check on GitHub's
  compare (300 files): an incomplete compare never carries, and ship asks for a fresh review.
- **Deleted:** `safeClass` and its test, docs and manifest lists. The report's risk line shows the tier, the matched rule and
  the facts.
- **`loosens()`** gains per tier: `approve` raised (`off` < `observe` < `on`), `merge` raised (`off` < `ready`), and
  `unwatched.merge`. The `safe.*` checks go.

## 8. CI uses the tier

The CI template's reviewer runs in an app repo's Actions job. Most app repos aren't watched by code review, and the job
can't call code review. So it classifies the PR itself with the same function, the same rules and the same facts (no labels
means nothing in the facts needs provenance):

1. **Rules first.** The job exchanges its OIDC token at `/ci/token` before anything else in the review step. The answer,
   which already carries the review model and effort, adds `tiers: { rules, repo_class, self }`: the repo's code review rules
   and class if it has an entry, else the default rules, plus the instance App's bot login (the fleet's own PRs are `member`).
   The compile writes the per-repo table beside `ci_review_model`; the kernel only looks up `claims.repo`. Without the
   gateway (a repo on its own OpenRouter secret), the template's copy of the default rules applies.
2. **Refusal first.** The codex-config refusal (`.codex/`, `codex.toml`, `AGENTS.override.md`) runs on the whole PR's paths
   before any tier shortcut, reuse or token failure, so a trivial or reused PR still gets it.
3. **Classify the whole PR** (merge base to head: `git diff --numstat`, the event's author and base).
4. **Then choose the range.** The prior-review step (`codegenie-prior.ts`) runs after classification and gets the tier and
   effort. Its green status records the tier, model and effort it reviewed at; `reuse` or `delta` is allowed only when that
   status names the same tier and model and an effort at least as high. Otherwise the review is full. The workflow's trigger
   swaps `labeled` for `edited`, so a retarget (the `base` fact) re-classifies; an edit that changes nothing reuses the review.
5. **Depth by tier**, fixed in the template:

   | Tier | CI review |
   |---|---|
   | `skip`, `trivial` | none for a full-PR run; a delta still runs, as today |
   | `standard` | `ci_review_model`'s model and effort |
   | `sensitive` | the same model, one effort higher (what `deep-review` did) |

   The brief's "critical paths" line becomes one line naming the tier and the rule that matched.
6. **Unchanged:** the reviewer-addressed text bump, the package-lock summary for the reviewer, fail-open on no verdict.
   `.github/tiers.ts` joins the trusted files read from the base or default branch, never the PR (`codegenie-prior.ts`'s list).

## 9. Who edits, and loosening

**Code review's settings.** The Reviewer Manager writes `code_review` through reviewed settings changes, and
`code_review_configure` already sends combo, push-round and ignore changes to the owner. Rules now decide auto-merge, so these
go to the owner too: any change to `rules`, any change to `repo_class`, any change in `by_tier` (combos, `push_rounds`, a
combo's `mandatory`).

**Ship's settings.** `loosens()` per tier (§7); adding a repo stays owner-only (decision 10).

**The Fleet pages save as the owner**, so their edits apply directly; the same validation runs.

## 10. Fleet pages

**Fleet → Reviews** (code review's module view, #1688) owns the rules and per-tier review. Per repo:

- **Repo class:** critical, standard or sandbox. Help: "An input to the tier rules below. With the default rules, critical
  makes every PR sensitive, and sandbox makes every PR trivial unless it touches a sensitive path or comes from an outsider."
- **Tier rules:** an ordered table, one row per rule: its conditions as chips and its tier. Add, remove, move up or down,
  "Reset to default". The last row is fixed ("everything else"); only its tier is editable. Each condition has plain-words help
  ("Lines: changed lines, not counting generated files and lockfiles").
- **Review per tier:** four cards (Skip, Trivial, Standard, Sensitive), each with today's combo pickers for "When a PR opens"
  and "On each push" and the number of push reviews. Skip's card says "no review".
- **Gating note** under the cards: which tiers' merges wait for code review (those with a mandatory combo), and that the AI
  reviewer still checks agents' pushes unless every tier the rules can select has one.
- **Read-only:** each open PR's tier, the rule that matched and its facts, from the PR row.

**Fleet → Ship** owns per-tier approve and merge. Per repo: on or off, the preset, a grid of tier × approve and merge (Skip
has merge only), and the unwatched merge for repos code review doesn't watch. Help on each cell, for example "Approve on: when
code review passes this PR's head, the App approves it." Each adopted PR shows its tier and rule. The Ship page links to the
Reviews page for the rules; neither page edits the other's settings.

## 11. Migration and cutover: one shape, no shims

**Old shapes are refused with a message**, never read:

- code review: `on_open`, `on_push` or `push_rounds` at an entry's top level: "on_open, on_push and push_rounds are per tier
  now: by_tier.<tier>.… (see the Reviews page)".
- ship: `approve`, `merge` or `safe` at a repo or `defaults` level: "approve and merge are per tier now: by_tier.<tier>.approve
  / merge; safe is gone: code review's tier rules say what is small and safe".

**One cutover.** The lanes land as separate PRs, but the instance pins the product only after all three have merged: the
compile refuses the old shape, the old product would ignore `by_tier` and drop the product repo's gate, and new tier rules
next to the old ship and CI decisions would mean two policies at once. The instance commit that bumps the pin converts
`code_review` in the same commit. Aiden-HQ/AidenHQ keeps its owner-settled combos verbatim in every reviewed tier:

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
    # Its globs were in .github/code-review-critical: CI classification only, no code review runs.
    - repo: aidenhq-alpha/roadmap-keeper
      rules:
        - { when: { paths: [src/identity.ts, src/aidenhq-identity.mjs, src/access.ts, src/domain/roadmap-service.ts,
            src/web/view-model.ts, src/web/record.ts, web/src/pages/record.tsx, src/store/memory.ts, src/store/postgres.ts,
            src/store/types.ts, src/admin-routes.ts, web/src/pages/admin.tsx, src/agent-route-guard.ts, src/api/agent.ts,
            src/api/agent-read.ts, src/api/agent-writer.ts, "migrations/*", src/config.ts, app.json] }, tier: sensitive }
        # …then the default rules, written out
      by_tier: { trivial: { on_open: [] }, standard: { on_open: [], on_push: [] }, sensitive: { on_open: [], on_push: [] } }
```

The product repo then behaves exactly as today: every tier runs the settled reviews **(owner, 2026-11-24: AidenHQ keeps its
settled combos in every tier)**. The settings writer may expand the YAML anchor; that is fine.

**roadmap-keeper** gets one PR in that repo, after the deploy: the new template workflow (which reads rules from the gateway)
and the deletion of `.github/code-review-critical`, together, so its own paths are never uncovered. (`Dockerfile` and
`.github/workflows/*` from its file are in the default `<sensitive>` already.)

Ship has no instance entry yet; its presets carry the change. Open PRs are classified on the first poll after the deploy.
Their earlier runs carry no policy, so each open PR on a gated repo gets one opening review under its tier's policy; their
open important findings still gate. That is a one-time cost on the PRs open at the cutover.

## 12. Behaviour changes

Each is deliberate; the owner accepted them all (2026-11-24).

| Was | Now |
|---|---|
| `deep-review` label: CI one effort higher, at once (the `labeled` trigger) | Gone. A sensitive PR gets the higher effort by its facts. No label changes a tier in this release. |
| CI skipped a PR under 20 lines with no critical path | CI skips `trivial`: 10 lines or fewer and 20 files or fewer, by a member. PRs of 11 to 19 lines are now reviewed. |
| CI: a critical path got a normal-effort review | A `sensitive` PR gets the higher effort. More spend on those PRs (cents each at the default model). |
| CI: any binary file made a PR critical | Only a PR with no substantive line (binary-only, generated-only) is `sensitive` by default. A binary next to code is judged by the code. |
| CI: a package-lock.json change that adds or changes a package was critical | Any lockfile change is `sensitive` (a superset), except a bot's manifest-and-lockfile-only PR, which is `skip`. |
| CI: an app's `.github/code-review-critical` file | The repo's `rules` in its code review entry. One app has the file (roadmap-keeper), migrated above. |
| Ship: `safe` was up to 1,200 substantive lines and 50 files, tests and docs not counted | Trivial is up to 10 lines and 20 files; 600+ lines is sensitive; tests and docs count. |
| Ship: a lockfile changed without its manifest was out of the safe class | Any lockfile change is `sensitive`, with or without its manifest or other code (the same rule as CI's row above); only a bot's manifest-and-lockfile-only PR is `standard`. |
| Code review: a newly watched repo got advice-only reviews | The preset's combos are mandatory, so a newly watched repo is gated. Existing entries are explicit and unchanged. |

## 13. What gets deleted

- **code review:** entry-level `on_open`, `on_push`, `push_rounds` and `REPO_DEFAULTS` (now the per-tier preset) in
  `config.ts`; `openOnly()`/`gated()` per entry (now per tier); `codeReviewGated()`'s raw-combo scan in `scripts/modules.ts`
  (now the shared parser); the per-repo moment pickers in the Reviews view; `GENERATED`/`LOCKS` in `recipe/scope.ts` (now the
  classifier's).
- **ship:** `safe.ts`'s `safeClass`, `TESTS`, `DOCS`, `MANIFESTS` (`carries()` keeps its compare cap); `settings.ts`'s
  `approve`, `merge`, `safe`, `APPROVE`'s `safe` and `all`, their `CONTROLS` and `loosens()` lines; `review_rounds` wherever
  a copy of it is still on main.
- **CI template** (`modules/ci/template`, and the synced `modules/code-review/recipe/code-review.ts`): the critical-path
  regex and glob loop, `.github/code-review-critical`, `CRITICAL_GLOBS`, `DEEP` and the `deep` depth, `PR_LABELS`, the
  `labeled` trigger, the under-20-line skip, the brief's `critical` input; the `deep-review` branches in
  `codegenie-prior.ts` and `codegenie-gate.ts`; their cases in `scripts/test/ci-gate.test.ts`; the passage in
  `docs/operations.md`, `ci.yml`'s header and `ci_review_model`'s help line in `modules/ci/module.yaml`.

## 14. Build plan

Three lanes, after #1687 and #1688 merge. They build in parallel against this spec; lane 1 merges first, and the instance pin
moves once all three have merged (§11).

**Lane 1: classifier and code review.**

- `kernel/sdk/src/tiers.ts`: facts, rule validation, `classify()`, default rules, `GENERATED`/`LOCKS`; synced to code review
  and the CI template.
- github's code-review read (`github-mcp/src/code-review-read.ts`): `author_association`, `changed_files`, the base sha, and
  the PR's paginated files list.
- `config.ts`: the new shape, the per-tier preset, old-shape refusals, `tierCfg()`; `scripts/modules.ts` uses its parser for
  the two gated lists; `config-tool.ts`: the schema and the owner-approval list.
- `engine.ts`: the snapshot and classification in `poll()`, the PR row's tier, `runs.tier` and `policy`, coverage by policy,
  the tier-change branch with `full: true`, the per-head verdict with `tier` and `requires_review`, `evidence()`'s `kind: none`.
- The Reviews view: repo class, the rules table, the per-tier cards, each PR's tier.
- Tests: end to end, a trivial PR reviewed by trivial's combo; a reviewed trivial PR pushed into sensitive, where both
  sensitive opening reviewers see the whole PR; a pending head that waits (also after a settings edit); a base merge that keeps its verdict; a PR
  that drops a tier and comes back gets a new full review. Plus `classify()` on the default rules (an outsider in a sandbox
  repo is sensitive; over 3,000 files is sensitive).

**Lane 2: ship.**

- `settings.ts`: `by_tier`, `unwatched`, the presets, refusals, `loosens()`. `safe.ts` trimmed to `carries()` and `judge()`
  reading the tier and policy; `decide`'s merge per tier; `merges.ts`'s `requires_review` and the final tier check before an
  approve, merge or enqueue (github); `productMergeEligible()` needing `requires_review`; the report's tier line; the Ship page grid.
- Tests: `judge()` per tier; a skip-tier PR on a gated repo with no GitHub approval rule merges; a carry refused when the
  policy differs; a pending tier waits; an App approval issued under an older policy is dismissed
  before a merge.

**Lane 3: CI template.**

- `ci.yml`, `code-review.ts`, `codegenie-prior.ts`: token first, refusal first, classify with `.github/tiers.ts`, the range
  after the tier, the tier in the green status, depth by tier, the deletions (§13).
- The gateway's `/ci/token` answer and the compile's per-repo rules table.
- `docs/operations.md`.
- Tests: `ci-gate.test.ts` rewritten for tiers (a trivial skip; a sensitive bump; a trivial PR touching `.codex/` refused; a
  reuse refused after the tier rose). No new suites.
- After the deploy: roadmap-keeper's PR (§11).

Each lane runs the local Codex review before pushing and gets a security review of its new path (the CI rules table, the
approval and merge decisions per tier) before it switches on.

## 15. Not handled (fails loudly or cautiously)

- **Labels** as a fact (§2). An open question for the owner: if wanted, added later in code review and served through the
  verdict.
- **Per-tier lenses, catalog options, `drafts` or `forks`.** Repo-level, as today.
- **Case-insensitive globs.** The CI regex was case-insensitive (`auth` matched `Auth`); globs are not. The default list spells
  the common forms; a repo adds others.
- **PRs over 3,000 files.** `sensitive`, with the reason.
- **Re-classifying closed or merged PRs.** Their tier stays what it was.
