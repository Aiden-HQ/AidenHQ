// Shared access (docs/design/access.md): from the instance setting `edge` and the
// instance apps' `share`, compile makes the gate's config (config/gate.json), cloudflared's locally managed config
// (config/cloudflared.yml: every share.host → the gate, then a 404 catch-all) and the two host-networked services. The gate
// signs each app's identity token with the vault's identity/gate.pem (scripts/identity.mjs; docs/design/app-identity.md).
// Off (nothing generated) unless `edge` is set. `node scripts/edge.mjs check [file]` is apply's refusal of any ingress
// rule whose target isn't the gate.
// settings.app_login (docs/design/access.md, App login modes): `access` (default) = every gate host needs
// its Access application and the Access token; `password` = the gate signs people in through the board's auth listener
// (AUTH_URL) and Access becomes optional per host (a host with an `aud` still needs it: password never removes Access).
// In password mode sign-in lives only on the my-apps host; each app host gets its own host-only session cookie through a
// one-time handoff code (services/gate/gate.mjs), and the gate strips auth cookies before any app.
// settings.edge.previews: true: pull request previews of shared apps (services/apps-mcp/src/previews.ts) at
// pr-<n>.<host> under each share.host, through the gate, with the parent's access: one ingress rule *.<host> per shared
// app behind the parent's own aud (its Access application must cover *.<host> too). apps-mcp writes which previews run
// (data/previews/previews.json); the gate takes only ports in PREVIEW_PORTS from it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const GATE_PORT = 3130; // services/apps-mcp/src/tailnet.ts reserves the same port
export const GATE_URL = `http://127.0.0.1:${GATE_PORT}`;
export const AUTH_PORT = 3129; // the board's auth listener: sign-in (password mode) and app access (both modes); apps-mcp reserves it too
export const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;
export const ACCOUNTS_FILE = "/accounts/accounts.json"; // the board's account map (email, role, disabled), mounted read-only
export const AUTH_SECRET_FILE = "/secrets/auth_listener"; // gate_board_secret in the gate: X-AidenHQ-Gate to 3129 (sign-in, app access)
export const LOGINS = ["access", "password"];
export const IDENTITY_KEY_FILE = "/secrets/identity_key"; // the vault's identity/gate.pem in the gate: it mints app identity tokens
export const PREVIEWS_FILE = "/previews/previews.json"; // apps-mcp's running previews (data/previews), mounted read-only
export const PREVIEW_PORTS = [39100, 39399]; // services/apps-mcp/src/registry.ts PREVIEW_PORTS
// cloudflared 2026.10.7 (multi-arch index), pinned by digest.
const CLOUDFLARED_IMAGE = "cloudflare/cloudflared:2026.10.7@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba";
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const fail = (m) => { throw new Error(m); };
const emails = (l, where) => (Array.isArray(l ?? []) ? l ?? [] : fail(`${where} must be a list`)).map((e) => (typeof e === "string" && e.includes("@") ? e.trim().toLowerCase() : fail(`${where}: ${e} is not an email`)));

/**
 * edgeConfig(settings, instanceApps, moduleApps) → { gate, cloudflared, compose } or null when `edge` isn't set.
 * `share` lives only in the instance apps.yaml; a module app may not declare it.
 */
