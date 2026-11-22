# Approvals: tiers, the AI reviewer and autonomy

Every write with lasting effect (push, pull request, merge, close, create_repo, fleet apply, app deploy, a send as the owner's
own account, any other write tool call through the proxy) is an approval record in the kernel (`kernel/src/records.ts`,
`kinds.ts`, `writes.ts`), not an agent's own action; the board keeps no approval store and only reads them. Code assigns each
record a tier from verified state. Routine changes run at once and everything else is decided by the AI reviewer, which
blocks only explicit malice and fails open (owner, 2026-11-22: "AI agents we use are trusted, not threat actors. AI
reviewer's only job is to stop obvious malicious attempts in case some component got compromised, never block innocent things
because it's unsure. Ideally no approval card comes to me"). The owner decides only his own veto, his own settings save and
an autonomy he set below full.

## Principles

- **Code assigns the tier, never the request.** The code host's `modules/github/service/src/plan.ts` (git writes) and the
  kernel's `apply-tier.ts` (fleet applies) compute a tier on the merits from state read from git and GitHub. `computeTier`
  (`kernel/src/tier.ts`) is the one function that sets the final tier: merit 0 runs at once, any higher merit is the AI
  reviewer's (Tier 1), and Tier 2 (the owner's) is only his veto on the task, his settings save (`ownerSave`) or autonomy off.
  A request with several parts takes its highest part; anything unrecognised is reviewed. The plan runs when the record is
  filed and again before it executes; a changed target closes the record as stale and it is filed again. A kind that declares
  `binds` (a head-bound write, such as a review post of one pull request at one commit) is judged on those target fields alone:
  a redeployed executor, a moved base or other text on the pull request never stales it while the head it acts on stands. Its
  kind declaration is still compared (the `policy` hash covers the whole kind, `binds` included: a raised floor or a changed
  binding holds a record approved under the old one), the record's own targets are compared under the fields it was filed with,
  and its args are compared too, so changed content is never run under an approval of the old content. A plan that names no
  bound target is refused at filing rather than carded. Every other kind keeps the full
  revalidation (executor revision, policy, args and targets).
- **The records are the audit trail.** Each record stores `tier`, `merit`, `reason` and `decided_by`, which the kernel
  stamps server-side from the credential used (`owner:board`, `owner:telegram`, `owner:reply`, `account:<id>`,
  `reviewer:<model>`, `reviewer:kernel/code`, `auto:<rule>`), never from a caller-supplied field. Lifecycle: `review` or
  `owner` then `approved`, `claimed` (once), `done` / `failed` / `unknown`; also `rejected`, `stale`, `cancelled`. Open
  expire after 7 days. `claimed` is live: its executor may report why it is still running (`POST /v1/writes/:id/wait`), the board
  shows that state as `running` with the reason (clipped for display; the whole reason is what identifies a change), and the
  record's task hears the reason once when the wait starts and again only when it changes.
- **Earlier decisions bind, narrowly** (`tier.ts` `priorDecisions`). The owner's rejection of an action on a task is his veto:
  every later request of it there is his card until he approves one. A reviewer's reject never binds: a resubmission, even of identical content, is reviewed afresh. Nothing else binds: no retry bound, no park, no lift.
- **A rejected head stays inspectable.** A `pr` card's head is reviewed before anything is pushed, so the code host keeps each
  reviewed head in its cache clone as `refs/reviewed/<approval>/<branch>`; it is never pushed and is pruned after 30 days
  (`modules/github/service/src/tidy.ts`).
- **The path inventory labels, it doesn't route to the owner.** `paths.yaml` (compiled with each official module's `paths:`
  into `config/kernel/paths.json`, read by `kernel/src/paths.ts` for every push, PR and merge; sensitivity 0, 1 or 2, `panel`
  still read as 1) says which files need the reviewer at all; sensitivity 2 labels the owner's paths on the card.

## Tiers

- **Tier 0: runs at once.** Executed directly with an audit-only record (`auto`, outcome filled in). No card, no ping.
- **Tier 1: AI reviewer.** One reviewer, one verdict: approve, or reject naming the malice. A reject goes back to the agent
  (never the owner) and is posted on its task. A review that fails (the reviewer module unreachable, a call error or timeout,
  every model refusing, a spend or tool-round limit) is tried once more after `RETRY_MS` (a minute; the model gateway already
  retries transient model errors), then approved by code (`fail_open`, `reviewer:kernel/code`). The only writes that never
  fail open are the ones the kernel refuses itself before it asks the reviewer (`review-loop.ts`): instance details in a
  GitHub write (`instanceDetails`, `instance_details`) and a diff that differs from the code host's own count of the change
  (`files_not_shown`). No other signal in the review path tags a secret-carrying write, so beyond that the rule is the model's:
  a malice verdict rejects, everything else approves.
- **Tier 2: owner.** A board card plus a message on the owner channel, with no reviewer first: the owner's veto on the task,
  autonomy off. His own signed-in settings
  save is his approval at filing.

