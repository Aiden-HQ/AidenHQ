# App identity: one signed token, pluggable sign-in

Status: approved direction (2026-11-13), built in this change. Companion to [access.md](access.md).

## Why

Today a shared app trusts plain headers (`X-AidenHQ-User`, `-Role`, `-Name`, `-App`) because they arrive beside a per-app
secret (`X-AidenHQ-Gate`), and agents reach an app's API with a second per-app static secret (`api.token`, e.g.
`ROADMAP_AGENT_TOKEN`). Two long-lived bearer secrets per app, each a full impersonation key if it leaks (an app's logs, a
crash dump, a prompt-injected agent echoing a response), and identity tied to email and to one sign-in method.

Instead: whoever signs a visitor in, the app sees one short-lived signed token, verified by a tiny shared middleware with a
public key. Nothing an app holds can mint identity.

## The token

A JWT (compact JWS), **EdDSA (Ed25519)** via `node:crypto`, sent to the app in `X-AidenHQ-Identity`. Claims:

| claim | value |
|---|---|
| `iss` | `aidenhq-gate` (people) or `aidenhq-apps` (agents) |
| `aud` | the app's name (registry `name`) |
| `sub` | a stable opaque id: people `u_` + 22 chars of base64url(sha256(`aidenhq-user:` + lowercased verified email)); agents `agent:<key>` |
| `kind` | `person` or `agent` |
| `email`, `name` | display and contact (agents: no email; `name` is the agent key) |
| `role` | the gate's resolved role on this app (people); `admin` (app_api) or `member` (app_view) for agents |
| `idp` | `access`, `password` (people), `apps-mcp` (agents) |
| `iat`, `exp` | `exp = iat + 300` |

The JWS header is `{alg: "EdDSA", kid, typ: "JWT"}`. Minted per request: browsers never see it (the gate adds it on the
way to the app), and the app sees each one at most for five minutes.

**`sub` comes from the verified email, not an account row**, so it is the same under every identity provider (Access, a
password, a future direct Okta or Google adapter all verify the same email) and stays the same when an Access-admitted
person later gets an account. It is opaque so apps key data on it rather than on the email. Cost: an email change makes a new
`sub`; AidenHQ has no email change today, and when it does, an account-id map replaces the hash in one place (the gate).

## Identity providers (the gate's adapters)

`modules/apps-platform/gate/gate.ts` has one interface per sign-in method:

```js
adapter.authenticate(req, ctx) → { email, name?, idp } | null   // null: no credential; throws Refused(status, msg)
```

- `access`: the Cloudflare Access JWT for the host's audience tag (RS256, team JWKS), as today.
- `password`: the board's Better Auth session through the auth listener (3129), as today.

The gate's `login` setting and the host's `aud` decide which adapters run; **all of them must pass** (a password host with an
`aud` still needs Access, checked before `/.auth` routing; the session after), exactly the current order. The gate then maps
the email to the account and role (accounts.json), refuses `blocked`, and mints. A future adapter (direct OIDC, Google,
Tailscale) is one more object with `authenticate`, its config, a `settings.app_login` value (`scripts/edge.mjs` `LOGINS`)
and its place in `authorize()`; the token, the middleware and the apps don't change. The adapters are a seam, not a
plugin registry: add the registry when a third one lands. The provider's own token
(the Access JWT and cookie, Better Auth cookies) never reaches an app: the gate keeps stripping `cf-access-*`, `x-aidenhq-*`,
`tailscale-*` and auth cookies inbound.

## What stays the gate's job

Host → app mapping; sign-in (adapters); coarse entry (account disabled, role `blocked` → 403, my-apps list, Access page,
in-app requests); same-origin writes and upgrades; stripping inbound identity. The app owns everything finer: read versus
write, per-user data and history, keyed by `req.user.sub` and `req.user.role`.

## The middleware

`modules/apps-platform/starter/aidenhq-identity.mjs`: every app starts from the starter, so it carries the file unchanged.
About 50 lines, no dependencies:

- reads the public keys from `/run/secrets/AIDENHQ_IDENTITY_KEYS` (re-read when its mtime changes);
- verifies `alg` EdDSA, a known `kid`, the signature, that the key's issuer equals `iss`, `aud` = `AIDENHQ_APP`, `exp` not
  passed, `iat` not in the future (60 s leeway), integer times and a lifetime of at most 300 s, a well-formed `sub` and a
  role that isn't `blocked`;
