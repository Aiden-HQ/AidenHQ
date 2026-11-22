// The identity gate (checks.ts identityProbes) against the real starter server, run as the platform runs it.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { finishedJob, IDENTITY_SCRIPT, identityDoors, identityPorts, identityProbeArgs, mergeScans, noHttpSurface, processUids, identityProbes, judgeIdentity, NO_SIGN_IN, unprobedServices, type Door } from "../src/checks.js";
import { agentSigner, forgedIdentity, IDENTITY_HEADER } from "../src/identity.js";
import { parseApp } from "../src/registry.js";

const SERVER = fileURLToPath(new URL("../../starter/server.mjs", import.meta.url));
const MIDDLEWARE = fileURLToPath(new URL("../../starter/aidenhq-identity.mjs", import.meta.url));
const dist = mkdtempSync(`${tmpdir()}/dist-`);
writeFileSync(`${dist}/index.html`, '<!doctype html><meta name="csp-nonce" content="__CSP_NONCE__"><div id="root"></div>');
const noKey = () => { throw new Error("no key"); };

const tailnet = parseApp({ name: "demo", repo: "example-org/x", owner: "a", description: "d", port: 8080, health: { url: "http://app:8080/api/health" } });
const shared = parseApp({ ...tailnet, share: { host: "demo.example.com" } });

const children: ChildProcess[] = [];
afterAll(() => children.forEach((c) => c.kill()));

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });

/** The starter's server.mjs on a free port, with the env the platform gives an app (policy.ts withSecrets). */
async function starter(env: Record<string, string>, code?: string, host = "127.0.0.1"): Promise<string> {
  const port = await freePort();
  const c = spawn(process.execPath, code ? ["--input-type=module", "-e", code] : [SERVER], { env: { PATH: process.env.PATH, PORT: String(port), HOST: host, DIST_DIR: dist, ...env }, stdio: "ignore" });
  children.push(c);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://${host}:${port}/api/health`).then((r) => r.ok, () => false)) return `http://${host}:${port}`;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the server didn't start");
}

/** `node`: the apps' tailnet node is the instance's door (tailnet.ts tailnetNode); false on a local, tunnel or public install. */
async function gate(app: typeof tailnet, base: string, node = true) {
  const forged = forgedIdentity(app.name, noKey);
  const answers = [];
  for (const probe of identityProbes(app, node, "/api/health")) {
    const r = await fetch(base + probe.path, { method: probe.method, headers: probe.forged ? { [IDENTITY_HEADER]: forged } : {}, redirect: "manual" });
    answers.push({ probe, status: r.status });
  }
  return judgeIdentity(answers);
}

/**
 * The platform's scan of one container (platform.ts identityCheck): IDENTITY_SCRIPT given its exposed ports, then the verdict.
 * `proc` replays a container's proc tree (a real one's topology needs Docker's pid namespace); without it the host's /proc
 * stands in, and sockets are off unless `keep`.
 */
function scan(app: typeof tailnet, exposed: number[], o: { required?: Door[]; ips?: string[]; keep?: number[]; proc?: string } = {}) {
  const probes = identityProbes(app, true, app.health.url ? new URL(app.health.url).pathname : undefined);
  const forged = forgedIdentity(app.name, noKey);
  const input = { ports: exposed, ips: o.ips ?? [], tls: noHttpSurface(app), ...(o.proc ? { proc: o.proc } : {}), probes: probes.map((p) => ({ method: p.method, path: p.path, headers: p.forged ? { [IDENTITY_HEADER]: forged } : {} })) };
  return new Promise<ReturnType<typeof identityPorts>>((ok, fail) => {
    // Sockets off unless `keep`: here /proc/net/tcp is the test host's, not one app container's.
    const script = o.keep || o.proc ? IDENTITY_SCRIPT : IDENTITY_SCRIPT.replace('[[proc + "/net/tcp", v4], [proc + "/net/tcp6", v6]]', "[]");
    const c = execFile(process.execPath, ["-e", script], (err, out) => {
      if (err) return fail(err);
      const sockets = (JSON.parse(out) as { sockets: any[] }).sockets.filter((k) => o.proc || (o.keep ?? exposed).includes(k.port)); // only this test's servers
      ok(identityPorts(sockets.map((k) => ({ service: "app", port: k.port, host: k.host, listening: k.listening, raw: k.raw, ...(k.tls ? { tls: k.tls } : {}), answers: k.statuses.map((status: number, i: number) => ({ probe: probes[i]!, status })) })), o.required ?? [], [], noHttpSurface(app)));
    });
    c.stdin!.end(JSON.stringify(input));
  });
}

