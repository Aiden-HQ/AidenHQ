# GitHub as the owner: one identity, no App

Issue: #1065. Status: draft for owner approval, 2026-11-20.

## Intent

Today every GitHub write, and some reads, need a GitHub App: a second identity the owner must create, install on each org
and keep running (the `codehost-github` service holds its key). When that service is down, everything GitHub breaks at
once, including reads the owner's own sign-in could do. On an install where the owner has already pressed Connect GitHub,
the App is pure setup cost.

The owner's decision: **AidenHQ acts on GitHub only as the owner**, through the one sign-in. The App is deleted. GitHub is
never a place the owner's instructions come from: the owner's authority reaches the fleet only through AidenHQ (approval
records, the board, Telegram, Slack). Our own records tell an agent's action under the owner's login from the owner's
own. Everything we write says so: commits carry `Co-Authored-By: AidenHQ <noreply@aidenhq.ai>`, text carries a "via
AidenHQ" footer.

## Goals

- One Connect GitHub (device code, one consent) unlocks all GitHub work: reads, issues, comments, PRs, merges, fleet repos,
  product-bug reports, Projects boards. No App, no agents org required, no apply after connecting.
- The board shows exactly what works, what doesn't and the one action that fixes it.
- An agent that needs something GitHub can't give gets a precise error; the owner hears about it once, through the chief
  of staff, with the exact step.
- Fewer containers and less code than today.

## Non-goals

- The team version (several people, each with their own GitHub identity). Note for later: the same design generalises to
  "each user's agents act as that user"; nothing here hard-wires one person deeper than today's single sign-in.
- Other setup simplifications found in the same review (defer connections to first use, optional tailnet, Google
  Internal client, Telegram as optional recovery). Separate designs, in that order.

## Anti-goals

- A fallback or a second path: no "App if present, else owner". The App code is deleted, not kept dormant.
- The owner's GitHub token reaching an agent, a job or a computer box.
- Anything an agent does on GitHub counting as the owner's word (labels, reviews, comments, approvals).
- Silent degradation: a fleet repo quietly landing in `local` because GitHub dropped, a write quietly not happening.

## Constraints

- The product CLAUDE.md "Conventions" section is the full rulebook (one way, TypeScript, minimal tests, delete before add).
- Every write stays an AidenHQ write record decided by its gate (AI reviewer tiers, the merge gate bound to the reviewed
  head). This design changes the identity writes run as, not who decides them.
- The owner's live instance currently runs on the App (agents org `aidenhq-alpha`, instance repo in it). It migrates in
  one apply with no lost work (see Migration).

## Approaches considered

- **A. Owner for person-like work, App for code work.** Smallest change; keeps per-org App installs (the IT-16630 pain)
  and two identities. Rejected by the owner.
- **B. Split by repo: App in the agents org, owner everywhere else.** Keeps a bot identity for the fleet's own repos;
  still two identities, the App setup page, the key and the service. Rejected: more to maintain than C for little gain
  once GitHub carries no authority.
- **C. Owner for everything (chosen).** One identity. The App's real job (separating agent actions from the owner's so
  agents can't approve themselves) moves to where authority actually lives: AidenHQ's own records. Codex cross-review
  (2026-11-20) agreed and simplified it: one container, attribution from existing records rather than a new log, the
  official MCP read-only.

## Design

### 1. One GitHub process

`github-mcp` and the code host (`modules/github/service`) run in **one container**, sharing `official.ts`'s sign-in and
token store. The token lives in one file on the host's state dir (0600, the host user's), bind-mounted into that container;
the only other reader is the host's git credential helper (§2). No agent, job or computer box ever gets it. Kept as they are: the kernel-authenticated executor listener, typed
write plans (`push` to agent branches, `pr`, `merge` after an approved record bound to the head, `close`, `create_repo`),
the durable merge queue, PR watch. Only their credential changes: every call uses the owner's bearer.

