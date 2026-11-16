# Access: who can reach what

Two surfaces, two audiences. The **board** (owner UI and approvals) is for admins only. **Shared apps** built by agents
can also be opened by other people in a browser, through one small gate. Nothing else is exposed: Paperclip and the
board are never reachable through the gate, and the host opens only SSH plus what its exposure mode needs.

## Overview

```
browser -> Cloudflare Access (optional per login mode) -> Tunnel -> cloudflared (outbound only)
        -> gate (127.0.0.1) -> the app on 127.0.0.1:<port>
admins  -> the exposure mode's front door -> board listener (127.0.0.1) -> Better Auth session on every route
```

Sharing is optional. An instance without the `edge` setting stays tailnet-only. An app is shared when its entry in the
instance `apps.yaml` has `share.host`; modules cannot declare `share`, and changing it is a Tier 2 approval.

## Exposure modes

How admins reach the board is one core setting, `settings.exposure` in `instance.yaml` (unset: `tailscale`, as every
install made before it). It also decides what the host firewall (`ops/vm/public-fw.sh`, our own nft table on the public
interface, input and forward) lets in. Everything else on that interface is dropped, and 80 is closed in every mode.

| Mode | Front door | Open on the public interface |
|---|---|---|
| `public` | Caddy on 443 with a Let's Encrypt certificate (unit U2) | tcp 22, 443 |
| `tailscale` | `tailscale serve` to 127.0.0.1:3121 | tcp 22, udp 41641 |
| `cloudflare` | cloudflared (outbound only) behind Cloudflare Access | tcp 22 |
| `local` | none: an SSH tunnel to 127.0.0.1:3121 | tcp 22 |

- **Admin and board listeners stay loopback** (the kernel's 3120; the board's 3121, 3122, 3129). The front door reaches
  3121 and 3120 on loopback. The one
  exception: a LAN-only VM in `local` mode with `AIDENHQ_PUBLIC_IF=none` may publish 3121 on the LAN.
- **443 opens only once a Caddy front door is compiled** (a `caddy` service in `compose.modules.yaml`). Until then
  `public` keeps the firewall at `local`, and setup says so. An active ufw gets `allow 443/tcp` in that case, and only
  then.
- **Applying a mode.** Compile writes it to `config/exposure`. The firewall changes when `sudo bash ops/vm/setup.sh`
  runs again; it writes the mode beside `PUBLIC_IF` in `/etc/default/aidenhq-public-fw`, and the boot-time unit
  reapplies it. An unknown mode there gets SSH only.
- **The check.** `scripts/verify-security.sh` compares the live table with the mode (as root, or with passwordless sudo)
  and fails on a wildcard 443 listener outside public mode.

The full design, including the switch from public to Tailscale or Cloudflare, is
[minimal-core-install.md](minimal-core-install.md).

## Accounts and sign-in

Accounts use Better Auth inside the kernel (lean-core 3a), stored in its own SQLite file `data/kernel/auth/auth.db`
(mode 600, its `auth.secret` beside it). `kernel/src/auth-rules.ts` holds the options and sign-in rules,
`kernel/src/accounts.ts` the kernel's side and `kernel/src/admin.ts` its pages. Until 3g moves them, the board's
gate-facing sign-in listener (3129), app access and account administration open the same file with the same options
(a synced copy, `services/board/src/auth-rules.ts`; the board mounts only `data/kernel/auth/`).

- **The admin listener** is the kernel's, on `127.0.0.1:3120`, behind its own front door (`tailscale serve --https=8444`,
  or the SSH tunnel). It serves sign-in, TOTP enrolment, link claims, the approval list and card pages, batch decide, the
  owner's confirmation page and the owner message frame, server-rendered with no script. Every page sends
  `frame-ancestors 'none'` except `/owner/message`, which the board's origins may frame. Every form carries this
  listener's own Origin exactly (cookies ignore ports, so the board's origin on the same host is refused) and, signed in,
  a token bound to the session. The board (3121) reads the same session cookie and links each card to its kernel page;
  it decides nothing.
