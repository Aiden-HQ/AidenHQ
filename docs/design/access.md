# Access: who can reach what

Two surfaces, two audiences. The board (owner UI and approvals) is for admins only. Shared apps built by agents can also
be opened by other people in a browser, through one small gate. Nothing else is exposed: Paperclip and the board are
never reachable through the gate, and the host opens only SSH plus what its exposure mode needs.

## Overview

```
browser -> Cloudflare Access (optional per login mode) -> Tunnel -> cloudflared (outbound only)
        -> gate (127.0.0.1) -> the app on 127.0.0.1:<port>
admins  -> the exposure mode's front door -> board listener (127.0.0.1) -> Better Auth session on every route
```

Sharing is optional. An instance without the `edge` setting shares nothing: on exposure `local` or `public` the gate
still serves each exposed app to AidenHQ admins only, at `<app>.localhost:3130` or `<app>.<ip-with-dashes>.sslip.io`
([app-doors.md](app-doors.md)). An app is shared when its entry in the instance `apps.yaml` has `share.host`; modules
cannot declare `share`, and changing it is a Tier 2 approval.

## Exposure modes

How admins reach the board is one core setting, `settings.exposure` in `instance.yaml` (unset: `tailscale`). It also
decides what the host firewall (`ops/vm/public-fw.sh`, our own nft table on the public interface, input and forward)
lets in. Everything else on that interface is dropped, and 80 is closed in every mode.

| Mode | Front door | Open on the public interface |
|---|---|---|
| `public` | Caddy with a Let's Encrypt certificate for the host's public IPv4: the board on 443, the admin listener on 8446, the module door on 8447 | tcp 22, 443, 8446, 8447 |
| `tailscale` | `tailscale serve` to 127.0.0.1:3121 | tcp 22, udp 41641 |
| `local` | none: an SSH tunnel to 127.0.0.1:3121 | tcp 22 |

- **Admin and board listeners stay loopback** (the kernel's 3120 and 3129; the board's 3121, 3122); the front door
  reaches 3121 and 3120 there. The one exception: a LAN-only VM in `local` mode with `AIDENHQ_PUBLIC_IF=none` may publish
  3121 on the LAN.
- **443 and 8446 open only once a Caddy front door is compiled** (a `caddy` service in `compose.modules.yaml`). Until
  then `public` keeps the firewall at `local`, and setup says so. An active ufw gets `allow 443/tcp` and `8446/tcp` only
  then.