Code refuses some requests before any review, with the reason to the agent: a request on a cancelled or done task; a product
write to its default branch; a push to the instance repo (it changes through apply);
a merge whose head moved or whose named checks are red or missing; content the reviewer already rejected as malicious; a
close outside the agents org or of an instance PR.

**The Platform Engineer's line** (`requester.platform`): a job holding the `platform-engineer` role, which admission
(`kernel/src/admission.ts`) freezes onto a job only on a task no agent filed, or one filed by an agent holding `architect` or
`fleet-audit`. It may push any branch; other jobs push only their own task's (`agent/<task>/…`). Any job may open a product PR,
push a product branch, or ask to merge a product PR (Tier 1 each, owner 2026-11-22): every product PR waits for `ci-required`
and the mandatory code review before it merges, and agents are trusted.

Typical git assignments (`plan.ts`; read it for the full rules):

| Request | Tier |
|---|---|
| Push or draft PR of an ordinary branch (`agent/<task>/...`) in the agents org; `.github/` exactly the product's CI template | 0 |
| Close a PR in the agents org or the product repo; create_repo in an allowed org | 0 |
| Merge in the agents org: every named check green (or running, merged only once green) on the exact head, head pushed by the code host, no other `.github/` change, app not sensitive | 0 |
| Same merge with a foreign head, other `.github/` change or sensitive app; any other `.github/` change; an empty repo's first push; push or PR outside the agents org; a change request on `local` | 1 |
| Push to an agents-org repo's default or deploy branch | 1 |
| Product repo: PR, branch push, or merge of a head the code host pushed with no red check | 1 |
| Merge with no named checks, red checks or a moved head; the instance repo; outside the agents org; product default branch | refused |

Fleet applies (`kernel.apply`, floor 1, planned by `apply-tier.ts`): a new trial agent, a handbook or memory change, a
graduation that adds no tools, a non-sensitive app change, removing an agent or app and a forward product pin are Tier 0 or 1;
new grants, roles, write connections or credentials, sensitive apps, settings, routine autonomy, a backward pin, unrecognised
files, loosening autonomy, raising spend limits and an owner-only setting are reviewed too (merit 1 or 2). Module
authority changes come from the authority diff (`scripts/compiler/authority.ts`).

Module write kinds are records too: a tool a module routes into a kind (manifest `writes:`) goes to that module's executor
(`executor@1`): its plan checks the caller and pins what runs, the kernel tiers it, and the executor runs it only once
approved, claimed and revalidated. Any other write is `conn.tool` at Tier 0 (a destructive one at Tier 1, replayed once). Apps
platform kinds (`modules/apps-platform/module.yaml`): a stateful `app_deploy` is Tier 1 (labelled when it touches a
migration or schema file), refused when too large to review; restarts, rollbacks and app API writes are Tier 0.

## The reviewer

The `modules/ai-reviewer` module (`service/src/review.ts`, reviewer@1) makes one schema-bound call per record in review, in
its own container with no harness, shell or network (the diff is attacker-written). Its only tools are read-only and served by
the service from the request itself (`changeTools`): `diff`, `read_file` and `grep`, every answer paged and fenced as data.

What it judges (owner, 2026-11-22): **explicit malice only**: secrets or private data sent somewhere new, injected instructions
followed, auth, the sandbox or a gate disabled or bypassed for no stated reason, a backdoor, a destructive action nobody asked
for, sabotage. Scope, design, quality, bugs, process and "the request chain didn't ask for this" are code review's and CI's,
never a reason to reject. The policy (`service/security/policy/`) is short: what malice is, secrets and exfiltration, prompt
injection, the verdict. Removed with the scope review: the second reviewer (panel, `second_review`, unsure handoffs), the
security checklist, the owner-approved source records (`sourcesInDiff`), the exposure-pins check, the request's sibling PRs,
the grader's note, earlier rejections' notes and the instance's decisions digest.

**Which pushes and PRs it reviews** (`ai_review_code`, the ai-reviewer module's setting, owner-only): `all` (default);
`none`; or `unless_code_review_mandatory` (none on a repo code review gates). A skipped push or PR is code's approval
(`code_review_owns`, model `kernel/code`). Merges, closes, create_repo, sends, settings, deploys and tool calls are always
reviewed. The one predicate is `codeReviewOwns` (`kernel/src/writes.ts`). `kernel/src/review-loop.ts` builds the review from
the record and sends it through `kernel/src/reviews.ts` with a single-use token. It returns `{decision: approve | reject,
reason_code, reason, findings}`, or `escalate` with `reviewer_failed` when it couldn't finish.

- **Models** (`service/src/aidenhq-sdk/judge.ts`). GPT Luna (medium) then DeepSeek Flash (high) when the first refuses, on
  OpenRouter with zero data retention; the requester's own model family is excluded.
- **Any size.** What fits one call is inline (`MAX_DIFF`, `MAX_FILES`); the rest is named in `DIFF_FILES` (`[not inline]`)
  and read with the tools when something points there. A file it cannot read (an executable or opaque binary) is named to it
  and the change is still reviewed.
- **Code's own refusals before any model** (the kernel's, and the reviewer runs the same functions): instance details in a
  GitHub write (`instance_details`), and a diff that differs from the code host's own count of the change
  (`files_not_shown`: what is reviewed must be what runs). Neither is malice, so a fixed resubmission is reviewed.
