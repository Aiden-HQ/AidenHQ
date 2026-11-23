# AidenHQ

## What this codebase does
- Self-hosted platform that runs AI agents (chief of staff Aiden, crews, Engineers) on one Docker Compose host, reached through Telegram, Slack or a web board.
- `kernel/` (aidenhq-kernel) is the trust hub: model gateway, tool proxy for MCP connections (`/c/<connection>/mcp`), identity and grants, write records tiered in code, job admission, and the code-host broker.
- Agents run as jobs inside gVisor agent computers launched by `services/computer/launcher.ts`. A box holds only its job token and mounted workspace.
- `services/board` is the owner UI (loopback 3121, reached through a front door). `services/paperclip-events` is the Paperclip plugin with a signed `post` action.
- `modules/*` holds agents, MCP connections (tasks, jira, glean, primer...), the GitHub code host (`modules/github/service`), dispatch (wakes into jobs), the security scanner, and the apps platform (`apps-mcp`, `gate`).
- Ingress families: HTTP (kernel admin 3120 and backplane 3130, board 3121, app gate 3129/front door, computer launcher gateway), RPC (module MCP servers, codehost ops, Paperclip post action), agent tools (every MCP tool call through the proxy), queue/poll (dispatch wake inbox, polling loops), cron (security scanner hourly, apps-mcp loops), CLI (`scanner once`). No inbound GitHub or Slack webhooks (ours are outbound and HMAC-signed); monitoring's Alertmanager posts to Fleet Steward's bearer-checked `POST /alerts` (`modules/fleet-steward/service/src/server.ts`).

## Auth shape
- Admin listener (3120) and gate sign-in listener (3129): Better Auth accounts in the kernel (argon2id passwords, TOTP, lockouts). `EXPOSED` in `kernel/src/auth-rules.ts` allowlists only the paths forwarded to Better Auth (404 for any other `/api/auth` call); the listeners' own pages and gate handoff/app-access requests live in `kernel/src/admin.ts` and `kernel/src/signin.ts` and check their route's credential.
- Board (`services/board/src/app.ts`): a session per origin from a one-time kernel handoff, re-checked with the kernel (`kernel-auth.ts`). `/mcp` accepts only an OAuth bearer (`mcp-auth.ts`, `mcpGrant`). Internal routes use `bearerMatches`.
- Module and backplane calls: per-module bearer tokens compared with timingSafeEqual or `secretIs`. Tool and module calls also carry a kernel-signed EdDSA caller assertion (`X-AidenHQ-Caller`, 60 s, `aud` = module), checked with `verifyCaller` and `kernelJwks` (`kernel/sdk/src/caller.ts`).
- Job boxes: one job token (`ahqj_`), looked up by hash. Launcher routes use separate secrets (`launcher_kernel_key`, `computer_progress_token`).
- Paperclip `post` action: HMAC-SHA256 over the company, agent and params with `paperclip_post_key`, skew of 60 s, each signature used once (`services/paperclip-events/sign.js`, `post.js`).
- Code host: only `modules/github` holds the owner's GitHub token. Other callers use typed ops under a `codehost:` grant (`covers`, `resolveRepo`, `routeKind`).
- Gate (`modules/apps-platform/gate`): Cloudflare Access JWT, or the board session on the auth listener. Identity is an Ed25519 JWT minted per request. Inbound identity headers are stripped.

## Threat model
- A prompt-injected or misbehaving agent exceeding its grants: tool grants checked in the proxy, writes filed as kernel records tiered by `computeTier`, the AI reviewer, and untrusted text fenced (`fence`, `fenceAnswer`).
- An internet visitor reaching the front door or gate: password plus TOTP, per-address and per-account limits, and origin checks on writes.
- Confused deputy between modules: caller assertions bound to `aud`, per-module tokens, and grants resolved in the kernel rather than from module settings.
- Escape from agent computers into host secrets or the Docker socket: launcher mounts limited to workspace, engine home and out folder.
- Token leakage: codehost ops must never return the GitHub token, and errors are scrubbed.
- Shared-app cross-talk: preview hosts, host-only cookies, and identity tokens scoped per app.

## Project-specific patterns to flag
- Handlers on 3120, 3121, 3129 or 3130 that lack a bearer, admin or module check; Better Auth paths missing from `EXPOSED` in `kernel/src/auth-rules.ts` (that set governs only requests forwarded to Better Auth).
- Secret comparison with `===`, `==` or `!==` instead of `timingSafeEqual`, `secretIs` or `sameKey`.
- Trust in `X-Forwarded-For`, `CF-Connecting-IP` or `x-aidenhq-*` headers without the proxy secret (`ipOr`, `NAMED_HEADER`, `GATE_HEADER`).
- Module MCP tools that take the caller from arguments or headers rather than `verifyCaller`.
- Writes that bypass kernel records (`writes.ts`, `computeTier`), or GitHub or Paperclip calls from agent-facing code outside the broker.
- Tool or connection answers returned to agents without `fence` or `fenceAnswer`.
- New `codehost` ops without `covers` checks, or launcher routes that mount secret dirs, the data dir or the Docker socket.
- Unbounded body reads (compare `readBody` and `readAll` limits).

## Known false-positives
- `aidenhq-sdk/` copies under `modules/*/connections/*` and `vendor/` folders are byte-identical copies of `kernel/sdk`, synced by `scripts/sync-shared.ts`.
- Unauthenticated by design: `/healthz`, `/v1/jwks`, the launcher's `/health`, and on 3120 OAuth's discovery and `POST /oauth2/register`. `/oauth2/authorize` and `/oauth/consent` need an admin session; `POST /oauth2/token` and `/oauth2/revoke` need a registered OAuth client (`kernel/src/admin.ts` ROUTES).
- Loopback listeners (3120, 3121, 3129) are reached only by host processes and the front door; their route credentials are in `kernel/src/auth-rules.ts`, `kernel/src/admin.ts` and `services/board/src/mcp-auth.ts`.
- Tailnet peers are rate-limited and never locked; `o.now` disables Better Auth rate limits in tests.
- Agent tool calls are checked against their grants in the kernel's tool proxy before they run; `computeTier` and the AI reviewer then decide each write.
- Sign-in passwords are verified by Better Auth's argon2 `verify`.