export function edgeConfig(settings, instanceApps, moduleApps) {
  for (const a of moduleApps) if (a.share) fail(`app ${a.name}: share is set only in the instance apps.yaml, never by a module`);
  const shared = instanceApps.filter((a) => a.share?.host);
  // A shared app is reached only through the gate: no other app may join its network (apps-mcp refuses it too).
  for (const a of [...instanceApps, ...moduleApps]) {
    const t = (a.connects ?? []).find((c) => shared.some((x) => x.name === c));
    if (t) fail(`app ${a.name} connects to ${t}, a shared app: shared apps are reached only through the gate`);
  }
  const edge = settings.edge;
  if (!edge) {
    if (shared.length) fail(`app ${shared[0].name} has share.host, but settings.edge isn't set (docs/setup.md, Shared access)`);
    return null;
  }
  const login = settings.app_login ?? "access";
  if (!LOGINS.includes(login)) fail(`settings.app_login must be ${LOGINS.join(" or ")}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(edge.tunnel_id ?? ""))) fail("settings.edge.tunnel_id must be the tunnel's UUID");
  for (const k of Object.keys(edge)) if (!["team_domain", "tunnel_id", "my_apps", "previews"].includes(k)) fail(`settings.edge.${k} is not a setting`);
  // An Access application's audience tag: required on every host with app_login access, optional with password.
  const audOf = (aud, where) => {
    if (aud == null && login === "password") return undefined;
    if (!aud || typeof aud !== "string") fail(`${where} needs ${where.startsWith("app") ? "share.aud" : "aud"} (its Access application's audience tag)`);
    return aud;
  };
  const owner = emails([settings.owner_email || fail("settings.owner_email is required with edge (the owner is an admin of every shared app)")], "settings.owner_email")[0];

  const hosts = {};
  for (const a of shared) {
    const s = a.share;
    if (!HOST.test(s.host)) fail(`app ${a.name}: share.host ${s.host} is not a lowercase DNS name`);
    if (hosts[s.host]) fail(`app ${a.name}: share.host ${s.host} is also ${hosts[s.host].app}'s`);
    if (/^pr-\d+\./.test(s.host)) fail(`app ${a.name}: share.host ${s.host}: pr-<n>.<host> hosts are previews'`);
    if (!Number.isInteger(a.port)) fail(`app ${a.name}: share.host needs a port`);
    if (a.port === GATE_PORT) fail(`app ${a.name}: port ${GATE_PORT} is the gate's`);
    if (a.port === AUTH_PORT) fail(`app ${a.name}: port ${AUTH_PORT} is the board's auth listener`);
    if ((s.groups ?? []).length) fail(`app ${a.name}: share.groups come in phase 2`);
    for (const k of ["viewers", "admins"]) if (s[k] !== undefined) fail(`app ${a.name}: share.${k} is gone: app admins are named on the board (Accounts, App admins) and set roles on the app's Access page`);
    const def = s.default_role;
    if (def !== undefined && (!/^[a-z][a-z0-9-]{1,30}$/.test(String(def)) || def === "admin")) fail(`app ${a.name}: share.default_role must be a role name, never admin`);
    hosts[s.host] = { app: a.name, port: a.port, ...(audOf(s.aud, `app ${a.name}: share.host`) ? { aud: s.aud } : {}), ...(def ? { default_role: def } : {}) };
  }
  // My apps: the gate's own page listing the shared apps the visitor may open (and, in password mode, where invites land).
  let myApps;
  if (edge.my_apps) {
    const m = edge.my_apps;
    for (const k of Object.keys(m)) if (!["host", "aud"].includes(k)) fail(`settings.edge.my_apps.${k} is not a setting`);
    if (!HOST.test(String(m.host ?? ""))) fail(`settings.edge.my_apps.host ${m.host} is not a lowercase DNS name`);
    if (hosts[m.host]) fail(`settings.edge.my_apps.host ${m.host} is also ${hosts[m.host].app}'s`);
    myApps = { host: m.host, ...(audOf(m.aud, "settings.edge.my_apps") ? { aud: m.aud } : {}) };
  }
  // my_apps: the catalog and each app's Access page (both modes); in password mode also the one sign-in host.
  if (!myApps) fail("settings.edge.my_apps.host is required: it serves My apps, each app's Access page and (password mode) sign-in");
  let previews;
  if (edge.previews) {
    if (edge.previews !== true) fail("settings.edge.previews is true or absent (previews take each app's own Access audience)");
    previews = { file: PREVIEWS_FILE, ports: PREVIEW_PORTS };
  }
  const gateHosts = [...Object.entries(hosts), ...(myApps ? [[myApps.host, myApps]] : [])];
  const anyAud = gateHosts.some(([, h]) => h.aud);
  const team = /^([a-z0-9-]+)\.cloudflareaccess\.com$/.exec(String(edge.team_domain ?? ""))?.[1];
  if (!team && (login === "access" || anyAud || edge.team_domain != null)) fail("settings.edge.team_domain must be <team>.cloudflareaccess.com");
  const issuer = team && `https://${team}.cloudflareaccess.com`;
  const gate = {
    port: GATE_PORT, login, ...(issuer ? { issuer, certs_url: `${issuer}/cdn-cgi/access/certs` } : {}),
    auth_url: AUTH_URL, auth_secret_file: AUTH_SECRET_FILE, accounts_file: ACCOUNTS_FILE, identity_key_file: IDENTITY_KEY_FILE, owner_email: owner,
    ...(myApps ? { my_apps: myApps } : {}), hosts, ...(previews ? { previews } : {}),
  };
  // Previews: *.<host> for each shared app, behind that app's aud, after every exact host (cloudflared takes the first match).
  const wild = previews ? Object.entries(hosts).map(([h, x]) => [`*.${h}`, x]) : [];
  const cloudflared = {
    tunnel: edge.tunnel_id,
    "credentials-file": "/run/secrets/cloudflared_credentials",
    ingress: [
      // cloudflared checks the Access token too (a second layer); the gate is the one that decides. Only a password-mode
      // host without an aud goes without Access.
      ...[...gateHosts, ...wild].map(([hostname, h]) => ({ hostname, service: GATE_URL, ...(h.aud ? { originRequest: { access: { required: true, teamName: team, audTag: [h.aud] } } } : {}) })),
      { service: "http_status:404" },
    ],
  };
  const hardening = { security_opt: ["no-new-privileges:true"], cap_drop: ["ALL"], restart: "unless-stopped", user: "${PUID:-1000}:${PGID:-100}", read_only: true };
  const compose = {
    services: {
      // Host networking: it listens on 127.0.0.1:<GATE_PORT> and reaches the apps' loopback ports. No secrets, no sockets.
      // Its signing key (vault identity/gate.pem, read-only; compile creates it) and nothing else of the identity dir.
      // The board's account map is the one file of data/ it sees (never data/board: no sessions, hashes or TOTP secrets).
      gate: {
        ...hardening, build: "./services/gate", image: "aidenhq/gate:local", network_mode: "host", environment: { GATE_CONFIG: "/config/gate.json" },
        volumes: [
          "./config/gate.json:/config/gate.json:ro", `\${AIDENHQ_DATA_DIR:-./data}/gate/accounts.json:${ACCOUNTS_FILE}:ro`,
          `\${AIDENHQ_SECRETS_DIR}/identity/gate.pem:${IDENTITY_KEY_FILE}:ro`,
          // Its proof to the board's auth listener (core's generated gate_board_secret): sign-in and app access.
          `\${AIDENHQ_SECRETS_DIR}/gate_board_secret:${AUTH_SECRET_FILE}:ro`,
          // Which previews run (apps-mcp writes it; a directory, so its atomic replace is seen).
          ...(previews ? [`\${AIDENHQ_DATA_DIR:-./data}/previews:${dirname(PREVIEWS_FILE)}:ro`] : []),
        ],
      },
      // The board reads the gate's config (the sign-in host, app hosts, login mode) and writes data/gate/accounts.json.
      // Only with edge: without it neither file exists, and a bind of a missing source would become a directory.
      board: { volumes: ["./config/gate.json:/config/gate.json:ro", "${AIDENHQ_DATA_DIR:-./data}/gate:/data/gate"] },
      // Outbound only; locally managed, so its ingress is this file and the dashboard can't change it.
      // The label carries the ingress's hash: compose recreates cloudflared exactly when its config changes (it reads it once).
      cloudflared: { ...hardening, labels: { "aidenhq.ingress-sha256": createHash("sha256").update(JSON.stringify(cloudflared)).digest("hex") }, image: CLOUDFLARED_IMAGE, network_mode: "host", command: ["tunnel", "--config", "/etc/cloudflared/config.yml", "run"], volumes: ["./config/cloudflared.yml:/etc/cloudflared/config.yml:ro"], secrets: ["cloudflared_credentials"], depends_on: ["gate"] },
    },
    secrets: { cloudflared_credentials: { file: "${AIDENHQ_SECRETS_DIR}/cloudflared_credentials.json" } },
  };
  return { gate, cloudflared, compose };
}

/**
 * Refuses any ingress whose target isn't the gate: only hostname → GATE_URL rules, then exactly the 404 catch-all. Every
 * rule requires Access, except with app_login password (the gate signs people in), where a rule may carry no Access at all.
 */
export function checkIngress(cfg, { login = "access" } = {}) {
  const bad = (m) => fail(`cloudflared ingress refused: ${m}`);
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
    if (r.service !== GATE_URL) bad(`${r.hostname} → ${r.service} (only ${GATE_URL}, the gate)`);
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
    console.error(e.message);
    process.exit(1);
  }
}

/**
 * Fails when two services claim one host port. `composes`: compose files ({ services }); `claims`: [port, who] the platform
 * holds outside compose (the host-networked gate, the board's auth listener, apps on loopback). The same `who` may repeat.
 */
export function checkPorts(composes, claims = []) {
  const owner = new Map();
  const claim = (port, who) => {
    if (owner.has(port) && owner.get(port) !== who) fail(`port ${port} is claimed by both ${owner.get(port)} and ${who}`);
    owner.set(port, who);
  };
  for (const [port, who] of claims) claim(Number(port), who);
  for (const c of composes) for (const [name, svc] of Object.entries(c?.services ?? {})) {
    for (const p of svc.ports ?? []) {
      // "ip:host:container", "host:container" or a long form; ${VAR:-default} resolves to its default.
      const parts = (typeof p === "object" ? String(p.published ?? "") : String(p).replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, "$1")).split(":");
      const host = typeof p === "object" ? parts[0] : parts.length >= 2 ? parts.at(-2) : "";
      if (/^\d+$/.test(host)) claim(Number(host), name);
    }
  }
}
