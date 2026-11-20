# Connect on first use

Status: approved by the owner, 2026-11-20. First of three setup simplifications (then: tailnet optional, the
organisation Google client).

## Intent

Install already requires only the account, the authenticator and the model key; everything else is skippable
(guided-setup.md). What's missing is the moment an agent needs a connection that isn't there. Today the tool answers
`<x>_auth_unavailable`, the agent improvises from handbook text, nobody hands the owner the one link that fixes it, and
agents keep calling dead connections. The owner should be able to skip every optional step at install and still have
everything work the first time they ask for it.

## Goals

- When the owner's own request needs a missing connection, the owner gets the exact Connect link **in that
  conversation**, once, and the work resumes by itself after they connect.
- Background work that hits a missing connection never pings the owner; it shows up as one deduped line in the next daily
  digest (owner decision, 2026-11-20).
- Agents know which connections are live and don't retry dead ones.
- One mechanism for every connection; GitHub's #1065 typed needs move onto it.
- Account recovery doesn't depend on Telegram.

## Non-goals

- Changing what install requires (already minimal) or the wizard's steps.
- Shared/published OAuth apps for Slack or Google (the organisation Google client is project 3).
- Tailnet-optional defaults (project 2).

## Anti-goals

- A ping for something the owner didn't ask for.
- The same missing connection reported twice in a day, or once per agent.
- A link that can't work where it's sent (a `#/route` in Telegram, an http redirect a vendor refuses).
- Per-connection copies of the routing logic.

## Constraints

- Product CLAUDE.md "Conventions" (one way, no fallbacks, minimal tests, delete old paths).
- Every exposure mode works: public, tailscale, cloudflare, local (owner rule).
- Untrusted text stays data; secrets and OAuth never pass through a model (owner-mcp design).
- Guided-setup's "a skipped flow is never a nag" becomes: never a nag for **background** work; the owner's own request
  gets the link.

## Approaches considered

- **A. Each connection notifies.** Copy #1065's `GitHubNeed` + notify into every connection. Rejected: the "did the owner
  ask?" routing would live in N places.
- **B. The kernel routes it (chosen).** Connections answer one standard error; the kernel, which already proxies every
  tool call, decides who hears about it and records connection state for agents.
- **C. Hide tools until connected.** Rejected: every Connect would need an apply, and Aiden couldn't say what's possible.

## Design

### 1. One error contract

A connection that can't serve a call because of something only the owner can fix answers an MCP `isError` result with
structured content:

```json
{ "error": "needs_owner",
  "need": { "connection": "google", "cause": "not_connected", "scope": "gmail.readonly", "org": null,
            "action": "connect", "url": "<absolute link>", "detail": "Gmail isn't connected" } }
```

- `cause`: `not_connected | expired | scope | sso | restricted` (owner-fixable). Non-owner-fixable causes
  (`unreachable`, `rate_limited`) are plain errors and never take this path.
