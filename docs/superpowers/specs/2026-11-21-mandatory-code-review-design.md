# Mandatory code review: no merge with an open important finding

Owner approved the direction 2026-11-21 (option B below; Codex cross-review agreed). Status: design.

## Intent

On a repo flagged `mandatory`, a pull request merges only after the configured reviewers have reviewed its current head
and every **important** finding on it is resolved. Today code review is advice: findings are posted and forgotten, a
stale finding never closes, the same issue is re-posted in new words after a force-push (PR #1181: ten force-pushes,
three posted reviews, repeated findings, none ever closed), and the `mandatory` flag only switches the AI reviewer
off. The owner wants review to be a real gate, decided by AI, without becoming an owner chore.

Success: on `Aiden-HQ/AidenHQ` (flagged mandatory once built), every fleet merge waits for the review; important
findings close when the fix lands or a judge dismisses them; the owner is rarely asked anything.

## Goals

- One verdict per PR head, owned by the code-review service, read by the merge queue before every merge on a mandatory
  repo.
- Findings have a lifecycle: open until a recheck confirms the fix, an AI judge dismisses it, or the owner dismisses it.
- Every new head rechecks every open important finding, including full reviews, rebases and force-pushes.
- A new run does not re-post an issue that is already open on the PR.
- Mandatory repos fail closed: a missing, skipped, failed or partial review keeps the merge waiting.

## Non-goals

- Gating the owner's own manual merges on GitHub (admin bypass is the owner's escape hatch, by choice).
- Gating humans who merge on GitHub directly (no GitHub App, so no check runs; a status is forgeable). Out of scope
  until there is a reason.
- `codehost-local` repos and repos without code review configured: no change.
- Nits and pre-existing findings never gate.

## Anti-goals

- A gate that strands merges: a waiting merge must always say why and how it unblocks, and resume by itself.
- Partial work read as clean (a truncated output, a failed verifier, a missing combo).
- Owner pings for routine disputes.

## Approaches considered

- **A. GitHub status plus a ruleset.** Rejected: AidenHQ acts as the owner, an admin, so admin bypass exempts both the
  owner and every fleet merge; check runs need an App we no longer have.
- **B. The merge queue asks the code-review service (chosen).** The service owns findings and the verdict in its
  SQLite; the github merge gate calls it right before its head-bound merge, only for repos on the compiled mandatory
  list. No GitHub permission needed; one source of truth.
- **C. B plus an aggregate `aidenhq/review` status the gate reads.** Rejected after Codex review: a status is
  forgeable by any writer, is per commit while verdicts are per PR (two PRs can share a head), and would be a second
  place the verdict lives.

## Design

### Verdict

`GET /v1/verdict?repo=&pr=&head=` on the code-review service (internal, service-key auth like its other internal
routes) returns one of:

- `pass`: the head is **covered** and no important finding on the PR is open.
- `wait` with reasons in plain words and the unblock step for each: review queued or running; review failed (retrying,
  or `@aiden review`); important findings open (titles and links; fix, reply to dispute, or owner dismisses on the
  board); repo config invalid; service unreachable is the caller's `wait`.

There is no `fail`: the merge record stays queued and re-asks on its normal cadence, so nothing is stranded.

**Covered** means a complete review batch finished at this head and its range starts at the merge base or at a head
that was itself covered. A complete batch = every combo the moment requires (on_open for the first or full review,
on_push for an incremental one) reached `done`, none truncated or with a failed verifier, none withheld an important
finding. A focused one-off review never counts toward coverage. A force-push whose last reviewed head is not an
ancestor of the new head is reviewed over the full range (merge base..head) by the on_push combos.

### Finding lifecycle

States: `open`, `fixed`, `dismissed` (plus the existing analytics outcomes `open_at_merge`, `open_at_close`).

- **Recheck:** the first run of each batch at a new head gets every open important finding on the PR (all of them, not
  only touched lines; full reviews and force-pushes included), with its original evidence, and judges each against the
  current tree. Only an explicit verified "fixed" closes one; uncertain or omitted leaves it open.
- **No repeats:** finders get the PR's open findings as "already reported"; a finding that restates one is dropped,
  not re-posted. Exact-id grouping stays as the storage key.
- **Reopen:** a fixed or dismissed finding reported again later reopens.
- Dispositions are applied in one transaction against the current head; a result for a superseded head is discarded
  (today `fixed` updates land before the superseded check).
- The cap of 50 findings carried forward does not apply to open important findings.

### Dismissal

- **AI judge:** a reply on a finding's thread (or `@aiden` on it) that disputes it starts a judge run: the finding, the
  fenced reply and the relevant code go to a structured judge (`kernel/sdk/src/judge.ts`, its cross-family selector)
  on a model family different from the PR author's model (from the job's trusted provenance; a human author: any
  family). `dismissed` (with reason) or `upheld`; the answer is posted on the thread. Indeterminate means upheld.
- **Owner:** a Dismiss button per open finding on the board's Reviews page (the owner's authenticated session). The
  owner's GitHub login alone never dismisses: fleet comments post as that login too.
- Every disposition records finding ids, head, reason, evidence and the deciding identity.

### Fail closed on mandatory repos

