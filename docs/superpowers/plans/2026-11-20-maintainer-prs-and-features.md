# Maintainer: per-repo duties, PR upkeep and owner-gated features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `maintainer_repos` becomes the one list of repos the fleet may merge and close in, with opt-in per-repo duties
(Dependabot ownership, quiet contributor PRs, GitHub-only feature requests built on `agent-build`).

**Architecture:** One parser of `maintainer_repos` in the kernel SDK, read by github-mcp (Maintainer tools), the
Maintainer watcher and the github code host (pr-watch, plan, merge queue). Behaviour beyond code is Maintainer handbook
text. Four PRs: A (config + Maintainer), B (pr-watch), C (merge/close widening, reviewer eval), D (#831 dating).

**Tech Stack:** TypeScript/Node 24 (`node --test`), github-mcp, kernel SDK synced by `scripts/sync-shared.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-20-maintainer-prs-and-features-design.md`

## Global Constraints

- Labels are fixed names: `feature-request`, `agent-build`. The fix label stays per repo (`label`, default `agent-fix`).
- New per-repo keys and defaults: `issues: true`, `features: false`, `dependabot: false`, `contributor_prs: false`, `stale_days: 7` (drafts 2×).
- Close note, verbatim: "Closed for inactivity. Reopen it if you pick it back up. If the change is still wanted, [file an issue](<new-issue link>) describing it, and the Maintainer will triage it like any report."
- Nudge names what's waiting on the author and the date: "Still working on this? Push or reply by <date> to keep it open."
- No feature-request message goes to Aiden or the owner digest.
- The App never counts as trusted for `agent-build`; the Maintainer's label tool can never add or remove `agent-build`.
- Merge/close widen to agents org + product repo + `maintainer_repos` only; an App install alone never widens it.
- CLAUDE.md: minimal end-to-end tests, Conventional Commit PR titles, worktree per builder, `sync-shared` after SDK edits, reviewer eval for PR C.

## Review Focus

- A PR whose author replied (no new commit) after the nudge: must not close. → Task 3 test `active author after nudge is not closed`.
- `agent-build` added by the App, or by a `write`-only collaborator on a repo trusting admin/maintain: must not file. → Task 2 tests.
- Two maintained repos with Dependabot PRs: one repo's PR closing must not clear the other's task. → Task 5 test.
- `maintainer_repos` with a new key misspelt (`contributor_pr`): load fails loudly, naming the entry. → Task 1 test.
- A merge on a repo removed from `maintainer_repos` after its card was filed: refused at merge time. → Task 6 test.

---

## PR A — config and Maintainer (Tasks 1–4, one branch `feat/maintainer-duties`)

### Task 1: One parser for `maintainer_repos`

**Files:**
- Create: `kernel/sdk/src/maintained-repos.ts` (moved from `parseRepos`/`MaintainedRepo`/`describeRepos` in `modules/github/connections/github-mcp/src/maintainer.ts:9-89`)
- Modify: `modules/github/connections/github-mcp/src/maintainer.ts` (import from `./aidenhq-sdk/maintained-repos.ts`), `scripts/sync-shared.mjs` (list the new file if it isn't picked up by directory), `modules/github/module.yaml` (owner paths)
- Test: `modules/github/connections/github-mcp/test/maintainer.test.ts`

**Interfaces:**
- Produces: `parseRepos(raw: string): MaintainedRepo[]`; `MaintainedRepo = { repo, owner, name, label, trusted, after_merge, issues: boolean, features: boolean, dependabot: boolean, contributor_prs: boolean, stale_days: number }`; `FEATURE_LABEL = "feature-request"`, `BUILD_LABEL = "agent-build"`; `inMaintained(repos: MaintainedRepo[], slug: string): boolean` (case-insensitive).

- [ ] Step 1: tests: defaults (`features/dependabot/contributor_prs` false, `issues` true, `stale_days` 7); `stale_days: 0` and `"x"` throw; unknown key `contributor_pr` throws `maintainer_repos[0]: unknown key contributor_pr`.
- [ ] Step 2: run `cd modules/github/connections/github-mcp && npm test` → the new tests FAIL.
- [ ] Step 3: move and extend the parser; `stale_days` integer 1–90.
- [ ] Step 4: `module.yaml` `maintainer_repos` gets `owner:` paths (as code-review's): `maintainer_repos.*.repo` `new: true`; `maintainer_repos.*.features|dependabot|contributor_prs` `to: true`. Check with `cd kernel && npm test` (setting-owner tests).
- [ ] Step 5: `node scripts/sync-shared.mjs`; github-mcp `npm test && npm run typecheck` PASS; commit `feat(github): maintainer_repos carries per-repo duties`.

### Task 2: Labels — feature triage and trusted `agent-build`

**Files:** Modify `modules/github/connections/github-mcp/src/maintainer.ts` (`trustedEvent`, `issueList`, `label`, `untriaged`, `repoSince`, `issuesSince`); `modules/github/module.yaml` tool descriptions. Test: `maintainer.test.ts`.

**Interfaces:**
- Consumes: Task 1 `BUILD_LABEL`, `FEATURE_LABEL`.
- Produces: `trustedEvent(e, r, label: string)` (trust for the exact label: App excluded by both `app_slug` and bot login when `label === BUILD_LABEL`); `issuesSince(cursors, triage, builds?: Record<string,string>)` returns per repo `builds: MaintainerIssue[]` and `build_cursor` (only for repos with `features: true`); `label(repo, n, action, label?)` accepts the fix label or `FEATURE_LABEL`, refuses `BUILD_LABEL` with `agent-build is the owner's label`.

- [ ] Step 1: tests: `agent-build added by the App is untrusted`; `agent-build by a write collaborator is untrusted when trusted is admin/maintain`; `agent-build by an admin is trusted`; `AGENT-BUILD (case) is not agent-build`; `label refuses agent-build`; `untriaged skips issues labelled feature-request or agent-build`; `issueList(repo, "agent-build") computes trust on agent-build events, not the fix label`.
- [ ] Step 2: run, FAIL. Step 3: implement (exact-case match for the two fixed labels). Step 4: PASS + typecheck. Step 5: commit `feat(github): trusted agent-build and feature-request labels`.

### Task 3: Watcher — build pass and contributor-PR pass; `github_app_pr_list`

**Files:** Modify `modules/maintainer/service/src/watcher.ts`, `modules/github/connections/github-mcp/src/maintainer.ts` (new `prList`), `modules/github/connections/github-mcp/src/main.ts` (register tool), `modules/github/module.yaml` (`named: [..., github_app_pr_list]`), `modules/maintainer/module.yaml` (grant it). Test: `modules/maintainer/test/watcher.test.mjs`, `maintainer.test.ts`.

**Interfaces:**
- Produces: `prList(repo): { repo, prs: { number, author, author_kind: "bot"|"fleet"|"human", draft, last_author_activity: string, review_requested: boolean, waiting_on_author: string|null, labels: string[] }[] }` (paginated, capped like `issueList`); "fleet" = authored by our App or the runner's bot identity. Watcher `Fire` gains `kind: "fix"|"build"|"pr-nudge"|"pr-close"`; task titles `Maintainer: build <repo>#<n> (agent-build)`, `Maintainer: nudge <repo>#<n>`, `Maintainer: close quiet <repo>#<n>`. Watcher state per repo: `nudged: { [n]: { at, author_activity_at } }`.
- Due rules (pure function `prDue(pr, state, stale_days, now): "nudge"|"close"|undefined`): human PRs only; `review_requested` or (green and `waiting_on_author` null) → undefined; quiet ≥ stale_days (draft 2×) and not nudged → nudge; nudged, no author activity since the nudge, quiet ≥ stale_days since nudge → close; author activity after nudge → clear the nudge.

- [ ] Step 1: tests on `prDue`: `quiet human PR is nudged`; `active author after nudge is not closed`; `nudged and silent is closed`; `draft waits twice as long`; `bot and fleet PRs are ignored`; `PR waiting on review is left alone`. Watcher test: `agent-build files one build task; both labels file one task`.
- [ ] Step 2: FAIL. Step 3: implement; the PR pass runs only for repos with `contributor_prs: true`, the build pass only with `features: true`. Step 4: PASS. Step 5: commit `feat(maintainer): build and quiet-PR passes`.

### Task 4: Maintainer handbook

**Files:** Modify `modules/maintainer/agents/maintainer/AGENTS.md`; `modules/maintainer/module.yaml` (description).

- [ ] Step 1: add sections (positive phrasing, per handbook rules): "Feature requests" (label `feature-request` with one comment naming the area; nothing to the owner); "A build task" (skip validation, brief an Engineer with the issue, follow through like a fix); "A nudge task" (comment via `github_app_issue_comment` with the Global Constraints copy, naming what's waiting); "A close task" (re-read `prList` for author activity and review requests first; close through the code host's close with the verbatim note and the repo's `/issues/new` link). Update Purpose: merges nothing itself; listed repos are where fleet work may merge.
- [ ] Step 2: run the suites that assert handbook text: `cd scripts && npm test`, `cd services/computer && node --test test/*.test.mjs`. PASS.
- [ ] Step 3: commit `docs(maintainer): handbook for features, nudges and closes`; open PR A; `node scripts/ci-local.mjs`.

## PR B — pr-watch on every Dependabot-enabled repo (Task 5, branch `feat/pr-watch-maintained`; after PR A merges)

### Task 5: pr-watch per maintained repo; dependabot skill

**Files:** Modify `modules/github/service/src/pr-watch.ts`, `modules/github/service/src/main.ts:50`, `modules/github/module.yaml` (pass `GITHUB_MAINTAINER_REPOS` to the github service), `modules/engineering/skills/dependabot/SKILL.md`. Test: `modules/github/test/pr-watch.test.mjs`.

**Interfaces:**
- Consumes: Task 1 `parseRepos`.
- Produces: `startPrWatch(o: PrWatchOptions & { repos: { repo: string; duties: "all"|"dependabot" }[] })`: one loop; product repo and agents-org repos `all` (today's behaviour), maintained non-own repos with `dependabot: true` get `dependabot` only. State `pr-watch.json` keyed `{ [repoLower]: {...today's state} }` (old flat state is discarded: no migration). GraphQL open-PR query paginated past 50. A Dependabot PR with no named checks counts as finished.

- [ ] Step 1: tests: `two repos: closing repo A's PR leaves repo B's dependabot task`; `dependabot-only repo gets no CI rerun and no branch cleanup`; `a Dependabot PR with no checks is filed`; `more than 50 open PRs are all seen`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: `cd modules/github && npm test` PASS.
- [ ] Step 5: SKILL.md: a PR too young → `task_wait` until its eligibility date, then rerun the age check; "couldn't establish the age" is a fix, not a wait; pins-only is the AI reviewer's judgment (policy 07), not a code check. Commit `feat(github): pr-watch owns Dependabot PRs on every maintained repo`; PR B.

## PR C — merge and close on maintained repos (Task 6, branch `feat/merge-maintained`; after PR A; model: opus)

### Task 6: Widen `plan.mjs` and the merge queue

**Files:** Modify `modules/github/service/src/plan.mjs` (`closePart`, `mergeParts`), `modules/github/service/src/github-app.ts` (new predicate), `modules/github/service/src/merges.ts:99,228`, `modules/github/service/src/service.ts:244,459` (pass `maintained`), `modules/ai-reviewer/service/security/policy/05-*.md`, `07-*.md`, `16-worked-cases.md`, cases in `modules/ai-reviewer/test/reviewer-cases/`. Test: `modules/github/test/plan.test.mjs`, `merge-queue.test.mjs`.

**Interfaces:**
- Produces: `mergeable(slug, agentsOrg, productRepo, maintained: string[]): boolean` in `github-app.ts`. `ownRepo` is unchanged (it also governs leak checks and workflow-write tokens, which stay as they are). Plan state gains `maintained: string[]`.
- Rules: a maintained repo outside the agents org merges and closes like an agents-org repo (same tiers, friction, `instanceRepo` refusals), plus Dependabot heads admitted as the product repo admits them; close of a Dependabot PR there by the Platform Engineer's line is Tier 0 as on the product repo; the merge queue re-checks `mergeable` at merge time and uses the App token there.

- [ ] Step 1: tests: `merge on a maintained repo outside the agents org is planned`; `close on a maintained repo is Tier 0`; `a repo the App is installed on but not maintained is still outside-merge`; `merge refused at queue time once the repo leaves maintainer_repos`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: `cd modules/github && npm test` PASS.
- [ ] Step 5: policy 05/07 text and two cases (approve: Dependabot pin bump on a maintained non-product repo; reject: merge card on an unlisted repo). Run the reviewer eval per CLAUDE.md (on the EX44, `openrouter_eval_key`): ≥95%, every miss a false block of a clean case.
- [ ] Step 6: commit `feat(github): the fleet merges and closes on maintained repos`; PR C with the eval receipt.

## PR D — #831 ghcr dating (Task 7, branch `fix/ghcr-dating`; independent)

### Task 7: Diagnose and fix the undatable Paperclip pin

**Files:** `scripts/supply-chain/pins.mjs`, `scripts/supply-chain/best-version.mjs` (`ghcrVersions`), `.github/workflows/ci.yml` (token permissions only if that's the cause). Test: `scripts/test/` supply-chain test.

- [ ] Step 1: reproduce locally: `node scripts/supply-chain/best-version.mjs docker ghcr.io/paperclipai/paperclip:2026.1117.0` with and without `GITHUB_TOKEN`; record the API status.
- [ ] Step 2: write a test for the cause found (e.g. a cross-org package read failing falls back to the image's GitHub release date for the same tag when the image's `org.opencontainers.image.source` names that repo); FAIL; implement; PASS.
- [ ] Step 3: commit `fix(scripts): date ghcr images from another org`; PR D. Re-run #831's checks after it merges.

## After merge (operator, not code)

- [ ] Instance `config` (instance repo): `maintainer_repos` lists the product repo with `dependabot: true` (keeps today's coverage) and `Aiden-HQ/aidenhq-distro` with external triage; bump the product pin; apply.
- [ ] Confirm the four distro graduation issues are triaged by the next daily run; file a test graduation issue to confirm new ones are picked up.
