# Approvals: tiers, the AI reviewer and autonomy

Every write with lasting effect (push, pull request, merge, close, create_repo, fleet apply, app deploy, a send as the owner's
own account, any other write tool call through the proxy) is an approval record in the kernel (`kernel/src/records.ts`,
`kinds.ts`, `writes.ts`), not an agent's own action; the board keeps no approval store and only reads them. Code assigns each
record a tier from verified state. Routine, low-risk changes run at once, everything else is decided by an AI reviewer, and
authority-expanding changes by two reviewers on different model families who must both approve. The owner decides only when
those two disagree, or after their own veto (owner, 2026-11-14: about two decisions a week). Friction (red checks, a moved head,
a change too large to read) goes back to the agent, never to the owner.

## Principles

- **Code assigns the tier, never the request.** The code host's `modules/github/service/src/plan.ts` (git writes) and the
  kernel's `apply-tier.ts` (fleet applies) are pure: they compute a tier on the merits from state read from git and GitHub
  (the authenticated requester, the real repos, bases and heads, the files in the actual diff, the compiled config diff).
  `computeTier` (`kernel/src/tier.ts`) is the one function that sets the final tier: floors, raises, the owner's veto, then
  the autonomy caps. A request with several parts takes its highest part (panel above plain Tier 1); anything unrecognised is
  Tier 2 (default deny). The plan runs when the record is filed and again before it executes; a changed target closes the
  record as stale and it is filed again.
- **The reviewer can only escalate.** It may approve or reject a Tier 1 card, add the second reviewer (`second_review`), or
  hand it to the owner. It never lowers a tier, never removes code's panel flag and never decides Tier 2 on its merits.
- **The records are the audit trail.** Each record stores `tier`, `reason` and `decided_by`, which the kernel stamps
  server-side from the credential used (`owner:board`, `owner:telegram`, `owner:reply`, `account:<id>`, `reviewer:<model>`,
  `reviewer:<model>+<second>` for the panel, `auto:<rule>`), never from a caller-supplied field. Lifecycle: `review` or
  `owner` then `approved`, `claimed` (once), `done` / `failed` / `unknown`; also `rejected`, `stale`, `cancelled`. Open records
  expire after 7 days.
- **Earlier decisions bind** (`tier.ts` `priorDecisions`). The owner's rejection of an action on a task is a veto: every later
  request of it there is the owner's until they approve one. The reviewer's rejection holds for exactly that content (the same
  commits or patch, under any branch name): such a request is refused by code before any review until a decision on the task
  answers it: the owner's own comment, or a comment by the agent that created the task or the chief of staff (owner,
  2026-11-20: a delegator's or chief of staff's decision may lift a rejection and a park, once per target; never the
  requester's own comment, nor an edit of the title or description); the agent changes it or reports back (owner,
  2026-11-18: refile only after a fix). The reviewer reads the task's comments (TASK_COMMENTS), each under a label code writes from its author:
  the owner's words, the delegator's or chief of staff's amendment of their request (an agent's, never the owner's), the
  requester's own context. Changed content is reviewed afresh with every earlier note attached. After `MAX_REJECTS` (5; owner,
  2026-11-20, raised from 3) unanswered reviewer rejections of one branch or PR since the owner's last yes, that target is parked with a note to the
  agent; the task's other targets are still reviewed. A decision on the task lifts the park: agents' decisions once per
  target (`AGENT_LIFTS`), the owner's always. A triage write (label, comment, close) is judged on the verdict the triaging
  agent reached: whether a stranger's issue is credible is that agent's judgement, not evidence the reviewer is owed (owner,
  2026-11-20). A rejection counts on the branch it was raised against, by name or by the
  change's content key; an action that names no branch or PR (an apply, a module digest) has the task as its target. Code's own
  refusals (`CODE_REJECTS`: moved, unreadable, too large) never count; a card closed because its head moved is `stale`.
- **A rejected head stays inspectable.** A `pr` card's head is reviewed before anything is pushed, so the code host keeps each
  reviewed head in its cache clone as `refs/reviewed/<approval>/<branch>`; the rejection names the ref and a later task's clone
  fetches it. It is never pushed. Refs are pruned after 30 days (`modules/github/service/src/tidy.ts`).
