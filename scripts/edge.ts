// Shared access (docs/design/access.md): from the instance setting `edge` and the
// instance apps' `share`, compile makes the gate's config (config/gate.json), cloudflared's locally managed config
// (config/cloudflared.yml: every share.host → the gate, then a 404 catch-all) and the two host-networked services. The gate
// signs each app's identity token with the vault's identity/gate.pem (scripts/identity.ts; docs/design/app-identity.md).
// Off (nothing generated) unless `edge` is set. `node scripts/edge.ts check [file]` is apply's refusal of any ingress
// rule whose target isn't the gate.
// settings.app_login (docs/design/access.md, App login modes): `access` (default) = every gate host needs
// its Access application and the Access token; `password` = the gate signs people in through the kernel's sign-in listener
// (AUTH_URL) and Access becomes optional per host (a host with an `aud` still needs it: password never removes Access).
// In password mode sign-in lives only on the my-apps host; each app host gets its own host-only session cookie through a
// one-time handoff code (modules/apps-platform/gate/gate.ts), and the gate strips auth cookies before any app.
// `header-jwt` = a front door in front of the gate (a hosting service's identity-aware proxy, reaching the gate over the
// tailnet): the gate verifies its signed ES256 token (settings.edge.identity: header, issuer, jwks_url, auth_method?) for the
// host's `aud`, and also listens on settings.edge.front (a tailnet address and port). No tunnel, no Access team, no
// cloudflared; every host needs its aud. The login is instance-wide.
// settings.edge.previews: true: pull request previews of shared apps (modules/apps-platform/apps-mcp/src/previews.ts) at
// pr-<n>.<host> under each share.host, through the gate, with the parent's access: one ingress rule *.<host> per shared
// app behind the parent's own aud (its Access application must cover *.<host> too). apps-mcp writes which previews run
// (data/previews/previews.json); the gate takes only ports in PREVIEW_PORTS from it.
// settings.edge.test_user ({ email, apps }): the one non-owner identity an allowlisted agent may sign in as, for page-level
// checks at exactly these shared apps (docs/design/access.md, Test-user sign-in). Compile validates it (its own email, at
// least one app, no repeats, each a shared app with a host) and writes it with the test listener's own bridge address and
// port. Naming no test user writes neither: the capability is inert, and the gate binds nothing for it.
// App doors (docs/design/app-doors.md): without `edge`, on exposure local or public, compile still runs the gate, serving
// every exposed app to AidenHQ admins at <app>.<base> (`localhost` over http on loopback; <ip-with-dashes>.sslip.io behind
// Caddy, scripts/front-door.ts), with each app's port from apps-mcp's doors file and sign-in only on the kernel's admin
// listener (it hands a one-time code back to the app host). Tailscale's apps node and `edge` keep their own doors.
// The module door (docs/design/app-doors.md): without `edge`, on every exposure mode (local, public, tailscale), a module
// service shared with no host (services.run.<svc>.share, e.g. the self-hosted Primer) opens for AidenHQ admins at the
// board's own host name on DOOR_PORT, which the front door (Caddy, `tailscale serve`) passes to the gate (local: the gate's
// own port, which the SSH tunnel forwards),
// signed in like any door. Its URL reaches the service as AIDENHQ_APP_URL (with `edge`, its share.host's).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const GATE_PORT = 3130; // modules/apps-platform/apps-mcp/src/tailnet.ts reserves the same port
export const GATE_URL = `http://127.0.0.1:${GATE_PORT}`;
export const DOOR_PORT = 8447; // the module door: the board's host on this port, through the front door to the gate
// cloudflared's way to the gate: a unix socket in a directory only the two of them mount (data/gate/socket), so the gate
// believes CF-Connecting-IP there and nowhere else (anything on the host's loopback reaches GATE_URL).
export const GATE_SOCKET = "/run/gate/gate.sock";
export const GATE_SOCKET_URL = `unix:${GATE_SOCKET}`;
const SOCKET_MOUNT = `\${AIDENHQ_DATA_DIR:-./data}/gate/socket:${dirname(GATE_SOCKET)}`;
export const AUTH_PORT = 3129; // the kernel's sign-in listener: sign-in (password mode) and app access (both modes); apps-mcp reserves it too
/** The test-user canary's listener: its own address, never the gate's port, the front door's socket or the tailnet. */
export const TEST_LISTENER_PORT = 3132;
/** The bridge gateway the canary browser's network has, and the only address the test listener binds (ops/vm/canary-net.sh).
 * Its own subnet (10.231.6.0/24), never the CI runners' (10.231.4.0/24) or the computers' (10.231.2.0/24). */
