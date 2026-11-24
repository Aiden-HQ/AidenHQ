// A module's compose services, generated from its validated `services:` declaration (spec §5.11). Modules ship no compose:
// any field outside kernel/schemas/services.json is a compile error, so a manifest can't express a bind mount, a socket, a
// capability, a host namespace, a DNS override or another module's network. Every service gets the hardened settings, its
// module's own network (aidenhq-mod-<module>, internal), its own egress network if it declares egress, its own secrets
// and, if declared, its module's data dir and own vault dir. Pure: scripts/modules.ts calls it and writes nothing here.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

type Dict = Record<string, unknown>;
/**
 * A service people reach through the gate (`share`): the gate's host for the module's app name, to its ui_port; with no host,
 * the install's module door (scripts/edge.ts). `service` is its compose key (the gate gives it AIDENHQ_APP_URL there).
 */
/** json-file has no rotation by default; every generated service (and the front door) gets this. */
export const LOG_ROTATION = { driver: "json-file", options: { "max-size": "20m", "max-file": "3" } };

export type Share = { name: string; service: string; port: number; share: { host: string; aud?: string; default_role?: string } };
export type Generated = { services: Record<string, Dict>; networks: Record<string, Dict>; secrets: Record<string, Dict>; roots: Record<string, Dict>; dataDirs: string[]; stateDirs: string[]; shares: Share[] };

/**
 * What the caller (the compiler) still lets this module reach of the root stack before its kernel routes exist, from its
 * closed, shrink-only legacy lists: `links`, root compose services (one network per pair, shared only by the linking
 * services and that root service) or root compose networks; `secrets`, root secrets it may mount; `hostEnv`, host
 * variables its env may read; `opsNetwork`, the network the ops shell creates for it (fixed bridge, subnet and firewall rule), which its services join alone.
 */
export type Legacy = { links?: string[]; secrets?: string[]; hostEnv?: string[]; opsNetwork?: string };

/** The closed privileged list (spec §5.6) plus host-metrics: read-only host /, /sys and /proc for collectors (ruling c). */
export const PRIVILEGED = ["docker", "host-unit", "sandbox-provider", "paperclip-plugin", "speaks-as-owner", "git-credential", "reviewer", "host-metrics"];

export const SERVICE_FIELDS = ["image", "build", "command", "entrypoint", "env", "secrets", "port", "ui_port", "healthcheck", "cpus", "memory", "pids", "user", "read_only", "tmp", "data", "state", "points", "workspaces", "host_mounts", "egress", "links", "join", "on_demand", "when", "share"];
/** The gate's public keys (scripts/identity.ts), which a shared service verifies people's identity with, as apps do. */
export const IDENTITY_KEYS_SECRET = "aidenhq_identity_keys";
/**
 * The code host's (privileged: [git-credential]): the job workspaces (the kernel's work_dir/tasks) read-only, and the host variables that name the product and instance repositories.
 */
const GIT_CREDENTIAL_HOST_ENV = ["AIDENHQ_PRODUCT_REPO", "AIDENHQ_INSTANCE_REPO"];
const SERVICES_FIELDS = ["run", "data"];
const HEALTH_FIELDS = ["test", "interval", "timeout", "retries", "start_period"];
const USERS: Record<string, string | undefined> = { owner: "${PUID:-1000}:${PGID:-100}", nobody: "65534:65534", image: undefined };
const DNS = ["1.1.1.1", "8.8.8.8"]; // fixed public resolvers: a container keeps the host's from when it started
const DIGEST = /^[a-z0-9][a-z0-9./_-]*(:[\w.-]+)?@sha256:[0-9a-f]{64}$/;
const SIZE = /^\d{1,5}[mg]$/;
const PATH = /^\/[\w.-]+(\/[\w.-]+)*$/;
const SECRET = /^[a-z0-9_]{1,64}$/;

