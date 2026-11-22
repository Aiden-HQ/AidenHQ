# Code review's optional GitHub App (2026-11-22)

Owner-approved 2026-11-22. Code review's GitHub writes can go through the owner's own GitHub App, per repo where it is installed,
so they stop sharing the owner's write limit.

## Why

Every GitHub write runs as the owner's account: the fleet's, code review's and the operator's. They all share GitHub's secondary
content-creation limit (about 80 a minute, 500 an hour). Code review makes most of those writes:

- the review POST and its inline comments
- file comments
- the summary PUT
- `resolveReviewThread`
- the `aidenhq/review` commit status
- the acknowledgement comment

When the limit is hit, GitHub answers "submitted too quickly" and every writer stalls.

## Decisions

1. **Optional, generic, per repo.** Without the App everything works as before. Any owner creates their own App from the
   kernel's admin page `/setup/github-app`, through GitHub's manifest flow. The App is `public: true`, so it can be installed on
   any org, on all of its repos or only some. For each PR, code review posts as the App when it is installed on the PR's base
   repository, and as the owner otherwise. Agents' PRs, pushes, merges and comments, and every read, stay on the owner's sign-in.
2. **One review writer.** `ReviewPoster.writer(repo)` in github-mcp (`modules/github/connections/github-mcp/src/review-post.ts`)
   handles every review write: the post, inline and file comments, the summary, resolves, the status, notices and acks.
   - It returns a `GitHub` client bound to the App's installation (`gh.as(identity)`, still behind `guard`) or the owner's.
   - The owner is picked when the App isn't set up, when its saved files are incomplete or unreadable (the App is optional:
     the card row warns), or when GitHub answers 404 for `GET /repos/{repo}/installation`.
   - Any other failure of a working App throws: a bad key GitHub rejects, a suspension, a permission error, a rate limit.
   - Installation lookups are cached for 10 minutes. Tokens are cached per installation until 5 minutes before `expires_at`.
3. **Pacing per identity.** github-mcp's client (`client.ts`) keeps one `Pace` per identity: the owner, or `app:<installation
   id>`. Each has its own rate buckets, serial write queue and secondary-limit backoff, and `Retry-After` is honoured. A new
   installation token keeps its identity's cooldown.
   - An App answer never touches the owner's sign-in state (scopes, `expired`, org problems).
   - An App 401 gets one retry with a fresh token, then surfaces.
4. **Merge gate unchanged.** `aidenhq/review` stays a commit status, with the same context and SHA. The merge queue still asks
   code review for the verdict. AidenHQ configures no branch protection. A repo admin who requires the status must let any
   source set it (see the gotchas below).
5. **Threads and cutover.**
   - A thread is ours when its first comment carries our marker and is by the owner or the App. Logins are compared by kind
     (REST `type`, GraphQL `__typename`), so a person named like the App's slug doesn't count.
   - Resolution is still decided by the threads code review recorded as its own.
   - Threads are read as the writer, and a thread whose `viewerCanResolve` is false is skipped with a reason.
   - On a PR whose earlier review or ack the owner posted, the App posts its own review and its own ack rather than editing the
     owner's. The service records the new ack id from the outcome.
6. **Setup and UX.**
   - The App's id and key are written by the kernel to `<vault>/modules/github/github-app/{app_id,key.pem,slug}`, the github module's
     own vault dir. The github process reads them at `/state/github-app/`, when needed, so no restart is required. The key goes
     from GitHub to the vault and nowhere else.
   - The vault root `github-app/` is not used. It belongs to the retired fleet App: apply deletes it, verify-security forbids it
     and compile reads its id for the #1065 migration.
   - The board's GitHub card shows a "Code review App" row: its bot and an Install link, or a warning with the error while
     the App fails (a bad key, a suspension), with Replace. The admin page also removes the App (code review then posts as the
     owner everywhere). For each org code review posted in,
     it shows whether code review posts as the App, as the owner, or as the App on n of m repos. That record is what the writer
     picked, kept in `/state/review-as.json`.
   - Where code review posts as the owner, the row carries the suggestion "Code review can post as its own GitHub App, so it
     doesn't share your write limit", with Create or Install. **Dismiss** removes the suggestion for that org for good (board
     store, `dismissed:<sign-in>:<key>`). The row stays, always `ok`. Nothing nags, blocks or degrades without the App.
   - The code review repo tiles say "Posts as the App" or "Posts as you".
7. **Measure.** Each content-creating write logs `github write` with its identity (owner or app), its path shape and
   `writes_this_hour` for that identity.

## Non-goals

- Check runs (the status stays a commit status).
- Changing the identity of agents' writes. Agents stay on the owner's sign-in.
- Any App use for reads.

## GitHub gotchas

- **Installations can cover selected repositories.** An org installation does not mean every repo in the org, so the lookup is
  per repo (`GET /repos/{o}/{r}/installation`).
- **Required status sources.** A required `aidenhq/review` pinned to one source breaks the fallback to the owner. Use a ruleset
  check with no `integration_id`, or classic protection with `app_id: -1`. Adding the check in GitHub's UI after the App has
  posted can pin it to the App.
- **Bot logins.** On REST the bot is `<slug>[bot]` with `type: "Bot"`. On GraphQL it is `<slug>` with `__typename: "Bot"`.
- **Thread resolution.** It is unverified whether an installation token with `pull_requests: write` can resolve a thread the
  owner started. It is gated on `viewerCanResolve`, read as the App, and skipped with a reason when false. Check it live on a
  throwaway PR after the first install.
- **Permissions.** The manifest asks for `pull_requests: write`, `statuses: write` and `metadata: read`. PR conversation
  comments (the ack) take `pull_requests: write`. Changing permissions later needs every installation to accept them, so the
  set is minimal.
- **Secondary limits.** GitHub documents a separate primary budget per installation. It does not promise separate secondary
  limits, so the App's queue keeps its own backoff and `Retry-After`.

## New installs

- A fresh install sees no App row, and nothing changes in how it works.
- Once code review posts in an org, the GitHub card shows "Code review in <org>: posts as you", with the dismissible
  suggestion.
- The App is per instance: another owner creates their own from the same page, under their own account or one of their orgs.