export const TEST_LISTENER_ADDRESS = "10.231.6.1";
export const TEST_NETWORK = "aidenhq-canary";
export const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
export const ACCOUNTS_FILE = "/accounts/accounts.json"; // the kernel's account map (email, role, disabled), mounted read-only
export const AUTH_SECRET_FILE = "/secrets/auth_listener"; // gate_board_secret in the gate: X-AidenHQ-Gate to 3129 (sign-in, app access)
export const LOGINS = ["access", "password", "header-jwt"];
export const IDENTITY_KEY_FILE = "/secrets/identity_key"; // the vault's identity/gate.pem in the gate: it mints app identity tokens
export const PREVIEWS_FILE = "/previews/previews.json"; // apps-mcp's running previews (data/previews), mounted read-only
export const DOORS_FILE = "/previews/doors.json"; // apps-mcp's door apps and their loopback ports, beside the previews file
const PREVIEWS_MOUNT = `\${AIDENHQ_DATA_DIR:-./data}/previews:${dirname(PREVIEWS_FILE)}:ro`;
/** A public door's base name for the host's IPv4: 203.0.113.7 → 203-0-113-7.sslip.io. */
export const sslipBase = (ip: unknown) => `${String(ip).replaceAll(".", "-")}.sslip.io`;
export const PREVIEW_PORTS = [39100, 39399]; // modules/apps-platform/apps-mcp/src/registry.ts PREVIEW_PORTS
// cloudflared 2026.10.7 (multi-arch index), pinned by digest.
const CLOUDFLARED_IMAGE = "cloudflare/cloudflared:2026.10.7@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba";
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Instance settings and apps.yaml entries: YAML the owner writes, checked field by field below. */
type Obj = Record<string, any>;
const fail = (m: string): never => { throw new Error(m); };
const emails = (l: unknown[] | null | undefined, where: string): string[] => (Array.isArray(l ?? []) ? l ?? [] : fail(`${where} must be a list`)).map((e: unknown) => (typeof e === "string" && e.includes("@") ? e.trim().toLowerCase() : fail(`${where}: ${e} is not an email`)));

/**
 * edgeConfig(settings, instanceApps, moduleApps, { publicIp, adminUrl, boardUrl }) → { gate, cloudflared, compose, urls }, or a
 * door's { gate, cloudflared: null, compose, urls } without `edge`, or null. `urls`: each shared module service's compose key →
 * the address people open it at (AIDENHQ_APP_URL). `share` lives only in the instance apps.yaml and module services (those carry
 * `service`); a module app may not declare it.
 */
