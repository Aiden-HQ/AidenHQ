# Setup reference

**To install AidenHQ, follow [SETUP.md](../SETUP.md)** (`ops/setup.sh`, with a check after every step). This page is
reference material SETUP.md doesn't cover: installing by hand, the account scripts, board account recovery and
shared access for colleagues.

## By hand

The route `ops/setup.sh` automates, for a host you prepare yourself (Ubuntu 24.04 or 26.04 with Docker and Compose, Node.js 24,
git, `bubblewrap` plus the private copy and `aidenhq-bwrap` AppArmor profile, `passt`; `sudo bash ops/vm/setup.sh` installs these). Use it only
if `ops/setup.sh` doesn't fit.

```sh
cp .env.example .env                 # host paths; AIDENHQ_SECRETS_DIR=~/.config/aidenhq
scripts/bootstrap.sh                 # secrets dir, data dirs
# create your private instance repo (instance.yaml, apps.yaml, agents/), check it out, and set
# AIDENHQ_INSTANCE_DIR=<checkout> in .env
ops/apply-config.sh                  # instance -> pinned product -> compile -> compose up -> setup
mkdir -p ~/.config/systemd/user && cp ops/units/aidenhq-{gateway,runner,computers}.service ops/units/prune-runs.* ~/.config/systemd/user/
systemctl --user enable --now aidenhq-gateway aidenhq-runner aidenhq-computers prune-runs.timer
```

Copy `config/runner.example.yaml` to `config/runner.yaml` and set `allowed_orgs` (see
[configuration.md](configuration.md)). Set `PAPERCLIP_DISABLE_SIGN_UP=true` in `.env` once you have created your
Paperclip account. Then `sudo bash ops/vault/init.sh` for the secret vault
([ops/vault/README.md](../ops/vault/README.md)).

The instance repo may live anywhere git can reach. `ops/setup.sh` makes a local one (`~/aidenhq-instance`, with the
bare repo `~/aidenhq-instance.git` as its origin). A GitHub-hosted one is an ordinary clone: apps-mcp pushes registry
changes to its `origin` unless `AIDENHQ_INSTANCE_PUSH_URL` says otherwise (see `.env.example`), and the runner changes
it only when its org is in `allowed_orgs` of `config/runner.yaml`.

## Connecting accounts

Run these on the host, then check with `scripts/healthcheck.sh`. SETUP.md step 7 covers Google, Telegram and Slack on
an `ops/setup.sh` host.

| Account | How |
|---|---|
| Google (Calendar, Drive, Gmail) | On an `ops/setup.sh` host: Connect Google on the board. By hand: `scripts/google-auth.sh <client.json>` with a Desktop-app OAuth client, once per account (`--email`, `--primary`). |
| Slack (read) | Set `SLACK_CLIENT_ID` in `.env`, then `scripts/slack-auth.sh` (callback on `localhost:3118`). |
| GitHub (read) | `gh auth login`, then `scripts/github-auth.sh`. |
| Primer | Set its URL on the board (Settings, Connections), then `scripts/primer-auth.sh`. |
| gcloud | `scripts/gcloud-auth.sh`. |
| Glean, Jira, Grafana, ClickHouse | Set the URL on the board (Settings, Connections) and approve the change, then press Connect on the loopback board (below). Grafana with `grafana_source: local` needs no sign-in. |

Sign-ins started on the board (Google, Glean, Jira, Grafana Cloud, ClickHouse) return to the board's loopback address, so start
them there: on your laptop run `ssh -N -L 3120:127.0.0.1:3120 <you>@<host>`, open `http://127.0.0.1:3120`, sign in to
the board and press Connect (Settings, Connections).

## The apps node's tailnet key

Agent-built apps get their own tailnet node and name (`aidenhq-<user>-apps`), so they never share the board's
cookies. It needs `TS_APPS_AUTHKEY` (a Tailscale admin makes it): in the Tailscale admin, add a tag (for example
`tag:aidenhq-apps`, under `tagOwners`; if your policy isn't allow-all, let your devices reach it on the app ports),
then Settings, Keys, *Generate auth key*: reusable, pre-approved, tagged with it. Without it apps run but aren't
reachable. To add it later, put the key in the vault as `tailscale_apps_authkey` and run
`docker compose up -d --force-recreate apps-edge` (it reads the key only at start).

## GitHub App for the runner

See SETUP.md step 8. The runner updates repositories in the agents organization (and creates one only on an approved `aidenhq create-repo` card) (`github_agents_org`, or
`aidenhq-<instance_name>`) as a GitHub App, not as a person. `ops/github-app-setup.mjs` needs `AIDENHQ_SETUP_HOST`
(the address your browser opens; it serves a one-time page on port 8765). Other organizations install the same App
on selected repositories; list them in `allowed_orgs` of `config/runner.yaml` and, for app deploys, `github_orgs` in
`instance.yaml`.

## Board accounts

Every board route, reads included, needs a signed-in admin with an authenticator app (design: [design/access.md](design/access.md)). The owner's account is `settings.owner_email`.

1. Setup prints the owner's one-time link at the end (72 hours, for `OWNER_EMAIL`, which must equal
   `settings.owner_email`). That makes the account, so a later link comes from `--reset <email>` (below), not `--link`.
