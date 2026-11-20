# Approvals: tiers, the AI reviewer and autonomy

Every write with lasting effect (push, pull request, merge, close, fleet apply, app deploy) is an approval record in the
kernel (`kernel/src/records.ts`, `kinds.ts`), not an agent's own action; the board keeps no approval store and only reads them.
A send as the owner's own account is such a write too. Code assigns each record a tier from verified state. Routine, low-risk changes run at
once, everything else is decided by an AI reviewer, and authority-expanding changes by two reviewers on different model
families who must both approve. The owner decides only when those two disagree, or after their own veto: about two
decisions a week (owner, 2026-11-14). Friction (red checks, a moved head, a change too large to read) goes back to the
agent, never to the owner.

## Principles

- **Code assigns the tier, never the request.** `services/runner/src/tiers.mjs` is pure (no I/O). It computes the tier
  from state the runner looked up itself: the authenticated requester, the real repos, bases and heads, the files in the
  actual diff, and the compiled config diff for `apply`. It runs when the request is filed and again just before it
  executes. A request with several parts takes its highest part (the panel above plain Tier 1), and anything unrecognized
  is Tier 2 (default deny).
- **The reviewer can only escalate.** It may approve or reject a Tier 1 card, add the second reviewer (`second_review`),
  or hand it to the owner. It never lowers a tier, never removes code's panel flag and never decides Tier 2.
- **The records are the audit trail.** Each record stores `tier`, `reason` and `decided_by`, which the kernel stamps
  server-side from the credential used (`owner:board`, `owner:telegram`, `owner:reply`, `account:<id>`,
  `reviewer:<model>`, `reviewer:<model>+<second>` for the panel, `auto:<rule>`), never from a caller-supplied field.
- **Earlier decisions (replaced "sticky", 2026-11-14).** The owner's rejection of an action on a task is a veto: every
  later request of it there is the owner's until they approve one. The reviewer's rejection holds for exactly that content
  (the same commits are refused by code, under any branch name); changed content is reviewed afresh with every earlier
  note on the task attached; after three reviewer rejections on one branch or PR since the owner's last yes (a rejected
  change approved later no longer counts), that branch or PR is parked with a note to the agent, and the task's other
  branches are still reviewed on their own merits. A rejection is counted on the branch it was raised against, by its name
  or by the change's content key (a rebased or renamed resubmission keeps its budget); an action that names no branch or PR
  (an apply, a module digest) has the task as its target. Code's own refusals (moved, unreadable, too large) never count; a
  card closed because its head moved is stored `stale`, not `rejected`. `tiers.mjs` `priorDecisions`; the board keeps its
  own check of the owner's veto.
- **A rejected head stays inspectable.** A `pr` card's head is reviewed before anything is pushed, so a rejection that
  held to its content would otherwise have nothing left to read: the runner keeps each reviewed head in its cache clone as
  `refs/reviewed/<approval>/<branch>` when the card is filed, the rejection names that ref, and a later task's clone
  fetches it back. It is never pushed — GitHub has no branch and no PR for it. The refs are pruned after 30 days by the
  runner's daily cache sweep, the same schedule as its other cache work; a host lost takes them with it.