export function edgeConfig(settings: Obj, instanceApps: Obj[], moduleApps: Obj[], door: Door = {}) {
  for (const a of moduleApps) if (a.share) fail(`app ${a.name}: share is set only in the instance apps.yaml, never by a module`);
  const shared = instanceApps.filter((a: Obj) => a.share?.host);
  // A shared app is reached only through the gate: no other app may join its network (apps-mcp refuses it too).
  for (const a of [...instanceApps, ...moduleApps]) {
    const t = (a.connects ?? []).find((c: string) => shared.some((x: Obj) => x.name === c));
    if (t) fail(`app ${a.name} connects to ${t}, a shared app: shared apps are reached only through the gate`);
  }
  const edge = settings.edge;
  const urls = Object.fromEntries(shared.filter((a) => a.service).map((a) => [a.service, `https://${a.share.host}`]));
  if (!edge) {
    if (shared.length) fail(`app ${shared[0]!.name} has share.host, but settings.edge isn't set (docs/setup.md, Shared access)`);
    return doorConfig(settings.exposure, door, instanceApps.filter((a) => a.service && !a.share?.host));
  }
  const login = settings.app_login ?? "access";
  if (!LOGINS.includes(login)) fail(`settings.app_login must be ${LOGINS.join(" or ")}`);
  const front = login === "header-jwt";
  if (!front && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(edge.tunnel_id ?? ""))) fail("settings.edge.tunnel_id must be the tunnel's UUID");
  for (const k of Object.keys(edge)) if (!["team_domain", "tunnel_id", "my_apps", "previews", "identity", "front", "test_user"].includes(k)) fail(`settings.edge.${k} is not a setting`);
  // An Access application's audience tag: required on every host with app_login access, optional with password.
  const audOf = (aud: unknown, where: string) => {
    if (aud == null && login === "password") return undefined;
    if (login === "header-jwt" && !aud) fail(`${where} needs ${where.startsWith("app") ? "share.aud" : "aud"} (the front door's audience for that host)`);
    if (!aud || typeof aud !== "string") fail(`${where} needs ${where.startsWith("app") ? "share.aud" : "aud"} (its Access application's audience tag)`);
    return aud;
  };
  const owner = emails([settings.owner_email || fail("settings.owner_email is required with edge (the owner is an admin of every shared app)")], "settings.owner_email")[0];

  const hosts: Record<string, Obj> = {};
  for (const a of shared) {
    const s = a.share;
    if (!HOST.test(s.host)) fail(`app ${a.name}: share.host ${s.host} is not a lowercase DNS name`);
    if (hosts[s.host]) fail(`app ${a.name}: share.host ${s.host} is also ${hosts[s.host]!.app}'s`);
    if (/^pr-\d+\./.test(s.host)) fail(`app ${a.name}: share.host ${s.host}: pr-<n>.<host> hosts are previews'`);
    if (!Number.isInteger(a.port)) fail(`app ${a.name}: share.host needs a port`);
    if (a.port === GATE_PORT) fail(`app ${a.name}: port ${GATE_PORT} is the gate's`);
    if (a.port === AUTH_PORT) fail(`app ${a.name}: port ${AUTH_PORT} is the kernel's sign-in listener`);
    if ((s.groups ?? []).length) fail(`app ${a.name}: share.groups come in phase 2`);
    for (const k of ["viewers", "admins"]) if (s[k] !== undefined) fail(`app ${a.name}: share.${k} is gone: app admins are named on the board (Accounts, App admins) and set roles on the app's Access page`);
    const def = s.default_role;
    if (def !== undefined && (!/^[a-z][a-z0-9-]{1,30}$/.test(String(def)) || def === "admin")) fail(`app ${a.name}: share.default_role must be a role name, never admin`);
    hosts[s.host] = { app: a.name, port: a.port, ...(audOf(s.aud, `app ${a.name}: share.host`) ? { aud: s.aud } : {}), ...(def ? { default_role: def } : {}) };
  }
  // My apps: the gate's own page listing the shared apps the visitor may open (and, in password mode, where invites land).
  let myApps: Obj | undefined;
  if (edge.my_apps) {
    const m = edge.my_apps;
    for (const k of Object.keys(m)) if (!["host", "aud"].includes(k)) fail(`settings.edge.my_apps.${k} is not a setting`);
    if (!HOST.test(String(m.host ?? ""))) fail(`settings.edge.my_apps.host ${m.host} is not a lowercase DNS name`);
    if (hosts[m.host]) fail(`settings.edge.my_apps.host ${m.host} is also ${hosts[m.host]!.app}'s`);
    myApps = { host: m.host, ...(audOf(m.aud, "settings.edge.my_apps") ? { aud: m.aud } : {}) };
  }
  // my_apps: the catalog and each app's Access page (both modes); in password mode also the one sign-in host.
  if (!myApps) fail("settings.edge.my_apps.host is required: it serves My apps, each app's Access page and (password mode) sign-in");
  let previews;
  if (edge.previews) {
    if (edge.previews !== true) fail("settings.edge.previews is true or absent (previews take each app's own Access audience)");
    previews = { file: PREVIEWS_FILE, ports: PREVIEW_PORTS };
  }
  // header-jwt: the front door's token settings and the tailnet listener it reaches (docs/design/access.md).
  let identity: Obj | undefined, frontDoor: Obj | undefined;
  if (front) {
    const i = edge.identity ?? fail("settings.edge.identity is required with app_login header-jwt");
    for (const k of Object.keys(i)) if (!["header", "issuer", "jwks_url", "auth_method"].includes(k)) fail(`settings.edge.identity.${k} is not a setting`);
    if (!/^[a-z0-9-]+$/.test(String(i.header ?? ""))) fail("settings.edge.identity.header must be a lowercase header name");
    for (const k of ["issuer", "jwks_url"]) if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(String(i[k] ?? ""))) fail(`settings.edge.identity.${k} must be an https URL`);
    if (i.auth_method !== undefined && (typeof i.auth_method !== "string" || !i.auth_method)) fail("settings.edge.identity.auth_method must be a non-empty string");
    identity = { header: i.header, issuer: i.issuer, jwks_url: i.jwks_url, ...(i.auth_method ? { auth_method: i.auth_method } : {}) };
    const f = edge.front ?? fail("settings.edge.front is required with app_login header-jwt: { address: <tailnet IP>, port }");
    for (const k of Object.keys(f)) if (!["address", "port"].includes(k)) fail(`settings.edge.front.${k} is not a setting`);
    const o = String(f.address ?? "").split(".").map(Number);
    if (o.length !== 4 || !o.every((n, k) => Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === String(f.address).split(".")[k]) || o[0] !== 100 || o[1]! < 64 || o[1]! > 127) fail("settings.edge.front.address must be a tailnet IPv4 address (100.64.0.0/10)");
    if (!Number.isInteger(f.port) || f.port < 1024 || f.port > 65535 || f.port === AUTH_PORT || f.port === GATE_PORT) fail(`settings.edge.front.port must be 1024-65535, never ${AUTH_PORT} or ${GATE_PORT}`);
    frontDoor = { address: f.address, port: f.port };
  } else for (const k of ["identity", "front"]) if (edge[k] !== undefined) fail(`settings.edge.${k} is only for app_login header-jwt`);
  // The test user: its own account (never the owner's or any existing one), and only apps this instance really shares.
  let testUser: Obj | undefined;
  if (edge.test_user !== undefined) {
    const t = edge.test_user;
    if (!t || typeof t !== "object" || Array.isArray(t)) fail("settings.edge.test_user must be { email, apps }");
    for (const k of Object.keys(t)) if (!["email", "apps"].includes(k)) fail(`settings.edge.test_user.${k} is not a setting`);
    const email = typeof t.email === "string" ? t.email.trim().toLowerCase() : "";
    if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 200) fail("settings.edge.test_user.email must be an email address");
    if (email === owner) fail("settings.edge.test_user.email must not be the owner's");
    if (!Array.isArray(t.apps) || !t.apps.length) fail("settings.edge.test_user.apps must list at least one shared app");
    const seen = new Set<string>();
    for (const a of t.apps) {
      if (typeof a !== "string" || !/^[a-z][a-z0-9-]{1,30}$/.test(a)) fail(`settings.edge.test_user.apps: ${a} is not an app name`);
      if (seen.has(a)) fail(`settings.edge.test_user.apps names ${a} twice`);
      seen.add(a);
      const shared = instanceApps.find((x: Obj) => x.name === a && x.share?.host) ?? fail(`settings.edge.test_user.apps: ${a} isn't a shared app with a share.host`);
      // A module service shared through the gate (services.run.<svc>.share, `service` set by the compiler) is not an app
      // apps-mcp's registry can resolve: the canary would fail before minting, so the setting is refused here.
      if (shared.service) fail(`settings.edge.test_user.apps: ${a} is a module service, not an app app_page_canary can open`);
    }
    testUser = { email, apps: [...seen] };
  }
  const gateHosts = [...Object.entries(hosts), ...(myApps ? [[myApps.host, myApps]] : [])];
  const anyAud = gateHosts.some(([, h]) => h.aud);
  const team = /^([a-z0-9-]+)\.cloudflareaccess\.com$/.exec(String(edge.team_domain ?? ""))?.[1];
  if (front && edge.team_domain != null) fail("settings.edge.team_domain isn't used with app_login header-jwt");
  if (!front && !team && (login === "access" || anyAud || edge.team_domain != null)) fail("settings.edge.team_domain must be <team>.cloudflareaccess.com");
  const issuer = team && `https://${team}.cloudflareaccess.com`;
  const gate: Obj = {
    port: GATE_PORT, login, ...(issuer ? { issuer, certs_url: `${issuer}/cdn-cgi/access/certs` } : {}),
    ...(identity ? { identity, front: frontDoor } : { socket: GATE_SOCKET }),
    auth_url: AUTH_URL, auth_secret_file: AUTH_SECRET_FILE, accounts_file: ACCOUNTS_FILE, identity_key_file: IDENTITY_KEY_FILE, owner_email: owner,
    ...(myApps ? { my_apps: myApps } : {}), hosts, ...(previews ? { previews } : {}),
    // Both or neither: a test user with no listener (or the reverse) would be a half-open door, so compile never writes one.
    ...(testUser ? { test_user: testUser, test_listener: { address: TEST_LISTENER_ADDRESS, port: TEST_LISTENER_PORT } } : {}),
  };
  // Previews: *.<host> for each shared app, behind that app's aud, after every exact host (cloudflared takes the first match).
  const wild = previews ? Object.entries(hosts).map(([h, x]) => [`*.${h}`, x]) : [];
  const cloudflared = front ? null : {
    tunnel: edge.tunnel_id,
    "credentials-file": "/run/secrets/cloudflared_credentials",
    ingress: [
      // cloudflared checks the Access token too (a second layer); the gate is the one that decides. Only a password-mode
      // host without an aud goes without Access.
      ...[...gateHosts, ...wild].map(([hostname, h]) => ({ hostname, service: GATE_SOCKET_URL, ...(h.aud ? { originRequest: { access: { required: true, teamName: team, audTag: [h.aud] } } } : {}) })),
      { service: "http_status:404" },
    ],
  };
  const hardening = HARDENING;
  const compose = {
    services: {
      // Host networking: it listens on 127.0.0.1:<GATE_PORT> and reaches the apps' loopback ports. No secrets, no sockets.
      // Its signing key (vault identity/gate.pem, read-only; compile creates it) and nothing else of the identity dir.
      // The kernel's account map is the one file of data/ it sees (never data/kernel: no sessions, hashes or TOTP secrets).
      gate: gateService([
        // Which previews run (apps-mcp writes it; a directory, so its atomic replace is seen).
        ...(previews ? [PREVIEWS_MOUNT] : []),
        // cloudflared's socket (the gate listens there too); not with a front door.
        ...(front ? [] : [SOCKET_MOUNT]),
      ]),
      // Outbound only; locally managed, so its ingress is this file and the dashboard can't change it.
      // The label carries the ingress's hash: compose recreates cloudflared exactly when its config changes (it reads it once).
      ...(front ? {} : { cloudflared: { ...hardening, labels: { "aidenhq.ingress-sha256": createHash("sha256").update(JSON.stringify(cloudflared)).digest("hex") }, image: CLOUDFLARED_IMAGE, network_mode: "host", command: ["tunnel", "--config", "/etc/cloudflared/config.yml", "run"], volumes: ["./config/cloudflared.yml:/etc/cloudflared/config.yml:ro", SOCKET_MOUNT], secrets: ["cloudflared_credentials"], depends_on: ["gate"] } }),
    },
    secrets: front ? {} : { cloudflared_credentials: { file: "${AIDENHQ_SECRETS_DIR}/cloudflared_credentials.json" } },
  };
  return { gate, cloudflared, compose, urls };
}