2. The owner opens it on the board's https address, sets a password (12+ characters), signs in, and scans the QR code
   with an authenticator app. Other browsers signed in before that are signed out.
3. Accounts (tab): invite other admins or app users; each invite is a one-time link the inviting admin passes on.

Recovery: `sudo ops/setup.sh --config owner.env --reset <email>` (a config file with just `OWNER_NAME`, `OWNER_EMAIL`
and `TIMEZONE` is enough) ends that account's sessions, lifts a lockout, clears
an admin's authenticator and sends a new link to the owner's Telegram only. Approvals in Telegram keep working
throughout. Five wrong passwords or codes from one address pause that address for 15 minutes; twenty through the gate
pause the account on the gate's sign-in only, never on the board.

## Shared access: apps for people beyond the tailnet

Optional. Colleagues open a shared app at `https://<app>.<domain>` in a browser, signed in through the organisation's
Cloudflare Access and identity provider (design: [design/access.md](design/access.md)). The VM keeps
zero inbound ports: `cloudflared` dials out, and the gate (`services/gate`, on `127.0.0.1:3130`) verifies every request
before it reaches the app. The board and Paperclip are never reachable this way.

### What the organisation's Cloudflare admins create

In the organisation's Cloudflare account (Zero Trust), on a domain it already holds there:

1. **A locally managed tunnel**: `cloudflared tunnel login`, then `cloudflared tunnel create aidenhq-<instance>`. Hand over
   the tunnel's **UUID** and its **credentials file** (`<UUID>.json`). Not a dashboard-managed tunnel or a tunnel token:
   the ingress must come from AidenHQ's config file only.
2. **One DNS record per shared app**: `cloudflared tunnel route dns <UUID> <app>.<domain>` (a CNAME to
   `<UUID>.cfargotunnel.com`). One flat name per app, so the zone's universal certificate covers it.
3. **One Access application per shared app** (self-hosted, hostname `<app>.<domain>`), with a policy of the identity
   provider plus the named people (later, groups). Never an "Everyone" or Bypass rule; the organisation's default session
   length. Hand over each application's **Application Audience (AUD) tag**.
4. The **team domain** (`<team>.cloudflareaccess.com`).

If your organisation wants change control on Access policies, agree the process with its security team up front.

### What the owner sets

- Vault: the credentials file at `$AIDENHQ_SECRETS_DIR/cloudflared_credentials.json` (mode 600, owned by `PUID`).
- `instance.yaml` settings: `edge: { team_domain: <team>.cloudflareaccess.com, tunnel_id: <UUID>, my_apps: { host, aud } }`
  and `owner_email`.
- The instance `apps.yaml` entry of each shared app (only there; modules can't share an app, `app_create` refuses it as
  sensitive, and only the owner's apply lands it):

  ```yaml
  - name: roadmap-keeper
    # ...
    port: 4100
    share:
      host: roadmap.example.com
      aud: <the Access application's AUD tag>
      default_role: member   # optional: what people get with no role set (else the app's manifest, else blocked)
  ```

  Who may use the app is set per app, not here: the owner names the app's admins on the board (Accounts, App admins),
  and they assign roles on the app's Access page (see [App access](configuration.md#app-access)).

Then apply. Compile writes `config/gate.json` and `config/cloudflared.yml` (every `share.host` → the gate, then a 404),
mounts the gate's signing key (the vault's `identity/gate.pem`, made on every apply when missing) and adds the `gate`
and `cloudflared` services; apply refuses any ingress rule that targets anything but the gate. A shared app loses its
`tailscale serve` route: the owner opens it through Access like everyone else. No app may `connects` to a shared app.
Adding `share` to an app that is already running doesn't redeploy it (only a new commit does): run `app_deploy <app>`
once after the apply, so it stops taking anonymous tailnet callers (`AIDENHQ_ANONYMOUS`) before people reach it. A changed ingress recreates `cloudflared` on apply (a hash label on the service).

### Accounts and sign-in mode

The gate reads the board's account map, `data/gate/accounts.json` (accounts: email, name, role, disabled; each shared
app's default role and role assignments; no secrets; the board rewrites it on every change and every minute). It is the
only file of `data/` the gate mounts. A disabled account is refused on every app, and every enabled admin account is an
admin of every shared app. If the gate can't read the file it refuses everyone (503).

