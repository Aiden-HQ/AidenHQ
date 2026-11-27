import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { tmpdir } from "node:os";
import { PolicyError, checkSources, sandbox } from "../src/policy.js";
import { isSensitive, parseApp } from "../src/registry.js";
import { checkPort, edgeTarget, serveConfig } from "../src/tailnet.js";

const DATA = "/data/apps";
const app = (o: object = {}) => parseApp({ name: "demo", repo: "example-org/x", owner: "a", description: "d", port: 8080, ...o });
const svc = (s: object) => ({ services: { web: { image: "x", ...s } } });
const run = (s: object, o: object = {}) => sandbox(svc(s), app(o), { APPS_DATA: DATA });

describe("image names", () => {
  const ctx = { context: `${DATA}/.platform/demo/src` };
  it("keep apps off the platform's images and other apps' names", () => {
    for (const s of [
      { image: "aidenhq/apps-mcp:local" },
      { image: "docker.io/aidenhq/apps-mcp-helper:x", pull_policy: "always" },
      { image: "index.docker.io/AidenHQ/apps-mcp:local" },
      { image: "registry-1.docker.io/library/aidenhq-board:local" },
      { image: "ghcr.io/aiden-hq/apps-mcp@sha256:" + "a".repeat(64) },
      { image: "app-other/web:1" },
      { image: "docker.io/library/app-other-web" },
      { image: "aidenhq/apps-mcp:local", build: ctx },
      { image: undefined, build: { ...ctx, tags: ["aidenhq/apps-mcp:local"] } },
      { image: "app-other-web", build: ctx },
      { image: "app-demo-web", build: ctx }, // compose's own name: app "demo-web"'s too
      { image: "docker.io/app-demo/web", build: ctx },
      { image: undefined, build: { ...ctx, tags: ["postgres:17"] } },
    ]) expect(() => run(s), JSON.stringify(s)).toThrow(PolicyError);
    for (const s of [{ image: "postgres:17" }, { image: "app-demo/web:1", build: { ...ctx, tags: ["app-demo/web:latest"] } }]) expect(() => run(s), JSON.stringify(s)).not.toThrow();
  });

  it("names an unnamed built image in the app's namespace, never compose's app-<name>-<service>", () => {
    expect(run({ image: undefined, build: ctx }).compose.services!.web.image).toBe("app-demo/web");
  });
});

