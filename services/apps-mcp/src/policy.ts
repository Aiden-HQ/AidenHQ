// Sandbox: runs on `docker compose config --format json` (fully resolved, so extends/include/interpolation can't hide
// anything). Refuses host-level options, injects hardening, rewrites networks and ports.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { parse } from "yaml";
import type { App } from "./registry.js";

export class PolicyError extends Error {}
export const edgeAlias = (app: string) => `edge-${app}`;
export type ComposeJson = { services?: Record<string, any>; networks?: Record<string, any>; volumes?: Record<string, any>; secrets?: Record<string, any>; configs?: Record<string, any>; [k: string]: unknown };

// Networks an app may join through `connects` (any other name is another app's own network).
// sources: the network only the warehouse (its owner, by `connects: [sources]`) and the AidenHQ services that read or write
// sources (compose.yaml) share; apps never join it, so they can't reach those services.
const SHARED: Record<string, string> = { warehouse: "apps_warehouse", paperclip: "aidenhq_backplane", sources: "aidenhq_sources" };
const SOCKETS = /docker\.sock|tailscaled\.sock/;
// The compose keys an app may use (as `docker compose config` resolves them). Keys with their own checks below
// (privileged, network_mode, security_opt, cap_add…) are listed so those checks give the specific reason.
const SERVICE_KEYS = new Set([
  "image", "build", "command", "entrypoint", "environment", "env_file", "healthcheck", "depends_on", "restart",
  "volumes", "tmpfs", "ports", "expose", "networks", "working_dir", "user", "read_only", "init", "labels",
  "stop_grace_period", "stop_signal", "ulimits", "shm_size", "hostname", "tty", "stdin_open", "platform", "pull_policy",
  "profiles", "dns", "deploy", "mem_limit", "memswap_limit", "cpus", "pids_limit", "secrets", "configs", "runtime",
  "privileged", "network_mode", "pid", "ipc", "userns_mode", "uts", "devices", "device_cgroup_rules", "security_opt",
  "volumes_from", "group_add", "cgroup_parent", "cgroup", "cap_add", "cap_drop",
]);
const BUILD_KEYS = new Set(["context", "dockerfile", "dockerfile_inline", "args", "target", "additional_contexts", "labels", "cache_from", "no_cache", "pull", "tags", "shm_size", "platforms", "network", "privileged", "secrets", "ssh"]);
const TOP_KEYS = new Set(["name", "services", "networks", "volumes", "secrets", "configs"]);
const cap = (c: string) => c.toUpperCase().replace(/^CAP_/, "");
const list = (v: unknown): any[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.keys(v) : v ? [v] : []);

/** realpath that tolerates a not-yet-created tail (Docker creates missing bind sources): resolves the nearest existing ancestor. */
export function real(p: string, rp: (p: string) => string = realpathSync): string {
  const abs = resolve(p);
  for (let cur = abs, rest = ""; ; rest = `/${cur.split("/").pop()}${rest}`, cur = dirname(cur)) {
    try {
      return posix.join(rp(cur), rest);
    } catch {
      if (cur === "/") throw new PolicyError(`cannot resolve ${p}`);
    }
  }
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).flatMap((x) => (typeof x === "string" ? [x] : typeof x?.path === "string" ? [x.path] : []));

/**
 * `docker compose config` reads env_file, extends and include files from the host before any policy sees the result, so the
 * raw YAML is checked first. Rather than re-implement compose's resolution, refuse what we don't need: `include`, `extends`
 * and interpolated (`$`) env_file paths. Remaining env_file paths must really live inside the checkout.
 */
export function checkSources(file: string, root: string, projectDir = root): void {
  const doc = (parse(readFileSync(file, "utf8"), { merge: true }) ?? {}) as any;
  for (const k of ["include", "secrets", "configs"]) if (doc[k]) throw new PolicyError(`top-level \`${k}\` is not supported; use one compose file and the app's env file`);
  for (const [name, svc] of Object.entries<any>(doc.services ?? {})) {
    for (const k of ["extends", "label_file"]) if (svc?.[k]) throw new PolicyError(`${name}: \`${k}\` is not supported`);
    for (const e of strs(svc?.env_file)) {
      if (e.includes("$") || e.startsWith("~") || isAbsolute(e) || e.split(/[\\/]/).includes("..")) throw new PolicyError(`${name}: env_file must be a plain relative path inside the app`);
      // compose may resolve against the compose file's dir or the project dir: both must stay inside the checkout
      for (const base of [dirname(file), projectDir, root]) {
        const r = real(resolve(base, e));
        if (r !== real(root) && !r.startsWith(`${real(root)}/`)) throw new PolicyError(`${e} is outside the app's checkout`);
      }
    }
  }
}

