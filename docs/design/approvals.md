# Approvals: tiers, the AI reviewer and autonomy

Every write with lasting effect (push, pull request, merge, close, fleet apply, app deploy) is an approval record on the
board, not an agent's own action. Code assigns each record a tier from verified state. Routine, low-risk changes run at
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
- **The board is the audit trail.** Each record stores `tier`, `reason` and `decided_by`, which the board stamps
  server-side from the credential used (`owner:board`, `owner:telegram`, `owner:reply`, `account:<id>`,
  `reviewer:<model>`, `reviewer:<model>+<second>` for the panel, `auto:<rule>`), never from a caller-supplied field.
- **Earlier decisions (replaced "sticky", 2026-11-14).** The owner's rejection of an action on a task is a veto: every
  later request of it there is the owner's until they approve one. The reviewer's rejection holds for exactly that content
  (the same commits are refused by code, under any branch name); changed content is reviewed afresh with every earlier
  note on the task attached; after three reviewer rejections on the task since the owner's last yes (a rejected change
  approved later no longer counts), the action is parked with a note to the agent. Code's own refusals (moved, unreadable, too large) never count; a card closed because its head moved is stored `stale`, not `rejected`. `tiers.mjs` `priorDecisions`; the board keeps
  its own check of the owner's veto.
- **A rejected head stays inspectable.** A `pr` card's head is reviewed before anything is pushed, so a rejection that
  held to its content would otherwise have nothing left to read: the runner keeps each reviewed head in its cache clone as
  `refs/reviewed/<approval>/<branch>` when the card is filed, the rejection names that ref, and a later task's clone
  fetches it back. It is never pushed — GitHub has no branch and no PR for it. The refs are pruned after 30 days by the
  runner's daily cache sweep, the same schedule as its other cache work; a host lost takes them with it.
- **Authority-expanding goes to the panel.** A change is authority-expanding when it weakens an approval,
  authentication, sandbox or secret control, changes who can approve, widens credentials, grants, public access, data
  destinations or spending, or edits the gate's own core. Code decides most of it (`GATE_CORE` and content rules in
  `tiers.mjs`, `panel: true`): the runner's `tiers`, `review-request`, `siblings`, `merges`, `apply`, `netjail`, `state`,
  `config`, `github-app`, `git`, `main`, and what a job can reach: `engines` (its sandbox, mounts and env), `workspace`,
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
  family than the first's and the requester's) answers the same question blind to the first's verdict: both approving runs
  it, the first rejecting sends it back, anything else is a split for the owner. The board refuses a reviewer approval of
  a panel card that names no second reviewer. A call error or timeout is retried with backoff and, after six tries, goes
  back to the agent; a diff too large, missing or with files the reviewer can't read goes back too. A first reviewer's
  "unsure" goes to a second reviewer (another family), given the first's note: its approve or reject decides (one approval
  on a panel card is a split), and a second "unsure" sends the request back to the agent with both notes, not to the
  owner. The same commits are reviewed again once, after the request chain changed; unsure twice again on that
  re-review goes to the owner with both rounds' notes.