- **Two kinds of account.** An admin signs in on the admin listener with email, password and TOTP and can approve cards
  there. A user never gets the board or the kernel pages; the account only opens shared apps.
- **Credentials.** Passwords are argon2id with a 12-character minimum. An admin session is refused unless TOTP is
  enrolled (except on the enrolment routes). Sessions last 30 days, sliding.
- **Invites and resets.** An admin invites an account by email and passes on a one-time link (72 hours, `BOARD_LINK_TTL_HOURS`; a new link for
  the same email kills older ones). No email is sent. Recovery is `ops/setup.sh --reset <email>`, which sends the link
  only to the owner's chat on the owner channel and ends that account's sessions. The operator key can start setup and
  trigger resets; it never creates sessions or decides approvals.
- **Lockout.** A named peer is an address the front door names with its secret, or the tailnet: every request
  `tailscale serve` passes on (it adds `Tailscale-User-Login`) is the one peer `tailnet`, whatever login it names, so a
  varied or forged login makes no new bucket. That header is read only on the admin listener `tailscale serve` targets
  (3120, behind `--https=8444`), only from the host's loopback and never beside the front door's header (Caddy's path,
  which strips it); the gate's listener (3129) never reads it. The tailnet peer is rate-limited only, never locked or banned:
  one check in flight per email, 4 in all, and 20 failures a minute, past which it waits out the minute. **Accepted risk:**
  the tailnet is the owner's own (the owner's devices and invited members), so one member slowing another is acceptable.
  For an address the front door names, 5 failed sign-ins in 15 minutes pause that (email, listener, address) for 15
  minutes, and Better Auth's per-address rate limits apply; open sessions are unaffected. An unidentified
  peer gets hard limits instead: per email, one check in flight, two free failures and then a stepped hold (1 s, x4, at
  most 5 minutes; 429 at once, Retry-After, the wrong-password words, no hashing), and after 10 failures in an hour no
  unidentified sign-in for that email until the hour is up (the owner hears once); across every email, at most 4 checks in
  flight and 30 failures a minute. Unidentified failures never hold a named peer. **Why the tailnet header is safe to read:** only host processes reach that loopback listener. Engineer jobs are
  network-jailed (verify-security's job-network probe finds every host address and port refused), and host processes are
  already trusted; a forged header only changes which limits apply, never who is signed in. A 20-failure account-wide
  ceiling applies only on the gate-facing listener.
- **Client addresses.** The address every limit counts is the socket's, unless a proxy names the client beside its
  shared secret: the gate on 3129 (`X-AidenHQ-Gate`, `gate_board_secret`; the gate itself believes CF-Connecting-IP only on
  cloudflared's unix socket, `data/gate/socket`), the front door on the board listener (`X-AidenHQ-Edge`,
  `edge_board_secret`). X-Forwarded-For is never read.
- **Address bans.** 20 failures in 15 minutes from one named address (an IPv6 address's whole /64), across emails, refuse
  its sign-in steps on that listener for an hour. A socket address is never banned: without a front door every client
  shares it.
- **Owner notices.** More than 30 failures in an hour for one account, from any addresses, tell the owner once an hour;
  nothing locks (an account-wide lock would let anyone lock the owner out). Those alerts are capped at 5 an hour (past it,
  one line says they are held back). Every new admin session tells the owner the time and address, never capped.
- **Every route needs an admin session**, reads and file downloads included, on the admin listener and the board's.
  The internal listener uses bearer tokens.
- **Every admin is an owner.** Any ready admin writes to Paperclip with the board key, so agents act on their words,
  and their decisions on the kernel's pages decide approvals. Decisions are stamped `account:<id>` from the session, never from
  the client. The board records which account wrote what (`authored`) and shows "by <name>" for non-owner admins.
- Exactly one account is the owner (`settings.owner_email`). The board cannot demote, disable or reset the owner; only
  `--reset` does.

## Shared apps: the gate

`services/gate/gate.ts` is unprivileged: no Docker socket, a read-only compiled config (`config/gate.json`) and the
board's account map (`accounts.json`), its signing key (the vault's `identity/gate.pem`), and reach only to the apps'
loopback ports. `scripts/edge.mjs` generates its
config and cloudflared's ingress (every `share.host` to the gate, then a 404), and apply refuses any ingress rule whose
target is not the gate. Per request the gate:

1. Maps `Host` to an app (unknown host: 404). The upstream comes only from the compiled config (a PR preview's port:
   from apps-mcp's previews file, only inside the compiled band; see Pull request previews).
2. Signs the visitor in through its sign-in adapters (next section) and resolves their role.
3. Strips every inbound `x-aidenhq-*`, `tailscale-*` and `cf-access-*` header, the Access token and cookie, and auth
   cookies, so one app cannot replay a visitor's identity at another.
4. Requires a same-origin `Origin` on writes and WebSocket upgrades (sibling app hosts are same-site).
5. Proxies with `X-AidenHQ-Identity`, a token it mints for this request and this app (Ed25519, 5 minutes: `sub`, email,
   name, role; [app-identity.md](app-identity.md)), which the app verifies with the shared middleware and requires on
   every route but its health path. Streaming passes unbuffered.

Anything the gate cannot read or verify (keys, accounts, sessions) refuses with a 503.

## Pull request previews

With `settings.edge.previews: true`, each open PR on a shared app's repo also runs as a preview
([previews.ts](../../services/apps-mcp/src/previews.ts)) at `pr-<n>.<share.host>`, with exactly the app's access:

- Compile adds one ingress rule `*.<share.host>` → the gate per shared app, after the exact hosts, behind that app's own
  `aud`; the app's Access application must list `*.<share.host>` as a second domain, so the same policy admits the same
  people. The gate verifies the parent's `aud` on a preview host.
- The upstream is the one place the gate reads something besides the compiled config: apps-mcp's
  `data/previews/previews.json` (`{ "<app>-pr-<n>": <port> }`, mounted read-only) says which previews run and where. The gate
  takes a host only when its parent is a compiled host, and a port only inside the compiled preview band (39100-39399),
  so the file can't point it at the board, Paperclip or a live app.
- The visitor's role is the parent's (blocked stays blocked); the identity token's `aud` is the preview's own name, so
  preview code can't replay a visitor's token at the live app. `/.aidenhq/request(s)` stay the live app's (404 on a
  preview); My apps doesn't list previews. In password mode the board hands off to a preview host like an app host.
- A preview runs unreviewed code under its parent's host, so with previews on the gate makes every cookie an app sets
  host-only (drops its `Domain`): a preview can't toss cookies at the live app or any sibling, and a live app's cookies
  never reach its previews.

## App login modes

Each mode is a sign-in adapter in the gate (`authenticate(req) → { email, idp }`; [app-identity.md](app-identity.md)); a
new identity provider is one more adapter.

`settings.app_login` chooses how people sign in (the "gate sign-in listener" is the board's auth listener on 3129):

- **`access` (default).** The Access token for the host's audience tag (`share.aud`) is required and verified against
  the team's JWKS (signature, issuer, audience, expiry). The identity provider is configured in Access by the
  organization's administrators, never in this code. Any email Access admits is a platform member unless its account is
  disabled.
- **`password`.** For instances without single sign-on. The gate delegates sign-in to Better Auth on 3129, which serves
  only sign-in pages, Better Auth's endpoints and the handoff and app-access calls; no board route. Sign-in lives only on
  the my-apps host. Each app host gets its own host-only `__Host-` session cookie through a one-time, 60-second handoff
  code bound to that host; there is no shared cookie. The gate calls 3129 with `gate_board_secret`, caches
  `get-session` for 60 seconds, and a membership is an enabled account. A host that also has an `aud` still needs Access:
  password mode adds sign-in and never removes Access.
- **`header-jwt`.** For a front door in front of the gate: a hosting service's identity-aware proxy (for example Depoly)
  that signs people in and forwards over the tailnet. The gate verifies the proxy's signed ES256 token in
  `edge.identity.header` against `edge.identity.issuer` and its JWKS (`jwks_url`): signature (the key must be an EC key,
  never RSA), issuer, the host's `aud` (required on every host), expiry, an email, and `auth_method` when configured (so
  a magic-link sign-in is refused where only SSO is meant). A missing or invalid token is a 401; a valid identity that is
  blocked is a 403; unreachable keys are a 503. The header is stripped before the app (HTTP and WebSocket), `/.auth` is a
  404 (the front door does sign-in), and app cookies are always host-only (`Domain` removed), since sibling apps share a
  parent domain. There is no tunnel and no Access team: the gate also listens on `edge.front` (a tailnet address and
  port), so the server has zero public inbound ports; the front listener accepts tailnet traffic, so a tailnet policy
  should let only the front door's tag reach that address and port. The login is instance-wide. The gate's `sub` is
  derived from the verified email by design (as in every mode); a provider may advise keying on its own `sub` instead.

The my-apps host (`edge.my_apps.host`, required with `edge`) serves the catalog of apps the visitor is not blocked from,
and each app's Access page. A user invite link lands there to set a password.

The board writes `accounts.json` (email, name, role, disabled, plus each app's default and role assignments) on every
change. Exports are serialized, and a block, demotion, removal or disable returns only after the gate's file has it.

## Per-app roles

The gate enforces one thing: `blocked`. The app decides the rest from the headers.

- **Core roles:** `blocked`, `member`, `admin`. An app may declare custom roles in its manifest.
- **Resolution** for a visitor: `admin` for an AidenHQ admin account; else the app's assignment for that email; else the
  app's default; else `blocked`. A role the running manifest no longer declares resolves to `blocked` (fail closed), and
  the assignment is kept so it can be repaired.
- **Default role.** A new app defaults to `blocked` unless `share.default_role` or the manifest's `default_role` says
  otherwise. An app's admins can change it, never to `admin`.
- **Who manages roles.** AidenHQ admins are admins of every app and cannot be blocked or removed. They name an app's
  admins on the board (Accounts, App admins); an app admin can set any role on any email for their own app, never on an
  AidenHQ admin, and cannot create accounts or links.
- **Access page** (`/access?app=<name>` on the my-apps host, also reachable at `/.aidenhq/access` on the app host): plain
  forms where an app's admins set roles and the default, with the last 50 changes. The board decides every change; writes
  need the exact `Origin`.
- Data lives in `auth.db` (`app_roles`, `app_defaults`, `app_requests`, `app_access_log`), keyed by app name. When an app
  leaves `gate.json`, all its rows are deleted within a minute.

## App manifest

An app may ship `aidenhq-app.yaml` at its `path` in its repo:

```yaml
roles:                 # custom roles; at most 10
  - name: editor       # [a-z][a-z0-9-]{1,30}, not a core role
    meaning: Can edit roadmap items.   # one line, at most 120 characters
default_role: member   # optional: blocked, member or a declared role, never admin
```

It is app-authored, so it is untrusted and validated strictly (`services/apps-mcp/src/manifest.ts`); an invalid manifest
refuses the deploy. apps-mcp reads it at the commit that is actually running and serves it to the board, which re-fetches
every minute and keeps the last good copy. A failed fetch changes nothing; before the first good fetch no custom role is
known.

## In-app requests and roles

People ask the app's maintaining agent for changes without any access to the board.

1. The app's UI posts `/.aidenhq/request` (text up to 4000 characters) on its own host. The gate serves this path itself
   and attaches the verified email; the board re-resolves the role, stores the request and wakes the maintainer through
   the `app-request` routine. Only the app name and a count reach Paperclip; the text does not. Limits: 20 requests an
   hour per person per app and 50 open per app. `/.aidenhq/requests` shows a person their own requests and replies.
2. The maintainer (the app's owning agent, or an agent with the `app-requests` role) uses apps-mcp tools:
   `app_requests`, `app_request_reply`, `app_roles` and `app_role_set`. Request text is untrusted data.
3. The control is in code, not the handbook: `app_role_set` succeeds only for a request that belongs to that app, is still
   open, and whose gate-verified requester is an admin of that app at the moment of the change. A member's request, a
   prompt-injected issue or the agent's own idea authorizes nothing. Every change is logged with who asked, who changed
   it and old and new role.
4. The owner can ask through the chief of staff, which files a request on the owner's behalf with
   `app_request_from_owner`; the board checks the comment is the owner's own and names the app.

## In-app feedback

Apps that keep their own intake (Roadmap Keeper's feedback) need an agent awake within a minute, not at its next scheduled
run, without the text leaving the app and without giving app users' words a privileged agent.

1. After the app's server stores a submission, its page calls `notifyOwner()` (app starter `src/lib/notify-owner.ts`):
   `POST /.aidenhq/notify` on its own host, same origin. The gate serves the path, never reads the body, and tells the board
   only the host's app and the verified visitor; a visitor blocked on the app is refused. The board logs who sent it; the app
   records its submitter on its own row.
2. The board counts the notice and runs the app's `App feedback: <app>` routine through Paperclip with that count alone: the
   first at once, then at most one run per app per 10 minutes (6 an hour; the minute sync fires what waited). Paperclip
   coalesces a run into a live one.
3. `scripts/modules.mjs` compiles that routine for a shared app whose registry entry sets `feedback_to`: `coalesce_if_active`,
   autonomy `tier0` (any Tier 1 write goes to the owner), fixed product text that fences the items as people's suggestions.
4. Grants are per agent, not per routine, so the run gets a narrow agent, enforced in code at every layer:
   - compile allows the `feedback_to` agent exactly `apps: app_api, app_view` and its task tools (`task_current`, `task_get`,
     `task_comments`, `task_list`, `task_comment`, `task_finish`, `task_set_status`, `task_delegate`, the automatic
     `memory_note`): any other tool, a read included, fails, and so does that agent in another app's `api.callers`;
   - apps-mcp refuses it any app but the ones that name it, with any tool (`feedbackOnly`), and an app may give it narrower
     API paths than its other callers (`api.callers: [{agent, paths}]`);
   - what it delegates or comments for others starts with `(From app feedback, untrusted: …)` (tasks-mcp, from the grants
     table's `feedback_for`); the runner then shows the task to the Engineer as a person's suggestion, as untrusted input,
     never as the agent's or the owner's request, and the AI reviewer sees the mark in the request chain;
   - the app may scope that identity on its own API (Roadmap Keeper: intake reads and one decision endpoint only).

An app can wake only the agent its own registry entry names (the app comes from the host, the agent from the instance repo);
any signed-in member's page can send a notice without submitting, which costs at most one empty run per app per 10 minutes.

## Security notes

- Header spoofing: the gate strips every inbound identity header (a forged `X-AidenHQ-Identity` included), and apps
  refuse any request without a valid token, so a process on the host or a Docker network that reaches an app port
  directly gets nothing. Only tailnet-only apps take token-less callers, as anonymous (`AIDENHQ_ANONYMOUS=tailnet`, set by the
  platform; [app-identity.md](app-identity.md)).
- App JavaScript runs on the app's origin and can file a request as the signed-in admin. This is accepted: requests are
  limited to what that admin could ask, authorize changes only while open, and are logged.
- Email squatting: only admins create accounts, and an Access policy must verify email.
- `scripts/verify-security.sh` checks the exposure after changes.