const HARDENING = { security_opt: ["no-new-privileges:true"], cap_drop: ["ALL"], restart: "unless-stopped", user: "${PUID:-1000}:${PGID:-100}", read_only: true };
/** The gate's service. Host networking: it listens on 127.0.0.1:<GATE_PORT> and reaches the apps' loopback ports. */
const gateService = (extra: string[]) => ({
  ...HARDENING, build: "./modules/apps-platform/gate", image: "aidenhq/gate:local", network_mode: "host", environment: { GATE_CONFIG: "/config/gate.json" },
  // No secrets, no sockets: its signing key (vault identity/gate.pem, read-only; compile creates it) and nothing else of the
  // identity dir; the kernel's account map is the one file of data/ it sees (never data/kernel: no sessions, hashes or TOTP).
  volumes: [
    "./config/gate.json:/config/gate.json:ro", `\${AIDENHQ_DATA_DIR:-./data}/gate/accounts.json:${ACCOUNTS_FILE}:ro`,
    `\${AIDENHQ_SECRETS_DIR}/identity/gate.pem:${IDENTITY_KEY_FILE}:ro`,
    // Its proof to the kernel's sign-in listener (core's generated gate_board_secret): sessions and handoffs.
    `\${AIDENHQ_SECRETS_DIR}/gate_board_secret:${AUTH_SECRET_FILE}:ro`,
    ...extra,
  ],
});