- The daily budget never skips a mandatory repo's run (spend still counts and shows).
- Fork PRs are reviewed automatically (as `forks: auto`).
- A failed run retries once by itself; after that the verdict says `@aiden review` reruns it.
- Drafts are not reviewed and not merged by the fleet, so no change.

### Merge gate

`modules/github/service/src/merges.ts` gains one step next to the reviewer-eval gate: for a repo on the compiled
mandatory list (`repos.code_review_mandatory`), ask `/v1/verdict` with the bound head; anything but `pass` is `wait`
with the reasons shown on the merge record and the board. Repos not on the list never call the service, so installs
without code review behave as today. A mandatory repo whose config is invalid is refused at apply time, not silently
dropped.

### Delete

- The `aidenhq/review` commit status: both per-run status writers and the always-success `reviewStatus`
  (`review-post.ts`, `review-render.ts`). Keep the named-check exclusion so old statuses never become a second gate.
- "The review is advice: it never approves or blocks a merge" and the "nothing enforces it yet" notes
  (`docs/design/code-review.md`, `module.yaml`, `config.ts`, `docs/design/approvals.md`).
- Rewrite the outdated "App where installed" comment in `modules/code-review/module.yaml`.

### Instance

Once deployed: `Aiden-HQ/AidenHQ` gets `mandatory: true` and `settings.ai_review_code: unless_code_review_mandatory`.
Then watch the next PRs end to end and fix what misbehaves.

## Calls made after the builder check (owner may override)

- **Who may dispute:** a reply starts the judge only from the PR's author or someone with write access to the repo (the
  same check `@aiden review` uses). A fork author or stranger's reply is ignored; the owner can still dismiss on the
  board. The reply reaches the judge fenced as data, never instructions.
- **Thread to finding:** each posted inline comment carries a hidden marker with its finding id (the poster already
  embeds markers); the comment reader returns the reply's parent thread so the service maps reply → finding id.
- **Where the judge runs:** as a check job of the code-review module (a `judge` mode of the existing recipe: the same
  credential-free box with the tree at the PR head, a capped model token, the ledger). Its spend counts toward
  `day_usd` but, like every mandatory run, is never skipped for budget.
- **Judge family:** the PR author's model comes from the agent named in the commit's `Co-authored-by: AidenHQ <agent>`
  trailer and that agent's compiled model; the judge uses a different family. Unknown author (a human, or no trailer):
  the instance's checker model (`~openai/gpt-luna-latest` today). Never the same family when known.
- **Complete run:** `done` with findings stored and no important finding dropped by a cap (important findings are never
  capped or ignored-out). Posting is not part of the verdict: a failed or held post doesn't hide a finding, which the
  verdict and the board read from the DB.
- **Head mismatch:** the verdict answers for the asked head; if the PR's current head differs, `wait` ("the PR moved;
  the newer head is being reviewed"). A PR the service hasn't seen yet: `wait` ("review not started").
- **Wiring:** the github merge path takes an injected `reviewGate` like `evalGate`; the github service gets its own key
  for the code-review service (one key per caller, like the board's) and the address; the github module does not
  require code-review (no mandatory repos, no call).
- **Invalid mandatory config:** a mandatory repo must list at least one `on_open` and one `on_push` combo (`[]` is
  refused for a mandatory repo; omitted takes the defaults). Checked where `scripts/modules.ts` compiles
  `code_review_mandatory`, failing the apply.

## Owner changes during the build (binding; they supersede the text above where they differ)

- **Mandatory is per reviewer, not per repo.** `mandatory` is a combo's (`{ engine, model, effort, run_usd?, mandatory? }`,
  default false); a repo is gated when any combo is. A gated repo has a mandatory combo at both moments (else refused by the
  service, the board and the compile); a repo-level `mandatory` is refused. Turning one on is owner-tier (a change to a moment's
  combos already is).
- **Only mandatory combos count.** Coverage needs the mandatory runs of the batch that reviewed the head; only important findings
  from mandatory runs gate; other combos' findings stay advice. The recheck runs in the batch's first mandatory run. Budget,
  fork and retry rules apply to mandatory runs only.
- **Coverage per head, by the batch that reviewed it.** A single-commit PR is covered by its on_open batch alone; on_push never
  has to run at a head on_open covered. On a gated repo a new head is a push only once an earlier head was covered, so a PR
  pushed to before its first review finished gets on_open at the newest head; an incremental range starts at a covered head.
- **Complete means whole.** A run counts only with no `coverage.incomplete` and no important finding withheld; a partial one
  waits with its reason (`@aiden review full`). `incomplete` means real partial coverage only: codex-native's "which parts it
  read isn't tracked" is a note (`coverage_note`), not a gap.
- **No repeats, safely.** A finding restates an open one only on the same file at no higher severity, and a mandatory review's
  important one only a gating one.
- **The judge.** One judge per finding per head (after a ruling, a new dispute needs a new head or the owner's Dismiss); its
  model is of no family any `Co-authored-by: AidenHQ …` trailer on any of the PR's commits names (none named: the checker
  model); everything it reads is fenced data. A single dismissal suffices. Its spend counts in the day total.

## Left to the builder

The verdict cache and polling cadence, the judge prompt, the board's verdict and Dismiss UI (match the Reviews page),
how a waiting merge shows its reasons, schema migration of `findings` (fresh columns are fine; no users).