- **Choosing a mode.** `ops/setup.sh` (and the installer) take `--exposure public|tailscale|local`. Without it, a new
  install takes `tailscale` on a tailnet (or with `TS_AUTHKEY`), else `public`, else (no public IPv4 of its own: behind
  NAT, a Mac's VM) `local`; a rerun keeps the mode it has.
- **Switching is a rerun:** `sudo ops/setup.sh --unattended --exposure <mode>` over SSH, which stays open in every mode,
  so a switch can't lock the owner out. It commits `settings.exposure`, rewrites the `.env` URLs, and renders the firewall:
  - leaving `public`, it closes 443 and 8446 before the apply removes Caddy;
  - entering `public`, it opens them after the apply has compiled Caddy;
  - leaving `tailscale` on a host that stays on the tailnet, it turns off the board's two `tailscale serve` doors.
  Asked for `tailscale` on a host not yet signed in to a tailnet, it installs Tailscale, moves nothing else and stops
  with the sign-in step (`sudo tailscale up`, then the same command again). No board page or agent changes the mode:
  the firewall is rendered only by root's `ops/vm/setup.sh`, and setup writes the mode into `.env` (`AIDENHQ_EXPOSURE`),
  where compile refuses an instance whose `settings.exposure` differs.
- **Applying a mode.** Compile writes it to `config/exposure`. `ops/vm/setup.sh` writes the mode setup passes it (else
  the compiled one) beside `PUBLIC_IF` in `/etc/default/aidenhq-public-fw`, and the boot-time unit reapplies it. An
  unknown mode there gets SSH only.
- **The check.** `scripts/verify-security.sh` compares the live table with the mode (as root, or with passwordless sudo)
  and fails on a wildcard 443 listener outside public mode. In public mode it also checks the door as the Internet meets
  it: a publicly trusted certificate on both sites, and exactly 401 from `https://<ip>/api/board` without a session.

### The public front door (Caddy)

`scripts/front-door.ts`, compiled only with `exposure: public`, for the IPv4 in `.env` (`AIDENHQ_PUBLIC_IP`; never
`instance.yaml`, which agents can change through an apply):

- **Sites on one name:** `https://<ip>` to the board (3121), `https://<ip>:8446` to the kernel's admin listener
  (3120), which needs its own origin for its forms, `https://<ip>:8447` to the gate as the module door, and an
  app door's `<app>.<ip-with-dashes>.sslip.io` hosts ([app-doors.md](app-doors.md)). `.env` holds both URLs (`BOARD_LAN_URL`, `AIDENHQ_ADMIN_URL`), which
  the kernel reads for its hosts, origins and the board's handoff origin; compile refuses a `.env` that disagrees with the IP.
- **Certificate.** Let's Encrypt, the `shortlived` profile (160 hours), over TLS-ALPN-01 on 443: no listener on 80, no
  HTTP/3, no admin API. Each site names its ACME issuer, so Caddy's local CA is never served; `default_sni` names the IP
  for clients that send no SNI. The exit check is `ops/test/caddy-staging-issuance.sh`, on a throwaway host with a public IPv4.
- **Headers.** On 8446 Caddy sets `X-AidenHQ-Client-IP` (the socket's address) and `X-AidenHQ-Edge` (from the compose
  secret `edge_board_secret`); a set replaces a client's value. On 443 it deletes both. Both sites delete `Forwarded`,
  `X-Real-IP`, the other `X-Forwarded-*` it doesn't set and `Tailscale-User-*`.
- **Container.** `services/caddy` (pinned image), host network, the owner's uid, read-only root, `cap_drop: ALL` plus
  `NET_BIND_SERVICE`, `no-new-privileges`; writable only `data/caddy` (0700). A label holding the Caddyfile's hash
  recreates it when the file changes.
- **Setup proves it or falls back.** `ops/setup.sh` waits up to 3 minutes for both sites to answer over a trusted
  certificate. Without one, or without a public IPv4 of the host's own, it says so and falls back to `local`: the
  instance's `exposure: local` (committed), the firewall closed, loopback URLs in `.env`, an apply that drops Caddy, a
  kernel restart, and the SSH tunnel printed. Never a half-working public address. Public by default (not asked for) on
  a host with no public IPv4 is simply `local`, said in one line.
- **Leaving public mode.** The rerun of setup closes 443 and 8446 first; then its apply, whose config has no `caddy`
  service, removes the running Caddy.
- **Certificate watch.** The kernel checks `https://<ip>` hourly with a verified handshake (`kernel/src/front-door.ts`):
  under 48 hours left, or a certificate that fails to verify, tells the owner, at most once every 12 hours.

## The AidenHQ MCP

The board's `/mcp` (bearer-only, never cookies) lets an admin's own Claude or Codex manage the instance
([docs/setup.md](../setup.md#manage-aidenhq-from-your-claude)).

- **Token type.** The kernel is the OAuth authorization server on the admin origin: `/oauth2/{authorize,token,register,revoke}`,
  the consent page `/oauth/consent` and `/.well-known/oauth-authorization-server` (clients register by dynamic
  registration or a client ID metadata document). The board serves `/mcp` and `/.well-known/oauth-protected-resource`.
  A token is bound to the board's `/mcp` audience and to an admin account; the board asks the kernel to verify it on
  each call (writes bypass the cache). Disabling or resetting the account, or Revoke on the Accounts page, ends it.
- **Open routes.** `/oauth2/*`, `/oauth/consent` and the well-known path are the exception to "every admin-listener
  route needs a signed-in admin": a client calls them before it has a token. Authorize and consent still require the
  password and TOTP sign-in; token, register and revoke are protocol endpoints.
- **Decide rule.** A card is decided by channel token, or by a signed-in admin through the board (the one approvals UI:
  his board session on a card's Approve or Reject, one card or a batch, or his MCP token at its `/mcp`), each through the
  kernel's `/v1/owner/decide` as `account:<id>` (`stale:account:<id>` closes a dead or duplicate card and is never a veto),
  always against the digest the client read. The kernel's old approval addresses (`/`, `/approvals`, `/approvals/<id>`)
  redirect to the board.
- **Front doors.** `public` (Caddy: all of 443 to the board, all of 8446 to the admin listener) and `tailscale` (the
  same two doors) pass these paths with no change.

## Accounts and sign-in

Accounts use Better Auth inside the kernel, stored in its own SQLite file `data/kernel/auth/auth.db` (mode 600, its
`auth.secret` beside it). Only the kernel opens it. `kernel/src/auth-rules.ts` holds the options and sign-in rules,
`accounts.ts` accounts, sessions, links, handoffs and the gate's account map, `admin.ts` the admin pages, `signin.ts` the
gate-facing sign-in listener (127.0.0.1:3129), `modules/apps-platform/src/app-access.ts` (the apps platform's, loaded by
the kernel) per-app roles and in-app requests, and `auth-api.ts` the
backplane routes modules use (the board's session and account administration, apps-mcp's in-app requests, `ops/setup.sh`'s
setup link and resets with the operator key).

- **The board on its own origin.** The board mounts no accounts file. `/auth/start` on the board sets a state nonce in
  its own cookie and sends the browser to the kernel's `/auth/handoff?to=<board origin>&state=`. There a ready admin
  (otherwise sign-in first) gets a one-time code (60 s, single use) bound to that origin, the module and the state; `to`
  must be exactly one of the installed UI origins (`AIDENHQ_BOARD_ORIGINS`, default `BOARD_LAN_URL`'s origin), so there
  is no open redirect. The board exchanges the code on the backplane (`POST /v1/auth/exchange`, `gateway_board_key`),
  only in the browser whose state cookie matches, and keeps the session token in its own host-only cookie
  (`__Host-aidenhq-board` on https). Every board request checks it with the kernel (`POST /v1/auth/session`, believed for
  5 seconds), so the admin listener's sign-out, a disable, a role change or a reset ends it. The kernel's own session
  cookie, which reaches the board's origin too, is never read there. Account administration on the board goes to the
  kernel as that admin's session (`/v1/accounts/*`).
- **The admin listener** is the kernel's, on `127.0.0.1:3120`, behind its own front door (8446 or the SSH tunnel). It
  serves sign-in, TOTP enrolment, link claims, the owner's confirmation page and the owner message frame, server-rendered
  with no script; its old approval addresses redirect to the board. Every page sends `frame-ancestors 'none'` except
  `/owner/message`, which the board's origins may frame. Every form carries this listener's own Origin exactly (cookies
  ignore ports, so the board's origin on the same host is refused) and, signed in, a token bound to the session.
- **Two kinds of account.** An admin signs in on the admin listener with email, password and TOTP and approves cards
  on the board. A user never gets the board or the kernel pages; the account only opens shared apps.
- **Credentials.** Passwords are argon2id with a 12-character minimum. An admin session is refused unless TOTP is
  enrolled (except on the enrolment routes). Sessions last 30 days, sliding.
- **Invites and resets.** An admin invites an account by email and passes on a one-time link (72 hours, 24 on public
  exposure; `AIDENHQ_LINK_TTL_HOURS`; a new link for the same email kills older ones). No email is sent. Recovery is
  `ops/setup.sh --reset <email>`, which sends the link only to the owner's chat on the owner channel and ends that
  account's sessions. The operator key can start setup and trigger resets; it never creates sessions or decides approvals.
- **Client addresses.** The address every limit counts is the socket's, unless a proxy names the client beside its
  shared secret: the gate on 3129 (`X-AidenHQ-Gate`, `gate_board_secret`; the gate itself believes CF-Connecting-IP only
  on cloudflared's unix socket, `data/gate/socket`) and the front door on the board listener (`X-AidenHQ-Edge`,
  `edge_board_secret`). X-Forwarded-For is never read.
- **Lockout** (`kernel/src/auth-rules.ts`, in memory):
  - An address a front door names: 5 failed sign-ins in 15 minutes pause that (email, listener, address) for 15 minutes;
    Better Auth's per-address rate limits also apply; open sessions are unaffected. 20 failures in 15 minutes from one
    named address (an IPv6 address's whole /64), across emails, refuse its sign-in and link-claim steps on that listener
    for an hour. A socket address is never banned: without a front door every client shares it.
  - The tailnet: every request `tailscale serve` passes on (it adds `Tailscale-User-Login`) is the one peer `tailnet`,
    whatever login it names. It is rate-limited only, never locked or banned: one check in flight per email, 4 in all, 20
    failures a minute, plus Better Auth's 20-a-minute limit on the sign-in steps. The header is read only on the admin
    listener `tailscale serve` targets (3120), only from the host's loopback and never beside the front door's header;
    the gate's listener (3129) never reads it. Accepted risk: the tailnet is the owner's own, so one member slowing
    another is acceptable. A forged header only changes which limits apply, never who is signed in.
  - An unidentified peer gets hard limits: per email, one check in flight, two free failures and then a stepped hold
    (1 s, x4, at most 5 minutes; 429 at once with Retry-After), and after 10 failures in an hour no unidentified sign-in
    for that email until the hour is up (the owner hears once); across every email, at most 4 checks in flight and 30
    failures a minute. Unidentified failures never hold a named peer. A 20-failure account-wide ceiling applies only on
    the gate-facing listener.
  - Codes, per account, whatever the peer: past 5 wrong codes in 15 minutes the next code check waits (1 s, doubling, at
    most a minute); one code check per account runs at a time (another gets 429, Retry-After: 1).
- **Owner notices.** More than 30 failures in an hour for one account, from any addresses, tell the owner once an hour;
  nothing locks the account (an account-wide lock would let anyone lock the owner out). Failure alerts are capped at 5 an
  hour (past it, one line says they are held back). Every new admin session tells the owner the time and address, never capped.
- **Every route needs an admin session**, reads and file downloads included, on the admin listener and the board's. The
  internal listener uses bearer tokens.
- **Every admin is an owner.** Any ready admin writes to Paperclip as the owner (through the kernel's `/v1/cp/owner`; the
  board holds no Paperclip key), so agents act on their words, and their decisions on the board decide
  approvals. Decisions are stamped `account:<id>` from the session, never from the client. The board records which
  account wrote what (`authored`) and shows "by <name>" for non-owner admins.
- Exactly one account is the owner (`settings.owner_email`). The board cannot demote, disable or reset the owner; only
  `--reset` does.

## Shared apps: the gate

`modules/apps-platform/gate/gate.ts` is unprivileged: no Docker socket, a read-only compiled config (`config/gate.json`)
and the board's account map (`accounts.json`), its signing key (the vault's `identity/gate.pem`), and reach only to the
apps' loopback ports. `scripts/edge.ts` generates its config and cloudflared's ingress (every `share.host` to the gate,
then a 404), and apply refuses any ingress rule whose target is not the gate. Per request the gate:

1. Maps `Host` to an app (unknown host: 404). The upstream comes only from the compiled config (a PR preview's port from
   apps-mcp's previews file, only inside the compiled band; see Pull request previews).
2. Signs the visitor in through its sign-in adapters (next sections) and resolves their role.
3. Strips every inbound `x-aidenhq-*`, `tailscale-*` and `cf-access-*` header, the Access token and cookie, and auth
   cookies, so one app cannot replay a visitor's identity at another.
4. Requires a same-origin `Origin` on writes and WebSocket upgrades (sibling app hosts are same-site).
5. Proxies with `X-AidenHQ-Identity`, a token it mints for this request and this app (Ed25519, 5 minutes;
   [app-identity.md](app-identity.md)), which the app verifies with the shared middleware and requires on every route
   but its health path. Streaming passes unbuffered.

Anything the gate cannot read or verify (keys, accounts, sessions) refuses with a 503.

## Board panels

An app can be pinned into the board's nav: its instance `apps.yaml` entry sets `panel: <label>` (1-24 characters). The
board shows the label in the top bar (and the phone tab strip) as a link to the app's own URL, taken from apps-mcp's
status row (`https://<share.host>` for a shared app), and opens it in a new tab.

- **A link, never a frame.** The board's CSP has no `frame-src` and sends `frame-ancestors 'none'`; the gate's sign-in
  pages and the handoff do too, and the `__Host-` cookies are `SameSite=Lax`, so a cross-site frame could neither start
  nor finish a handoff. Opening the app's host at top level is the normal flow: the my-apps sign-in, the one-time code
  bound to that host and browser, the host-only cookie. An app without `share.host` is a link to the apps node on the
  tailnet, as on the Apps tab.
- **Who pins.** `panel` is a sensitive field (`isSensitive`): `app_create` refuses it, so an agent proposes a pin and the
  Platform Engineer applies it as an `apps.yaml` change through the normal card. A module app may not set it (compile
  refuses it, as with `share`). Unpinning is deleting the line.

## Pull request previews

With `settings.edge.previews: true`, each open PR on a shared app's repo also runs as a preview
([previews.ts](../../modules/apps-platform/apps-mcp/src/previews.ts)) at `pr-<n>.<share.host>`, with exactly the app's access:

- Compile adds one ingress rule `*.<share.host>` to the gate per shared app, after the exact hosts, behind that app's own
  `aud`; the app's Access application must list `*.<share.host>` as a second domain. The gate verifies the parent's
  `aud` on a preview host.
- The upstream is the one place the gate reads something besides the compiled config: apps-mcp's
  `data/previews/previews.json` (`{ "<app>-pr-<n>": <port> }`, mounted read-only) says which previews run and where. The
  gate takes a host only when its parent is a compiled host, and a port only inside the compiled preview band
  (39100-39399), so the file can't point it at the board, Paperclip or a live app.
- The visitor's role is the parent's (blocked stays blocked); the identity token's `aud` is the preview's own name, so
  preview code can't replay a visitor's token at the live app. `/.aidenhq/request(s)` stay the live app's (404 on a
  preview); My apps doesn't list previews. In password mode the board hands off to a preview host like an app host.
- A preview runs unreviewed code under its parent's host, so with previews on the gate makes every cookie an app sets
  host-only (drops its `Domain`): a preview can't toss cookies at the live app or any sibling, and a live app's cookies
  never reach its previews.

## App login modes

Each mode is a sign-in adapter in the gate ([app-identity.md](app-identity.md)); `settings.app_login` chooses one for the
instance. The gate sign-in listener is the kernel's on 127.0.0.1:3129; the gate serves the sign-in pages itself
(`modules/apps-platform/gate/signin-pages.ts`) and passes only their steps on.

- **`access` (default).** The Access token for the host's audience tag (`share.aud`) is required and verified against
  the team's JWKS (signature, issuer, audience, expiry). The identity provider is configured in Access by the
  organization's administrators, never in this code. Any email Access admits is a platform member unless its account is
  disabled.
- **`password`.** For instances without single sign-on. The gate delegates sign-in to Better Auth on 3129, which serves
  only Better Auth's endpoints and the handoff and app-access calls; no page and no admin or board route. Sign-in lives
  only on the my-apps host. Each app host gets its own host-only `__Host-` session cookie through a one-time, 60-second
  handoff code bound to that host; there is no shared cookie. The gate calls 3129 with `gate_board_secret`, caches
  `get-session` for 60 seconds, and a membership is an enabled account. A host that also has an `aud` still needs
  Access: password mode adds sign-in and never removes Access.
- **`header-jwt`.** For a front door in front of the gate: a hosting service's identity-aware proxy that signs people in
  and forwards over the tailnet. The gate verifies the proxy's signed ES256 token in `edge.identity.header` against
  `edge.identity.issuer` and its JWKS (`jwks_url`): signature (the key must be an EC key, never RSA), issuer, the host's
  `aud` (required on every host), expiry, an email, and `auth_method` when configured (so a magic-link sign-in is
  refused where only SSO is meant). A missing or invalid token is a 401; a valid identity that is blocked is a 403;
  unreachable keys are a 503. The header is stripped before the app (HTTP and WebSocket), `/.auth` is a 404 (the front
  door does sign-in), and app cookies are always host-only (`Domain` removed), since sibling apps share a parent domain.
  There is no tunnel and no Access team: the gate also listens on `edge.front` (a tailnet address and port), so the
  server has zero public inbound ports; a tailnet policy should let only the front door's tag reach that address and port.

The my-apps host (`edge.my_apps.host`, required with `edge`) serves the catalog of apps the visitor is not blocked from,
and each app's Access page. A user invite link lands there to set a password.

The board writes `accounts.json` (email, name, role, disabled, plus each app's default and role assignments) on every
change. Exports are serialized, and a block, demotion, removal or disable returns only after the gate's file has it.

## Test-user sign-in

An agent can see an AidenHQ app signed in, or prove a page-level flow end to end — the page's own JavaScript, its
same-origin `fetch("/.aidenhq/notify")` and the gate's real notify handler — without a person at a sign-in screen. Two
callers use it, both only on instances that name a test user: the `app_page_canary` tool on the `apps` connection (one
feedback submission), and a module's job tool serving its own pass (the UI Reviewer's signed-in review, read-only).

1. **The setting.** `settings.edge.test_user: { email, apps }` names one non-owner account (e.g. `canary@aidenhq.test`,
   non-routable) and the shared apps it may reach. Compile refuses the owner's own address, an empty or repeated app
   list, and an app that isn't a shared app with a `share.host`; it then writes `test_user` and `test_listener` (the
   listener's own bridge address and port) into the gate's config. With no setting neither key is written: no route
   mints a session and no test listener binds or serves a page, including straight after a product deploy that lands
   this code ahead of the setting.
2. **The account.** The kernel creates the email as a `test` account row on first use: no password, invite or mailbox.
   It is never the owner and never an admin.
3. **The session.** `POST /v1/test-session` on the kernel's internal API takes `{ app, minutes? }` from a module holding
   `kernel.test-session`, made while it serves a live job's tool call in flight, and checks the job's agent holds role
   `app-tester` (its grants row, never a key list and never the request), the app is in `test_user.apps`, and the task is
   open and assigned to that agent. The kernel sets the **live-app mode**: `read` for every caller, and `test-write` only
   for `apps.app_page_canary`'s own submission. AidenHQ apps never get more: a body asking for `test-write` or `any` is
   refused (400), whatever the app's own settings say. It creates a Better Auth session for the test account, 15 minutes
   by default and at most 60 (the canary's is always 15), with a `test:` marker, and returns a one-time, 60-second,
   single-use, host- and state-bound handoff code. `POST /v1/test-session/revoke` ends it; so does the task finishing, and the tool revokes in
   a `finally` whatever the browser did. `test_session_minted` and `test_session_revoked` audit rows carry the agent key,
   task id, app, session id and expiry — never a cookie, token or code value.
4. **The listener.** The gate's test listener binds only `test_listener.address` (a bridge gateway the front door never
   proxies, reached only from the canary browser's network and the agent computers' network), and serves nothing without
   a live test session: it redeems
   `/.auth/handoff?code=…&state=…` with the kernel once and sets a host-only `__Host-` cookie on
   `<app>.canary.localhost`. It never accepts the front-door identity header and never an anonymous request (401, no
   page). It checks the cookie with the kernel's session check, the same way password mode checks a session — no new
   shared secret — and refuses every other host. The session's mode decides each request and upgrade: `read` serves
   `GET`/`HEAD` only (no other method, no WebSocket, no `POST /.aidenhq/notify`); `test-write` refuses `DELETE` and paths
   matching `delete|destroy|remove|purge|archive|cancel|refund|pay|checkout|billing|invite|send|transfer|publish|deploy`.
   A refusal is 403 `blocked by live-app mode` and never reaches the app. The cookie lives as long as its session. The
   normal gate and the front door are unchanged.
5. **The identity.** Each request is minted per request by the gate's own signer as the test user, `role: "member"`, for
   that one app (`idp: "test"`). Never admin, never the board. The cookie is valid only on the test listener's origin
   for the named app's host: not at the front door, not at the app's public URL (a different host), not for another app
   (403/404). An expired or revoked session is a 401.

**On an existing host, once.** `ops/vm/setup.sh` installs the canary network's unit
(`ops/units/aidenhq-canary-net.service`) and script on a new host, but an apply does not re-run it. Before the setting
is added, an upgraded host installs them once (sudo, as the CI runner's own network is installed on an upgrade):

```sh
sudo install -m0755 ops/vm/canary-net.sh /usr/local/sbin/aidenhq-canary-net
sudo install -m0644 ops/units/aidenhq-canary-net.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aidenhq-canary-net
```

Without it there is no `aidenhq-canary` bridge, the gate cannot bind `10.231.6.1`, and `app_page_canary` cannot start a
browser: the canary stays unavailable (nothing opens or serves) rather than running on an unguarded network. The
setting's own apply card says so.

An agent computer reaches the listener too (`10.231.6.1:3132` from `ahq-computers`, and nothing else new):
`ops/vm/computer-net.sh` opens it and `ops/vm/canary-net.sh` lets it through. An upgraded host installs both scripts
again and re-runs them once:

```sh
sudo install -m0755 ops/vm/computer-net.sh /usr/local/sbin/aidenhq-computer-net
sudo install -m0755 ops/vm/canary-net.sh /usr/local/sbin/aidenhq-canary-net
sudo install -m0644 ops/units/aidenhq-ci-net.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl restart aidenhq-computer-net aidenhq-ci-net aidenhq-canary-net
```

With the host's `ufw` active, `ops/vm/ufw-rules.sh` also opens the listener to those two bridges only
(`10.231.6.1:3132` from `ahq-canary` and `ahq-computers`); `ops/vm/setup.sh` runs it on a new host. On an upgraded host, run it once the
same way (`sudo bash ops/vm/ufw-rules.sh tailscale`, or `public` for a public exposure), or `ufw`'s default deny keeps
the browser from reaching the listener.

Negative checks are part of the acceptance, not polish: no setting means the mint refuses and the listener serves no
page; an unauthenticated browser gets 401; another app's host gets 403/404; an expired or revoked session gets 401; the
public app URL refuses the test cookie; a test account is not an admin and has no board access.

## Per-app roles

The gate enforces one thing: `blocked`. The app decides the rest from the identity token's `role`.

- **Core roles:** `blocked`, `member`, `admin`. An app may declare custom roles in its manifest.
- **Resolution** for a visitor: `admin` for an AidenHQ admin account; else the app's assignment for that email; else the
  app's default; else `blocked`. A role the running manifest no longer declares resolves to `blocked` (fail closed), and
  the assignment is kept so it can be repaired.
- **Default role.** A new app defaults to `blocked` unless `share.default_role` or the manifest's `default_role` says
  otherwise. An app's admins can change it, never to `admin`.
- **Who manages roles.** AidenHQ admins are admins of every app and cannot be blocked or removed. They name an app's
  admins on the board (Accounts, App admins); an app admin can set any role on any email for their own app, never on an
  AidenHQ admin, and cannot create accounts or links.
- **Access page** (`/access?app=<name>` on the my-apps host, also at `/.aidenhq/access` on the app host): plain forms
  where an app's admins set roles and the default, with the last 50 changes. The board decides every change; writes need
  the exact `Origin`.
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

It is app-authored, so it is untrusted and validated strictly (`modules/apps-platform/apps-mcp/src/manifest.ts`); an
invalid manifest refuses the deploy. apps-mcp reads it at the commit that is actually running and serves it to the
board, which re-fetches every minute and keeps the last good copy. A failed fetch changes nothing; before the first good
fetch no custom role is known.

## In-app requests and roles

People ask the app's maintaining agent for changes without any access to the board.

1. The app's UI posts `/.aidenhq/request` (text up to 4000 characters) on its own host. The gate serves this path itself
   and attaches the verified email; the board re-resolves the role, stores the request and wakes the maintainer through
   the `app-request` routine. Only the app name and a count reach Paperclip; the text does not. Limits: 20 requests an
   hour per person per app and 50 open per app. `/.aidenhq/requests` shows a person their own requests and replies.
2. The maintainer (the app's owning agent, or an agent with the `app-requests` role) uses apps-mcp tools:
   `app_requests`, `app_request_reply`, `app_roles` and `app_role_set`. Request text is untrusted data.
3. The control is in code, not the handbook: `app_role_set` succeeds only for a request that belongs to that app, is
   still open, and whose gate-verified requester is an admin of that app at the moment of the change. A member's
   request, a prompt-injected issue or the agent's own idea authorizes nothing. Every change is logged with who asked,
   who changed it and old and new role.
4. The owner can ask through the chief of staff, which files a request on the owner's behalf with
   `app_request_from_owner`; the board checks the comment is the owner's own and names the app.

## In-app feedback

Apps that keep their own intake (Roadmap Keeper's feedback) wake an agent within a minute, without the text leaving the
app and without giving app users' words a privileged agent.

1. After the app's server stores a submission, its page calls `notifyOwner()` (app starter `src/lib/notify-owner.ts`):
   `POST /.aidenhq/notify` on its own host, same origin. The gate serves the path, never reads the body, and tells the
   board only the host's app and the verified visitor; a visitor blocked on the app is refused.
2. The board counts the notice and runs the app's `App feedback: <app>` routine through Paperclip with that count alone:
   the first at once, then at most one run per app per 10 minutes (the minute sync fires what waited). Paperclip
   coalesces a run into a live one.
3. `scripts/modules.ts` compiles that routine for a shared app whose registry entry sets `feedback_to`:
   `coalesce_if_active`, autonomy `tier0` (any Tier 1 write goes to the owner), fixed product text that fences the items
   as people's suggestions.
4. Grants are per agent, not per routine, so the run gets a narrow agent, enforced in code at every layer:
   - compile allows the `feedback_to` agent exactly `apps: app_api, app_view` and its task tools (`task_current`,
     `task_get`, `task_comments`, `task_list`, `task_comment`, `task_finish`, `task_block`, `task_cancel`, `task_delegate`, the
     automatic `memory_note`): any other tool, a read included, fails, and so does that agent in another app's `api.callers`;
   - apps-mcp refuses it any app but the ones that name it, with any tool (`feedbackOnly`), and an app may give it
     narrower API paths than its other callers (`api.callers: [{agent, paths}]`), down to exact routes (the method, then
     `{name}` for one segment; `modules/apps-platform/apps-mcp/src/api.ts`);
   - what it delegates or comments for others starts with `(From app feedback, untrusted: ...)` (tasks-mcp, from the
     grants table's `feedback_for`); the dispatcher (`modules/dispatch`) then shows the task to the Engineer as a person's suggestion, as
     untrusted input, never as the agent's or the owner's request, and the AI reviewer sees the mark in the request chain.

An app can wake only the agent its own registry entry names (the app comes from the host, the agent from the instance
repo); any signed-in member's page can send a notice without submitting, which costs at most one empty run per app per
10 minutes.

## Security notes

- Header spoofing: the gate strips every inbound identity header (a forged `X-AidenHQ-Identity` included), and apps
  refuse any request without a valid token, so a process on the host or a Docker network that reaches an app port
  directly gets nothing. Only tailnet-only apps take token-less callers, as anonymous (`AIDENHQ_ANONYMOUS=tailnet`, set
  by the platform; [app-identity.md](app-identity.md)).
- App JavaScript runs on the app's origin and can file a request as the signed-in admin. This is accepted: requests are
  limited to what that admin could ask, authorize changes only while open, and are logged.
- Email squatting: only admins create accounts, and an Access policy must verify email.
- `scripts/verify-security.sh` checks the exposure after changes.
- The fast chat lane's tool calls: the chat-lane module's own token (role `kernel.lane`) plus the agent it speaks for
  (`x-aidenhq-lane-agent`). The kernel takes that agent's grants and roles from the grants table, on its chat task, and
  refuses an agent with no chat task (`kernel/src/identity.ts` laneCaller). The call carries no job, so every job-only route
  refuses it: memory, settings, waits and model calls billed to a run.
- Agent memory (`POST /v1/memory/:op`, `kernel/src/memory.ts`): only a module with `kernel.memory` serving a live job's
  `memory_<op>` call reaches it, and only that job's own agent's document, from the grants table; another agent's only for
  read and a removals-only rewrite, by a `librarian`. Every fact passes one check (length, secrets redacted, nothing
  instruction-shaped), and its readers get it fenced as data. `GET /v1/memory/:key` is for the board and the lane.
