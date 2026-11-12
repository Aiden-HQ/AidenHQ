# Access: who can reach what

Two surfaces, two audiences. The **board** (owner UI and approvals) is for admins only. **Shared apps** built by agents
can also be opened by other people in a browser, through one small gate. Nothing else is exposed: Paperclip and the
board are never reachable through the gate, and the host keeps zero inbound ports.

## Overview

```
browser -> Cloudflare Access (optional per login mode) -> Tunnel -> cloudflared (outbound only)
        -> gate (127.0.0.1) -> the app on 127.0.0.1:<port>
admins  -> board listeners (loopback and the tailnet address) -> Better Auth session on every route
```

Sharing is optional. An instance without the `edge` setting stays tailnet-only. An app is shared when its entry in the
instance `apps.yaml` has `share.host`; modules cannot declare `share`, and changing it is a Tier 2 approval.

## Accounts and board sign-in

Accounts use Better Auth inside the board process, stored in its own SQLite file `data/board/auth.db` (mode 600).
`services/board/src/accounts.ts` is the glue.

- **Two kinds of account.** An admin signs in to the board with email, password and TOTP and can approve cards. A user
  never gets the board; the account only opens shared apps.
- **Credentials.** Passwords are argon2id with a 12-character minimum. An admin session is refused unless TOTP is
  enrolled (except on the enrolment routes). Sessions last 30 days, sliding.
- **Invites and resets.** An admin invites an account by email and passes on a one-time link (72 hours; a new link for
  the same email kills older ones). No email is sent. Recovery is `ops/setup.sh --reset <email>`, which sends the link
  only to the owner's chat on the owner channel and ends that account's sessions. The operator key can start setup and
  trigger resets; it never creates sessions or decides approvals.
- **Lockout.** 5 failed sign-ins in 15 minutes pause that (email, listener, address) for 15 minutes; open sessions are
  unaffected. A 20-failure account-wide ceiling applies only on the gate-facing listener, so strangers cannot lock the
  owner out of the board.
- **Every route needs an admin session**, reads and file downloads included, on the board listeners. The internal
  listener uses bearer tokens.
- **Every admin is an owner.** Any ready admin writes to Paperclip with the board key, so agents act on their words,
  and their taps or typed replies decide approvals. Decisions are stamped `account:<id>` from the session, never from
  the client. The board records which account wrote what (`authored`) and shows "by <name>" for non-owner admins.
- Exactly one account is the owner (`settings.owner_email`). The board cannot demote, disable or reset the owner; only
  `--reset` does.

## Shared apps: the gate

`services/gate/gate.mjs` is unprivileged: no Docker socket, a read-only compiled config (`config/gate.json`) and the
board's account map (`accounts.json`), and reach only to the apps' loopback ports. `scripts/edge.mjs` generates its
config and cloudflared's ingress (every `share.host` to the gate, then a 404), and apply refuses any ingress rule whose
target is not the gate. Per request the gate:

1. Maps `Host` to an app (unknown host: 404). The upstream comes only from the compiled config.
2. Signs the visitor in (next section) and resolves their role.
3. Strips every inbound `x-aidenhq-*`, `tailscale-*` and `cf-access-*` header, the Access token and cookie, and auth
   cookies, so one app cannot replay a visitor's identity at another.
4. Requires a same-origin `Origin` on writes and WebSocket upgrades (sibling app hosts are same-site).
5. Proxies with `X-AidenHQ-User` (verified email), `X-AidenHQ-Role`, `X-AidenHQ-Name` (display only), `X-AidenHQ-App` and
   `X-AidenHQ-Gate`, the app's own secret, which the app should require. Streaming passes unbuffered.

Anything the gate cannot read or verify (keys, accounts, sessions) refuses with a 503.

## App login modes

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

## Security notes

- Header spoofing: the gate strips every inbound identity header, and apps should reject requests without
  `X-AidenHQ-Gate`. A process on the host or a shared Docker network could still call an app port directly; apps sit
  on loopback and their own networks.
- App JavaScript runs on the app's origin and can file a request as the signed-in admin. This is accepted: requests are
  limited to what that admin could ask, authorize changes only while open, and are logged.
- Email squatting: only admins create accounts, and an Access policy must verify email.
- `scripts/verify-security.sh` checks the exposure after changes.