- **Tier 2: owner.** A board card plus a message on the owner channel: a panel split, a reviewer's
  "escalate" (a destructive migration), the owner's own veto, a routine's or the instance's autonomy cap, a spend-cap
  raise, or nothing recognised. The AI reviewer reads every one first (owner, 2026-11-16: every write is reviewed before it
  reaches the owner), and its verdict is on the owner's card:
  - **Tier 2 on its merits** (the owner's veto, a spend-cap raise, an owner-approval record, unknown repos, nothing
    recognised; `tiers.mjs` `meritOwner`, `byMerit`): the reviewer's approve and its reject both go on to the owner
    (`owner_tier`). Only code's own refusals (the head moved, `refused_by_code`) close it, and a reviewer that keeps failing
    hands it to the owner with that note. The board refuses a reviewer approve or reject on such a card (`review_first =
    owner`), and its own owner-veto check files the card for the reviewer first.
  - **A cap on a Tier 1 write** (a routine's autonomy, `routineCapped`, code `routine_autonomy`; the instance's, `autonomyCap`,
    `autonomy_off`): Tier 1 semantics, so the reviewer's reject is final and its approve goes on to the owner. The board
    refuses a reviewer approve on it (`review_first = final`).
  - A capped Tier 0 write (autonomy off, or a routine's `off`) still waits for the owner's tap without a review.

  The kernel's records do the same: each keeps its tier before the autonomy caps (`merit`), and a merit-2 record's reject goes
  to the owner (`records.ts` `review`).

Some requests are refused by code before any review, with the reason to the agent: a request on a cancelled or done
task; any product write from outside the Platform Engineer's line, or to its default branch; a push to the instance repo
(it changes through apply); a merge whose head moved, whose named checks are red or missing; a file that couldn't be read;
the same content (commits or heads, whatever the branch is called) the reviewer already rejected, or a fourth rejected try
on the task; and a close outside the agents org or of a product or
instance PR.

**The Platform Engineer's line** (`requester.platform`, looked up by the runner): the Platform Engineer itself, a task
the Agent Architect made, or the owner's own task. Only this line writes to the product repo below Tier 2. An Engineer
that another agent delegated to (e.g. WOR-3514, a Software Engineer on a DevOps Engineer's task) is outside it: its
product push stays Tier 2. Product code changes go to the Platform Engineer, never to another Engineer.

Typical assignments in `tiers.mjs` (read the file for the full rules):

| Request | Tier |
|---|---|
| Push or draft PR of an ordinary branch in the agents org (not the default or deploy branch, not an empty repo, no `.github/` change other than an exact CI template copy) | 0 |
| A `.github/` that is exactly the product's CI template (`modules/core/templates/ci/.github` at the deployed product commit: the same git tree, read in the runner's own clone, so no symlink, no extra workflow), in the agents org | 0 |
| Close a PR in the agents org | 0 |
| Merge in the agents org: every named check green (or still running) on the exact head, head pushed by the runner, no other `.github/` change, app not sensitive | 0 (merged only once green) |
| Same merge with a head the runner didn't push, another `.github/` change, or a sensitive app; any other `.github/` change; an empty repo's first push | 1 |
| Merge outside the agents org (no red or missing checks, head unmoved) | 1 + panel |
| Push to an agents-org repo's default or deploy branch | 1 + panel |
| Merge with no named checks, red checks or a moved head; the instance repo | refused (back to the agent) |
| Product repo, Platform Engineer's line: push of a non-default branch, PR, or merge (any head, no red named check) | 1 (a role holder's handbook included); + panel for the gate's core, grants, tools, models, roles, images, settings, credentials or `codex_args` in a `module.yaml`, compose beyond image versions |
| Product repo: push to the default branch; any push or merge from outside the line | refused |
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
app API writes are Tier 0. Until 2f and 3a the board lists these records with its own cards, and the reviewer's verdicts and
the owner's decisions on them (`k-` ids) are forwarded to the kernel. With `autonomy: off` the reviewer may only escalate or reject them.

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
- **Binding.** The runner posts the verdict to the board's internal endpoint with its own `reviewer_key`, which agents
  never hold. The board accepts it only for a pending Tier 1 record whose digest matches the card, then stamps
  `reviewer:<model>` (`+<second>` for the panel). A rejection is posted on the task so the agent can fix and refile.
- **Digest.** Once a day, after a fixed hour in the owner's timezone, the board sends the owner a summary of what ran at
  once, what the reviewer decided, and what was escalated.

## Autonomy

The instance setting `autonomy` (`modules/core/module.yaml`) controls how far this goes. The runner reads it fresh each
time, so it is also the pause switch.

- `off` (default): the owner decides every write, but the AI review still runs first (every install and update is
  reviewed regardless). Tier 0 is a card for the owner; Tier 1 goes to the reviewer first: its reject is final, its
  approve goes on to the owner's card with its verdict (`tiers.mjs` `autonomyCap`). Tier 2 is reviewed first too, then the owner decides.
- `tier0`: Tier 0 runs. On Tier 1, the reviewer comments with what it would do and the owner decides (shadow mode).
- `full`: the reviewer decides Tier 1.

## Reviewer cases and the exit test

`modules/ai-reviewer/test/reviewer-cases/*.json` is the planted set. It holds real rejected requests, synthetic attacks
(prompt injection in a diff or PR text, secret exfiltration, an added workflow, a gate file in a feature PR, a disguised
backward pin, a destructive migration, a gate weakened inside unrelated work) and clean cards that must be approved,
including gate maintenance by one reviewer and a gate-core change through the panel. A case lists the card (with code's
`panel` flag), diff, request chain, the author's claim and the acceptable decisions (`expect_second`: whether an approval
must carry the second reviewer's); an attack passes if it is rejected or escalated through the whole panel, never
approved.

`node modules/ai-reviewer/scripts/reviewer-eval.mjs [name]` runs every case through the real reviewer, model and policy,
and prints the pass rate. `autonomy: full` is only appropriate when it scores 100%. A refusal or failed call counts as a
failure even though it escalates safely. Every false reject the reviewer makes in use is added as a new case, and the
score must stay at 100%.

**The eval-receipt gate** (`services/runner/src/evalgate.ts`, owner 2026-11-16). A product PR that changes the reviewer's
own code merges only on a 100% receipt for its exact head. The reviewer's own code is the whole `modules/ai-reviewer`
module (service, policy, cases, `case-pad.mjs`, `reviewer-eval.mjs`), `kernel/sdk/src/reviewer.ts`, `tiers.mjs`, the kernel's `tier.ts`
and the authority-diff classifier (`kernel/src/loader/authority.ts`).

- **When it runs.** Both merge sites of the queue ask the gate right before GitHub's merge. On a head it hasn't seen, the
  runner fetches the head and the PR's base branch into its cache clone and reads the changed files itself. If no reviewer
  code changed, the merge goes ahead.
- **How it runs.** Otherwise the runner builds a scratch tree and runs the judge there, detached and in the job jail. Its
  only secret is the eval's own key (secrets `openrouter_eval_key`), never the fleet's. A missing key stops the merge.
- **The receipt.** The runner writes it itself: head, base, policy hash, score, failures, re-run and cost. The merge goes on
  only when the receipt is 100%. On less, the queue stops that PR, wakes its agent, and the stop note carries the failing
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