const fail = (msg: string): never => { throw new Error(msg); };
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, where: string): string[] => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : fail(`${where} must be a list of strings`));
const noDots = (p: string) => !p.split("/").includes("..");

/** 10.240.0.0/12 in /26s, by the network's name: stable whatever else is enabled. Collisions are checked by the caller. */
export function subnetFor(name: string): string {
  const n = createHash("sha256").update(name).digest().readUInt32BE(0) % 16384;
  return `10.${240 + (n >> 10)}.${(n >> 2) & 255}.${(n & 3) * 64}/26`;
}

/**
 * What compose would expand: `$$` passes (a literal $), as does a `$` compose leaves alone (`($|/)`); `${secrets.x}` and the
 * module's host variables only where `env` allows them; any other `${…}` or `$NAME` fails.
 */
function interpolation(value: string, where: string, env?: { host: string[]; secret: (n: string) => void }): string {
  return value.replace(/\$\$|\$\{([^}]*)\}|\$(?=[A-Za-z_{])/g, (m, inner: string | undefined) => {
    if (m === "$$") return m;
    if (env && inner !== undefined) {
      const s = /^secrets\.([a-z0-9_]+)$/.exec(inner);
      if (s) { env.secret(s[1]!); return `/run/secrets/${s[1]}`; }
      const h = /^([A-Z][A-Z0-9_]*)(:-[^$]*)?$/.exec(inner);
      if (h && env.host.includes(h[1]!)) return m;
    }
    return fail(`${where}: ${m} is not allowed (only $$, \${secrets.<name>} and the module's host variables in env)`);
  });
}

/** The module's own secrets: what it declares; a root secret only ever through its legacy list. */
export function ownSecrets(def: Dict): string[] {
  const s = isMap(def.secrets) ? def.secrets : {};
  const provided = (Array.isArray(s.provided) ? s.provided : []).map((p) => (isMap(p) ? p.name : p));
  const auth = Object.values(isMap(def.connections) ? def.connections : {}).map((c) => (isMap(c) ? c.auth : undefined));
  const jobcaps = (Array.isArray(def.jobcaps) ? def.jobcaps : []).map((j) => (isMap(j) ? j.read_secret : undefined));
  const all = [def.generated_secrets, def.optional_secrets, s.generated, provided, auth, jobcaps].flat().filter((x): x is string => typeof x === "string");
  return [...new Set(all)];
}

/**
 * Validates a module's `services:` (and `board_env`, `secrets.state`, `privileged`) and returns its compose contributions:
 * services keyed `<module>-<svc>` (the old name stays a network alias), networks, secret files, additions to root services
 * (`roots`: environment, secrets and networks added to root services) and the data dirs to create.
 * ctx.local: the module comes from a local-path marketplace source (only those may build). ctx.rootServices, rootNetworks,
 * rootSecrets: the root compose's, which a module reaches only through ctx.legacy.
 */