/**
 * A proc tree as IDENTITY_SCRIPT sees a container's: its net/tcp{,6} rows and the pids whose /proc/<pid>/fd hold socket
 * inodes. A peer helper that shares the network namespace but not the pid namespace is a listener whose inode no pid holds.
 */
function procTree(o: { listeners: { port: number; inode: number }[]; held: number[] }): string {
  const root = mkdtempSync(`${tmpdir()}/proc-`);
  mkdirSync(`${root}/net`);
  const row = (port: number, inode: number, local = "0100007F") =>
    `0: ${local}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 ${inode} 1 0000000000000000 100 0 0 10 0`;
  writeFileSync(`${root}/net/tcp`, ["  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode", ...o.listeners.map((l) => row(l.port, l.inode))].join("\n"));
  writeFileSync(`${root}/net/tcp6`, "  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode\n");
  // The app's own processes: pid 42 holds its listeners (and an unrelated stdin); pid 43 is the app's second process.
  const pid = (n: number, links: Record<string, string>) => {
    mkdirSync(`${root}/${n}/fd`, { recursive: true });
    for (const [fd, target] of Object.entries(links)) symlinkSync(target, `${root}/${n}/fd/${fd}`);
  };
  pid(42, Object.fromEntries([["0", "/dev/null"], ...o.held.map((i, n) => [String(n + 3), `socket:[${i}]`])]));
  pid(43, { 0: "/dev/null" });
  return root;
}
const portOf = (base: string) => Number(new URL(base).port);
/** The socket inode of a listening TCP port in this host's table (undefined where /proc/net/tcp isn't readable). */
function inodeOf(port: number): number | undefined {
  let t = "";
  try { t = readFileSync("/proc/net/tcp", "utf8"); } catch { return undefined; }
  for (const l of t.split("\n").slice(1)) {
    const c = l.trim().split(/\s+/);
    if (c[3] !== "0A" || parseInt(c[1]!.split(":")[1]!, 16) !== port) continue;
    return Number(c[9]);
  }
  return undefined;
}
/** A raw TCP server on a free port: `code` is its connection handler `(s) => ...`. */
async function tcp(code: string, host = "127.0.0.1"): Promise<number> {
  const port = await freePort();
  children.push(spawn(process.execPath, ["-e", `require("net").createServer(${code}).listen(${port}, "${host}")`], { stdio: "ignore" }));
  await new Promise((r) => setTimeout(r, 300));
  return port;
}
/**
 * A TLS listener's answers, without needing a certificate: a ClientHello gets the opening of a real handshake record
 * (`16 03 03`, as Node's own TLS server answers one) and the plaintext GET gets a TLS alert (`15 03 03 00 02 02 28`).
 * That pair is exactly what a real HTTPS listener produced when checked offline against `tls.createServer`; the gate reads
 * only the record opening, so no key material belongs in the repo.
 */
