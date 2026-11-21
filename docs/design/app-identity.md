# App identity: one signed token, pluggable sign-in

Whoever signs a visitor in, a shared app sees one short-lived signed token, verified by a tiny shared middleware with a
public key. Nothing an app holds can mint identity. Companion to [access.md](access.md).

## The token

A JWT (compact JWS), EdDSA (Ed25519) via `node:crypto`, sent to the app in `X-AidenHQ-Identity`. Claims:

| claim | value |
|---|---|
| `iss` | `aidenhq-gate` (people) or `aidenhq-apps` (agents) |
| `aud` | the app's name (registry `name`) |
| `sub` | a stable opaque id: people `u_` + 22 chars of base64url(sha256(`aidenhq-user:` + lowercased verified email), `subOf` in the gate); agents `agent:<key>` |
| `kind` | `person` or `agent` |
| `email`, `name` | display and contact (agents: no email; `name` is the agent key) |
| `role` | the gate's resolved role on this app (people); `admin` (`app_api`) or `member` (`app_view`) for agents |
| `idp` | `access`, `password`, `header-jwt` (people), `apps-mcp` (agents) |
| `iat`, `exp` | `exp = iat + 300` |
| `methods`, `path` | agents only: what the token may do (below) |

The JWS header is `{alg: "EdDSA", kid, typ: "JWT"}`. Minted per request: browsers never see it (the gate adds it on the
way to the app), and the app sees each one at most five minutes.

`sub` comes from the verified email, not an account row, so it is the same under every identity provider and stays the
same when an Access-admitted person later gets an account. It is opaque so apps key data on it rather than the email.
It is deterministic, not private; an email change or reassignment makes or inherits a `sub`, and moving to account ids
would mean migrating apps' stored `sub`s.

## Identity providers (the gate's adapters)

`modules/apps-platform/gate/gate.ts` has one adapter per sign-in method:
`authenticate(req, cfg, host, aud) → { email, idp } | null | { status, msg }`, with an email the provider verified.

- `access`: the Cloudflare Access JWT for the host's audience tag (RS256, team JWKS).
- `header-jwt`: a front door's signed identity header (`cfg.identity`: header, issuer, JWKS, optional `auth_method`), see access.md.
- `password`: the board's Better Auth session through the auth listener (3129).

The gate's `login` setting (`settings.app_login`, `LOGINS` in `scripts/edge.ts`: `access`, `password`, `header-jwt`) and
the host's `aud` decide which adapters run, and all of them must pass: a `password` host with an `aud` still needs Access
(checked before `/.auth` routing), then the session. When both run, Access only admits and the password session
identifies; the two emails may differ. The gate then maps the email to the account and role (accounts.json), refuses
`blocked`, and mints. A new method is one more adapter object, a `settings.app_login` value and its place in
`authorize()`; the token, the middleware and the apps don't change. The provider's own token (the Access JWT and cookie,
Better Auth cookies) never reaches an app: the gate strips `cf-access-*`, `x-aidenhq-*`, `tailscale-*` and auth cookies inbound.

## What stays the gate's job

Host to app mapping; sign-in (adapters); coarse entry (account disabled, role `blocked` gives 403, my-apps list, Access
page, in-app requests); same-origin writes and upgrades; stripping inbound identity. The app owns everything finer: read
versus write, per-user data and history, keyed by `req.user.sub` and `req.user.role`.

## The middleware

`modules/apps-platform/starter/aidenhq-identity.mjs` (the starter and `services/computer/images/agent-base/app-starter/`
carry it; every app copies it unchanged). No dependencies:

- reads the public keys from `/run/secrets/AIDENHQ_IDENTITY_KEYS` (re-read when its mtime changes);
- verifies `alg` EdDSA, a known `kid`, the signature, that the key's issuer equals `iss` (never anything in the token),
  `aud` = `AIDENHQ_APP`, `exp` not passed, `iat` not in the future (60 s leeway), integer times, `exp > iat` and a
  lifetime of at most 300 s, a well-formed `sub` and a role that isn't `blocked`;
- binds issuer to kind: `aidenhq-gate` may only assert `person`, `aidenhq-apps` only `agent` (`sub` = `agent:<key>`), so
  a leaked agent key can never impersonate a person;
- enforces an agent token's `methods` and `path` when present (403);
- exposes `identify(req) → { sub, email, name, role, kind }` (throws with a status) and `protect(handler, { health })`,
  which wraps the app's whole request handler (and its upgrade handler), sets `req.user` or answers 401. Only `GET` on
  the exact health path passes without a token. Long-lived connections (SSE, WebSocket) are checked once, at request or
  upgrade time.

