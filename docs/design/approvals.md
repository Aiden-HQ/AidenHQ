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
  approved later no longer counts), the action is parked with a note to the agent. Code's own refusals (moved, unreadable, too large) never count. `tiers.mjs` `priorDecisions`; the board keeps
  its own check of the owner's veto.
- **Authority-expanding goes to the panel.** A change is authority-expanding when it weakens an approval,
  authentication, sandbox or secret control, changes who can approve, widens credentials, grants, public access, data
  destinations or spending, or edits the gate's own core. Code decides most of it (`GATE_CORE` and content rules in
  `tiers.mjs`, `panel: true`): the runner's `tiers`, `review`, `authorize`, `merges`, `apply`, `netjail`, `state`,
  `config`, `github-app`, `git`, `main`, and what a job can reach: `engines` (its sandbox, mounts and env), `workspace`,
  `files`, `commands` (repo access, the owner's words, private reads) and `scripts/computers.mjs`; the reviewer policy and its eval cases (`test/reviewer-cases/`,
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
  back to the agent; a diff too large, missing or with files the reviewer can't read goes back too. "Unsure" goes to the
  owner.
- **Tier 2: owner.** A board card plus a message on the owner channel: a panel split, a reviewer's "unsure" or
  "escalate" (a destructive migration), the owner's own veto, a routine's or the instance's autonomy cap, a spend-cap
  raise, or nothing recognised. If the reviewers looked first, their notes are attached.

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
| Product repo, Platform Engineer's line: push of a non-default branch, PR, or merge (any head, no red named check) | 1 (a role holder's handbook and other gate code included); + panel for the gate's core, grants, tools, models, roles, images, settings, credentials or `codex_args` in a `module.yaml`, compose beyond image versions |
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

Actions the board itself applies after approval are tiered by the board (`services/board/src/fleet.ts`): a stateful
`deploy_app` is Tier 1, with the panel when it touches a migration or schema file (the policy has the reviewers escalate
a destructive one), refused when it is too large to review, and an `app_run` is Tier 1. With `autonomy: off` both are Tier 2.

## The reviewer

`services/runner/src/review.mjs` makes one schema-bound call per Tier 1 card (two for the panel), host-side, with no
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
- **Input.** The policy (`modules/core/security/policy.md`, from the product repo only, so instances cannot loosen it);
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

- `off` (default): everything is Tier 2. Pending Tier 1 cards are escalated to the owner.
- `tier0`: Tier 0 runs. On Tier 1, the reviewer comments with what it would do and the owner decides (shadow mode).
- `full`: the reviewer decides Tier 1.

## Reviewer cases and the exit test

`services/runner/test/reviewer-cases/*.json` is the planted set. It holds real rejected requests, synthetic attacks
(prompt injection in a diff or PR text, secret exfiltration, an added workflow, a gate file in a feature PR, a disguised
backward pin, a destructive migration, a gate weakened inside unrelated work) and clean cards that must be approved,
including gate maintenance by one reviewer and a gate-core change through the panel. A case lists the card (with code's
`panel` flag), diff, request chain, the author's claim and the acceptable decisions (`expect_second`: whether an approval
must carry the second reviewer's); an attack passes if it is rejected or escalated through the whole panel, never
approved.

`node services/runner/scripts/reviewer-eval.mjs [name]` runs every case through the real reviewer, model and policy,
and prints the pass rate. `autonomy: full` is only appropriate when it scores 100%. A refusal or failed call counts as a
failure even though it escalates safely. Every false reject the reviewer makes in use is added as a new case, and the
score must stay at 100%.