`settings.app_login` picks how visitors sign in:
- `access` (default): as above, Cloudflare Access on every host.
- `password`: for owners without an identity provider in Access. Sign-in is served only on the my-apps host
  (`edge.my_apps.host`, required): the gate passes a fixed set of `/.auth/*` pages and endpoints there to the board's
  auth listener on `127.0.0.1:3129`, and never the session or token endpoints. An app host without a session sends the
  visitor to the my-apps host, which (once signed in) gets a one-time code from the board, bound to that app host and
  valid for 60 s and to the browser that started it (a state nonce in a short-lived cookie on the app host); the app
  host's `/.auth/handoff` redeems it server-side and sets its own host-only `__Host-better-auth.session_token` cookie.
  `POST /.auth/sign-out` on an app host revokes that host's session; signing out on the my-apps host revokes all of them. No cookie is shared across hosts, the gate never passes an auth cookie to an
  app and drops any app's attempt to set one, and it checks each session server-side. Only people with an account get in (in `access` mode, anyone the Access policy admits is a member, account or not);
  `share.aud` and `team_domain` become optional, and a host
  that keeps its `aud` still requires Access. Without an `aud`, the sign-in host and the apps face the internet with no
  Access in front.

`edge.my_apps: { host, aud }` (required) is the gate's own hostname (a DNS record, and in `access` mode an Access
application, like a shared app's): "My apps" lists the apps the visitor isn't blocked from, and each app's Access page
lives there.

### What a shared app must do

Every request carries `X-AidenHQ-Identity`, a 5-minute Ed25519 token for this app ([app identity](design/app-identity.md)):
the gate signs it for people, apps-mcp for agents. The app verifies it with the shared middleware, the product's
`modules/core/templates/app/aidenhq-identity.mjs` copied unchanged, which reads the public keys the platform mounts
(`/run/secrets/AIDENHQ_IDENTITY_KEYS`) and the app's name (`AIDENHQ_APP`), and refuses anything without a valid token.
`req.user` is `{ sub, email, name, role, kind }`: `sub` is a stable opaque id (`u_…` for people, `agent:<key>` for
agents); `role` is `member`, `admin` or one of the app's own roles. The gate refuses only `blocked` people and requires
same-origin writes; the app decides everything else per role (a `member` can write unless the app says no), keys per-user
data on `sub`, and treats a role it doesn't know as no more than `member`. Agents arrive as `kind: agent` (`admin` through
`app_api`, for that one method and path; `member`, reads only, through `app_view`).

- **Custom roles:** `aidenhq-app.yaml` at the app's path declares them (`roles: [{ name, meaning }]`, at most 10, and an
  optional `default_role`). apps-mcp checks it on deploy (an invalid one refuses the deploy) and the board reads it at
  the running commit. A role the manifest drops makes its holders `blocked` until an admin picks another.
- **Post-deploy checks:** every deploy (and `app_rollback`, and `app_check` on demand) runs light probes after health:
  `render` loads a web app's `/` in a headless browser and fails on a CSP block, a failed stylesheet or script, a console
  error or no stylesheet applied; `agent` GETs `<first api path>/schema` on an app with `api:` and expects 200 with JSON.
  A failure rolls the deploy back. `checks: { render: [/, /audit], agent: [/api/agent/x/schema] }` in `aidenhq-app.yaml`
  sets the paths (declared paths are strict; `[]` turns a kind off).
- **Admin screens:** link to `/.aidenhq/access` (the app's Access page). Settings the app has are its own screen, shown
  to `admin`.
- **Requests to the app's agent:** `fetch("/.aidenhq/request", { method: "POST", headers: { "content-type":
  "application/json" }, body: JSON.stringify({ text, context }) })` from the app's own page (`text` up to 4000
  characters, `context` up to 500). The gate adds who is asking; `/.aidenhq/requests` shows the person their requests and
  the replies.

In Node:

```js
import { createServer } from "node:http";
import { createIdentity } from "./aidenhq-identity.mjs";
const { protect } = createIdentity();
const server = createServer(protect((req, res) => { /* req.user: { sub, email, name, role, kind } */ }, { health: "/api/health" }));
server.on("upgrade", protect((req, socket, head) => { /* WebSocket, checked once here */ }, { health: "/api/health" }));
```

### Verify

- `docker compose ps gate cloudflared`: both up; `docker compose logs cloudflared` shows registered connections.
- From a browser, `https://<app>.<domain>`: the identity provider's login, then the app. A `blocked` person gets 403.
- Forged headers are ignored: `curl -H 'X-AidenHQ-Identity: x' https://<app>.<domain>` stops at Access; on the host,
  `curl -H 'Host: <app>.<domain>' -H 'X-AidenHQ-Identity: x' http://127.0.0.1:3130/` is a 403 (no Access token).
- Going around the gate fails: on the host, `curl http://127.0.0.1:<app port>/` gets the app's 401 (no identity);
  `scripts/verify-security.sh` checks this for every shared app.
- A cross-site write (a form post from another host) is a 403; a streaming page (SSE) updates live; after the Access session expires the
  next request goes back to the login.

## Verify

`scripts/healthcheck.sh` and `scripts/verify-security.sh` check the stack; see [operations.md](operations.md).