/** The host's own addresses, from .env (compile's `door`). */
interface Door { publicIp?: string; adminUrl?: string; boardUrl?: string }

/**
 * The doors without `edge` (docs/design/app-doors.md), or null. App doors: `local` serves <app>.localhost:<GATE_PORT> over
 * http, `public` <app>.<ip-with-dashes>.sslip.io through Caddy. The module door (`moduleDoors`: module services shared with no
 * host, at most one): the board's own host on DOOR_PORT in public and tailscale, localhost:<GATE_PORT> in local. Sign-in is the admin
 * listener's (`adminUrl`), never the gate's.
 */
function doorConfig(exposure: unknown, { publicIp, adminUrl, boardUrl }: Door = {}, moduleDoors: Obj[] = []) {
  let doors: Obj | undefined, origin: Obj | undefined, signin: string;
  // A local door is the viewer's own loopback: only where the board is too (not a LAN VM's board on a LAN address).
  const loopback = !boardUrl || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(boardUrl);
  if (exposure === "local" && loopback) {
    doors = { base: "localhost", file: DOORS_FILE };
    origin = { scheme: "http", port: GATE_PORT };
    signin = adminUrl || "http://localhost:3120";
  } else if (exposure === "public" && publicIp) {
    doors = { base: sslipBase(publicIp), file: DOORS_FILE };
    signin = adminUrl || `https://${publicIp}:8446`;
  } else if ((exposure ?? "tailscale") === "tailscale" && /^https:\/\//.test(boardUrl ?? "") && adminUrl) signin = adminUrl;
  else return null;
  if (moduleDoors.length > 1) fail(`modules ${moduleDoors.map((a) => a.name).join(", ")} each share a service with no host: the module door serves one (give the others a host)`);
  const hosts: Obj = {}, urls: Obj = {};
  for (const a of moduleDoors) {
    // The board's own host name (cookies ignore ports: the gate keeps its session apart, modules/apps-platform/gate/gate.ts).
    // Local: the gate's own port, which the SSH tunnel already forwards; elsewhere the front door's DOOR_PORT.
    const board = new URL(boardUrl || "http://localhost:3121");
    const at = `${board.protocol}//${board.hostname}:${exposure === "local" ? GATE_PORT : DOOR_PORT}`;
    hosts[board.hostname] = { app: a.name, port: a.port, door: true, origin: at };
    urls[a.service] = at;
  }
  if (!doors && !moduleDoors.length) return null;
  const gate: Obj = {
    port: GATE_PORT, login: "password", auth_url: AUTH_URL, auth_secret_file: AUTH_SECRET_FILE, accounts_file: ACCOUNTS_FILE, identity_key_file: IDENTITY_KEY_FILE,
    hosts, ...(origin ? { origin } : {}), ...(doors ? { doors } : {}), signin,
  };
  return { gate, cloudflared: null, compose: { services: { gate: gateService([PREVIEWS_MOUNT]) }, secrets: {} }, urls };
}

/**
 * Refuses any ingress whose target isn't the gate: only hostname → GATE_SOCKET_URL rules, then exactly the 404 catch-all. Every
 * rule requires Access, except with app_login password (the gate signs people in), where a rule may carry no Access at all.
 */
export function checkIngress(cfg: Obj | undefined, { login = "access" }: { login?: string } = {}) {
  const bad = (m: string): never => fail(`cloudflared ingress refused: ${m}`);
  for (const k of Object.keys(cfg ?? {})) if (!["tunnel", "credentials-file", "ingress"].includes(k)) bad(`unexpected key ${k}`);
  const rules = cfg?.ingress;
  if (!Array.isArray(rules) || !rules.length) bad("no ingress");
  const last = rules.at(-1);
  if (JSON.stringify(last) !== JSON.stringify({ service: "http_status:404" })) bad("the last rule must be the 404 catch-all");
  const seen = new Set();
  for (const r of rules.slice(0, -1)) {
    for (const k of Object.keys(r)) if (!["hostname", "service", "originRequest"].includes(k)) bad(`rule key ${k}`);
    // A wildcard is one leading `*.` label (preview hosts), never alone on a top-level domain.
    if (typeof r.hostname !== "string" || !HOST.test(r.hostname.replace(/^\*\.(?=[^.]+\.)/, "x.")) || seen.has(r.hostname)) bad(`hostname ${r.hostname}`);
    seen.add(r.hostname);
    if (r.service !== GATE_SOCKET_URL) bad(`${r.hostname} → ${r.service} (only ${GATE_SOCKET_URL}, the gate)`);
    for (const k of Object.keys(r.originRequest ?? {})) if (k !== "access") bad(`${r.hostname}: originRequest.${k}`);
    if ((login !== "password" || r.originRequest) && r.originRequest?.access?.required !== true) bad(`${r.hostname}: Access must be required`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "check") {
  const file = process.argv[3] ?? "config/cloudflared.yml";
  if (!existsSync(file)) process.exit(0); // edge off
  // The login mode comes from the gate's config beside it; anything unreadable means the strict (access) check.
  let login = "access";
  try { login = JSON.parse(readFileSync(join(dirname(file), "gate.json"), "utf8")).login === "password" ? "password" : "access"; } catch {}
  try {
    checkIngress(YAML.parse(readFileSync(file, "utf8")), { login });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

/**
 * Fails when two services claim one host port. `composes`: compose files ({ services }); `claims`: [port, who] the platform
 * holds outside compose (the host-networked gate, the kernel's sign-in listener, apps on loopback). The same `who` may repeat.
 */
export function checkPorts(composes: Obj[], claims: [number | string, string][] = []) {
  const owner = new Map<number, string>();
  const claim = (port: number, who: string) => {
    if (owner.has(port) && owner.get(port) !== who) fail(`port ${port} is claimed by both ${owner.get(port)} and ${who}`);
    owner.set(port, who);
  };
  for (const [port, who] of claims) claim(Number(port), who);
  for (const c of composes) for (const [name, svc] of Object.entries<Obj>(c?.services ?? {})) {
    for (const p of svc.ports ?? []) {
      // "ip:host:container", "host:container" or a long form; ${VAR:-default} resolves to its default.
      const parts = (typeof p === "object" ? String(p.published ?? "") : String(p).replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, "$1")).split(":");
      const host = typeof p === "object" ? parts[0] : parts.length >= 2 ? parts.at(-2) : "";
      if (/^\d+$/.test(host!)) claim(Number(host), name);
    }
  }
}
