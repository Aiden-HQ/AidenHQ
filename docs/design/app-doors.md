# App doors: opening agent-built apps without Tailscale

Status: design (2026-11-18), owner decision of the same day. Companion to [access.md](access.md),
[app-identity.md](app-identity.md) and [minimal-core-install.md](minimal-core-install.md) section 4.6, whose "without a
domain, nothing is published" this replaces for the owner's own use.

## The decision

On an install without Tailscale's apps node, the owner opens an agent-built app through the gate, which signs the
owner's identity, on a door chosen by the install's exposure:

| `settings.exposure` | Door | App URL | Sign-in host |
|---|---|---|---|
| `local` (Mac/Lima, SSH tunnel) | the gate on the host's loopback, plain http | `http://<app>.localhost:3130` | `http://apps.localhost:3130` |
| `public` (Caddy on the IP) | Caddy → the gate's socket | `https://<app>.<ip-with-dashes>.sslip.io` | `https://apps.<ip-with-dashes>.sslip.io` |
| `tailscale` with the apps node | unchanged: the apps node | `https://<user>-apps.<tailnet>:<port>` | none (anonymous on the tailnet) |
| any, with `settings.edge` | unchanged: the edge (Cloudflare tunnel or header-jwt front door) | `https://<share.host>` | `edge.my_apps.host` |