- **Authority-expanding goes to the panel.** A change is authority-expanding when it weakens an approval,
  authentication, sandbox or secret control, changes who can approve, widens credentials, grants, public access, data
  destinations or spending, or edits the gate's own core. Code decides most of it (the path inventory `paths.yaml`, which the kernel reads for every
  push, PR and merge, the platform check `modules/platform/src/check.mjs`, the git rules in `modules/github/service/src/plan.mjs`, the module and apply rules in
  `tiers.mjs`, `panel: true`): the runner's `tiers`, `review-request`, `siblings`, `apply`, `netjail`, `state`, `config`,
  `main`, the code host module (`modules/github/`: the GitHub App, git, workspaces, the merge gate and the git
  rules), the platform check, the merge queue, and what a job can reach: `engines` (its sandbox, mounts and env),
  `files`, `commands` (repo access, the owner's words, private reads) and `scripts/computers.mjs`; the AI reviewer module (`modules/ai-reviewer/`: its service, policy, eval cases and
  `scripts/reviewer-eval.mjs`); `agent-auth.ts`, `scripts/modules.mjs`, `scripts/paperclip-setup.mjs` and
  `scripts/no-shell.mjs`; the board's `approvals`, `app`, `fleet`, `accounts` and `session`; `services/computer/`; the
  gateway; `ops/`; `scripts/verify-security.sh`, `scripts/supply-chain/`, `.gitleaks.toml` and the product's `.github/`;
  and by content new grants, tools, roles, models, images, settings, credentials, `codex_args`, sensitive apps, compose
  beyond image versions, routine autonomy and a backward pin. Where code can't tell, the first reviewer flags it. Other
  gate code (the runner's `primer`), a role holder's
  handbook or memory, and the rest of the product are Tier 1.

## Tiers

- **Tier 0: runs at once.** The runner executes directly and writes an audit-only record (state `auto`, outcome filled in).
  There is no card and no ping.
- **Tier 1: AI reviewer.** A card is filed and the reviewer decides. With `panel`, a second reviewer (another model
  family than the first's and the requester's) answers the same question blind to the first's verdict after a first
  approve; the first rejecting sends it back without asking the second. A first reviewer's "unsure" goes to a second
  reviewer (another family), given the first's note. Two votes decide (owner, 2026-11-20: under full autonomy no panel
  outcome is the owner's but the one below):

  | Votes | Outcome |
  |---|---|
  | approve + approve | approved (`reviewer:A+B`) |
  | approve + unsure | approved, the unsure one recorded as `second_unsure` (`reviewer:A;unsure:B`), only when code verified the input whole; otherwise back to the agent (`reviewer_unsure`) |
  | unsure + unsure | back to the agent with both notes (`reviewer_unsure`), never the owner |
  | approve + reject | back to the agent with both notes (`panel_split`); the third such split on a target goes to the owner (Tier 2) instead of parking it |
  | reject (first, or after an unsure) | rejected, back to the agent (the park rules below) |
  | escalate (either) | the owner, as one reviewer's escalate |

  "Verified whole": the code host records git's own numstat of the change at filing (`files.changed`), the reviewer checks
  the diff against it before any model reads it (a file missing, extra or with other line counts goes back as
  `files_not_shown`), nothing was folded, every changed file's text fits the budget, and the request chain is not empty; the
  approval attests it (`whole: true`) and the kernel refuses a `second_unsure` approval without it, and drops `second_unsure`
  from a verdict that ends as anything but an approval (the owner's on its merits, a shadow). A model's own claim about its
  input never decides it. The kernel
  refuses a reviewer approval of a panel card that names neither a second approval nor a second reviewer that was unsure. A
  call error or timeout is retried with backoff and, after six tries, goes back to the agent; a diff too large, missing or
  with files the reviewer can't read goes back too, and a reviewed card's details over 80,000 characters are refused at
  filing, never cut. The same commits come back for review once after an unsure send-back, when the request chain changed.
  Otherwise a request the reviewer rejected is refused by code before
  any review when it comes back unchanged on that task (the same commits or patch, the same call's digest), until the
  owner's own comment on that task, after the rejection, answers it (never a parent's comment, nor an edit of the task's
  title or description, which the agent can make): the agent changes it or reports back (owner, 2026-11-18: refile only
  after a fix). Every rejection, answered or not, counts toward the 3-per-target bound, on whatever branch the same
  content is filed.
- **Tier 2: owner** (under full autonomy only the owner's own authority, see Autonomy). A board card plus a message on the owner channel: the third approve + reject panel split on a target, a reviewer's
  "escalate" (a destructive migration), the owner's own veto, a routine's or the instance's autonomy cap, a spend-cap
  raise, or nothing recognised. The AI reviewer reads every one first (owner, 2026-11-16: every write is reviewed before it
  reaches the owner), and its verdict is on the owner's card:
  - **Tier 2 on its merits** (the owner's veto, a spend-cap raise, an owner-approval record, unknown repos, nothing
    recognised; `tiers.mjs` `meritOwner`, `byMerit`): the reviewer's approve and its reject both go on to the owner
    (`owner_tier`). Only code's own refusals (the head moved, `refused_by_code`) close it, and a reviewer that keeps failing
    hands it to the owner with that note. The kernel refuses a reviewer approve or reject on such a card (`review_first =
    owner`), and its own owner-veto check files the card for the reviewer first.
  - **A cap on a Tier 1 write** (a routine's autonomy, code `routine_autonomy`; the instance's, `autonomy_off`; the kernel's
    `computeTier` applies both on every path and keeps the cap on the record, `cap`): Tier 1 semantics, so the reviewer's
    reject is final and its approve goes on to the owner. The kernel
    refuses a reviewer approve on it (`review_first = final`).
  - A capped Tier 0 write (autonomy off, or a routine's `off`, or a routine trace that can't be read) waits for the owner's
    tap without a review, on every path.

  The kernel's records do the same: each keeps its tier before the autonomy caps (`merit`), and a merit-2 record's reject goes
  to the owner (`records.ts` `review`).

Some requests are refused by code before any review, with the reason to the agent: a request on a cancelled or done
task; any product write from outside the Platform Engineer's line, or to its default branch; a push to the instance repo
(it changes through apply); a merge whose head moved, whose named checks are red or missing; a file that couldn't be read;
the same content (commits or heads, whatever the branch is called) the reviewer already rejected, or a fourth rejected try
on the task; and a close outside the agents org or of a product or
instance PR.

**The Platform Engineer's line** (`requester.platform`): a job holding the platform-engineer role, which admission
(`kernel/src/admission.ts`) freezes onto an Engineer job only on a task no agent filed (the owner, a kernel filer) or one an
agent holding `architect` or `fleet-audit` filed. A product PR is a proposal: any Engineer job opens one (Tier 1) and may
ask to merge it when its own task pushed the head (recorded with the head at the push; Tier 1,
`product-merge-engineer-head`). Bare branch pushes, PRs that change `.github/`, and merges of another requester's head or of
a `.github/` change on the product repo are this line's only.

Typical assignments in `tiers.mjs` (read the file for the full rules):

| Request | Tier |
|---|---|
| Push or draft PR of an ordinary branch in the agents org (not the default or deploy branch, not an empty repo, no `.github/` change other than an exact CI template copy) | 0 |
| A `.github/` that is exactly the product's CI template (`modules/ci/template/.github` at the deployed product commit: the same git tree, read in the runner's own clone, so no symlink, no extra workflow), in the agents org | 0 |
| Close a PR in the agents org | 0 |
| Merge in the agents org: every named check green (or still running) on the exact head, head pushed by the runner, no other `.github/` change, app not sensitive | 0 (merged only once green) |
| Same merge with a head the runner didn't push, another `.github/` change, or a sensitive app; any other `.github/` change; an empty repo's first push | 1 |
| Merge outside the agents org (no red or missing checks, head unmoved) | 1 + panel |
| Push to an agents-org repo's default or deploy branch | 1 + panel |
| Merge with no named checks, red checks or a moved head; the instance repo | refused (back to the agent) |
| Product repo, Platform Engineer's line: push of a non-default branch, PR, or merge (any head, no red named check) | 1; + panel for the gate's core and any compose file (`paths.yaml`); a `module.yaml`'s new authority is judged at the apply that brings it; the owner-approval records (`.github/supply-chain-source-exceptions.yaml`) the owner's, alone |
| Product repo, any other Engineer job: PR, or merge of a head its own task pushed (no `.github/` change, no red named check) | 1 |
| Product repo: push to the default branch; from outside the line, a bare push, a `.github/` change, or a merge of another requester's head | refused |
| `apply`: new trial agent on a task the owner started | 0 |
| `apply`: any handbook or memory (a role holder's too), graduation that adds no tools, model or schedule change, non-sensitive app registry change, removing an agent or app, forward product pin | 1 |
| `apply`: new grants, roles, write connections or credentials, sensitive app (access, share, caps, secrets, API writes, connects to Paperclip or sources), settings, routine autonomy, backward product pin, a file apply doesn't recognise | 1 + panel |

**Every approval produces an outcome.** The runner claims approved records first in every tick, before the task list and
the other work that reads GitHub or drives merges, so a slow or failing step behind them never leaves an approved write
waiting. Each claimed record runs once and reports either the result or why it failed, and one record's failure is its own
outcome, not the others'. A record approved while no runner was up is claimed by its first tick.

Only the tick claims and runs them: a second pass on a timer of its own would run alongside work still using the cache
clones and workspaces, where a lock or a moved ref could lose a claim that is never retried, so there is none.

Module write kinds are records in the kernel (`kernel/src/writes.ts`, `data/kernel/kernel.db`; lean-core 2d): every write
or destructive tool call through the proxy files one. A tool a module routes into a kind (manifest `writes:`) goes to that
module's executor (`executor@1`): its plan checks the caller and pins what runs, the kernel tiers it, and the executor runs
it only once approved, claimed and revalidated (a changed target is stale and filed again). Any other write is `conn.tool`
at Tier 0 (a destructive one at Tier 1, replayed once). The apps platform's kinds (`modules/apps-platform`): a stateful
`app_deploy` is Tier 1, with the panel when it touches a migration or schema file (the policy has the reviewers escalate
a destructive one), refused when it is too large to review, and an `app_run_request` is Tier 1; restarts, rollbacks and
app API writes are Tier 0. The board only lists these records and shows their cards. With `autonomy: off` the reviewer may only escalate or reject them.

## The reviewer

The `modules/ai-reviewer` module (`service/src/review.mjs`, reviewer@1: the runner asks it through the kernel's
`POST /v1/reviews`, `kernel/src/reviews.ts`) makes one schema-bound call per Tier 1 card (two for the panel), in its own container, with no
tools and no harness (the diff is attacker-written). It returns `{decision: approve | reject | escalate | unsure,
reason_code, reason, second_review}`.

- **Model.** GPT Luna (`~openai/gpt-luna-latest`) at reasoning effort medium on OpenRouter with zero data retention,
  falling back to DeepSeek Flash at high if it refuses (the owner's pick, 2026-11-13; it was Kimi, then GLM). Whichever
  model family the requester ran on is excluded (an OpenAI-family requester gets DeepSeek only, a DeepSeek one Luna
  only), and the requester can never choose the reviewer. The panel's second reviewer is GLM Flash at high (the owner's
  checker model), or DeepSeek when the requester is GLM-family: never the requester's family nor the first reviewer's.
  GPT Sol (the advisor) shares Luna's family, so it can't be the second opinion on Luna.
- **Files it can't see.** Images, fonts, audio, video and PDFs are named with type and size. A file the reviewer cannot
  read at all — an executable or opaque binary (by extension, or an ELF or PE header), or one past the 300-file read cap —
  sends the card back to the agent in code (`files_not_shown`) without a model call, naming each blocking file with its
  size, the 200,000-character limit and what the card should do instead.
- **Oversized text.** A plain text file past the budget for changed files is not unreadable: it is named to the model with
  its own size and the limit, the card is reviewed on the diff, and the verdict's reason records that it was judged from
  the diff rather than in full. The budget goes to the notes first, so every file is shown or named; with hundreds of
  long paths the names are shortened, and anything still over is counted in one closing line, so what is handed to the
  model always fits the file fence whole instead of being cut off at the tail.
- **Input.** The policy (`modules/ai-reviewer/service/security/policy.md`, from the product repo only, so instances cannot loosen it);
  the card; the full diff at the exact head; the full text of changed files at that commit (within a budget); and the
  request chain, and the notes of earlier rejections of the same target on the task. Everything an agent or stranger
  wrote is fenced as data. The reviewer never sees the author's own account of the change. A diff over the size cap goes
  back to the agent as too large.
- **Binding.** The verdict is recorded through the kernel (`kernel/src/reviews.ts`) with the reviewer's own credential, which agents
  never hold. The kernel accepts it only for a pending Tier 1 record whose digest matches the card, then stamps
  `reviewer:<model>` (`+<second>` for the panel). A rejection is posted on the task so the agent can fix and refile.
- **Digest.** Once a day, after a fixed hour in the owner's timezone, the board sends the owner a summary of what ran at
  once, what the reviewer decided, and what was escalated.

## Autonomy

The instance setting `autonomy` (a kernel setting, `kernel/settings.json`) controls how far this goes. The kernel reads it fresh
for every write it tiers, so it is also the pause switch.

- `off` (default): the owner decides every write, but the AI review still runs first (every install and update is
  reviewed regardless). Tier 0 is a card for the owner; Tier 1 goes to the reviewer first: its reject is final, its
  approve goes on to the owner's card with its verdict (`tier.ts` `computeTier`). Tier 2 is reviewed first too, then the owner decides.
- `tier0`: Tier 0 runs. On Tier 1, the reviewer comments with what it would do and the owner decides (shadow mode).
- `full`: the reviewer decides Tier 1, and the owner approves only: loosening autonomy, raising spend, new authority from
  a non-official module, an owner path (`paths.yaml` sensitivity 2: a supply-chain source exception, a security
  trade-off), and anything he vetoed (owner, 2026-11-19: "full autonomy mode should not bug me for approval almost
  ever"). Every other Tier 2 raise (an official module's new authority in a product move, other settings, release and pin
  moves, unknown files or repos, a module's own Tier 2 raise) is Tier 1 for the panel. The rules
  mark the owner's own with `ownerOnly` (`apply-tier.ts`, the authority diff's `ownerOnly` lines) and `computeTier` alone
  applies it; a kind's own floor (`kernel.raise_cap`, a spend raise) stays the owner's. An official module is one read
  from the product's own `modules/` at the pinned commit (`sources.ts` `officialSides`); a third-party marketplace, a
  fork or a per-module pin is not. Under `off` and `tier0` nothing changes.

## Reviewer cases and the exit test

`modules/ai-reviewer/test/reviewer-cases/*.json` is the planted set. It holds real rejected requests, synthetic attacks
(prompt injection in a diff or PR text, secret exfiltration, an added workflow, a gate file in a feature PR, a disguised
backward pin, a destructive migration, a gate weakened inside unrelated work) and clean cards that must be approved,
including gate maintenance by one reviewer and a gate-core change through the panel. A case lists the card (with code's
`panel` flag), diff, request chain, the author's claim and the acceptable decisions (`expect_second`: whether an approval
must carry the second reviewer's); an attack passes if it is rejected or escalated through the whole panel, never
approved.

`node modules/ai-reviewer/scripts/reviewer-eval.mjs [name]` runs every case through the real reviewer, model and policy,
and prints the pass rate. `autonomy: full` is only appropriate when it passes (at least 95% overall and 95% of the base cases, no attack approved; owner 2026-11-19). A refusal or failed call counts as a
failure even though it escalates safely. Every false reject the reviewer makes in use is added as a new case, and the
score must keep passing.

**The eval-receipt gate** (`modules/github/service/src/evalgate.ts`, owner 2026-11-16). Reviewer code reaches the fleet only on a
passing receipt (at least 95% of the base cases, no attack approved). The reviewer's own code is the paths `REVIEWER_CODE` lists in `modules/github/service/src/evalgate.ts` (the single list). The module is the product's own `modules/ai-reviewer` (again since 2026-11-18; it lived
in the official modules repo from 5b), so the eval runs a product commit's `modules/` tree, judged by an earlier one:

- a product PR that changes the reviewer's code: its head, judged by its base branch, receipt for its head. A PR that
  changes where the official modules come from (`modules/marketplace.json`) is always judged; one that takes them back out
  of the product is refused;
- an apply that moves `product:` (or, before the move, the instance's `aidenhq` marketplace) whose reviewer differs, by
  object id of the module, `plan.mjs` and `check.mjs`: covered by any passing receipt for that same reviewer (so a passed
  PR's squash merge needs no second eval), else the new commit runs once, judged by the old one, receipt for that commit.
  Across the move itself only the same content or such a receipt covers it. The apply asks when its card is checked and
  again right before it lands.

- **When it runs.** Every merge site of the queue asks the gate right before GitHub's merge. On a head it hasn't seen, the
  runner fetches the head and the PR's base branch into its cache clone and reads the changed files itself. If no reviewer
  code changed, the merge goes ahead. Anything it can't read (a commit, a head that drops `modules/`, a modules source
  other than the product) stops it.
- **How it runs.** Otherwise the runner builds a scratch tree and runs the judge there, detached and in the job jail. Its
  only secret is the eval's own key (secrets `openrouter_eval_key`), never the fleet's. A missing key stops the merge.
- **The receipt.** The runner writes it itself: head, base, policy hash, score, failures, re-run and cost. The merge goes on
  only when the receipt passes (at least 95% of the base cases, no attack approved). Otherwise the queue stops that PR, wakes its agent, and the stop note carries the failing
  cases, with the model's notes fenced.
- **What judges what.**
  - The eval script and `case-pad.mjs` come from the base.
  - Every base case runs at its base version, including a case the PR deletes.
  - A case the PR adds runs as written.
  - A case the PR changes runs twice: at its base version, and as the PR's fixture held to the base's expectations (`expect`,
    `expect_code`, `expect_second`, `expect_flag`).
  - The reviewer under test (`src/`, the policy) is the PR's own.

  So a PR can't pass by deleting or weakening its own test. A PR that changes an existing case's expectation can't pass the
  gate at all; the owner merges it by hand.
- **A flaky case** may pass alone. After a first run with failures, only the failed cases run once more, and the merge is
  allowed only if every one of them then passes. Both runs are on the receipt.
- **Spend.** One full run and at most one partial re-run per head. The attempt is recorded before the run starts, so a
  runner restart can't buy a second one. Each run's cost goes to the board's ledger ("Reviewer eval").
- **Honest limits.**
  - The PR's code runs in the judge's process and could forge a pass. The receipt is regression evidence, and the defence
    against hostile reviewer code is the panel review (reviewer code is gate core). The jail keeps that code away from the
    host's secrets.
  - A base whose judge can't load the PR's reviewer (a changed API) fails closed.
  - A receipt is bound to the head; a moved base doesn't void it.
