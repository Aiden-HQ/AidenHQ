# App doors: opening agent-built apps without Tailscale

Companion to [access.md](access.md) and [app-identity.md](app-identity.md). On an install without Tailscale's apps node,
the owner opens an agent-built app through the gate, which signs the owner's identity, on a door chosen by the
install's exposure:

| `settings.exposure` | Door | App URL | Where the owner signs in |
|---|---|---|---|
| `local` (Mac/Lima, SSH tunnel) | the gate on the host's loopback, plain http | `http://<app>.localhost:3130` | the admin listener, `http://localhost:3120` (through the tunnel) |
| `public` (Caddy on the IP) | Caddy to the gate on loopback | `https://<app>.<ip-with-dashes>.sslip.io` | the admin listener, `https://<ip>:8446` |
| `tailscale` with the apps node | unchanged: the apps node | `https://<user>-apps.<tailnet>:<port>` | none (anonymous on the tailnet) |
| `tailscale` without the apps node (no `TS_APPS_AUTHKEY`) | none: apps run, and the Apps row says why there is no link (a door on the board's own tailnet name isn't possible: MagicDNS has no per-app names, and a port on the board's name would share its cookies) | none | n/a |
| any, with `settings.edge` | unchanged: the edge (Cloudflare tunnel or header-jwt front door) | `https://<share.host>` | `edge.my_apps.host` |

A door serves every exposed app (`expose: true`, a port, no `share.host`; `exposes()` in apps-mcp `tailnet.ts`) and only
to AidenHQ admins (the owner and admins they made). Other people get an app only by sharing it (`share.host` under
`settings.edge`). Previews have no door. A local door is compiled only when the board is on loopback (not a LAN VM's
board, where `<app>.localhost` would be the viewer's own machine).

## How it works

**One origin rule.** `config/gate.json` has `origin: { scheme, port }` (absent: `https`, default port). The gate's
`sameOrigin`, `exactOrigin`, redirects and sign-out, the kernel's handoff target check and apps-mcp's app URL all build
origins from it.

**Door hosts are dynamic.** `app_create` commits `apps.yaml` without an apply, so doors aren't compiled per app.
`gate.json` has `doors: { base, file, signin }` (`base`: `localhost` or `<ip-with-dashes>.sslip.io`; `signin`: the admin
listener's URL). apps-mcp (`src/doors.ts`) writes the file (`doors.json` beside its previews file in `data/previews`,
`{ "<app>": <port> }`) from the exposed apps it serves, once healthy. The gate maps `<app>.<base>` to that port: the name
must be in the file, the port must not be a platform port (apps-mcp `RESERVED`) or below 1024. Anything else is 404.
The kernel checks a door origin by its shape (`doorHost`); whether the app runs is the gate's to check.

**No sign-in on a door host.** The owner signs in on the kernel's admin listener (password and TOTP). A door has no
my-apps host and no sign-in pages: `/.auth/*` on a door host serves only the handoff and sign-out. An app host without a
session redirects to the admin listener's `/auth/handoff?to=<app origin>&state=<nonce>&next=<path>` (the gate sets the
state nonce in the app host's own cookie first). The admin listener signs the owner in if needed, then, for a ready
admin and a `to` that is exactly a door origin (`<name>.<base>` with the door's scheme and port, from `gate.json`), mints
the one-time code the gate already redeems (60 s, single use, bound to that host, the state and the admin listener's
session) and redirects to `<app origin>/.auth/handoff?code=...&state=...&next=...`. The gate redeems it on the kernel's
3129 and sets the app host's own `__Host-` cookie. Signing out on the admin listener ends every app host session it
handed out.

**Compile (`scripts/edge.ts`, `doorConfig`).** With no `settings.edge` and exposure `local` or `public`, compile emits
the gate (`login: password`, `hosts: {}`, the `doors` block, `origin` for local) instead of nothing. The gate mounts
`data/previews` read-only. In `public` mode the Caddyfile (`scripts/front-door.ts`) gains a wildcard site for the door
base: `tls { on_demand; issuer acme { disable_http_challenge } }` (TLS-ALPN-01 on 443; port 80 stays closed),
`reverse_proxy 127.0.0.1:3130`, and a global `on_demand_tls { ask http://127.0.0.1:3130/.aidenhq/door-ask }`. The gate
answers 200 only for a name in the doors file, so a stranger can't make Caddy order certificates for arbitrary names. A
certificate is ordered at the first handshake for that name.

**apps-mcp.** The status row's `url` is the door's URL when the door serves the app and works; otherwise no URL and
`unpublished: "<reason>"`. Local: the door works once the gate config has doors and the app is in the file. Public:
apps-mcp completes a TLS handshake to the IP with the app's name as SNI, verified against Node's roots, before it shows
the URL (on the deploy, every few minutes while it fails, hourly once it works); that handshake is also what makes Caddy
order the certificate. Failing, the reason says the sslip.io certificate wait can take days (sslip.io names share one
Let's Encrypt limit) and to ask Aiden for an own domain or Tailscale.

**Board.** The Apps tab and panel links show `url` or the reason, never a dead link. For a local door the board checks
that this browser keeps a Secure cookie on plain http (`keepsSecureCookies`, `services/board/web/src/util.ts`); where it
doesn't (Safari), the row says apps open in Chrome or Firefox on this Mac, with a Copy link button instead of Open
(owner's choice).

**Aiden.** When an app is unpublished with a reason, Aiden offers the two lasting doors: Tailscale (exposure `tailscale`
with the apps node key) or the owner's own domain. Today an own domain means `settings.edge`, a Cloudflare tunnel with
`app_login: password` (or Access); `edgeConfig` requires `tunnel_id` unless a header-jwt front door is set. A domain
served by Caddy itself is not built.

**Install (`ops/setup.sh`).** The SSH tunnel line forwards the gate too, on the same port, because the port is part of the
origin: `ssh -N -L 3121:... -L 3120:... -L 3130:127.0.0.1:3130 <host>`.

## Security

- **Every app request carries a gate-signed identity.** Doors only add hosts to the gate; it mints the token as for a
  shared app. `anonymousCallers` and `config/apps-node` are untouched: a door app never gets `AIDENHQ_ANONYMOUS`, so
  apps-mcp's identity probe still requires it to refuse a token-less request.
- **Admins only, explicitly.** The gate refuses a non-admin account on a door host (403) whatever accounts.json says, so
  an app manifest's `default_role` can't open it to users. Door apps have no Access page, requests or notify (404).
- **No shared cookie.** Each app host gets its own host-only `__Host-` session cookie through the one-time handoff. The
  gate drops `Domain` from an app's `Set-Cookie` on a door host (`hostOnly`), so no app can set a cookie for a sibling or the base.
- **Cookies ignore ports.** On plain-http `*.localhost` any local listener on an app's host name can be sent its cookie,
  so isolation never rests on the host name alone: the gate never forwards its session cookie to an app and drops any app
  `Set-Cookie` naming it; the kernel accepts a handed-off session only from the gate's session lookup for the exact host
  it was redeemed on, never on the admin listener or the board; and an app's own loopback port takes no session at all,
  only the gate's signed identity.
- **Local: no shared origin.** `<app>.localhost` is its own site. The board and admin listener stay on `127.0.0.1`, a
  different cookie jar; no door host is bare `localhost` or an IP. Chromium and Firefox keep `__Host-` + Secure cookies
  on `http://a.localhost:<port>`, don't send them to `b.localhost`, and refuse a `Domain=localhost` cookie. WebKit keeps
  no Secure cookie on http and accepts `Domain=localhost`, so Safari is refused up front (board check above). There is
  no non-Secure fallback. The admin pages' CSP `form-action` lists the door origins (`http://*.localhost:3130`), because
  Chromium applies it to the redirect chain after the TOTP post.
- **Public: same-site strangers.** sslip.io is not on the Public Suffix List, so every `*.sslip.io` page in the world is
  same-site with ours. Cookies are `__Host-` (a stranger can't set them with `Domain=sslip.io`) and host-only; app
  `Set-Cookie` loses any `Domain`; writes and upgrades need the exact Origin (scheme, host and port), which a sibling
  can't send; reads are guarded by CORS. The board and admin listener stay on the bare IP, never on sslip.io.
- **Public: trusting sslip.io's DNS.** Whoever answers for `sslip.io` can point an app host elsewhere and get a
  certificate for it. No password or TOTP code is ever typed on an sslip.io host: sign-in happens only on the admin
  listener at the bare IP, and an app host gets identity only through the one-time handoff. A hijacked app host can show
  no credible sign-in form of ours and gets at most one app host's session, never the board, the admin listener or
  another app.
- **Certificates.** On demand, only for names the gate approves; TLS-ALPN-01 only; the board's IP site is unchanged.
- `scripts/verify-security.sh` checks that every door host refuses a request without a session and a door app's port
  refuses a token-less request.

## Not supported

A Caddy-served own domain, non-admin access through a door, previews on a door, Safari on a local install.
