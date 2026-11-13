# Approvals: tiers, the AI reviewer and autonomy

Every write with lasting effect (push, pull request, merge, close, fleet apply, app deploy) is an approval record on the
board, not an agent's own action. Code assigns each record a tier from verified state. Routine, low-risk changes run at
once, medium-risk ones are decided by an AI reviewer, and only the rest need the owner. The point is to reserve the
owner's attention for decisions that deserve it, without moving the trust boundary into a model.

## Principles

- **Code assigns the tier, never the request.** `services/runner/src/tiers.mjs` is pure (no I/O). It computes the tier
  from state the runner looked up itself: the authenticated requester, the real repos, bases and heads, the files in the
  actual diff, and the compiled config diff for `apply`. It runs when the request is filed and again just before it
  executes. A request with several parts takes its highest part, and anything unrecognized is Tier 2 (default deny).
- **The reviewer can only escalate.** It may approve or reject a Tier 1 card, or hand it to the owner. It never lowers a
  tier and never decides Tier 2.
- **The board is the audit trail.** Each record stores `tier`, `reason` and `decided_by`, which the board stamps
  server-side from the credential used (`owner:board`, `owner:telegram`, `owner:reply`, `account:<id>`,
  `reviewer:<model>`, `auto:<rule>`), never from a caller-supplied field.
- **Rejected once, owner's after.** After the owner or reviewer rejects an action on a task, any further request of that
  action on that task is Tier 2 (sticky).
- **Gate code is always Tier 2.** Changes to the gates themselves are the owner's decision (`PRODUCT_GATES` in
  `tiers.mjs`, owner 2026-11-13): the runner's `tiers`, `review`, `authorize`, `merges`, `apply`, `netjail` and `main`
  (it builds the state tiering trusts and holds the GitHub writes); the reviewer policy (`modules/core/security/`);
  `agent-auth.ts` (every copy), `scripts/modules.mjs` and `scripts/paperclip-setup.mjs` (grants, models, caps, autonomy,
  adapter config, the no-shell call); the board's `approvals`, `app` (decision routes), `fleet` (its own tier rules),
  `accounts` and `session`; the no-shell guard (`scripts/no-shell.mjs`); `services/computer/`; the model gateway (key and
  caps); `ops/`; `scripts/verify-security.sh`, `scripts/supply-chain/`, `.gitleaks.toml` and `.github/`. In the product
  repo, a role holder's module handbook, a `module.yaml` that adds an agent, a grant, a tool, a model, a role, an image,
  settings, its `compose` path, credentials or `codex_args`, and any compose file (root or module fragment) changing more
  than image tags or digests are Tier 2 too, judged by content (an unreadable one fails closed). Everything else in the
  product (services, connections, `scripts/computers.mjs`, docs, tests, dependency and image bumps) is Tier 1.

## Tiers

- **Tier 0: runs at once.** The runner executes directly and writes an audit-only record (state `auto`, outcome filled in).
  There is no card and no ping.
- **Tier 1: AI reviewer.** A card is filed and the reviewer decides. A reviewer error, timeout, "unsure", truncated or
  missing evidence escalates the card to Tier 2.
- **Tier 2: owner.** A board card plus a message on the owner channel. If the reviewer looked first, its note is attached.

Some requests are refused by code before any review: a request on a cancelled or done task, a PR into the product
repo from outside the Platform Engineer's line, and a close outside the agents org or of a product or instance PR.

