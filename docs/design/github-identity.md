# GitHub identity: the App where installed, else the owner

Every GitHub write goes out as one identity, picked by one rule. Companion to [code-review.md](code-review.md) and
[approvals.md](approvals.md); the modules' own READMEs ([github](../../modules/github/README.md),
[ship](../../modules/ship/README.md)) say what they write.

## The rule

`access.actorFor(target, op)` (github-mcp's `client.ts`) answers with the instance's **GitHub App** iff

1. the App is set up (its id and key are in the github module's vault dir),
2. it is installed on the target repository (or organization), and
3. that installation has accepted every permission the op needs;

otherwise with the **owner's sign-in** (the one Connect GitHub sign-in). Nothing else switches the identity: no fallback on
an error, a rate limit or a refusal. A write with no actor is refused, and a GraphQL mutation must be one of the named
`MUTATIONS` (create commit, update refs, dequeue, add project item, set project field, resolve thread).

**One actor per write attempt.** The reads that decide a write (a PR's head, a thread's author) go as the same actor as the
write, so an attempt never mixes identities.

## Ops

Each write names an op, and each op the permissions an App installation must hold for the App to be its actor:

| op | App permissions (write unless noted) | used for |
|---|---|---|
| `push` | contents, workflows | branch pushes, ref updates, commits |
| `merge` | contents | merges and merge-queue entries |
| `update_branch` | pull_requests, contents | updating a PR branch |
| `pr` | pull_requests | PRs, reviews, review comments, replies, resolves, approvals |
| `dequeue` | pull_requests | leaving the merge queue |
| `issue` | issues | issues, labels, conversation comments, notices |
| `status` | statuses | commit statuses |
| `actions` | actions | re-running jobs |
| `actions_read` | actions (read) | reading runs and job logs |
| `contents` | contents | file writes through the contents API |
| `project` | organization_projects | Projects boards |
| `create_repo`, `runner_token` | never the App | always the owner |

`push` always needs `workflows`, so who pushes depends on the repo's installation, never on the diff.

## Reads

A REST read of a repository goes as the App where its installation holds the permission the path needs (`readerFor`), else
as the owner. GraphQL reads, organization and user listings and searches stay the owner's. There is no retry as the owner
after a refusal. Every GET goes through one ETag cache per identity, so a 304 costs nothing.

## A broken or refusing App

- **`app_broken`**: the App is set up but unusable (unreadable files, a bad key, a suspension, a failed installation lookup,
  GitHub down). The write throws; it never goes as the owner. The board's card shows the reason with Replace.
- **`app_refused`**: GitHub refused the App ("not accessible by integration"). The cached installation is evicted so the next
  attempt reads it again; the write is never retried as the owner.

## The App's identity

Who the App is (slug, bot login `<slug>[bot]`, bot user id) is read from GitHub (`GET /app`, `GET /users/<slug>[bot]`) and
cached 10 minutes; no slug is stored. The vault holds only `github-app/{app_id,key.pem}`. Installation lookups (installed or
not, accepted permissions) are cached 10 minutes, installation tokens until shortly before they expire. The kernel asks the
code host for the App's login (`GET /aidenhq/v1/app`) for the CI tier payload `tiers.self`.

## Threads, comments and statuses

Review threads are ours by marker and an author that is the owner or the App's live bot login. Comments, notices and
statuses made by another identity are never edited across a switch: the current actor posts its own (a comment edit goes
through only for a comment the actor itself made). Flow trusts the App's bot as an agent and a member; the Maintainer trusts a
label event made via the App, except the `agent-build` label, which is the owner's own word.

## Approvals

Ship's approve write is App-only and skipped on a PR the App opened (`ship-no-app`: approval needs a person). The review id
of each approval that write makes is recorded (`service/src/approvals.ts`), and only those approvals count toward a merge
(`approvedAt` in the merge gate): a session box's App token can post a review as the same bot, and that is not ship's word.
`github_pr_review` (an agent's tool) stays COMMENT-only.

## Merges and async requests

Ship merges and enqueues as before, as the chosen actor (the App where installed with contents write). GitHub's asynchronous
merge requests store the actor key that made them and are read back as that identity, so a request that outlives one
execution is never read as another.

## Commits

Commits the code host makes locally (clones in its cache) are the owner's, with the `Co-authored-by: AidenHQ` trailer. The
registry commit op is a `createCommitOnBranch` bound to the parent (`expectedHeadOid`) with no custom author, so GitHub makes
the commit as whoever the actor is: the App's, signed by GitHub. A push that merges the base is one merge commit made through REST git data
(`git/trees` on the head's tree, `git/commits` with parents head and base tip, no author or committer), which GitHub signs for
the App, then the branch moved bound to the head exactly (`updateRefs` with `beforeOid`); a commit GitHub didn't sign is never written.

## Session boxes and the host

- **Session boxes** get App-only tokens, never the owner's: one installation token narrowed to the repo and to contents and
  pull_requests write, each only if the installation accepted it (contents is required). Never the App's wider grants: a box
  can't touch workflows, issues or their labels. No App, no git credential in the box.
- **The host's instance checkout** (`ops/git-credential-github.mjs`) answers with an App installation token where the App is
  installed on the instance repo with contents and workflows write (git's `get` can't tell a fetch from a push, so it always
  asks for the push permissions), else the owner token. A broken App answers nothing.

## Rate limits and pacing

Each identity has its own limits and queue: the owner, and each App installation (`app:<installation id>`). github-mcp keeps
one pacer per identity (rate buckets, serial write queue, secondary-limit backoff, `Retry-After`); an App answer never touches
the owner's state. Content-creating writes go one at a time per identity, at least a second apart, within the write's budget
(the writes of one tool invocation share one 240 s budget; a write that can't start in what is left fails at once). A call from a tool fails
at once with a typed `rate_limited` need; a background call waits.

## The board card

The GitHub card has one **GitHub App** row (`@bot` with Install, or "isn't working" with Replace, or "not set up" with a Create
suggestion, which Dismiss removes) and one row per installation ("App on `<account>`", all or selected repositories). An
installation that hasn't accepted a permission the ops need shows a warning listing them with a Review link.

## Permissions and accepting them

The App is made on the kernel's admin page `/setup/github-app` (GitHub's manifest flow; public, so any org installs it on all
or some of its repos). It asks for contents, workflows, pull_requests, issues, statuses and actions (write), organization_projects
(write) and checks and metadata (read). It does not ask for administration or self-hosted runners.

An installation keeps the permissions it was made with until its owner accepts a raise on GitHub. Until then the ops that need
the new permission go as the owner on that repo or org, without error, and the card shows what is pending.

## New installs

No App, no change: the owner's sign-in writes everything and a session box gets no git credential. Setting up the App later
moves each op to it, repo by repo, as installations accept the permissions.