The service no longer waits on `when: { agents_org: true }`: it starts with the module and answers "GitHub isn't
connected" until the sign-in exists. Connecting needs no apply.

### 2. The token broker becomes operations

`kernel/src/codehost.ts`'s `/v1/codehost/token` (repo- and permission-narrowed installation tokens) is **deleted**:
handing out the owner's bearer would defeat every caller's grant. Each caller gets a typed operation from the code host
instead, run with the owner's token inside the GitHub process:

| Caller today | Becomes |
|---|---|
| `modules/apps-platform/apps-mcp/src/github-app.ts` (registry pushes, preview comments, fleet PRs outside the agents org) | code host ops for those exact writes/reads |
| `modules/grading/service/src/github.ts` (evidence reads) | a read op (check runs, PR files at a sha) |
| `ops/ci-runner-token.ts` (org runner registration) | an op returning only the runner registration token |
| `ops/git-credential-app.mjs` (host checkouts of the instance repo) | `ops/git-credential-github.mjs` reads the same token file directly; works before the container starts (apply fetches first) |
| snapshot / clone / bundle (`kernel/src/codehost.ts`) | kept, using the owner token inside the code host |

`kernel/src/github-app.ts`, the `/setup/github-app` admin routes (`kernel/src/admin.ts`), the App key mounts, the
"GitHub App" setup flow and `AIDENHQ_GITHUB_AGENTS_ORG`'s write-once behaviour are deleted.

### 3. Where fleet repos live

Setting **`github_fleet_org`** (replaces `github_agents_org`): an org chosen once from the orgs the owner can create repos
in (orgs only, not the user account: runner registration and `@agents` grants are org-shaped; my call). Unset: fleet repos live in `local` (codehost-local) as today. Set: bare
`create_repo` and `@agents` grants resolve to it. The setting survives a disconnect: while GitHub is disconnected a
`create_repo` there **refuses** with "GitHub isn't connected", never switches to `local`. The owner's live instance sets
it to `aidenhq-alpha`.

### 4. Writes and the footer

- Commits the fleet makes (agent branches, starter, train, settings, squash merges) are authored and committed as the
  owner (name and GitHub noreply email from `/user`) with the trailer `Co-Authored-By: AidenHQ <noreply@aidenhq.ai>`,
  added **before** any SHA is bound to a record.