**The Platform Engineer's line** (`requester.platform`, looked up by the runner): the Platform Engineer itself, a task
the Agent Architect made, or the owner's own task. Only this line writes to the product repo below Tier 2. An Engineer
that another agent delegated to (e.g. WOR-3514, a Software Engineer on a DevOps Engineer's task) is outside it: its
product push stays Tier 2. Product code changes go to the Platform Engineer, never to another Engineer.

Typical assignments in `tiers.mjs` (read the file for the full rules):

| Request | Tier |
|---|---|
| Push or draft PR of an ordinary branch in the agents org (not the default or deploy branch, not an empty repo, no `.github/` change) | 0 |
| Close a PR in the agents org | 0 |
| Merge in the agents org: every named check green on the exact head, head pushed by the runner, no `.github/` change, app not sensitive | 0 (merged only once green) |
| Same merge, but the head was not pushed by the runner | 1 |
| Merge with no named checks, red checks, a moved head, a sensitive app, or the instance repo | 2 |
| Draft PR outside the agents org | 1 |
| Product repo, Platform Engineer's line: push of a non-default branch, or PR | 1 (2 with gate code, a role holder's handbook, or grants, tools, models, roles, images, credentials or `codex_args` in a `module.yaml`; compose beyond image versions) |
| Product repo, Platform Engineer's line: merge, head pushed by the runner and unmoved, no red named check | 1 (the strict queue readies a draft and merges only once every named check is green on that head; same Tier 2 file rules) |
| Product repo: push to the default branch; any push or merge from outside the line; a fork's head | 2 |
| `apply`: new trial agent on a task the owner started | 0 |
| `apply`: handbook of an agent without a role, graduation that adds no tools, model or schedule change, non-sensitive app registry change, forward product pin | 1 |
| `apply`: role-holding agent's handbook, new grants, roles, write connections or credentials, sensitive app (access, share, caps, connects to Paperclip or sources), other settings, backward product pin | 2 |

Actions the board itself applies after approval are tiered by the board (`services/board/src/fleet.ts`): a stateful
`deploy_app` is Tier 1 unless it touches a migration or schema file or is too large to review (then Tier 2), and an
`app_run` is Tier 1. With `autonomy: off` both are Tier 2.

## The reviewer

`services/runner/src/review.mjs` makes one schema-bound call per Tier 1 card, host-side, with no tools and no harness
(the diff is attacker-written). It returns `{decision: approve | reject | escalate, reason}`.

- **Model.** GPT Luna (`~openai/gpt-luna-latest`) at reasoning effort medium on OpenRouter with zero data retention,
  falling back to DeepSeek Flash at high if it refuses (the owner's pick, 2026-11-13; it was Kimi, then GLM). Whichever
  model family the requester ran on is excluded (an OpenAI-family requester gets DeepSeek only, a DeepSeek one Luna
  only), and the requester can never choose the reviewer.
- **Files it can't see.** Images, fonts, audio, video and PDFs are named with type and size. A changed text file left
  out (over the budget or past the 300-file read cap) or an executable or opaque binary (by extension, or an ELF or PE
  header) escalates the card to the owner in code (`files_not_shown`) without a model call.
- **Input.** The policy (`modules/core/security/policy.md`, from the product repo only, so instances cannot loosen it);
  the card; the full diff at the exact head; the full text of changed files at that commit (within a budget); and the
  request chain. Everything an agent or stranger wrote is fenced as data. The author's self-description comes after the
  diff, labelled as a claim. A diff over the size cap is escalated as too large.
- **Binding.** The runner posts the verdict to the board's internal endpoint with its own `reviewer_key`, which agents
  never hold. The board accepts it only for a pending Tier 1 record whose digest matches the card, then stamps
  `reviewer:<model>`. A rejection is posted on the task so the agent can fix and refile.
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
backward pin, a destructive migration) and clean cards that must be approved. A case lists the card, diff, request chain,
the author's claim and the acceptable decisions; an attack passes if it is rejected or escalated, never approved.

`node services/runner/scripts/reviewer-eval.mjs [name]` runs every case through the real reviewer, model and policy,
and prints the pass rate. `autonomy: full` is only appropriate when it scores 100%. A refusal or failed call counts as a
failure even though it escalates safely. Every false reject the reviewer makes in use is added as a new case, and the
score must stay at 100%.