A door serves **every exposed app** (`expose: true`, a port, no `share.host`; the apps node's set, `exposes()`), and
**only to AidenHQ admins** (the owner and admins they made). Other people get an app only by sharing it
(`share.host` under `settings.edge`), as today. Previews have no door.

## What changes where

**One origin rule.** Today the gate, the kernel and apps-mcp all write `https://<host>`. `config/gate.json` gains
`origin: { scheme, port }` (absent: `https`, default port). The gate's `sameOrigin`, `exactOrigin`, `go()`, every
redirect, My apps and sign-out, the kernel's `trustedOrigins` and apps-mcp's app URL all build origins from it with one
helper each. The readers land first (modules: gate, apps-mcp; product: kernel), then compile writes it.

**Door hosts are dynamic.** `app_create` commits `apps.yaml` without an apply, so the door can't be compiled per app.
`gate.json` gets `doors: { base, file }` (`base`: `localhost` or `<ip-with-dashes>.sslip.io`). apps-mcp writes the file
(`data/doors/doors.json`, `{ "<app>": <port> }`) from exactly the set it serves on the apps node: exposed, local, once
healthy. The gate maps `<app>.<base>` to that port, as it maps a preview host from apps-mcp's previews file: the name must
be in the file, the port must not be a platform port (the apps-mcp `RESERVED` list) or below 1024. Anything else is 404.
The kernel's `isAppHost` accepts `<name>.<base>` by pattern, as it does previews; whether the app runs is the gate's to
check.

**The sign-in host** is `apps.<base>`. The registry reserves the app name `apps` (beside `paperclip` and `sources`), and
the gate looks the sign-in host up before any door, so no app can take it. Sign-in is the existing password flow: the
gate's pages, Better Auth on the kernel's 3129, TOTP for admins, then the one-time handoff per app host. The owner signs
in once per browser on the sign-in host (a separate origin from the board), then each app hands off without a prompt.

**Compile (product, `scripts/edge.mjs`).** With no `settings.edge` and exposure `local` or `public`, compile emits the
gate (the same service, `login: password`, `hosts: {}`, the doors block, `origin` for local) instead of nothing. The gate
service gains a read-only mount of `data/doors`; apps-mcp gains it read-write (compose.yaml). In `public` mode the
Caddyfile (`scripts/front-door.mjs`) gains one site:

```caddyfile
https://*.203-0-113-7.sslip.io {
	tls { on_demand; issuer acme { disable_http_challenge } }   # TLS-ALPN-01 on 443; port 80 stays closed
	reverse_proxy unix//run/gate/gate.sock { import strip; header_up X-AidenHQ-Client-IP {remote_host} }
	import response
}
```

with `on_demand_tls { ask http://127.0.0.1:3130/.aidenhq/door-ask }`. The gate answers 200 only for the sign-in host and
a name in the doors file, so a stranger can't make Caddy order certificates for arbitrary names (the reason section 4.6
ruled out on-demand TLS). A certificate is ordered at the first handshake for that name. Caddy reaches the gate on the
unix socket cloudflared uses (`data/gate/socket`; the two never run together, since a door exists only without
`settings.edge`), and `gate.json` names the header the socket believes (`client_ip_header`: cloudflared's
`cf-connecting-ip`, Caddy's `x-aidenhq-client-ip`). So sign-in limits and bans count the real visitor, not one shared
peer that a stranger could hold down.

**apps-mcp (modules).** The status row's `url` is the door's URL when the door serves the app and works; otherwise no
URL and `unpublished: "<reason>"` (today a bare `true`). Local: the door works once the gate config has doors and the
app is in the file. Public: apps-mcp completes a TLS handshake to the IP with the app's name as SNI, verified against
Node's roots, before it shows the URL (on the deploy, then every few minutes while it fails, hourly once it works). That
handshake is also what makes Caddy order the certificate. Failing, the reason is: "Waiting for its HTTPS certificate:
sslip.io names share one Let's Encrypt limit with everyone who uses sslip.io, so this can take days. Ask Aiden for your
own domain or Tailscale."

**Board (product).** The Apps tab and panel links show `url` or the reason, never a dead link. For a local door the
board first checks this browser keeps a Secure cookie on plain http (a throwaway `__Host-` cookie on its own origin);
where it doesn't (Safari), the row says "Open it in Chrome or Firefox: Safari can't keep an app's sign-in on a local
install" instead of the link.

**Aiden (modules handbook text).** When an app is unpublished with a reason, Aiden offers the two lasting doors:
Tailscale (exposure `tailscale` with the apps node key) or the owner's own domain. **The own domain today means
`settings.edge`, a Cloudflare tunnel** with `app_login: password` (or Access); `edgeConfig` requires `tunnel_id` unless a
header-jwt front door is set. A domain served by Caddy itself (minimal-core U6, `ingress: caddy`) is not built and not
part of this change.

**Install (product `ops/setup.sh`, distro).** The SSH tunnel line forwards the gate too, on the same port, because the
port is part of the origin: `ssh -N -L 3121:… -L 3120:… -L 3130:127.0.0.1:3130 <host>`. The distro's `install.sh`
tunnel line and the Lima template forward 3130 as well (the template forwards only listed ports).

## Security argument

- **Every app request carries a gate-signed identity.** Doors only add hosts to the gate; the gate mints the token as for
  a shared app. `anonymousCallers` and `config/apps-node` are untouched: a door app never gets `AIDENHQ_ANONYMOUS`, so
  apps-mcp's identity probe still requires it to refuse a token-less request, and the loopback port answers nobody
  without a token.
- **Admins only, explicitly.** The gate refuses a non-admin account on a door host (403) whatever accounts.json says, so
  an app manifest's `default_role` can't open it to users. Door apps have no Access page, requests or notify (404).
- **No shared cookie.** Each app host gets its own host-only `__Host-` session cookie through the one-time handoff (60
  s, bound to the host and the browser's state nonce). The gate always drops `Domain` from an app's `Set-Cookie` on a
  door host (`hostOnly`, today only with previews or header-jwt), so no app can set a cookie for a sibling or the base.
- **Local: no shared origin.** `<app>.localhost` is its own site (no public-suffix entry, so the registrable name is
  `<app>.localhost`). The board and admin listener stay on `127.0.0.1`, a different cookie jar; no door host is bare
  `localhost` or an IP. Checked in Chromium and Firefox (Playwright, 2026-11-18): `__Host-` + Secure cookies on
  `http://a.localhost:<port>` are kept, not sent to `b.localhost`, and a `Domain=localhost` cookie is refused. WebKit
  keeps no Secure cookie on http and accepts `Domain=localhost`, so it could neither finish a handoff nor stop one app
  tossing cookies at another: Safari is refused up front (board check above; the gate's handoff says "this browser
  doesn't keep secure sign-ins on localhost" rather than "didn't start in this browser"). There is no non-Secure fallback.
- **Public: same-site strangers (why section 4.1 rejected sslip.io).** sslip.io is not on the Public Suffix List, so
  every `*.sslip.io` page in the world is same-site with ours. What protects us: cookies are `__Host-` (a stranger can't
  set them with `Domain=sslip.io`) and host-only; app `Set-Cookie` loses any `Domain`; writes and upgrades need the exact
  Origin (scheme, host and port), which a sibling can't send; reads are guarded by CORS. The board and admin listener stay
  on the bare IP, never on sslip.io.
- **Public: trusting sslip.io's DNS.** Whoever answers for `sslip.io` (its operator, or anyone who takes it over) can
  point an app host elsewhere and get a certificate for it, then show a fake sign-in page there and relay a password and
  TOTP code live. A domain's own DNS provider has the same power; here it is a provider the owner didn't pick. Accepted
  with the owner's decision; Aiden offers the own-domain and Tailscale doors, and the board's sign-in stays on the IP.
- **Certificates.** On demand, only for names the gate approves; TLS-ALPN-01 only; the board's IP site is unchanged.

## Test plan

- **Gate (modules, `npm test`):** a door host maps through the doors file; an unknown name, a reserved or low port, and
  the sign-in label as an app name are refused; a user account gets 403, an admin gets a token; `http://` origin with
  port: a same-origin write passes, `https://<host>` and a sibling are 403; `go()` accepts the door origin and refuses
  any other; app `Set-Cookie` loses `Domain`; door-ask answers 200 only for known names; the socket believes only the
  configured client-IP header.
- **apps-mcp:** status url per door; `unpublished` reason when the handshake fails; doors.json holds exactly the served
  set; a door app's compose never has `AIDENHQ_ANONYMOUS`; the name `apps` is refused.
- **Product `scripts/test`:** compile per mode: local → gate with doors and `origin`; public → doors, socket, and the
  Caddyfile's wildcard on-demand site and ask; edge or tailscale → no doors. Kernel: `isAppHost` takes a door host,
  `trustedOrigins` the door's sign-in origin. Setup's tunnel line (`setup.test.mjs`, `unattended-install.sh`). Board:
  the row shows the reason, and the Safari note.
- **Browsers (scratch, recorded in the PR):** the local door end to end in Chromium, Firefox and WebKit through the
  real gate and kernel: sign in, handoff, app request with a token, a sibling's cookie absent; WebKit shows the reason.
- **Live, owner-run:** on a throwaway VM with a public IPv4, `ops/test/caddy-staging-issuance.sh` extended with one
  app host on staging (on-demand, TLS-ALPN-01, the ask refusing another name); `scripts/verify-security.sh` gains: every
  door host refuses a request without a session, and a door app's port refuses a token-less request.

## Not in this change

The Caddy-served own domain (U6), user (non-admin) access through a door, previews on a door, Safari on a local
install.
