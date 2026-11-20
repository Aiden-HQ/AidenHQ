# Maintainer: per-repo duties, PR upkeep and owner-gated features

Status: design, 2026-11-20. Owner decisions are marked **(owner)**; everything else is the designer's call.

## Why

On 2026-11-20 nothing owned the PRs the fleet didn't open: a Dependabot PR parked for days (AidenHQ#831, its task WOR-8763
left in `todo` with no recheck), dead PRs in a retired repo, and four distro "failed graduation" issues with no comment.
Today the Maintainer handles only issues labelled `agent-fix`; the github module's `pr-watch` (`modules/github/service/src/pr-watch.ts`)
files one Dependabot task, for the product repo only; the Fleet Steward's stale-PR check sees only agents-org and
fleet-authored PRs. Feature requests on a maintained repo are never labelled (the handbook forbids labelling anything that
isn't a fix) and stay open forever.

Goal: every open issue and PR on a repo the owner lists has a known state and an end, without the fleet taking over
someone's live work, and with GitHub, not Aiden, as the channel for feature requests.

## Goals

- The owner chooses, per maintained repo, what the Maintainer looks after (like Code Review's per-repo settings).
- No PR goes stale: bot PRs always have a live task; quiet human PRs are nudged, then closed.
- Feature requests are triaged and labelled on GitHub and built only when a trusted person adds a build label.
- Any repo works **(owner)**: "all our modules should be able to accept any repo", not just the agents org and the product repo.

## Non-goals

- Reviewing PR code: the Code Review module does that on the repos it lists.
- Adopting or finishing a contributor's branch.
- Messages about feature requests through Aiden or the owner digest **(owner)**.

## Anti-goals

- Closing or touching a PR whose author is still working on it.
- The fleet approving its own features: the App's own `agent-build` label never counts (code-enforced).

## Approaches

1. **Extend the Maintainer module (picked).** Per-repo switches on `maintainer_repos`; the existing watchers gain PR passes;
   new App-scoped PR tools; the rest is handbook text. One place to configure everything on a maintained repo.
2. Stale PRs to the Fleet Steward (it already has `stalePrs`). Rejected: splits one repo's upkeep across two agents.
3. GitHub's `actions/stale` workflow per repo. Rejected: can't tell a live Dependabot task from a parked one, and the config
   lives in each repo rather than the instance.

## Design

### Configuration

Each `maintainer_repos` entry (github module; parsed in `github-mcp/src/maintainer.ts`) gains, besides
`repo, label, trusted, after_merge`:

| key | default | meaning |
|---|---|---|
| `issues` | `true` | today's behaviour: validate `label` issues, hand fixes over, see them through |
| `features` | `false` | triage feature requests (label `feature-request`); build ones carrying `build_label` |
| `dependabot` | `false` | every open Dependabot PR has an Engineer task |
| `contributor_prs` | `false` | nudge, then close quiet human PRs |
| `stale_days` | `7` | quiet days before the nudge, and again before the close; drafts get double |

The labels are fixed names, not settings: `feature-request` and `agent-build` **(owner: its own label)**. New switches
default off (quiet start); the product repo's Dependabot coverage moves here, so the instance config lists the product
repo with `dependabot: true` in the same change (nothing is lost). Unknown keys still fail loudly. Turning on
`features`, `dependabot` or `contributor_prs` is the owner's change, with wildcard `owner:` paths as Code Review already
uses (`maintainer_repos.*.contributor_prs`, `to: true`). `maintainer_repos` is the one repo list for upkeep: the Maintainer
and `pr-watch` both read it. Code Review keeps its own list (reviewer profiles, budgets and fork rules are review-only).

### Feature requests (GitHub only)

- Triage (external triage and the new-issue run): an issue asking for new behaviour is checked for a duplicate and for
  being already built (closed as today), else labelled `feature-request` with one comment naming the area it touches.
  Nothing else: no digest line, no message **(owner)**. Triage skips issues already carrying `feature-request` or
  `build_label`.
- Build: the watcher polls `agent-build` too (its own cursor and fired set). A trusted `agent-build` files a fix-style
  task marked as a feature; the Maintainer skips the "is it real" validation and hands it to an Engineer with the issue as
  the brief; the PR goes through the normal cards, merges, and the issue closes per `after_merge`. An issue carrying both
  labels gets one implementation task.
- Trust for `agent-build`: the same roles as the repo's `label` **(owner)**, except the App never counts (excluded by both
  its App slug and its bot login). Trust is computed on the latest event for the exact label being acted on (today
  `issueList` computes it against the fix label whatever label it filters by: fix that), matched exactly, not
  case-insensitively, and re-read just before the hand-off. The Maintainer's label tool may add or remove the fix label and
  `feature-request`, never `agent-build`. Both the daily and the per-issue triage skip issues already carrying either.

### Dependabot PRs (`dependabot: true`)

- One filer: `pr-watch` files its existing `dependabot:<repo>/<n>` task to the platform-engineer role for each maintained
  repo with `dependabot: true` (today it runs for `PRODUCT_REPO` only). One scan loop over the repos, with its state keyed
  by repo (today one `pr-watch.json` would let one repo's cleanup mark another's task done), paginated past the newest 50
  PRs. A Dependabot PR with no named checks is filed too (today it never qualifies). On a repo added this way, `pr-watch`
  does only the Dependabot duty: its CI reruns and abandoned-branch cleanup stay on the fleet's own repos.
- The Engineer's `dependabot` skill does the work, as today. A PR it parks because it's too young calls `task_wait` until
  the known eligibility date and reruns the age check on wake. "Couldn't establish the age" is a different case: a failure
  to fix, not a wait. The Fleet Steward's weekly sweep reuses the PR's existing task rather than filing another.
- No nudges on bot PRs.

### Any repo: merge and close **(owner)**

Two places refuse outside repos today, and both widen: `modules/github/service/src/plan.mjs` (closes and merges outside
the agents org, the product repo's Dependabot PRs excepted for the Platform Engineer) and the merge queue
`modules/github/service/src/merges.ts` (`ownRepo`). Widened to any repo on `maintainer_repos` (not any repo the App can
reach: the App is public and anyone can install it, so an install must never be enough). Each merge or close is a
reviewed card naming the exact repo, PR and head; the head, checks and instance-repo protections stay. Dependabot's
"pins only" is the AI reviewer's judgment per policy 07 (the skill wrongly calls it a code check: fix the skill text).
This changes the code host's git rules and the tier function, so the AI reviewer eval must pass on it (CLAUDE.md), with
policy `05`/`07` and its cases updated to match.

### Contributor PRs (`contributor_prs: true`)

Applies to open PRs not authored by a bot or by the fleet (our App, the runner).

- Quiet = no commit, comment or review reply by the PR's author for `stale_days` (drafts: twice that). Any author activity
  resets the clock and cancels a pending close.
- First quiet period: one nudge comment that names what's waiting on the author (a red check, a requested change, a
  conflict) and the date it closes: "Still working on this? Push or reply by <date> to keep it open."
- Second quiet period after the nudge: close with the fixed note **(owner)**: "Closed for inactivity. Reopen it if you pick
  it back up. If the change is still wanted, [file an issue](<repo's new-issue link>) describing it, and the Maintainer will
  triage it like any report." The nudge is recorded; just before closing, author activity and review requests are read
  again (a reply leaves the head unchanged, so the head alone can't tell).
- A PR waiting on a maintainer's review (an open review request, or green with nothing asked of the author) is not the
  author's silence: left alone.

### Tools (github-mcp, App-scoped, maintained repos only)

One new read, `github_app_pr_list` (open PRs with author kind bot/fleet/human, draft, last author activity, labels:
`named`). Comments reuse the scrubbed `github_app_issue_comment` (a PR is an issue on GitHub's API); closing reuses the
code host's close record (`plan.mjs` close, widened above). No new write tools.

### Watcher

`modules/maintainer/service/src/watcher.ts` adds, per repo with `contributor_prs` on, a PR pass on the same timer: files
one task per PR with a nudge or close due, deduped through its state file like issues. Nothing due = no model run.

### Fixes for today's gaps

- #831's "could not be dated": ghcr dating already exists (`best-version.mjs` `ghcrVersions`, the GitHub Packages API), so
  the likely cause is that CI's token can't read another org's package (`paperclipai`). Diagnose the exact digest first,
  then fix at that cause; until then waiting 7 days won't make it pass.
- `aidenhq-distro` joins `maintainer_repos` (in the instance config) with external triage. Check who files the graduation
  issues first: immediate triage skips issues filed by our own App, so the existing four go to the daily triage, and new
  ones need a real filing to confirm they're picked up. The Maintainer labels them itself. No bot trust is added.

## Left to the builder

Exact tool shapes, state-file layout, how "fleet-authored" is detected, the `owner:` path syntax, and a few end-to-end
tests: a quiet PR nudged then closed, an active PR untouched, `agent-build` by the App ignored and by an admin filing a
build task, `pr-watch` filing on a second repo, a Dependabot merge on a non-agents-org repo planned.