export function generateCompose(name: string, def: Dict, ctx: { root: string; local: boolean; rootServices?: string[]; rootNetworks?: string[]; rootSecrets?: string[]; legacy?: Legacy; workDir?: string; settings?: Dict }): Generated {
  const out: Generated = { services: {}, networks: {}, secrets: {}, roots: {}, dataDirs: [], stateDirs: [], shares: [] };
  const svcs = def.services;
  const where = (f: string) => `${name}: ${f}`;
  const privileged = def.privileged == null ? [] : strings(def.privileged, where("privileged"));
  for (const p of privileged) if (!PRIVILEGED.includes(p)) fail(where(`privileged entry ${p} is not in the closed list (${PRIVILEGED.join(", ")})`));
  const secretsDecl = isMap(def.secrets) ? def.secrets : def.secrets == null ? {} : fail(where("secrets must be a map"));
  for (const k of Object.keys(secretsDecl)) if (!["generated", "provided", "state"].includes(k)) fail(where(`secrets.${k} is not allowed`));
  if (secretsDecl.state != null && typeof secretsDecl.state !== "boolean") fail(where("secrets.state is true or false"));
  const own = new Set(ownSecrets(def));
  const rootSecrets = new Set(ctx.rootSecrets ?? []);
  const lg = ctx.legacy ?? {};
  const legacySecrets = lg.secrets ?? [];
  const secretFile = (s: string, what: string) => {
    if (!SECRET.test(s)) fail(`${what}: ${s} is not a secret name`);
    if (legacySecrets.includes(s)) return void (out.secrets[s] = { file: `\${AIDENHQ_SECRETS_DIR}/${s}` });
    if (!own.has(s) || rootSecrets.has(s)) fail(`${what}: secret ${s} isn't one of ${name}'s own (declare it under secrets, generated_secrets or optional_secrets)`);
    out.secrets[s] = { file: `\${AIDENHQ_SECRETS_DIR}/${s}` };
  };
  // A module whose sign-in returns to the board (board.signins) or whose setup flow links back to it (board.setup_flows) may
  // read the board's https address (BOARD_LAN_URL): the one redirect besides loopback its sign-in accepts, and where a link
  // to an in-app route points from a chat that cannot open a bare `#/` route.
  const contributed = isMap(def.contributes) ? def.contributes : {};
  const signIns = contributed["board.signins"];
  const setupFlows = contributed["board.setup_flows"];
  const boardAddress = (Array.isArray(signIns) && signIns.length) || (Array.isArray(setupFlows) && setupFlows.length);
  const gitCredential = privileged.includes("git-credential");
  const host = [...(lg.hostEnv ?? []), ...(boardAddress ? ["BOARD_LAN_URL"] : []), ...(gitCredential ? GIT_CREDENTIAL_HOST_ENV : [])];
  const envOf = (env: unknown, what: string, mounts: string[]) => {
    if (env == null) return {};
    if (!isMap(env)) return fail(`${what} must be a map`);
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) fail(`${what}: ${k} is not a variable name`);
      if (!["string", "number", "boolean"].includes(typeof v)) fail(`${what}.${k} must be a string`);
      o[k] = interpolation(String(v), `${what}.${k}`, { host, secret: (s) => { secretFile(s, `${what}.${k}`); mounts.push(s); } });
    }
    return o;
  };

  if (def.board_env != null) {
    const mounts: string[] = [];
    const environment = envOf(def.board_env, where("board_env"), mounts);
    out.roots.board = { environment, ...(mounts.length ? { secrets: [...new Set(mounts)] } : {}) };
  }
  if (svcs == null) return out;
  const sv: Dict = isMap(svcs) ? svcs : fail(where("services must be a map"));
  for (const k of Object.keys(sv)) if (!SERVICES_FIELDS.includes(k)) fail(where(`services.${k} is not allowed`));
  if (sv.data != null && typeof sv.data !== "boolean") fail(where("services.data is true or false"));
  if (!isMap(sv.run) || !Object.keys(sv.run).length) fail(where("services.run must map each service's name to its declaration"));
  const requires = Array.isArray(def.requires) ? def.requires.map(String) : [];
  const legacy = lg.links ?? [];
  const ops = lg.opsNetwork;
  const own_net = `mod-${name}`;
  const net = (key: string, n: string, internal: boolean) => (out.networks[key] ??= { name: n, ...(internal ? { internal: true } : {}), ipam: { config: [{ subnet: subnetFor(n) }] } });
  if (ops) out.networks[own_net] = { name: ops, external: true };
  else net(own_net, `aidenhq-mod-${name}`, true);

  for (const [svc, raw] of Object.entries(sv.run as Dict)) {
    const at = (f: string) => `${name}: services.run.${svc}.${f}`;
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(svc)) fail(where(`services.run: ${svc} is not a service name (a-z, 0-9, -)`));
    if (!isMap(raw)) fail(at("") + " must be a map");
    const s = raw as Dict;
    for (const f of Object.keys(s)) if (!SERVICE_FIELDS.includes(f)) fail(`${at(f)} is not allowed`);
    // `when: { <setting>: <value> }`: the service runs only while every named setting has that value (primer_mode: self-host);
    // `true` means any non-empty value (platform: no container until forks is set).
    if (s.when != null) {
      if (!isMap(s.when) || !Object.keys(s.when).length || Object.values(s.when).some((v) => typeof v !== "string" && v !== true)) fail(`${at("when")} maps settings to the values the service runs with (or true: set)`);
      if (!Object.entries(s.when as Dict).every(([k, v]) => (v === true ? String(ctx.settings?.[k] ?? "") !== "" : String(ctx.settings?.[k] ?? "") === v))) continue;
    }
    const key = svc.startsWith(`${name}-`) ? svc : `${name}-${svc}`;
    const o: Dict = {};
    // Image: by digest, or built from a folder inside the module (local sources only).
    if (s.build != null) {
      if (!ctx.local) fail(`${at("build")}: a module from a remote source needs an image by digest`);
      if (s.image != null) fail(`${at("image")}: a built service names no image (it is aidenhq/${key}:local)`);
      // `.`: the module's own folder (one image built from more than one of its trees).
      const b = typeof s.build === "string" && /^\.(\/[\w./-]+)?$/.test(s.build) && noDots(s.build.slice(1)) ? resolve(ctx.root, s.build) : fail(`${at("build")} must be the module's folder or a folder in it (. or ./…)`);
      if (!(b === ctx.root || b.startsWith(ctx.root + sep)) || !existsSync(join(b, "Dockerfile"))) fail(`${at("build")}: ${s.build} has no Dockerfile in the module`);
      Object.assign(o, { build: b, image: `aidenhq/${key}:local` });
    } else if (typeof s.image === "string" && DIGEST.test(s.image)) o.image = s.image;
    else fail(`${at("image")} must be pinned by digest (name@sha256:…)`);
    const user = s.user ?? "owner";
    if (typeof user !== "string" || !(user in USERS)) fail(`${at("user")} is owner, nobody or image`);
    if (USERS[user as string]) o.user = USERS[user as string];
    if (s.read_only != null && typeof s.read_only !== "boolean") fail(`${at("read_only")} is true or false`);
    if (s.read_only !== false) o.read_only = true;
    if (s.tmp != null) o.tmpfs = [`/tmp:size=${typeof s.tmp === "string" && SIZE.test(s.tmp) ? s.tmp : fail(`${at("tmp")} is a size (16m)`)}`];
    // init: a node PID 1 never reaps its exited children (git zombies); logging: json-file has no rotation by default.
    Object.assign(o, { init: true, logging: LOG_ROTATION, security_opt: ["no-new-privileges:true"], cap_drop: ["ALL"], restart: s.on_demand === true ? "no" : "unless-stopped" });
    if (s.on_demand != null && typeof s.on_demand !== "boolean") fail(`${at("on_demand")} is true or false`);
    if (s.on_demand === true) o.profiles = [name];
    for (const f of ["entrypoint", "command"]) if (s[f] != null) o[f] = strings(s[f], at(f)).map((v) => interpolation(v, at(f)));
    const mounts: string[] = [];
    const environment = envOf(s.env, at("env"), mounts);
    if (Object.keys(environment).length) o.environment = environment;
    for (const x of s.secrets == null ? [] : strings(s.secrets, at("secrets"))) { secretFile(x, at("secrets")); mounts.push(x); }
    if (mounts.length) o.secrets = [...new Set(mounts)];
    // Mounts: the module's data dir and own vault dir, read-only host paths for host-metrics; nothing else exists.
    const volumes: string[] = [];
    for (const d of s.data == null ? [] : strings(s.data, at("data"))) {
      const m = /^([a-z0-9][a-z0-9_-]*):(\/[^:]+?)(:ro)?$/.exec(d);
      if (!m || !PATH.test(m[2]!) || !noDots(m[2]!)) fail(`${at("data")}: ${d} is not <folder>:<container path>[:ro]`);
      if (sv.data !== true) fail(`${at("data")}: declare services.data: true (the module's data dir)`);
      volumes.push(`\${AIDENHQ_DATA_DIR:-./data}/modules/${name}/${m![1]}:${m![2]}${m![3] ?? ""}`);
      out.dataDirs.push(`modules/${name}/${m![1]}`);
    }
    if (s.state != null) {
      const m = typeof s.state === "string" ? /^(\/[^:]+?)(:ro)?$/.exec(s.state) : null;
      if (!m || !PATH.test(m[1]!) || !noDots(m[1]!)) fail(`${at("state")} is a container path (/state), optionally :ro`);
      if (secretsDecl.state !== true) fail(`${at("state")}: declare secrets.state: true (the module's own vault dir)`);
      volumes.push(`\${AIDENHQ_SECRETS_DIR}/modules/${name}:${m![1]}${m![2] ?? ""}`);
      out.stateDirs.push(`modules/${name}`);
    }
    const mountAt = (f: string) => (typeof s[f] === "string" && PATH.test(s[f] as string) && noDots(s[f] as string) ? (s[f] as string) : fail(`${at(f)} is a container path (/points.json)`));
    // Its own points' contributions (config/points/<module>.json), read-only.
    if (s.points != null) {
      if (!isMap(def.points)) fail(`${at("points")}: the module defines no points`);
      volumes.push(`\${AIDENHQ_CONFIG_DIR:-./config}/points/${name}.json:${mountAt("points")}:ro`);
    }
    if (s.workspaces != null) {
      if (!gitCredential) fail(`${at("workspaces")}: needs privileged: [git-credential]`);
      if (!ctx.workDir || !ctx.workDir.startsWith("/") || ctx.workDir.includes(":")) fail(`${at("workspaces")}: the host's work_dir isn't known`);
      volumes.push(`${ctx.workDir}/tasks:${mountAt("workspaces")}:ro`);
    }
    for (const h of s.host_mounts == null ? [] : strings(s.host_mounts, at("host_mounts"))) {
      if (!privileged.includes("host-metrics")) fail(`${at("host_mounts")}: needs privileged: [host-metrics]`);
      if (!/^(\/|\/sys|\/proc):\/[\w.-]+(\/[\w.-]+)*:ro(,rslave)?$/.test(h)) fail(`${at("host_mounts")}: ${h} is not a read-only mount of /, /sys or /proc`);
      volumes.push(h);
    }
    if (volumes.length) o.volumes = volumes;
    if (s.port != null && !(Number.isInteger(s.port) && (s.port as number) > 0 && (s.port as number) < 65536)) fail(`${at("port")} is a port number`);
    if (s.ui_port != null) {
      if (!(Number.isInteger(s.ui_port) && (s.ui_port as number) >= 1024 && (s.ui_port as number) < 65536) || s.port == null) fail(`${at("ui_port")} is a host port (1024-65535) for its port`);
      o.ports = [`127.0.0.1:${s.ui_port}:${s.port}`];
    }
    // `share: { host, aud?, default_role? }`: people reach the service through the gate at https://<host> as app `<module>`,
    // like a shared app (scripts/edge.ts); host comes from a setting only the instance sets, empty: the install's module door
    // (the board's host on the door port, AidenHQ admins only; docs/design/app-doors.md). The service
    // gets the gate's public keys at /run/secrets/AIDENHQ_IDENTITY_KEYS and AIDENHQ_APP, to verify X-AidenHQ-Identity.
    if (s.share != null) {
      const sh = isMap(s.share) ? s.share : fail(`${at("share")} must be a map`);
      for (const f of Object.keys(sh)) if (!["host", "aud", "default_role"].includes(f)) fail(`${at(`share.${f}`)} is not allowed`);
      if (s.ui_port == null) fail(`${at("share")}: needs a ui_port (the gate proxies to 127.0.0.1:<ui_port>)`);
      if (out.shares.length) fail(`${at("share")}: a module shares one service (its app name is the module's)`);
      out.secrets[IDENTITY_KEYS_SECRET] = { file: "${AIDENHQ_SECRETS_DIR}/identity/keys.json" };
      o.secrets = [...((o.secrets as unknown[]) ?? []), { source: IDENTITY_KEYS_SECRET, target: "AIDENHQ_IDENTITY_KEYS" }];
      o.environment = { ...((o.environment as Dict) ?? {}), AIDENHQ_APP: name };
      out.shares.push({ name, service: key, port: s.ui_port as number, share: { host: String(sh.host ?? ""), ...(sh.aud ? { aud: String(sh.aud) } : {}), ...(sh.default_role ? { default_role: String(sh.default_role) } : {}) } });
    }
    if (s.healthcheck != null) {
      const h = isMap(s.healthcheck) ? s.healthcheck : fail(`${at("healthcheck")} must be a map`);
      for (const f of Object.keys(h)) if (!HEALTH_FIELDS.includes(f)) fail(`${at(`healthcheck.${f}`)} is not allowed`);
      o.healthcheck = { ...h, test: strings(h.test, at("healthcheck.test")).map((v) => interpolation(v, at("healthcheck.test"))) };
    }
    if (s.cpus != null) o.cpus = typeof s.cpus === "number" && s.cpus > 0 && s.cpus <= 64 ? s.cpus : fail(`${at("cpus")} is 0-64`);
    if (s.memory != null) o.mem_limit = typeof s.memory === "string" && SIZE.test(s.memory) ? s.memory : fail(`${at("memory")} is a size (2g)`);
    if (s.pids != null) o.pids_limit = Number.isInteger(s.pids) && (s.pids as number) > 0 ? s.pids : fail(`${at("pids")} is a number`);
    // Networks: its module's own; its own egress; legacy root links; networks of modules it requires.
    if (s.egress != null && typeof s.egress !== "boolean") fail(`${at("egress")} is true or false`);
    const nets: string[] = [own_net];
    if (s.egress === true && !ops) { net(`${own_net}-egress`, `aidenhq-mod-${name}-egress`, false); nets.push(`${own_net}-egress`); }
    for (const l of s.links == null ? [] : strings(s.links, at("links"))) {
      if (!legacy.includes(l)) fail(`${at("links")}: ${name} may not reach ${l}`);
      if ((ctx.rootNetworks ?? []).includes(l)) nets.push(l);
      else if ((ctx.rootServices ?? []).includes(l)) {
        const k = `${own_net}-${l}`;
        net(k, `aidenhq-mod-${name}-${l}`, true);
        nets.push(k);
        const r = (out.roots[l] ??= {});
        r.networks = [...new Set([...((r.networks as string[]) ?? []), k])];
      } else fail(`${at("links")}: ${l} is neither a root service nor a root network`);
    }
    for (const j of s.join == null ? [] : strings(s.join, at("join"))) {
      if (!requires.includes(j) || j === name) fail(`${at("join")}: ${name} may join only the network of a module it requires (${j})`);
      nets.push(`mod-${j}`);
    }
    if (s.egress === true || ops) o.dns = DNS;
    o.networks = Object.fromEntries([...new Set(nets)].map((n) => [n, key === svc ? {} : { aliases: [svc] }]));
    // Read by the kernel's resolver (net.ts) and the host's isolation check, which compares the running networks against them.
    const links = s.links == null ? [] : (s.links as string[]), joins = s.join == null ? [] : (s.join as string[]);
    o.labels = { "aidenhq.module": name, "aidenhq.service": svc, ...(links.length ? { "aidenhq.links": links.join(",") } : {}), ...(joins.length ? { "aidenhq.join": joins.join(",") } : {}), ...(ops ? { "aidenhq.ops_network": ops } : {}) };
    if (key in out.services) fail(where(`two services are named ${key}`));
    out.services[key] = o;
  }
  return out;
}