- binds issuer to kind: `aidenhq-gate` may only assert `person` (a `sub` not starting `agent:`), `aidenhq-apps` only `agent`
  (`sub` = `agent:<key>`), so a leaked agent key can never impersonate a person;
- exposes `identify(req) → { sub, email, name, role, kind }` (throws with a status) and `protect(handler, { health })`,
  which wraps the app's whole request handler (and its upgrade handler) and sets `req.user` or answers 401.

The app wraps its whole handler; only `GET` on the exact health path passes without a token. Long-lived connections (SSE, WebSocket) are checked once,
at request or upgrade time.

**Tailnet-only apps** (`expose: true`, no `share.host`) are reached by tailnet browsers through apps-edge, which cannot mint
tokens yet. For them only, and only when the apps' tailnet node really is the instance's door (`exposure: tailscale`, the
node's join key in the vault, so compile writes `config/apps-node` = `tailnet`, and `APPS_URL_BASE` set; apps-mcp re-reads
it at every deploy and probe, and anything else fails closed), apps-mcp sets `AIDENHQ_ANONYMOUS=tailnet` and `identify`
returns `null` for a request with no token (a bad token still fails). In every other mode (`local`, `public`,
`cloudflare`, or tailscale without the node) the only ways to an app's port are the host's loopback and Docker bridges, so
the app requires a signed identity and the deploy's identity probe requires it to refuse a token-less request. The app treats `null` as an anonymous caller who gets only what it gives anyone (reads, a
public form), as the roadmap app does today. The default
(the variable absent) refuses: the platform must opt an app out, never the app itself. A Tailscale adapter (apps-edge →
gate) removes this case later.

## Agents (app_api, app_view)

apps-mcp mints the agent's token itself with its own Ed25519 key (`iss` `aidenhq-apps`, `sub` `agent:<key>`, `kind` agent):
`role: admin` for `app_api` (still only the agent keys in `api.callers` and only under `api.paths`, enforced in apps-mcp as
today) and `role: member` for `app_view`. The token goes in the same header, is never shown to the agent and is redacted
from any response that echoes it. `api.token` and every per-app agent token are removed; `api` becomes `{ callers, paths }`.

**Disagreement with the direction as written** ("the gate, or apps-mcp via the gate's signer; key read only by the gate"):
the gate runs only with `edge` (the live instance has none, and its one app is called by agents every day), it listens on the
host's loopback, which apps-mcp (on bridge networks) cannot reach, and apps-mcp holds the Docker socket, so a key hidden from
it is not hidden. A separate agent key, bound in the middleware to agent identities only, gives the same guarantee (only the
platform mints; apps-mcp cannot impersonate people through the token) with no new channel between services.

## Keys and rotation

The vault dir `identity/` holds `gate.pem` and `apps.pem` (Ed25519 private keys, PKCS#8, mode 600) and `keys.json` (the
public keys as a JWK set; each key has `kid` = first 16 characters of the base64url SHA-256 of its raw public key and `iss`).
`scripts/compile.mjs` (every apply) creates a missing private key and rewrites `keys.json` **in place** from every
`gate*.pem` and `apps*.pem` in the dir (in place, because a single-file bind mount pins the inode). Mounts:

- the gate: `identity/gate.pem` (read-only), and nothing else of the dir;
- apps-mcp: `identity/apps.pem` (read-only), plus the host path of `keys.json` to mount into apps;
- every app: `keys.json` as the compose secret `AIDENHQ_IDENTITY_KEYS`, and `AIDENHQ_APP=<name>` in its environment.

Rotation: rename `gate.pem` to `gate.old.pem`; apply (a new `gate.pem`; `keys.json` lists both; the gate reads its key on
start, so recreate it); after five minutes delete `gate.old.pem` and apply again. The same for `apps.pem` (restart apps-mcp).
A compromised key: delete it (never rename it, or `keys.json` keeps trusting it), apply, restart the signer.

The gate does not serve a JWKS over HTTP: apps cannot reach the host's loopback, and the mounted file is simpler and works
offline. Public keys are not secret; the file sits in the vault only to share its mount path.