- Text posted to GitHub (issues, comments, PR bodies, review comments) ends with `— via AidenHQ (<agent name>)`.
- `github_official` (GitHub's own MCP through the sign-in) becomes **read-only**: every mutating tool denied. Mutations go
  only through our typed tools, which add the footer and file the write record.
- `github_pr_review` (owner token, `main.ts:432`, today accepts APPROVE) posts **COMMENT only**: an agent's review must
  not satisfy branch protection as the owner's. (`review-post.ts` already posts COMMENT only.)
- Writes to GitHub are commit **statuses** only (`review-post.ts:133`, `projects.ts:157`), which `repo` allows. Check runs
  are only read (Actions'), which the owner token can do. Nothing creates a check run, so nothing needs an App.
- `github_comment_orgs` is deleted. Which repos a write may touch is the AI reviewer's call on each write record, plus
  what the owner's account can reach.
- `github_app_*` tools are renamed to plain `github_*` (the Maintainer's issue/label/state/comment/list/tree/file tools)
  and keep their scrubbing and repo scoping (`maintainer_repos`).

### 5. Attribution: our records, not a new log

No new write log. `kernel/src/writes.ts` already records requester and outcome for every write record; successful
outcomes gain the GitHub identifiers (commit SHA, PR/issue number, comment id, label + issue). Background writes without a
record (the train, the merge queue's own housekeeping) emit the same identifiers as Flow facts. Consumers:

- The Maintainer tells fleet PRs and issues from human ones by recorded number/SHA.
- `flow.ts` `author_kind`: `agent` when the object is in our records, or (records pruned, a crash, a restore) when the
  PR body carries the AidenHQ footer or its head commit the AidenHQ trailer; `owner` when it's the owner's login and
  neither; else as today. The marker fallback is forgeable, which is fine: attribution carries no authority. PRs the App
  authored before the switch keep `agent` from their records.
- apps-platform finds fleet PRs by recorded number.
- review-post edits/resolves its own comments by recorded comment id.

A crash between the GitHub write and the record leaves the object **unknown**: treated like the owner's own, which costs
nothing because nothing on GitHub carries authority. The footer still tells human readers.

### 6. Authority moves to AidenHQ

- **`agent-build`:** the label dispatch in `modules/maintainer/service/src/watcher.ts` is deleted. The owner's word to
  build a feature is the owner's own message in AidenHQ (board chat, Telegram, Slack DM), e.g. "build #1065". Aiden calls
  a Maintainer tool `issue_build(repo, number, owner_message_id)`; **code** checks that the cited message is authored by
  the owner's account (the board account / owner channel identity, as approvals are) and names that repo and issue, then
  files the build task bound to the issue's content hash at that moment. No LLM decides it's the owner's word; a later edit
  to the issue makes it stale, as today. One step for the owner, no extra card (my call).
- **`agent-fix` and other trusted labels** (`modules/github/connections/github-mcp/src/maintainer.ts`): the signed-in owner's login is excluded before the
  collaborator-role test. Other admin/maintain collaborators (e.g. Taylan) still count.
- **Product-bug filings** (`modules/github/connections/github-mcp/src/projects.ts` `reportIssue`): filed as the owner, scrubbed and fingerprint-deduped as today,
  **without** adding `agent-fix` (it wouldn't be trusted, and an outside reporter may not be allowed to label). The
  Maintainer triages it like any issue. `github_app_issue` becomes `github_product_issue`; the chief-of-staff and Fleet
  Steward grants and `prompts/product-bugs.md` follow. `github_issue_link` stays, only for an install where GitHub isn't
  connected.
- Merge authority is unchanged: AidenHQ's approved record bound to the head, then `merges.ts` sends that SHA.

### 7. Scopes

First connect asks for `repo`, `read:org`, `workflow` (agents may change workflow files) and `project` (Projects v2).
`admin:org` is asked for only when the CI module is turned on (org runner registration); turning it on shows "Reconnect
GitHub to allow CI runners" and nothing else changes until then. The granted scopes are read from GitHub's
`X-OAuth-Scopes` header and shown on the board; a feature whose scope is missing says which one and offers Reconnect.

### 8. The board: one GitHub card

Connections shows one GitHub card. Sketch:

```
GitHub                                   Connected as @your-login  
  Reads, issues, comments ............... working
  Pull requests and merges .............. working
  Fleet repos ........................... in aidenhq-alpha        [Change]
  CI runners ............................ needs permission       [Reconnect]
  Projects boards ....................... working
  ! 0xPolygon: GitHub needs you to authorize single sign-on      [Authorize]
  ! acme-corp: the org restricts outside apps                    [Request access]
  Rate limit: 3,812 of 5,000 left, resets 14:20
```

States: **not connected** (Connect; agents can't use GitHub), **working**, **expired** (a sign-in that worked and stopped:
the existing red banner with Reconnect), **per-org blocked** (SSO not authorized, or the org's OAuth app restrictions),
**rate-limited** (until when). Built on the existing `board.signins` status (`/auth/status`), extended with per-org
problems and scopes. No App state exists any more.

### 9. Guidance when an agent needs GitHub

- Every GitHub failure is a typed error naming the cause and the fix: not connected, expired, missing scope `<x>`, org
  `<o>` needs SSO authorization (the URL from GitHub's `X-GitHub-SSO` header), org `<o>` restricts the app (the request
  URL), repo `<r>` not reachable by your account, rate-limited until `<t>`.
- An owner-fixable cause (connect, reconnect, scope, SSO, org approval) reaches the owner **once** through the chief of
  staff's `notify`, deduped by cause, with the one link. The task waits; it isn't failed. Everything else is the agent's
  to handle (a repo it can't reach: say so on the task and pick another route).
- The setup flow text says what Connect unlocks and that agents act as you, labelled as AidenHQ.

### 10. Edge cases

| Case | Behaviour |
|---|---|
| Never connected | Reads and writes refuse "GitHub isn't connected"; product bugs use `github_issue_link`; fleet repos stay `local` unless `github_fleet_org` is set (then refuse) |
| Sign-in revoked or token rejected (401) | Mark expired (banner + one notify); merge queue and pending writes hold and resume on reconnect |
| Org requires SAML SSO and token isn't authorized | 403 with SSO URL → per-org line on the card, one notify |
| Org restricts OAuth apps | Per-org line with the request-access link; works once an org admin approves |
| Missing scope | The feature names the scope; Reconnect asks for the full current set |
| Repo the owner can't reach (404) | Typed error naming the repo; no retry loop |
| Primary or secondary rate limit | One limiter in the GitHub process (everything shares it now): background work (merge queue, PR watch, Flow ingest, warehouse sync, Maintainer scans) pauses when REST or GraphQL remaining drops below a reserve (20%), leaving room for interactive calls and the owner's own use; idle scans slow when nothing is open; back off to the reset on a 403/429; the card shows it |
| Rulesets that list the App as a bypass actor (the product repo's `main protection` does) | Migration replaces it with the repository admin role |
| Branch protection requires an approving review | The owner can't approve their own PR on GitHub: the PR waits for a human reviewer; the merge card says so. Fleet-created repos are created without that rule |
| Existing protections or required checks pinned to the App | Migration rewrites them (see Migration) |
| Owner leaves an org | Repos there become "not reachable"; nothing else breaks |
| Crash between a write and its record | Attribution unknown → treated as the owner's; no authority impact |
| Owner and an agent act on the same issue | Told apart by records; neither's GitHub action is authority |
| Owner has two GitHub accounts | One sign-in; whichever account connected is the identity. Reconnect switches it |

### 11. What is dropped (owner OK'd 2026-11-20)

- The App's separate bot identity on commits, comments and status checks.
- One-hour, repo-narrowed installation tokens (the owner token is long-lived and reaches every repo the owner can; it
  stays inside the GitHub process).
- Other orgs installing the public App so the fleet can PR there: now "repos the owner's account can reach".
- The App setup page, the App key and the codehost-github App code.
- Also dropped by this design (listed for the owner's review): `github_official`'s write tools (replaced by our typed
  tools); `github_comment_orgs`; `agent-build` as a GitHub label trigger (replaced by the owner's word in AidenHQ);
  `agent-fix` on product filings.

### 12. Migration (the owner's live instance)

One product release, then one apply:

1. The owner reconnects GitHub once (new scopes); the board asks for it after the deploy.
2. `github_fleet_org: aidenhq-alpha` set by the compile from the old `AIDENHQ_GITHUB_AGENTS_ORG`.
3. Rulesets and branch protections on `aidenhq-alpha` repos and the product repo that name the App (bypass actor, or a
   required check pinned to its integration id) are rewritten: bypass → repository admin role, checks → any source
   (a one-off script in the release). Checked 2026-11-20: the product repo's `main protection` requires `ci-required`
   from any source, no approving reviews, and bypasses for an Integration.
4. Host checkouts switch credential helper (apply does it).
5. Open fleet PRs authored by the App stay as they are; the merge queue merges them with the owner token (their records
   already bind the head).
6. After it runs, the App can be uninstalled and deleted on GitHub by the owner (one card with the link); nothing reads it.

### 13. Left to the builder

File layout of the merged container; the exact typed-op names and schemas; how slow idle polling gets; the credential
helper's mechanics; test shape (a few end-to-end: connect → issue → PR → merge on a test repo; not-connected and SSO error
paths); wording of footers and card copy within the rules above; docs/setup.md section 8 rewrite and the distro site copy.