export function sandbox(resolved: ComposeJson, app: App, env: { APPS_DATA: string; realpath?: (p: string) => string }): { compose: ComposeJson } {
  // The checkout (and the sandboxed compose beside it) is platform state; containers may read it, never write it.
  const checkout = `${env.APPS_DATA}/.platform/${app.name}/src`;
  const rp = (p: string) => real(p, env.realpath);
  // The real path (symlinks followed) must be inside `base`, itself resolved.
  const within = (p: string, base: string) => {
    const r = rp(p);
    const b = rp(base);
    return r === b || r.startsWith(`${b}/`);
  };
  const refuse = (svc: string, what: string): never => {
    throw new PolicyError(`${app.name}/${svc}: ${what} is not allowed`);
  };
  // Apps get no writable host paths at all (their data lives in named volumes). The only host path is a read-only bind inside the
  // platform-owned checkout, judged on its realpath; never a socket.
  const inside = (x: string, base: string) => x === base || x.startsWith(`${base}/`);
  const hostPath = (svc: string, raw: string, readOnly = false): void => {
    const p = posix.resolve(raw);
    const r = rp(p);
    if (SOCKETS.test(p) || SOCKETS.test(r)) refuse(svc, `mounting ${p}`);
    if (app.host !== "local") refuse(svc, `host path ${p} (the path checks run here, not on ${app.host}: named volumes only)`);
    if (!(readOnly && rp(checkout) === checkout && inside(p, checkout) && inside(r, checkout))) refuse(svc, `host path ${p} (only read-only paths inside the app's checkout; use a named volume for data)`);
  };
  const own = `app-${app.name}`;
  const networks: Record<string, any> = { [own]: { name: own, ...(app.internet ? {} : { internal: true }) } };
  const attach = [own];
  for (const target of [app.name, ...app.connects]) {
    const net = target === app.name ? SHARED[target] : (SHARED[target] ?? `app-${target}`); // an app that owns a shared network joins it
    if (!net || attach.includes(`c-${net}`)) continue;
    networks[`c-${net}`] = { name: net, external: true };
    attach.push(`c-${net}`);
  }

  for (const k of Object.keys(resolved)) if (!TOP_KEYS.has(k)) refuse("compose", `top-level \`${k}\``);
  const services = resolved.services ?? {};
  for (const [svc, s] of Object.entries(services)) {
    // edge-<app> names an app to the apps' tailnet node (edgeAlias); a service name is a DNS name on its networks too.
    if (svc.startsWith("edge-")) refuse(svc, "a service name starting with edge-");
    // Allowlist first: a key compose adds later (use_api_socket, provider, post_start…) is refused until reviewed.
    for (const k of Object.keys(s)) if (!SERVICE_KEYS.has(k)) refuse(svc, `\`${k}\``);
    for (const k of Object.keys(s.build ?? {})) if (!BUILD_KEYS.has(k)) refuse(svc, `build \`${k}\``);
    if (s.privileged) refuse(svc, "privileged");
    // Compose's own labels identify a container as an app's (app_api targets by them): never app-set.
    for (const l of Array.isArray(s.labels) ? s.labels.map((x: string) => x.split("=")[0]) : Object.keys(s.labels ?? {})) if (String(l).startsWith("com.docker.compose.")) refuse(svc, `label ${l}`);
    // Any value of these joins a namespace outside the app (host, container:<other>, service:<other>).
    for (const k of ["network_mode", "pid", "ipc", "userns_mode"]) if (s[k]) refuse(svc, `${k}: ${s[k]}`);
    if (s.uts === "host") refuse(svc, "uts: host");
    for (const k of ["devices", "device_cgroup_rules", "security_opt", "volumes_from", "group_add", "cgroup_parent", "cgroup"]) if (list(s[k]).length || (k === "cgroup_parent" && s[k])) refuse(svc, k);
    const b = s.build;
    if (b) {
      if (b.privileged || b.network === "host" || list(b.secrets).length || list(b.ssh).length) refuse(svc, "privileged, host-network, secrets or ssh build");
      const ctx = String(b.context ?? "");
      // Build contexts are read from the host: only paths inside the checkout (no git/url contexts).
      const local = (c: string) => posix.isAbsolute(c) && within(c, checkout);
      if (!local(ctx)) refuse(svc, `build context ${ctx}`);
      if (b.dockerfile && !local(posix.resolve(ctx, b.dockerfile))) refuse(svc, `dockerfile ${b.dockerfile}`);
      for (const c of Object.values<string>(b.additional_contexts ?? {})) if (!c.startsWith("docker-image://") && !local(c)) refuse(svc, `additional build context ${c}`);
    }
    const extra = list(s.cap_add).filter((c) => !app.caps.map(cap).includes(cap(c)));
    if (extra.length) refuse(svc, `cap_add ${extra.join(",")}`);
    for (const v of s.volumes ?? []) {
      if (v.type === "bind") hostPath(svc, v.source, !!v.read_only);
      else if (v.type !== "volume" && v.type !== "tmpfs") refuse(svc, `volume type ${v.type}`);
    }
    for (const ef of list(s.env_file)) hostPath(svc, typeof ef === "string" ? ef : ef.path, true);
    // A preview's compose is its parent's: it publishes the parent's port, moved below to the preview's own.
    for (const p of s.ports ?? []) if (p.published === undefined || Number(p.published) !== (app.preview?.published ?? app.port)) refuse(svc, `published port ${p.published} (only the registry port is allowed)`);

    delete s.runtime;
    delete s.deploy?.resources;
    delete s.memswap_limit;
    Object.assign(s, {
      security_opt: ["no-new-privileges:true"],
      cap_drop: ["ALL"],
      cap_add: [...new Set([...list(s.cap_add).map(cap), ...app.caps.map(cap)])],
      mem_limit: app.limits?.memory ?? "1g",
      cpus: app.limits?.cpus ?? 1,
      pids_limit: app.limits?.pids ?? 512,
      // The service publishing the app's port answers to the apps' tailnet node as edge-<app>, on the app's own network only
      // (aliases are per network; apps can't set networks, so no other app holds the name). Container names can collide.
      networks: Object.fromEntries(attach.map((n) => [n, n === own && s.ports?.length ? { aliases: [edgeAlias(app.name)] } : {}])),
      ...(app.untrusted ? { runtime: "runsc" } : {}),
    });
    if (!s.cap_add.length) delete s.cap_add;
    if (s.ports) s.ports = s.ports.map((p: any) => ({ ...p, ...(app.preview ? { published: String(app.port) } : {}), host_ip: "127.0.0.1" }));
  }
  // Compose names a volume app-<name>_<key> unless told otherwise; a custom name could attach another app's volume.
  for (const [k, v] of Object.entries<any>(resolved.volumes ?? {})) if (v?.external || v?.driver_opts || (v?.driver && v.driver !== "local") || (v?.name && v.name !== `${own}_${k}`)) refuse(k, "an external, named or driver-backed volume");
  for (const kind of ["secrets", "configs"] as const) for (const [k, v] of Object.entries<any>(resolved[kind] ?? {})) if (v?.file) hostPath(k, v.file, true);

  return { compose: { ...resolved, services, networks } };
}