const tlsResponder = (): Promise<number> => tcp(`(s) => s.on("data", (d) => {
  s.end(d[0] === 0x16 ? Buffer.from([0x16, 0x03, 0x03, 0, 4, 2, 0, 0, 0]) : Buffer.from([0x15, 0x03, 0x03, 0, 2, 2, 40]));
})`);
// This host's own non-loopback IPv4 address: an app container's eth0.
const eth0 = Object.values(networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;
// hello2: no registry port, no health.url, a compose that publishes nothing; its image EXPOSEs 8080.
const hello2 = parseApp({ name: "hello2", repo: "example-org/x", owner: "a", description: "d" });

describe("identity gate", () => {
  it("passes the starter, shared and tailnet-only", async () => {
    expect(await gate(shared, await starter({ AIDENHQ_APP: "demo" }))).toMatchObject({ ok: true });
    expect(await gate(tailnet, await starter({ AIDENHQ_APP: "demo", AIDENHQ_ANONYMOUS: "tailnet" }))).toMatchObject({ ok: true });
  });

  it("without the apps' tailnet node, refuses an exposed app that lets token-less callers in", async () => {
    // A local install (no tailnet): the only way in is the host's loopback, so token-less is never anonymous.
    const r = await gate(tailnet, await starter({ AIDENHQ_APP: "demo", AIDENHQ_ANONYMOUS: "tailnet" }), false);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.what).toContain(NO_SIGN_IN);
    expect(await gate(tailnet, await starter({ AIDENHQ_APP: "demo" }), false)).toMatchObject({ ok: true });
  });

  it("refuses the starter with its identity check removed, even where token-less callers are allowed", async () => {
    // No AIDENHQ_APP: server.mjs skips protect, exactly as if the wrapper were deleted.
    const open = await starter({});
    for (const app of [shared, tailnet]) {
      const r = await gate(app, open);
      expect(r.ok).toBe(false);
      expect(r.findings[0]!.what).toContain(NO_SIGN_IN);
    }
  });

  it("refuses an app that takes a forged identity header", async () => {
    // Trusts any X-AidenHQ-Identity it is sent and refuses only requests without one.
    const naive = await starter({}, `import { createServer } from "node:http";
      createServer((req, res) => { res.writeHead(req.url === "/api/health" || req.headers["${IDENTITY_HEADER}"] ? 200 : 401); res.end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1");`);
    const r = await gate(shared, naive);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.what).toMatch(/with a forged identity answered 200/);
  });

  it("knocks on the doors people and agents use, and on none of an app without HTTP", () => {
    // The starter's compose as the platform runs it: app publishes 127.0.0.1:8080 → 8080.
    const compose = { services: { app: { ports: [{ target: 8080, published: "8080", host_ip: "127.0.0.1" }] }, worker: {} } };
    expect(identityDoors(tailnet, compose)).toEqual([{ service: "app", port: "8080", health: "/api/health" }]);
    expect(identityDoors(shared, compose)).toEqual([{ service: "app", port: "8080", health: "/api/health" }]);
    // Published elsewhere than health.url: both doors. Published nothing (apps before the starter published): the health door.
    expect(identityDoors(parseApp({ ...tailnet, health: { url: "http://worker:9000/healthz" } }), compose)).toEqual([{ service: "app", port: "8080" }, { service: "worker", port: "9000", health: "/healthz" }]);
    expect(identityDoors(tailnet, { services: { app: {} } })).toEqual([{ service: "app", port: "8080", health: "/api/health" }]);
    // A database (the warehouse): no HTTP door.
    const db = parseApp({ name: "db", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false });
    expect(identityDoors(db, { services: { pg: { ports: [{ target: 5432, published: "5433" }] } } })).toEqual([]);
  });

  it("the forgery carries the platform's kid, so the middleware refuses it on the signature alone", async () => {
    const dir = mkdtempSync(`${tmpdir()}/keys-`);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(`${dir}/apps.pem`, privateKey.export({ type: "pkcs8", format: "pem" }));
    const x = publicKey.export({ format: "jwk" }).x!;
    const kid = createHash("sha256").update(Buffer.from(x, "base64url")).digest("base64url").slice(0, 16);
    writeFileSync(`${dir}/keys.json`, JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x, kid, iss: "aidenhq-apps" }] }));
    const { createIdentity } = await import(MIDDLEWARE);
    const id = createIdentity({ app: "demo", keysFile: `${dir}/keys.json` });
    const sign = agentSigner(`${dir}/apps.pem`);
    const req = (token: string) => ({ method: "GET", url: "/", headers: { [IDENTITY_HEADER]: token } });
    expect(id.identify(req(sign("demo", "deploy-check", { role: "admin", methods: ["GET", "HEAD"] })))).toMatchObject({ sub: "agent:deploy-check" });
    expect(() => id.identify(req(forgedIdentity("demo", sign)))).toThrow(expect.objectContaining({ status: 401, message: "bad identity" }));
  });

  it.runIf(process.platform === "linux")("refuses an app that publishes nothing and has no health.url, but answers on a port without protect (hello2)", async () => {
    expect(identityDoors(hello2, { services: { app: { expose: ["8080"] } } })).toEqual([]);
    const r = await scan(hello2, [portOf(await starter({}))]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.what).toContain(NO_SIGN_IN);
    expect(await scan(hello2, [portOf(await starter({ AIDENHQ_APP: "hello2" }))])).toMatchObject({ ok: true });
  });

  it.runIf(!!eth0 && process.platform === "linux")("probes the container's own address, where an app bound only to eth0 answers", async () => {
    const port = portOf(await starter({}, undefined, eth0));
    const r = await scan(hello2, [port], { ips: [eth0!] });
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.what).toContain(`on ${eth0}: ${NO_SIGN_IN}`);
  });

  it.runIf(process.platform === "linux")("sends every probe: an app that hangs on a forged identity but serves token-less requests is refused", async () => {
    const picky = await starter({}, `import { createServer } from "node:http";
      createServer((req, res) => { if (req.url === "/api/health" || !req.headers["${IDENTITY_HEADER}"]) res.end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1");`);
    const r = await scan(hello2, [portOf(picky)]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.what).toMatch(/with no identity answered 200/);
  }, 60_000);

  it.runIf(process.platform === "linux")("skips only a port that clearly isn't HTTP or that nothing listens on; any other silence fails closed", async () => {
    const banner = await tcp(`(s) => s.end("-ERR unknown command\\r\\n")`);
    expect(await scan(hello2, [banner])).toMatchObject({ ok: true, findings: [{ hard: false, what: expect.stringMatching(/other than HTTP/) }] });
    expect((await scan(hello2, [banner], { required: [{ service: "app", port: String(banner) }] })).ok).toBe(false); // the registry says HTTP
    expect((await scan(hello2, [await tcp("(s) => s.destroy()")])).ok).toBe(false); // hangs up without a word
    expect((await scan(hello2, [await tcp("() => {}")])).ok).toBe(false); // accepts and never answers
    expect((await scan(hello2, [await freePort()])).findings[0]).toMatchObject({ hard: false, what: expect.stringMatching(/nothing listens/) });
    expect(identityPorts([], [])).toMatchObject({ ok: true, findings: [{ hard: false, what: expect.stringMatching(/nothing can reach it/) }] });
    expect(identityPorts([], [{ service: "app", port: "8080" }]).ok).toBe(false);
    // A process no scan could read fails closed and is named, even when every required door answered.
    const open = { service: "app", port: 8080, host: "127.0.0.1", listening: true, answers: [] };
    const denied = identityPorts([open], [], ["app:7"]);
    expect(denied.ok).toBe(false);
    expect(denied.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/couldn't read the sockets of process app:7/) });
  }, 120_000);

  it.runIf(process.platform === "linux")("probes a socket the app's own process holds, wherever a peer listener sits on the same network", async () => {
    // Real listeners: the app's own HTTP server (a starter) and a peer's, both in this host's network namespace. The proc tree
    // stands for the container's: the app's pids hold one inode, and the peer's listener belongs to no pid in that namespace.
    const own = await starter({});
    const peer = await tcp("() => {}");
    const ownInode = inodeOf(portOf(own))!;
    const proc = procTree({ listeners: [{ port: portOf(own), inode: ownInode }, { port: peer, inode: ownInode + 1000 }], held: [ownInode] });
    // Nothing to expose: both listeners are in the table, so only the inode filter can tell them apart.
    const r = await scan(hello2, [], { proc });
    // The peer's listener is not the app's: it is not even probed. The app's own socket is, and fails closed as it should.
    expect(r.path).toBe(`app:${portOf(own)}`);
    expect(r.findings.map((f) => f.what).join(" ")).not.toContain(`app:${peer}`);
    expect(r.findings[0]!.what).toContain(NO_SIGN_IN);
    expect(r.ok).toBe(false);
  }, 60_000);

  it.runIf(process.platform === "linux")("drops a listener no process of the app's pid namespace holds, even when it answers HTTP on the app's port", async () => {
    // A port the app is supposed to answer on, listening, but held by nobody the app's pids own: not the app's to judge.
    const open = await starter({});
    const inode = inodeOf(portOf(open))!;
    // A helper's own HTTP answer (200, so it would be a hard finding) that the app's pid namespace does not hold.
    const peer = await tcp(`(s) => s.end("HTTP/1.0 200 OK\r\n\r\n")`);
    const proc = procTree({ listeners: [{ port: peer, inode: inode + 7 }], held: [] });
    expect(await scan(hello2, [], { proc })).toMatchObject({ ok: true, findings: [{ hard: false, what: expect.stringMatching(/nothing can reach it/) }] });
    // The same socket attributed to the app's own process is probed and fails closed.
    const held = procTree({ listeners: [{ port: peer, inode: inode + 7 }], held: [inode + 7] });
    const r = await scan(hello2, [], { proc: held });
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.what).toContain(`app:${peer}`);
  }, 60_000);

  it("runs the identity scan in the app container's pid namespace as well as its network namespace", () => {
    // The inode filter only sees the app's own processes with --pid; without it every peer's listener would count again.
    const id = "a".repeat(64);
    const a = identityProbeArgs("aidenhq/apps-mcp-helper:abc", id, 1000);
    expect(a.slice(a.indexOf("--network"), a.indexOf("--network") + 4)).toEqual(["--network", `container:${id}`, "--pid", `container:${id}`]);
    // The app's own uid and no capabilities: its /proc/<pid>/fd is readable by that uid alone, nothing looser.
    expect(a.slice(a.indexOf("--user"), a.indexOf("--user") + 2)).toEqual(["--user", "1000:1000"]);
    expect(a.slice(a.indexOf("--cap-drop"), a.indexOf("--cap-drop") + 2)).toEqual(["--cap-drop", "ALL"]);
    expect(a).not.toContain("--cap-add");
    expect(a.join(" ")).not.toMatch(/--privileged|-v |--volume|--mount|--pid host|--network host/);
  });

  it("scans once per uid and keeps a process denied only when every scan was refused it", () => {
    expect(processUids("UID                 PID\n0                   4100\n1000                4122\n1000                4130\n")).toEqual([0, 1000]);
    const k = (listening: boolean) => ({ port: 8080, host: "127.0.0.1", listening, statuses: [401] });
    const merged = mergeScans([{ sockets: [k(false)], denied: ["7", "9"] }, { sockets: [k(true)], denied: ["1", "9"] }]);
    expect(merged.sockets).toEqual([k(true)]);
    expect(merged.denied).toEqual(["9"]);
    // TLS evidence survives whichever scan owns the socket: one uid may read the listener another could not, and the
    // ClientHello's answer is what decides the skip, so a later owner must not drop an earlier "tls".
    const t = (listening: boolean, tls: "tls" | "no") => ({ port: 5433, host: "127.0.0.1", listening, tls, statuses: [0, 0] });
    expect(mergeScans([{ sockets: [t(false, "tls")] }, { sockets: [t(true, "no")] }]).sockets).toEqual([t(true, "tls")]);
    expect(mergeScans([{ sockets: [t(true, "no")] }, { sockets: [t(false, "tls")] }]).sockets).toEqual([t(true, "tls")]);
    // A "no" from one scan and no answer from another is still "no"; nothing invented, nothing lost.
    expect(mergeScans([{ sockets: [t(false, "no")] }, { sockets: [{ port: 5433, host: "127.0.0.1", listening: true, statuses: [0] }] }]).sockets).toEqual([{ port: 5433, host: "127.0.0.1", listening: true, statuses: [0], tls: "no" }]);
  });

  it("fails closed on any service without a running container, unless it is a current, port-less one-shot job that finished", () => {
    // `sidecar` declares no port at all: it may listen anyway, or start later.
    const compose = { services: { app: { ports: [{ target: 8080 }] }, sidecar: {}, migrate: {}, seed: { expose: ["9000"] } } };
    const hashes = { app: "h-app", sidecar: "h-side", migrate: "h-mig", seed: "h-seed" };
    const c = (service: string, o: { running?: boolean; exit?: number; restart?: string; hash?: string; exposed?: string[] } = {}) => ({
      State: { Running: !!o.running, Status: o.running ? "running" : "exited", ExitCode: o.exit ?? 0 },
      HostConfig: { RestartPolicy: { Name: o.restart ?? "no" } },
      Config: { Labels: { "com.docker.compose.service": service, "com.docker.compose.config-hash": o.hash ?? hashes[service as keyof typeof hashes] }, ExposedPorts: Object.fromEntries((o.exposed ?? []).map((p) => [p, {}])) },
    });
    const up = [c("app", { running: true }), c("sidecar", { running: true }), c("seed", { running: true })];
    expect([c("x", { restart: "on-failure" }), c("x", { restart: "" })].every(finishedJob)).toBe(true);
    expect([c("x", { exit: 1 }), c("x", { restart: "always" }), c("x", { restart: "unless-stopped" })].some(finishedJob)).toBe(false);
    expect(unprobedServices(compose, [...up, c("migrate")], hashes)).toEqual([]); // this deploy's migration, done
    expect(unprobedServices(compose, [up[0]!, up[2]!, c("migrate")], hashes)).toEqual(["sidecar"]); // not running, declares nothing
    expect(unprobedServices(compose, [...up, c("migrate", { hash: "h-old" })], hashes)).toEqual(["migrate"]); // a stale exit from an older config
    expect(unprobedServices(compose, [...up, c("migrate"), c("migrate", { hash: "h-old" })], hashes)).toEqual(["migrate"]); // every container must be current
    expect(unprobedServices(compose, [...up, c("migrate", { exposed: ["8080/tcp"] })], hashes)).toEqual(["migrate"]); // its image EXPOSEs a port: a server
    expect(unprobedServices(compose, [up[0]!, up[1]!, c("migrate"), c("seed")], hashes)).toEqual(["seed"]); // declares expose: a server
    expect(unprobedServices(compose, up, hashes)).toEqual(["migrate"]); // no container at all
  });

  it.runIf(process.platform === "linux")("lets the warehouse shape past the gate: not exposed, no health.url, one published database port", async () => {
    // The warehouse: a database on a published port, reached only on the host's loopback (expose: false), with no health.url
    // and no api. It is not expected to serve HTTP at all, so its silent database socket is a recorded skip.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false });
    expect(noHttpSurface(db)).toBe(true);
    // A real PostgreSQL answers an HTTP GET by hanging up, and never says a word: `closed`, which used to fail the deploy.
    const r = await scan(db, [await tcp("(s) => s.on('data', () => s.destroy())")]);
    expect(r.ok).toBe(true);
    expect(r.findings.filter((f) => f.hard)).toEqual([]);
  }, 60_000);

  it.runIf(process.platform === "linux")("still judges a closed non-HTTP socket hard on an app that is exposed, shared, has a health.url or has an api", async () => {
    // The app-level skip is refused for every app that could serve HTTP, so the gate fails exactly as it did before for them:
    // a socket that hangs up without a word is unconfirmed, never a skip.
    const base = { name: "db", repo: "example-org/x", owner: "a", description: "d", port: 5433 };
    const withDoor = [
      parseApp({ ...base, expose: true }),
      parseApp({ ...base, share: { host: "db.example.com", aud: "aud-db-0001" } }),
      parseApp({ ...base, health: { url: "http://db:5433/health" } }),
      parseApp({ ...base, expose: false, health: { url: "http://db:5433/health" }, api: { callers: ["k"], paths: ["/api"] } }),
    ];
    for (const app of withDoor) {
      expect(noHttpSurface(app)).toBe(false);
      const r = await scan(app, [await tcp("(s) => s.on('data', () => s.destroy())")]);
      expect(r.ok).toBe(false);
      expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/no HTTP answer \(closed\)/) });
    }
  }, 120_000);

  it.runIf(process.platform === "linux")("judges a socket that answers HTTP on the warehouse shape too: the skip never covers an HTTP answer", async () => {
    // The skip's own bound: this is the SAME not-exposed, no-health.url, no-api shape as the warehouse test above, but the
    // socket answers HTTP. An HTTP answer is judged first, so it is a hard finding (no sign-in) rather than a skip.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false });
    expect(noHttpSurface(db)).toBe(true);
    const plain = await tcp(`(s) => s.on("data", () => s.end("HTTP/1.0 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok"))`);
    const r = await scan(db, [plain]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringContaining(NO_SIGN_IN) });
  }, 60_000);

  it.runIf(process.platform === "linux")("judges TLS-wrapped HTTP on the warehouse shape hard: the skip needs a probe that says no TLS", async () => {
    // How a real TLS server answers both probes: a ClientHello gets a handshake record (0x16 0x03 0x03), and the plaintext
    // GET gets a TLS alert (0x15 0x03 0x03). The plaintext look alone reads that alert as a non-HTTP banner, so without the
    // ClientHello an HTTPS listener would be skipped like a database. The ClientHello decides: "answers HTTPS", hard, on the
    // very shape the app-level skip covers.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false });
    expect(noHttpSurface(db)).toBe(true);
    const r = await scan(db, [await tlsResponder()]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS \(a TLS ClientHello got a TLS record\)/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("keeps a lone TLS opening byte hard: a record begun and abandoned is not a plain banner", async () => {
    // A listener that writes one 0x15 (a TLS alert's content type) and hangs up could serve HTTPS. Inferring from that byte
    // alone is what let an earlier head skip it, so the ClientHello must decide and the record opening stays hard.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false });
    const lone = await tcp(`(s) => s.on("data", () => s.end(Buffer.from([0x15])))`);
    const r = await scan(db, [lone]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS \(a TLS ClientHello got a TLS record\)/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("judges a socket that answered HTTP bytes with no counted status hard, on the warehouse shape too", async () => {
    // A malformed HTTP reply: fetch gets no status (so no counted answer), but the plaintext look still sees "HTTP/". It is
    // an HTTP listener and must never be skipped; the skip is for sockets that answered neither HTTP nor TLS.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false });
    expect(noHttpSurface(db)).toBe(true);
    const malformed = await tcp(`(s) => s.on("data", () => s.end("HTTP/1.1 xx\\r\\n\\r\\n"))`);
    const r = await scan(db, [malformed]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTP \(a plaintext GET got an HTTP reply\)/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("records a skipped identity port as a non-hard finding that names the app-level reason", async () => {
    // The skip is not silent: the deploy's result still says which port was not probed, and why.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false });
    const port = await tcp("(s) => s.on('data', () => s.destroy())");
    const r = await scan(db, [port]);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([{ hard: false, what: expect.stringMatching(new RegExp(`app:${port} on .*isn't exposed, isn't shared and has no health.url or api`)) }]);
  }, 60_000);

  it.runIf(process.platform === "linux")("finds a socket nothing declares or exposes, on the address it is bound to", async () => {
    const host = eth0 ?? "127.0.0.1";
    const port = portOf(await starter({}, undefined, host));
    const found = await scan(hello2, [], { keep: [port] });
    expect(found.path.split(" ")).toContain(`app:${port}`);
    expect(found.findings[0]!.what).toContain(`on ${host}: ${NO_SIGN_IN}`);
  }, 120_000);
});