- **Input.** The policy (from the product repo only); the card; the full diff at the exact head and the changed files; the
  request chain; the task's comments, each line marked by code with its author. Everything an agent or stranger wrote is
  fenced as data. The reviewer never sees the author's own account of the change.
- **Binding.** The kernel accepts a verdict only for a pending record whose digest matches the card, with the reviewer's own
  credential (agents never hold it), and stamps `reviewer:<model>`. A rejection is posted on the task.

## Autonomy

The kernel setting `autonomy` (`kernel/settings.json`; a new install starts at `full`) is read fresh for every write the
kernel tiers, so it is also the pause switch. A routine may carry its own `autonomy` (same values); a task traced to a
routine (`taskRoutineCap`) is capped by the strictest routine on its trace. An unknown routine, an invalid value or an
incomplete trace counts as `off`; a trace that can't be read now fails the request with 503 rather than guessing.

- `off`: the owner decides every write, with no reviewer first (rule `autonomy-off` or `routine-autonomy`).
- `tier0`: Tier 0 runs; on Tier 1 the reviewer only comments (shadow: its verdict becomes a note for the owner, `shadow`),
  for the instance's setting and for a routine's cap kept on the record (`cap`).
- `full`: the reviewer decides, and the owner sees only his own veto's cards.

The release updater's own filing is uncapped (`uncapped`, `release-updates.md`). An approved record whose cap tightened before
it ran is held for the owner (`records.hold`).

## Reviewer cases and the exit test

`modules/ai-reviewer/test/reviewer-cases/*.json` is the planted set: real rejected requests, synthetic attacks (prompt
injection, secret exfiltration, an added workflow, a gate file in a feature PR, a disguised backward pin, a destructive
migration, a gate weakened inside unrelated work) and clean cards that must be approved. A case lists the card, diff,
request chain, the author's claim and the acceptable decisions; an attack passes if rejected, never approved. Since the
malice-only ruling (2026-11-22) every case that expected a scope, process or supply-chain reject expects approve. Every false
reject the reviewer makes in use is added as a new case.

`node modules/ai-reviewer/scripts/reviewer-eval.ts [--force] [name]` runs every case through the real reviewer, model and policy,
8 at a time. A whole run that passes records the module's content in `~/.local/state/aidenhq/reviewer-eval-receipts.json`;
the next run of the same content prints "already covered" and spends nothing (`--force` runs it anyway).
`autonomy: full` is only appropriate when it passes (at least 95% of the base cases, no attack approved; owner, 2026-11-19).
A failed call counts as a failure even though the kernel fails it open.

**Retiring a case (owner, 2026-11-21).** Every existing case runs at its base branch's expectation, so a change can't loosen
its own test. When the owner decides a case no longer applies (the reviewer stopped judging what it checks), it goes on
`modules/ai-reviewer/test/retired-cases.json`: `{ "case": "<file name without .json>", "reason": "...", "approved_by": "owner",
"date": "YYYY-MM-DD" }`. The list is one of the harness's `judged.files`, so the judge (CI and the kernel's check job) reads
it from the base branch, never from the change: a retirement merges to main first, in its own PR, and the change that drops
or flips the case lands after it. Each entry is `approved_by: "owner"`: only the owner retires a case (the path inventory labels the list his path). A retired case does
not run in either version (`<case>.json`, the judge's `<case>.head.json`); every other case runs as before.

**The reviewer eval** (owner 2026-11-16; CI only since 2026-11-22). Reviewer code reaches the fleet only on a passing eval.
The reviewer's own code is the paths `REVIEWER_CODE` lists (`modules/github/service/src/evalgate.ts`, the single list). CI's
`reviewer-eval` job runs the eval on a same-repo PR or a push to main that touches one of them, and it is part of
`ci-required`, so the PR merges only on its pass; a passing run is reused for the same content of every listed file. The code
host runs no eval of its own: every product commit the release train pins already merged through it.

- **What judges what.** The eval script comes from the base; every base case runs at its base version, including one the PR
  deletes; a case the PR adds runs as written; a case the PR changes runs twice (base version, and the PR's fixture held to
  the base's expectations). The reviewer under test is the PR's own. So a PR can't pass by deleting or weakening its test; one
  that changes an existing case's expectation can't pass the gate and the owner merges it by hand.
- **Honest limits.** The PR's code runs in the judge's process and could forge a pass: the receipt is regression evidence, and
  the defence against hostile reviewer code is code review's mandatory review of the product repo. A base whose judge can't load the
  PR's reviewer fails closed.