/**
 * App secrets reach containers as files, never as values: each declared secret is a file in the vault
 * (<hostDir>/<app>/<KEY>, a host path for the Docker daemon) mounted at /run/secrets/<KEY> in every service. Applied
 * after sandbox(), so the app's own compose can't declare secrets; the sandboxed compose and Docker's metadata hold
 * only paths. Apps use *_FILE conventions or read the file.
 * Identity (docs/design/app-identity.md): every service also gets the public keys (AIDENHQ_IDENTITY_KEYS, from
 * identityKeysFile) and AIDENHQ_APP, and AIDENHQ_ANONYMOUS=tailnet only for an exposed app that isn't shared; whatever the
 * app's compose said for these is overwritten.
 */
export const IDENTITY_KEYS = "AIDENHQ_IDENTITY_KEYS";
export function withSecrets(c: ComposeJson, app: App, hostDir: string, identityKeysFile: string): ComposeJson {
  // App-authored secrets and configs never survive (defense in depth: checkSources already refuses the top-level ones);
  // only the registry's declared secrets are granted.
  const { secrets: _s, configs: _c, ...rest } = c;
  const anonymous = !!app.port && app.expose && !app.share?.host; // tailnet.ts exposes(): token-less reads may be anonymous
  const services = Object.fromEntries(Object.entries<any>(c.services ?? {}).map(([n, s]) => {
    const { secrets: _ss, configs: _sc, ...svc } = s;
    if (Array.isArray(svc.environment)) throw new PolicyError(`service ${n}: environment must be a map`);
    const { AIDENHQ_APP: _a, AIDENHQ_ANONYMOUS: _n, ...env } = svc.environment ?? {};
    return [n, { ...svc, environment: { ...env, AIDENHQ_APP: app.name, ...(anonymous ? { AIDENHQ_ANONYMOUS: "tailnet" } : {}) }, secrets: [...app.secrets, IDENTITY_KEYS] }];
  }));
  return { ...rest, services, secrets: { ...Object.fromEntries(app.secrets.map((k) => [k, { file: `${hostDir}/${app.name}/${k}` }])), [IDENTITY_KEYS]: { file: identityKeysFile } } };
}

/**
 * The sandboxed compose file as written for `docker compose -f … up`. `docker compose config` already escapes every
 * literal dollar sign (including ones inside resolved values) by doubling it, so it is written as is: escaping again
 * turned an app's escaped command substitution into a literal at run time.
 */
export const serializeCompose = (c: ComposeJson): string => JSON.stringify(c, null, 1);