describe("sandbox refuses", () => {
  it.each([
    ["privileged", { privileged: true }],
    ["a forged compose identity label", { labels: { "com.docker.compose.project": "app-other" } }],
    ["host network", { network_mode: "host" }],
    ["pid of another container", { pid: "container:apps-mcp" }],
    ["ipc of another container", { ipc: "container:x" }],
    ["group_add", { group_add: ["docker"] }],
    ["docker socket", { volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/s" }] }],
    ["writable bind of the app's own data dir", { volumes: [{ type: "bind", source: `${DATA}/demo/data`, target: "/e" }] }],
    ["writable checkout", { volumes: [{ type: "bind", source: `${DATA}/.platform/demo/src`, target: "/e" }] }],
    ["platform state", { volumes: [{ type: "bind", source: `${DATA}/.platform/demo`, target: "/e", read_only: true }] }],
    ["host path", { volumes: [{ type: "bind", source: "/etc", target: "/e" }] }],
    ["unlisted cap", { cap_add: ["SYS_ADMIN"] }],
    ["seccomp unconfined", { security_opt: ["seccomp=unconfined"] }],
    ["apparmor unconfined", { security_opt: ["apparmor=unconfined"] }],
    ["SELinux labels off", { security_opt: ["label=disable"] }],
    ["unmasked system paths", { security_opt: ["systempaths=unconfined"] }],
    ["no-new-privileges off", { security_opt: ["no-new-privileges:false"] }],
    ["hardening beside a loosening", { security_opt: ["no-new-privileges:true", "seccomp=unconfined"] }],
    ["read-only symlink out of the checkout", { volumes: [{ type: "bind", source: `${DATA}/.platform/demo/src/link`, target: "/e", read_only: true }] }, { realpath: (p: string) => (p.endsWith("/link") ? "/etc" : p) }],
    ["build context outside the checkout", { build: { context: `${DATA}/demo/other` } }],
    ["other published port", { ports: [{ target: 80, published: "22" }] }],
    // Allowlist: anything not known to be safe is refused, including keys newer compose versions add.
    ["Docker API socket", { use_api_socket: true }],
    ["a provider service (runs a host binary)", { provider: { type: "model" } }],
    ["host gateway", { extra_hosts: ["host.docker.internal:host-gateway"] }],
    ["post_start hook", { post_start: [{ command: "x" }] }],
    ["gpus", { gpus: "all" }],
    ["an unknown key", { some_future_key: 1 }],
    ["build entitlements", { build: { context: `${DATA}/.platform/demo/src`, entitlements: ["network.host"] } }],
    ["build cache export to the host", { build: { context: `${DATA}/.platform/demo/src`, cache_to: ["type=local,dest=/tmp/x"] } }],
  ])("%s", (...row: unknown[]) => { const [, s, o] = row as [string, Record<string, unknown>, { realpath: (p: string) => string }?]; expect(() => sandbox(svc(s), app(), { APPS_DATA: DATA, ...o })).toThrow(PolicyError); });

  it("refuses every bind on a remote host", () => {
    const bind = { volumes: [{ type: "bind", source: `${DATA}/.platform/demo/src/init`, target: "/r", read_only: true }] };
    expect(() => sandbox(svc(bind), app({ host: "remote1" }), { APPS_DATA: DATA })).toThrow(PolicyError);
  });

  it("refuses an env_file outside the checkout, before compose reads it", () => {
    const dir = mkdtempSync(`${tmpdir()}/co-`);
    mkdirSync(`${dir}/sub`);
    writeFileSync(`${dir}/compose.yaml`, "services:\n  web:\n    image: x\n    env_file: /etc/hosts\n");
    expect(() => checkSources(`${dir}/compose.yaml`, dir)).toThrow(PolicyError);
    writeFileSync(`${dir}/compose.yaml`, "services:\n  web:\n    image: x\n    env_file: sub/a.env\n");
    expect(() => checkSources(`${dir}/compose.yaml`, dir)).not.toThrow();
  });

  it("refuses a volume with a custom name, allows the default one", () => {
    expect(() => sandbox({ ...svc({}), volumes: { d: { name: "app-other_data" } } }, app(), { APPS_DATA: DATA })).toThrow(PolicyError);
    expect(() => sandbox({ ...svc({}), volumes: { d: { name: "app-demo_d" } } }, app(), { APPS_DATA: DATA })).not.toThrow();
  });

  it("refuses unknown top-level keys", () => {
    expect(() => sandbox({ ...svc({}), models: { m: {} } } as any, app(), { APPS_DATA: DATA })).toThrow(PolicyError);
  });

  it("allows the app starter's own compose service (its no-new-privileges security_opt included)", () => {
    const starter = parse(readFileSync(new URL("../../starter/compose.yaml", import.meta.url), "utf8")).services.app;
    expect(starter.security_opt).toEqual(["no-new-privileges:true"]);
    // `docker compose config` resolves "127.0.0.1:8080:8080" to the long form policy sees. Its host port becomes the app's
    // registry port, whichever the DevOps Engineer picked; the container port and the loopback binding stay.
    const [, published, target] = /^127\.0\.0\.1:(\d+):(\d+)$/.exec(starter.ports[0])!;
    const ports = () => [{ host_ip: "127.0.0.1", published, target: Number(target) }];
    const s = run({ ...starter, ports: ports(), image: undefined, build: { context: `${DATA}/.platform/demo/src` } }, { port: 8785 }).compose.services!.web;
    expect(s.security_opt).toEqual(["no-new-privileges:true"]);
    expect(s.ports).toEqual([expect.objectContaining({ published: "8785", target: Number(target), host_ip: "127.0.0.1" })]);
    // Anything else is refused as before: another bind address on another port, a second publish, or no registry port.
    const build = { image: undefined, build: { context: `${DATA}/.platform/demo/src` } };
    expect(() => run({ ...build, ports: [{ host_ip: "0.0.0.0", published, target: 8080 }] }, { port: 8785 })).toThrow(/published port 8080/);
    expect(() => run({ ...build, ports: [{ published, target: 8080 }] }, { port: 8785 })).toThrow(/published port 8080/);
    expect(() => run({ ...build, ports: [...ports(), { host_ip: "127.0.0.1", published: "9000", target: 9000 }] }, { port: 8785 })).toThrow(/second published port/);
    expect(() => run({ ...build, ports: ports() }, { port: undefined })).toThrow(/published port/);
  });

  it("allows an ordinary web service", () => {
    expect(() => run({ image: undefined, build: { context: `${DATA}/.platform/demo/src`, dockerfile: "Dockerfile", args: { A: "1" } }, command: ["node", "s.js"], environment: { A: "1" }, healthcheck: { test: ["CMD", "true"] }, restart: "unless-stopped", depends_on: { db: { condition: "service_healthy" } }, ports: [{ target: 3000, published: "8080" }], volumes: [{ type: "volume", source: "data", target: "/d" }], read_only: true, tmpfs: ["/tmp"], user: "1000", working_dir: "/app", init: true, ulimits: { nofile: 1024 } })).not.toThrow();
  });

});

describe("sandbox output", () => {
  const out = (o: object = {}) => run({ ports: [{ target: 80, published: "8080" }] }, o).compose;

  it("hardens, limits and binds ports to localhost", () => {
    const s = out().services!.web;
    expect(s.cap_drop).toEqual(["ALL"]);
    expect(s).toMatchObject({ mem_limit: "1g", cpus: 1, pids_limit: 512, security_opt: ["no-new-privileges:true"] });
    expect(s.ports.every((p: any) => p.host_ip === "127.0.0.1")).toBe(true);
    expect(s.runtime).toBeUndefined();
  });
  it("runs untrusted apps under gVisor", () => expect(out({ untrusted: true }).services!.web.runtime).toBe("runsc"));
  it("uses an internal network without internet", () => {
    const c = run({}, { internet: false, port: undefined }).compose;
    expect(c.networks!["app-demo"].internal).toBe(true);
  });
  it("joins only its own network plus connects", () => {
    const c = out({ connects: ["warehouse"] });
    expect(Object.keys(c.services!.web.networks)).toEqual(["app-demo", "c-apps_warehouse"]);
    expect(c.networks!["c-apps_warehouse"]).toMatchObject({ name: "apps_warehouse", external: true });
  });
  it("the sources network (writers and apps-mcp reach the warehouse there): sensitive to join, never an app's name", () => {
    expect(out({ connects: ["sources"] }).networks!["c-aidenhq_sources"]).toMatchObject({ name: "aidenhq_sources", external: true });
    expect(isSensitive(app({ connects: ["sources"] }), [])).toBe(true);
    expect(() => app({ name: "sources" })).toThrow();
  });
});

it("refuses the board's tailnet port", () => {
  expect(() => checkPort(app({ port: 8443 }))).toThrow(/reserved/);
});

it("serves each exposed app on the apps node: its port, proxied to the publishing container's own port", () => {
  const sb = sandbox({ services: { db: { image: "pg" }, web: { image: "x", ports: [{ target: 3000, published: "8080" }] } } }, app(), { APPS_DATA: DATA }).compose;
  const t = edgeTarget(app() as any, sb)!;
  expect(t).toEqual({ port: 8080, host: "edge-demo", target: 3000 }); // a platform-set alias, never a container name
  expect(sb.services!.db.networks["app-demo"]).toEqual({});
  expect(serveConfig([t])).toEqual({
    TCP: { "8080": { HTTPS: true } },
    Web: { "${TS_CERT_DOMAIN}:8080": { Handlers: { "/": { Proxy: "http://edge-demo:3000" } } } },
  });
  // Fails closed: no alias (deployed before it), no route; and no app may name a service edge-*.
  expect(edgeTarget(app() as any, { services: { web: { ports: [{ target: 3000, published: "8080" }], networks: { "app-demo": {} } } } })).toBeUndefined();
  expect(() => sandbox({ services: { "edge-other": { image: "x" } } }, app(), { APPS_DATA: DATA })).toThrow(PolicyError);
  expect(serveConfig([])).toEqual({}); // clears every route (an empty file would be ignored)
});

describe("app secrets are files, never values", () => {
  it("mounts each declared secret from the vault into every service", async () => {
    const { withSecrets } = await import("../src/policy.js");
    const a = app({ secrets: ["DB_PASSWORD"] });
    const out = withSecrets({ services: { web: { image: "x" }, worker: { image: "y", secrets: ["OTHER"] } } }, a, "/home/u/.config/aidenhq/apps", "/home/u/.config/aidenhq/identity/keys.json", true);
    expect(out.secrets).toEqual({ DB_PASSWORD: { file: "/home/u/.config/aidenhq/apps/demo/DB_PASSWORD" }, AIDENHQ_IDENTITY_KEYS: { file: "/home/u/.config/aidenhq/identity/keys.json" } });
    expect(out.services!.web.secrets).toEqual(["DB_PASSWORD", "AIDENHQ_IDENTITY_KEYS"]);
    expect(out.services!.worker.secrets).toEqual(["DB_PASSWORD", "AIDENHQ_IDENTITY_KEYS"]); // app-authored entries never survive
  });
  it("strips app-authored secrets and configs even when the app declares none", async () => {
    const { withSecrets } = await import("../src/policy.js");
    const out = withSecrets({ services: { web: { image: "x", secrets: ["S"], configs: ["C"] } }, secrets: { S: { file: "/etc/shadow" } }, configs: { C: { file: "/x" } } }, app(), "/h", "/k.json", true);
    expect(out).toEqual({ services: { web: { image: "x", environment: { AIDENHQ_APP: "demo", AIDENHQ_ANONYMOUS: "tailnet" }, secrets: ["AIDENHQ_IDENTITY_KEYS"] } }, secrets: { AIDENHQ_IDENTITY_KEYS: { file: "/k.json" } } });
  });
  it("sets the identity environment itself: the app's name, and anonymous tailnet reads only for an exposed, unshared app behind the apps' tailnet node", async () => {
    const { withSecrets } = await import("../src/policy.js");
    const forged = { services: { web: { image: "x", environment: { AIDENHQ_APP: "other", AIDENHQ_ANONYMOUS: "tailnet", KEEP: "1" } } } };
    const env = (o: object, node = true) => withSecrets(structuredClone(forged), app(o), "/h", "/k.json", node).services!.web.environment;
    expect(env({ port: 8080 })).toEqual({ KEEP: "1", AIDENHQ_APP: "demo", AIDENHQ_ANONYMOUS: "tailnet" });
    // No apps' tailnet node (local, tunnel or public install): the host's loopback is the only way in, so no anonymous callers.
    expect(env({ port: 8080 }, false)).toEqual({ KEEP: "1", AIDENHQ_APP: "demo" });
    expect(env({ port: 8080, expose: false })).toEqual({ KEEP: "1", AIDENHQ_APP: "demo" });
    expect(env({ port: 8080, share: { host: "demo.example.com", aud: "aud-12345678" } })).toEqual({ KEEP: "1", AIDENHQ_APP: "demo" });
  });
});

describe("the apps' tailnet node", () => {
  it("is the door only when compile says so and the node has an address; anything else fails closed", async () => {
    const { tailnetNode } = await import("../src/tailnet.js");
    const dir = mkdtempSync(`${tmpdir()}/node-`);
    const file = (v: string) => (writeFileSync(`${dir}/apps-node`, v), `${dir}/apps-node`);
    expect(tailnetNode(file("tailnet\n"), "https://acme-apps.example.ts.net")).toBe(true);
    expect(tailnetNode(file("none\n"), "https://acme-apps.example.ts.net")).toBe(false);
    expect(tailnetNode(file("tailnet\n"), "")).toBe(false);
    expect(tailnetNode(`${dir}/missing`, "https://acme-apps.example.ts.net")).toBe(false);
  });
});