- A shared SDK helper (new `kernel/sdk/src/needs.ts`, synced to modules) builds it.
- Connections on the shared vendor proxy (`vendor/proxy.ts`: Glean, Jira, Grafana, Primer, GitHub's official MCP…) get it
  with no per-connection code: the proxy already knows the sign-in state, so it answers `needs_owner` itself when there is
  no sign-in (`not_connected`) or the upstream rejected the token (`expired`, where it already calls `mark("expired")`).
- The hand-written MCPs (google-workspace, github-mcp, hubspot, slack) call the helper where they return
  `<x>_auth_unavailable` today (Google's is in-band JSON text, `main.ts:103`). The old codes are deleted.
- GitHub (after #1065 merges): its `GitHubNeed` causes map one to one (`not_connected`, `expired`, `scope`, `sso`,
  `restricted`, with `org`), and `client.ts`'s own `kernelNotify` is deleted in this project's PR.
- The kernel reads `needs_owner` from the module's answer **before** `fenceAnswer` strips `structuredContent` (connection
  modules are our code; only the upstream data inside is untrusted).

### 2. The kernel routes it

The kernel's tool proxy sees the `needs_owner` answer and:

1. **Records connection state**: `connection_state(connection, cause, since)`. It clears when the owner finishes that
   connection's Connect: the board, which runs every sign-in and setup flow, calls the kernel
   (`POST /v1/connections/<name>/ok`) when one completes; a later successful call through the proxy also clears it.
2. **Decides who hears**:
   - **The owner asked**: walk the task's parent links to the root task (Paperclip parent ids); the request is the
     owner's when that root was created from the owner's own words (an owner board comment, or a message relayed from the
     owner's Telegram/Slack chat). A routine's run is background even if the owner created the routine. The kernel:
     - sends one `notify` (kind `decision`, `task:` the root task, `dedupe_key` `connect:<connection>:<cause>`): what's
       needed, why ("to read your inbox"), and the link. Owner-channel delivers it to the owner's channels and the board,
       like any decision; the kernel only carries it (routing, mutes and dedupe stay owner-channel's);
     - records the calling task as waiting through the same code path as an agent's own `/v1/wait` (reason
       `agent_wait`, `on: "<connection> connection"`, wake key `connect:<connection>`), so the board shows it as waiting on
       the connection. No new reason.
     When the state clears, the kernel fires wake key `connect:<connection>` and every task waiting on it resumes.
   - **Background**: no message. The kernel sends `notify` kind `digest` with `dedupe_key`
     `connect:<connection>:<cause>`; owner-channel's existing digest batching (`notify_digest_hours`) and dedupe do the
     rest.
3. **Answers the agent** with a short, fixed text: "Google isn't connected; the owner has the link / it's in the
   digest. Don't retry; you'll be woken when it's connected" (owner-asked) or "… skip this source for now" (background).

The agent's job ends its turn on this answer (the wait is already recorded); it doesn't call `task_wait` itself.

### 3. Agents can see what's connected

Connection state changes at runtime, so it can't live in the compiled handbook. The per-run context the kernel/runner
assembles at each job start gains one line per granted connection that is currently down: `google: not connected since
<date>`. Agents skip those tools instead of discovering it by failure. No new tool.

### 4. Links that work where they land

The kernel builds `url` absolute, from the board's public name (`BOARD_LAN_URL` / exposure settings), to the connection's
own Connect (the sign-in's Connect, or `#/setup/<module>` for a flow). By mode:

- Device-code and pairing flows (GitHub, Telegram): work everywhere.
- Redirect flows needing https (Slack): when the install has no https board name, the message says so plainly ("needs
  the board on an https address: <one-line pointer>") instead of a link that fails.
- Loopback flows (Google Desktop client) in `local`/tunnel mode: the message says to open it on the computer that has the
  tunnel. (Project 2 revisits this.)

### 5. Recovery without Telegram

`ops/setup.sh --reset <email>` prints the one-time reset link on the server: the operator endpoint
(`/v1/operator/reset`, local to the host) returns it, built on the board's public base URL. Whoever can run it already
controls the server, so nothing new is exposed, and it works in every mode. In Cloudflare `access` mode there is no link
(Access owns identity) and it prints that instead. The Telegram delivery of reset links (`deliverSecrets`, the
`credentials: true` channel) is deleted: one way (owner OK'd 2026-11-20).

### 6. Clean-ups

- `modules/chief-of-staff/skills/research-tools/SKILL.md`: drop the stale `scripts/github-auth.sh` and per-tool
  "reconnect" text; the kernel's answer now says what to do.
- `docs/design/guided-setup.md`: the "never a nag" line becomes the background/owner-asked rule above.
- Aiden's tour (AGENTS.md "tour"): unchanged; it still offers skipped steps once.

## Edge cases

| Case | Behaviour |
|---|---|
| Owner asks; connection missing; owner never connects | Task stays waiting; the digest lists it daily; no repeat message |
| Owner connects | State clears; waiting tasks wake and retry once |
| Two connections missing for one request | One message listing both links |
| Sign-in expires mid-task (owner-asked) | Same path, cause `expired`, link is Reconnect |
| Background routine on a dead connection | Not pinged; skipped while the preamble marks it down |
| Connection answers `needs_owner` for a cause the kernel doesn't know | Treated as `not_connected` text with its detail |
| Owner-asked work through a delegated agent | Chain walks to the owner's task; message goes in the owner's thread |

## Left to the builder

The `connection_state` storage and how status sources clear it; how the task chain is walked (Paperclip parent links);
digest wording; the preamble line format; which connections need the helper call vs get it from the proxy; tests (a few
end to end: owner-asked Gmail missing → one message → connect → task resumes; background → digest only).