## Failure modes

- `keys.json` missing, unreadable or torn mid-write: the middleware refuses (401/503) and re-reads on the next request.
- The gate's key missing: the gate answers 503 for app hosts (as for any unreadable state). apps-mcp's key missing:
  `app_api`/`app_view` fail with a clear error.
- An app without the middleware: anything that reaches its port is trusted. Shared apps sit on loopback and their own
  networks (no app may `connects` to a shared app), and the Coach and `scripts/verify-security.sh` check for it.
- Clock skew between host and containers: one host clock; 60 s leeway on `iat`.

## Migration of existing apps

There is one: roadmap-keeper (tailnet-only, agents write through `app_api`). No compatibility shim: the old headers,
`AIDENHQ_GATE_SECRET` and `api.token` go in one product change, so its agent writes fail between the product apply and the
app's redeploy. Order: merge the product change; bump the product and drop `token:` from its `api` in the instance
`apps.yaml` in **one** instance commit (the old apps-mcp requires `token`, the new one refuses it, and one bad entry stops
the whole registry); apply; then merge the app's patch, which auto-deploys (or `app_deploy`). Not the app first: it
auto-deploys, and without the platform's `AIDENHQ_APP` and keys it fails health and rolls back. The window for agent
writes is apply → the app's redeploy (minutes). Afterwards delete the stale vault file `apps/roadmap-keeper/ROADMAP_AGENT_TOKEN`.

## Review

The Coach checks, for an agent that owns an app, that the app verifies `X-AidenHQ-Identity` with the shared middleware;
missing is a finding for the app's owner. `scripts/verify-security.sh` checks that a shared app's port refuses a request with
no token, and that the gate drops a forged `X-AidenHQ-Identity`.

## Refinements after Codex review

Codex (2026-11-13) approved the direction, confirmed both deviations (the separate agent key, the tailnet exception) and the
email-derived `sub`, and raised six risks. Folded in:

1. **The tailnet exception is not tailnet provenance.** Anything that reaches the port (host loopback, a connected
   container) is equally anonymous. Codex proposed limiting it to token-less `GET`/`HEAD`; built that way first, then
   **reverted** in the build: the roadmap app's public intake form takes anonymous posts on the tailnet today, and the
   middleware's job is to make identity unforgeable, not to set anonymous policy. `null` means "anyone": the app gives it
   only what it gives anyone, and every privileged route (agent API, admin writes) still needs a valid token. apps-mcp sets `AIDENHQ_APP` and `AIDENHQ_ANONYMOUS` itself after the sandbox, overwriting anything the
   app's compose declared, and sets the exception only for an exposed app without `share.host`. Adding `share.host` takes a
   redeploy, which drops it.
2. **An agent token was broader than the call.** Agent tokens now name what they may do: `app_api` tokens carry `methods`
   (the one method) and `path` (the exact path), `app_view` tokens `methods: [GET, HEAD]`; the middleware enforces both
   (403). People's tokens carry neither.
3. **Emergency rotation kept the bad key.** A compromised key is deleted, not renamed (Keys and rotation, above).
4. **Adapters: who identifies, who only admits.** Each identifying adapter must return an email its provider verified.
   When both run (a password host with an `aud`), Access only admits and the password session identifies, as today; the two
   emails may differ (a person's Access login need not be their AidenHQ account). Made explicit in the gate's code.
5. **Claim checks spelled out:** typed claims, integer `iat`/`exp`, `exp > iat`, at most 300 s, exact `aud`, issuer bound
   to the key entry in `keys.json` (never to anything in the token), `sub` format per kind, role not `blocked`.
6. **Forgetting the middleware.** The template wraps the whole handler, upgrades included, with one fixed health
   exception, and `scripts/verify-security.sh` checks every shared app's port refuses a token-less request before the owner
   relies on ingress.

Not adopted: anonymous reads only (1, above). Also left for the owner: agents' role is fixed (`admin` through `app_api`,
`member` through `app_view`), not granted per caller in `api.callers`; add that when an app needs two agent roles. Noted: the hash `sub` is deterministic, not private; an email reassigned to another person inherits
the old `sub`'s data, and moving to account ids later means migrating apps' stored `sub`s, not just changing the gate.