- **Authority-expanding goes to the panel.** A change is authority-expanding when it weakens an approval, authentication,
  sandbox or secret control, changes who can approve, widens credentials, grants, public access, data destinations or
  spending, or edits the gate's own core. Code decides most of it: the path inventory `paths.yaml` (compiled with each
  official module's `paths:` into `config/kernel/paths.json`, read by `kernel/src/paths.ts` for every push, PR and merge;
  sensitivity 0, 1, `panel` or 2, the highest matching entry wins), the platform check (`modules/platform/src/check.ts`),
  `plan.ts`, and the apply rules. By content: new grants, tools, roles, models, images, settings, credentials, sensitive apps,
  compose beyond image versions, routine autonomy and a backward pin. Where code can't tell, the first reviewer flags it.
  The supply-chain source exceptions file is sensitivity 2: only the owner's own tap approves it.

## Tiers

- **Tier 0: runs at once.** Executed directly with an audit-only record (`auto`, outcome filled in). No card, no ping.
- **Tier 1: AI reviewer.** A card is filed and the reviewer decides. With `panel`, a second reviewer (another model family
  than the first's and the requester's) answers the same question blind to the first's verdict after a first approve; the
  first rejecting sends it back without asking the second. A first reviewer's `unsure` goes to a second reviewer (another
  family) given the first's note. Two votes decide (owner, 2026-11-20: under full autonomy no panel outcome is the owner's
  but the 4th split below):

  | Votes | Outcome |
  |---|---|
  | approve + approve | approved (`reviewer:A+B`) |
  | approve + unsure | approved, the unsure one recorded as `second_unsure` (`reviewer:A;unsure:B`), only when code verified the input whole; otherwise back to the agent (`reviewer_unsure`) |
  | unsure + unsure | back to the agent with both notes (`reviewer_unsure`), never the owner |
  | approve + reject | back to the agent with both notes (`panel_split`), up to 3 times on a target; the 4th goes to the owner (Tier 2). Splits have their own count and never count toward the 3-rejection park bound |
  | reject (first, or after an unsure) | rejected, back to the agent |
  | escalate (either) | the owner, as one reviewer's escalate |

  "Verified whole": the code host records git's own numstat of the change at filing (`files.changed`); the reviewer checks
  the diff against it before any model reads it (a mismatch goes back as `files_not_shown`), and the request chain is not
  empty. Every changed file and every line of the diff is inline or a tool call away, whatever the size. The approval attests it (`whole: true`); the
  kernel refuses a `second_unsure` approval without it and drops `second_unsure` from a verdict that ends as anything but an
  approval. A model's own claim about its input never decides it. Reviewers are told the diff is whole only when it is.
  The kernel refuses a reviewer approval of a panel card that names neither a second approval nor a second reviewer that was
  unsure. A failed or slow review is retried with backoff capped at 15 minutes, never rejected for it; a diff
  missing, or with files the reviewer can't read, goes back too. Nothing is refused at filing for its size: the card stores
  its details cut (with code's note) and the record's context carries them whole while it is open, for the reviewer and the
  owner's card. Each review's model calls are capped (`REVIEW_USD`, $10, on its gateway token); a review that reaches a
  spend cap goes to the owner (`review_cap`), never approved. After an unsure send-back and after each panel split, the
  same commits get one more review once the request chain changed (the same chain stays refused).
- **Tier 2: owner.** A board card plus a message on the owner channel. The AI reviewer reads every one first (owner,
  2026-11-16: every write is reviewed before it reaches the owner) and its verdict is on the card.
  - **Tier 2 on its merits** (owner veto, spend-cap raise, owner-approval record, unknown repos, nothing recognised; `meritOwner`,
    `byMerit`): the reviewer's approve and reject both go on to the owner (`owner_tier`). Only code's own refusals close it.
    The kernel refuses a reviewer approve or reject on such a card (`review_first = owner`).
  - **A cap on a Tier 1 write** (see Autonomy): Tier 1 semantics, so the reviewer's reject is final and its approve goes on to
    the owner (`review_first = final`).
  - A capped Tier 0 write waits for the owner's tap without a review.

Code refuses some requests before any review, with the reason to the agent: a request on a cancelled or done task; a product
write from outside the Platform Engineer's line, or to a default branch; a push to the instance repo (it changes through apply);
a merge whose head moved or whose named checks are red or missing; unreadable files; content the reviewer already rejected, or a
fourth rejected try; a close outside the agents org or of a product or instance PR (except a Dependabot PR on the product repo).

**The Platform Engineer's line** (`requester.platform`): a job holding the `platform-engineer` role, which admission
(`kernel/src/admission.ts`) freezes onto a job only on a task no agent filed, or one filed by an agent holding `architect` or
`fleet-audit`. A product PR is a proposal: any Engineer job opens one (Tier 1) and may ask to merge it when its own task pushed
the head (Tier 1, `product-merge-engineer-head`). Bare branch pushes, PRs that change `.github/`, and merges of another
requester's head or of a `.github/` change on the product repo are this line's only.

Typical git assignments (`plan.ts`; read it for the full rules):

| Request | Tier |
|---|---|
| Push or draft PR of an ordinary branch (`agent/<task>/...`) in the agents org; `.github/` exactly the product's CI template | 0 |
| Close a PR in the agents org; the Platform line closing a product Dependabot PR; create_repo in an allowed org | 0 |
| Merge in the agents org: every named check green (or running, merged only once green) on the exact head, head pushed by the code host, no other `.github/` change, app not sensitive | 0 |
| Same merge with a foreign head, other `.github/` change or sensitive app; any other `.github/` change; an empty repo's first push; push or PR outside the agents org; a change request on `local` | 1 |
| Push to an agents-org repo's default or deploy branch | 1 + panel |
| Product repo: PR, branch push (Platform line), or merge of a head the code host pushed with no red check | 1 (+ panel for paths the inventory marks) |
| Merge with no named checks, red checks or a moved head; the instance repo; outside the agents org; product default branch | refused |

Fleet applies (`kernel.apply`, floor 1, planned by `apply-tier.ts`): a new trial agent, a handbook or memory change, a
graduation that adds no tools, a non-sensitive app change, removing an agent or app and a forward product pin are Tier 0 or 1;
new grants, roles, write connections or credentials, sensitive apps, settings, routine autonomy, a backward pin and unrecognised
files are Tier 1 + panel; loosening autonomy, raising spend caps and setting an owner-only setting are the owner's. Module
authority changes come from the authority diff (`scripts/compiler/authority.ts`).

Module write kinds are records too: a tool a module routes into a kind (manifest `writes:`) goes to that module's executor
(`executor@1`): its plan checks the caller and pins what runs, the kernel tiers it, and the executor runs it only once
approved, claimed and revalidated. Any other write is `conn.tool` at Tier 0 (a destructive one at Tier 1, replayed once). Apps
platform kinds (`modules/apps-platform/module.yaml`): a stateful `app_deploy` is Tier 1, with the panel when it touches a
migration or schema file, refused when too large to review; restarts, rollbacks and app API writes are Tier 0.

## The reviewer

The `modules/ai-reviewer` module (`service/src/review.ts`, reviewer@1) makes one schema-bound call per Tier 1 card (two for
the panel), in its own container with no harness, shell or network (the diff is attacker-written). Its only tools are
read-only and served by the service from the request itself (`changeTools`): `diff` (one changed file's diff, or code's
index of all of them), `read_file` (a changed file's full text at the head) and `grep` (over both), every answer paged and
fenced as data. The kernel drives it: each sweep

What it judges (owner, 2026-11-21): **authorization and safety only**. Scope (is this what the request chain asked),
authority (the panel for authority-expanding changes), secret and private-data exfiltration, injected or untrusted
instructions, instance details in GitHub writes, exposure (the `exposure-pins` check) and the security checklist's items
about authority, secrets, exposure and scope (`security/checklist.json`: `reviewer-cases-kept`, `exposure-pins`,
`gate-file-moved`, `scoped-deletions`). Whether a change works or is well built (bugs, tests, style, reliability) is code
review's, CI's and the grader's: the reliability items (`data-mount-dirs`, `timeout-sized`, `sync-shared`,
`schema-setup-race`, `progress-after-success`, `drain-on-restart`, `module-contract-docs`), the PR's Evidence section and the
screenshot nit left the reviewer.

**Which pushes and PRs it reviews** (`ai_review_code`, the ai-reviewer module's setting, owner-only): `all` (default);
`none` (no code-host push or PR on any repo); or `unless_code_review_mandatory` (none on a repo code review gates: one with a
`mandatory: true` combo, whose merges wait for code review's verdict; docs/design/code-review.md "Mandatory reviewers"). A skipped push or PR is code's approval (`code_review_owns`, model `kernel/code`), held like any verdict
to the record's review-first. A panel record (authority-expanding: gate-core paths, a default or deploy branch head) is never skipped. Merges, closes, create_repo, sends, settings, deploys and tool calls are always reviewed. The
one predicate is `codeReviewOwns` (`kernel/src/writes.ts`), on the record's kind and the repos its targets name.
`kernel/src/review-loop.ts` builds the review from the record and sends it through `kernel/src/reviews.ts` with a single-use
token. It returns `{decision: approve | reject | escalate | unsure, reason_code, reason, second_review}`.

- **Models** (`service/src/aidenhq-sdk/judge.ts`). GPT Luna (medium) then DeepSeek Flash (high) as fallback, on OpenRouter with
  zero data retention; the requester's own model family is excluded and the requester can never choose the reviewer. The
  panel's second reviewer is GLM Flash (high), else DeepSeek, else Luna: never the requester's family nor the first reviewer's.
- **Any size (owner, 2026-11-21: "reviewers should be able to handle infinitely large PRs").** Nothing is refused or cut
  for size. What fits one call is inline: the diff up to `MAX_DIFF` (150,000 characters) whole, else each file's diff in
  order while it fits, and the changed files' text up to `MAX_FILES` (200,000). The rest is named in `DIFF_FILES`
  (`[not inline]`) and read with the tools. Code counts an approval that did not read a not-inline file's diff to the end as
  unsure. Each review is bounded by spend (`REVIEW_USD`) and by tool rounds (`MAX_TURNS`, 30, `judge.ts`); reaching either
  goes to the owner (`review_cap`), never approved. Considered and not taken: chunking the change into parts judged
  separately (a change split across parts can hide what only the parts together do) and an agentic reviewer in a check-job
  box with the whole repo (no eval could run it, cards without a repo need another path, minutes per vote). The tools read
  the change's own files, not the rest of the repo: the reviewer judges scope and safety, which the change shows.
- **Files it can't see.** Images, fonts, audio, video and PDFs are named with type and size. A file it cannot read at all (an
  executable or opaque binary) sends the card back to the agent in code (`files_not_shown`) without a model call.
- **Input.** The policy (`service/security/policy/`, from the product repo only, so instances cannot loosen it); the card; the
  full diff at the exact head and the changed files' text (inline, or through the tools); the request chain; the task's merged sibling PRs;
  the grader's latest verdict; earlier decisions on the task; the instance's decisions digest. Everything an agent or stranger
  wrote is fenced as data. The reviewer never sees the author's own account of the change.
- **Binding.** The kernel accepts a verdict only for a pending record whose digest matches the card, with the reviewer's own
  credential (agents never hold it), and stamps `reviewer:<model>` (`+<second>` for the panel). A rejection is posted on the
  task so the agent can fix and refile.
- **Digest.** Once a day the owner gets a summary of what ran at once, what the reviewer decided and what was escalated.

## Autonomy

The kernel setting `autonomy` (`kernel/settings.json`; default `off`, a new install starts at `full`) is read fresh for every
write the kernel tiers, so it is also the pause switch. A routine may carry its own `autonomy` (same values); a task traced to a
routine (`taskRoutineCap`: the task's parents and kernel provenance up to the routine's execution) is capped by the strictest
routine on its trace. An unknown routine, an invalid value or an incomplete trace counts as `off`; a trace that can't be read
now fails the request with 503 rather than guessing.

- `off`: the owner decides every write, but the AI review still runs first. Tier 0 becomes a card for the owner (rule
  `autonomy-off`); Tier 1 goes to the reviewer first: its reject is final, its approve goes on to the owner's card with its
  verdict. Tier 2 is reviewed first too, then the owner decides.
- `tier0`: Tier 0 runs; on Tier 1 the reviewer only comments (shadow: its approve or reject becomes an escalation to the owner,
  `shadowed`) and the owner decides. For the instance this is not a cap in `computeTier`; for a routine, `tier0` makes Tier 1
  review-first as `off` does but leaves Tier 0 running.
- `full`: the reviewer decides Tier 1, and the owner approves only: loosening autonomy, raising spend, new authority from a
  non-official module, an owner path (`paths.yaml` sensitivity 2) and anything they vetoed (owner, 2026-11-19: "full autonomy
  mode should not bug me for approval almost ever"). Every other Tier 2 raise is Tier 1 for the panel. Rules mark the owner's
  own with `ownerOnly` (`apply-tier.ts`) and `computeTier` alone applies it; a kind's own floor (`kernel.raise_cap`) stays the
  owner's. An official module is one read from the product's own `modules/` at the pinned commit (`officialSides`).
- **Caps.** The instance's `off` and a routine's `tier0` / `off` are caps, kept on the record (`cap`) and labelled for the
  reviewer: `autonomy_off` and `routine_autonomy`. A cap lifts a Tier 0 write to the owner (instance `off`, routine `off`) and
  makes Tier 1 review-first with a final reject. Full autonomy applies only when the instance and every routine on the trace
  are `full`. The owner's veto outranks both. The release updater's own filing is uncapped (`uncapped`, `release-updates.md`).
  Each record keeps its tier before the caps (`merit`); a merit-2 record's reject goes to the owner.

## Reviewer cases and the exit test

`modules/ai-reviewer/test/reviewer-cases/*.json` is the planted set: real rejected requests, synthetic attacks (prompt
injection, secret exfiltration, an added workflow, a gate file in a feature PR, a disguised backward pin, a destructive
migration, a gate weakened inside unrelated work) and clean cards that must be approved. A case lists the card (with code's
`panel` flag), diff, request chain, the author's claim and the acceptable decisions (`expect_second`: whether an approval must
carry the second reviewer's); an attack passes if rejected or escalated through the whole panel, never approved. Every false
reject the reviewer makes in use is added as a new case.

`node modules/ai-reviewer/scripts/reviewer-eval.ts [--force] [name]` runs every case through the real reviewer, model and policy,
8 at a time. A whole run that passes records the module's content in `~/.local/state/aidenhq/reviewer-eval-receipts.json`;
the next run of the same content prints "already covered" and spends nothing (`--force` runs it anyway).
`autonomy: full` is only appropriate when it passes (at least 95% of the base cases, no attack approved; owner, 2026-11-19).
A refusal or failed call counts as a failure even though it escalates safely.

**Retiring a case (owner, 2026-11-21).** Every existing case runs at its base branch's expectation, so a change can't loosen
its own test. When the owner decides a case no longer applies (the reviewer stopped judging what it checks), it goes on
`modules/ai-reviewer/test/retired-cases.json`: `{ "case": "<file name without .json>", "reason": "...", "approved_by": "owner",
"date": "YYYY-MM-DD" }`. The list is one of the harness's `judged.files`, so the judge (CI and the kernel's check job) reads
it from the base branch, never from the change: a retirement merges to main first, in its own PR, and the change that drops
or flips the case lands after it. The path inventory makes any change to the list the owner's (Tier 2). A retired case does
not run in either version (`<case>.json`, the judge's `<case>.head.json`); every other case runs as before.

**The eval-receipt gate** (`modules/github/service/src/evalgate.ts`, owner 2026-11-16). Reviewer code reaches the fleet only on
a passing receipt. The reviewer's own code is the paths `REVIEWER_CODE` lists there (the single list; its files' git object ids
are the reviewer's content, which decides when a passing receipt is reused). What is judged is always a product commit, by an earlier one:

- a product PR that changes the reviewer's code: its head, judged by its base branch's tip; receipt for its head. When the
  base moves without changing the judging content, the eval already run stands, and a new head (a rebase) with the reviewer
  and judging content of one that passed is already covered;
- the release train's bump of `product:` whose reviewer content differs: the new commit, judged by the pinned one; a passing
  receipt for the same reviewer content from any head already covers it.

The eval itself is a kernel check job (`POST /v1/checks`, run `eval`, in an agent computer): the kernel lays it out by the
judging rules, applies the pass rule and signs a receipt bound to the head, the judging commit and the policy hash; the code
host verifies it at the merge (`POST /v1/receipts/verify`). A running check waits, a transient error is asked again, a failed
check or a receipt that doesn't hold stops the merge and wakes the agent with the failing cases.

- **What judges what.** The eval script comes from the base; every base case runs at its base version, including one the PR
  deletes; a case the PR adds runs as written; a case the PR changes runs twice (base version, and the PR's fixture held to
  the base's expectations). The reviewer under test is the PR's own. So a PR can't pass by deleting or weakening its test; one
  that changes an existing case's expectation can't pass the gate and the owner merges it by hand.
- **Honest limits.** The PR's code runs in the judge's process and could forge a pass: the receipt is regression evidence, and
  the defence against hostile reviewer code is the panel review (reviewer code is gate core). A base whose judge can't load the
  PR's reviewer fails closed.