**Tailnet-only apps** (`expose: true`, no `share.host`) are reached by tailnet browsers through apps-edge, which cannot
mint tokens. For them only, and only when the apps' tailnet node really is the instance's door (`exposure: tailscale`,
the node's join key in the vault, so compile writes `config/apps-node` = `tailnet`, and `APPS_URL_BASE` set; apps-mcp
re-reads it at every deploy and probe, anything else fails closed), apps-mcp sets `AIDENHQ_ANONYMOUS=tailnet` and
`identify` returns `null` for a request with no token (a bad token still fails). The app treats `null` as an anonymous
caller who gets only what it gives anyone (reads, a public form); every privileged route (agent API, admin writes) still
needs a valid token. apps-mcp sets `AIDENHQ_APP` and `AIDENHQ_ANONYMOUS` itself after the sandbox, overwriting anything
the app's compose declared; the platform opts an app out, never the app itself. Adding `share.host` takes a redeploy,
which drops it. In every other mode (`local`, `public`, `cloudflare`, or tailscale without the node) the only ways to an
app's port are the host's loopback and Docker bridges, so the app requires a signed identity and the deploy's identity
probe requires it to refuse a token-less request.

**An app with no HTTP surface** — not exposed, no `share.host`, no `health.url` (a database, like the warehouse) — is
probed the same way, and a socket that answers HTTP is still judged. A database answers silence to an HTTP request, so
such an app's socket is identified positively as PostgreSQL: it must decline SSL and then answer a startup message with
a complete, well-formed PostgreSQL protocol frame — a truncated header, a malformed body, an authentication code the
protocol does not define or without the payload that code carries (AuthenticationOk, cleartext, GSS and SSPI carry none;
MD5 a four-byte salt; SASL a non-empty mechanism list, each name NUL-terminated and ended by a separate NUL), or an error
without its severity, SQLSTATE and message is not identification. An SSLRequest
reply alone is not enough — a TLS listener offers SSL too, and a multiprotocol listener could serve HTTPS on the same
port — so a socket that offers SSL stays closed, and a socket identified as PostgreSQL is also sent TLS hellos: one per
hostname (the app's, and its share host's when distinct), each a valid single-name SNI list, and one with no name. A
listener that serves HTTPS only for a recognized name answers that name's hello, and a router that serves its default
route when SNI is absent and closes an unknown name answers the unnamed one. Either answer means the port speaks TLS, so
it is a web app and stays closed too. Only a socket identified
as a database alone is skipped, with a non-hard finding; silence alone is never enough. On any other app, or for any socket
not identified that way, the same silence — `closed`, `silent` — fails closed.

## Agents (app_api, app_view)

apps-mcp mints the agent's token itself (`modules/apps-platform/apps-mcp/src/identity.ts`) with its own Ed25519 key
(`iss` `aidenhq-apps`, `sub` `agent:<key>`, `kind` agent, `idp` `apps-mcp`), in the same header; it is never shown to the
agent and is redacted from any response that echoes it.

- `app_api`: `role: admin`, `methods` the call's one method, `path` the exact path. Only agent keys in the app's
  `api.callers` and only under `api.paths`, enforced in apps-mcp. `api` is `{ callers, paths }`; there is no static
  `api.token` (the registry refuses one).
- `app_view`: `role: member`, `methods: [GET, HEAD]`.

The key is separate from the gate's because apps-mcp holds the Docker socket and sits on bridge networks the gate's
loopback listener doesn't reach, so a key hidden from it would not be hidden. The middleware accepts it for agent
identities only, so apps-mcp cannot impersonate people. An agent's role is fixed by the tool, not granted per caller.

## Keys and rotation

The vault dir `identity/` holds `gate.pem` and `apps.pem` (Ed25519 private keys, PKCS#8, mode 600) and `keys.json` (the
public keys as a JWK set; each key has `kid` = first 16 characters of the base64url SHA-256 of its raw public key and
`iss`). `scripts/identity.ts` (run by `scripts/compile.ts` on every apply) creates a missing private key and rewrites
`keys.json` in place (a single-file bind mount pins the inode) from every `gate*.pem` and `apps*.pem` in the dir. Mounts:

- the gate: `identity/gate.pem` (read-only), nothing else of the dir;
- apps-mcp: `identity/apps.pem` (read-only), plus the host path of `keys.json` to mount into apps;
- every app: `keys.json` as the compose secret `AIDENHQ_IDENTITY_KEYS`, and `AIDENHQ_APP=<name>` in its environment.

Rotation: rename `gate.pem` to `gate.old.pem`; apply (a new `gate.pem`; `keys.json` lists both; the gate reads its key
on start, so recreate it); after five minutes delete `gate.old.pem` and apply again. The same for `apps.pem` (restart
apps-mcp). A compromised key is deleted, never renamed (or `keys.json` keeps trusting it), then apply and restart the
signer. There is no JWKS over HTTP: apps cannot reach the host's loopback, and the mounted file works offline. Public
keys are not secret; the file sits in the vault only to share its mount path.

## Failure modes

- `keys.json` missing, unreadable or torn mid-write: the middleware refuses (401/503) and re-reads on the next request.
- The gate's key missing: the gate answers 503 for app hosts. apps-mcp's key missing: `app_api`/`app_view` fail with a clear error.
- An app without the middleware: anything that reaches its port is trusted. Shared apps sit on loopback and their own
  networks (no app may `connects` to a shared app). Fleet Steward's agent review flags an app that doesn't verify
  `X-AidenHQ-Identity` with the shared middleware, and `scripts/verify-security.sh` checks that every shared app's port
  (and each door's app) refuses a request with a forged token and that the gate drops a forged `X-AidenHQ-Identity`.
