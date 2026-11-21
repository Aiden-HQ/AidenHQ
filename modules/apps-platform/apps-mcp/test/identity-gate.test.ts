// The identity gate (checks.ts identityProbes) against the real starter server, run as the platform runs it.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { declaredPort, finishedJob, IDENTITY_SCRIPT, identityDoors, identityPorts, identityProbeArgs, mergeScans, postgresOnly, processUids, identityProbes, judgeIdentity, NO_SIGN_IN, unprobedServices, type Door } from "../src/checks.js";
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
function scan(app: typeof tailnet, exposed: number[], o: { required?: Door[]; ips?: string[]; keep?: number[]; proc?: string; sni?: string[]; declared?: Door | null; pg?: string } = {}) {
  const probes = identityProbes(app, true, app.health.url ? new URL(app.health.url).pathname : undefined);
  const forged = forgedIdentity(app.name, noKey);
  // The compose mapping the registry declaration names: the app's published port → its container port. A test server listens
  // on a free port, so the platform's compose (app.port → target) is stood in for by the port actually exposed here; `declared`
  // overrides it to prove a socket the declaration doesn't name stays hard.
  const declared = o.declared !== undefined ? o.declared ?? undefined : postgresOnly(app) && exposed.length ? { service: "app", port: String(exposed[0]) } : undefined;
  const input = { ports: exposed, ips: o.ips ?? [], ...(declared ? { postgresProbe: Number(declared.port) } : {}), sni: o.sni ?? [app.name, app.share?.host].filter(Boolean), ...(o.proc ? { proc: o.proc } : {}), probes: probes.map((p) => ({ method: p.method, path: p.path, headers: p.forged ? { [IDENTITY_HEADER]: forged } : {} })) };
  return new Promise<ReturnType<typeof identityPorts>>((ok, fail) => {
    // Sockets off unless `keep`: here /proc/net/tcp is the test host's, not one app container's.
    let script = o.keep || o.proc ? IDENTITY_SCRIPT : IDENTITY_SCRIPT.replace('[[proc + "/net/tcp", v4], [proc + "/net/tcp6", v6]]', "[]");
    // A controlled socket for the PostgreSQL probe: TCP does not preserve write boundaries, so a test that needs a reply in
    // one read event (or two) replaces the probe's connection instead of hoping a server's writes arrive that way.
    if (o.pg) {
      // The factory is evaluated once: a connection counter inside it must persist across the probe's two connections.
      script = script.replace("const postgres = (host, port) => new Promise", `const pgFactory = ${o.pg};\nconst postgres = (host, port) => new Promise`);
      script = script.replace("const s = pgConnect(host, port);", "const s = pgFactory(host, port);");
    }
    const c = execFile(process.execPath, ["-e", script], (err, out) => {
      if (err) return fail(err);
      const sockets = (JSON.parse(out) as { sockets: any[] }).sockets.filter((k) => o.proc || (o.keep ?? exposed).includes(k.port)); // only this test's servers
      ok(identityPorts(sockets.map((k) => ({ service: "app", port: k.port, host: k.host, listening: k.listening, raw: k.raw, answers: k.statuses.map((status: number, i: number) => ({ probe: probes[i]!, status })) })), o.required ?? [], [], declared));
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

  it("takes only a declared protocol: postgres as a database, never an inference from missing fields", () => {
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    expect(postgresOnly(db)).toBe(true);
    // Missing expose/health is not a declaration: an app with no HTTP door still needs protocol: postgres.
    expect(postgresOnly(parseApp({ name: "plain", repo: "example-org/x", owner: "a", description: "d", expose: false }))).toBe(false);
    expect(postgresOnly(parseApp({ ...db, protocol: undefined }))).toBe(false);
    // The registry refuses the declaration beside any HTTP door: a tailnet route, a share host, a health url or an API.
    for (const o of [{ expose: true }, { health: { url: "http://pg:5432/health" } }, { share: { host: "db.example.com" } }, { api: { callers: ["k"], paths: ["/api"] }, health: { url: "http://pg:5432/health" } }])
      expect(() => parseApp({ ...db, ...o })).toThrow(/protocol: postgres is for an app with no HTTP surface/);
    // The warehouse's own compose: one published database port, no door the gate has to knock on.
    expect(identityDoors(db, { services: { postgres: { ports: [{ target: 5432, published: "5433" }] } } })).toEqual([]);
    // The declaration covers the one socket its published port maps to: the compose service and the container port, not the
    // host's published number. A published port the compose doesn't map exempts nothing.
    expect(declaredPort(db, { services: { postgres: { ports: [{ target: 5432, published: "5433" }] } } })).toEqual({ service: "postgres", port: "5432" });
    expect(declaredPort(db, { services: { postgres: { ports: [{ target: 5432, published: "5434" }] } } })).toBeUndefined();
    expect(declaredPort(parseApp({ ...db, protocol: undefined }), { services: { postgres: { ports: [{ target: 5432, published: "5433" }] } } })).toBeUndefined();
  });

  // A PostgreSQL server's first bytes, as the gate sees them: an HTTP GET makes it hang up (raw: closed); an SSLRequest gets
  // `N` (SSL is off, as in the official image); the StartupMessage then gets AuthenticationRequest (`R`). The startup message
  // must be well-formed: its length covers the whole packet and its protocol is 3.0, so a broken emission fails the test.
  // The probe reads the SSL refusal on one connection and sends the startup message on a fresh one, so each connection is
  // classified by its first message: an HTTP GET or TLS hello is hung up on, an SSLRequest gets "N", a startup message gets R.
  // SSLRequest is an 8-byte frame whose length is 8 and whose protocol code is 80877103 (0x04d2162f).
  const PG = `(s) => {
    let got = Buffer.alloc(0);
    s.on("data", (d) => {
      got = Buffer.concat([got, d]);
      if (got[0] === 0x47) return s.destroy();
      if (got[0] === 0x16) return s.destroy(); // a TLS hello: not a startup packet, so Postgres hangs up
      if (got.length < 4) return; // the length has not all arrived
      const len = got.readUInt32BE(0);
      if (got.length < len) return; // the frame has not all arrived
      if (len === 8 && got.readUInt32BE(4) === 80877103) return s.end("N"); // SSLRequest
      const proto = got.readUInt32BE(4);
      if (len !== got.length || proto !== 196608) return s.destroy();
      s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]));
    });
  }`;

  it.runIf(process.platform === "linux")("lets a database app deploy past the gate: a socket confirmed as PostgreSQL is a recorded skip, not a hard finding", async () => {
    // The warehouse's shape: not exposed, no health.url, one published database port. Postgres hangs up on an HTTP GET and
    // completes a startup handshake: the gate identifies it positively and says so, instead of failing closed on `closed`.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const r = await scan(db, [await tcp(PG)]);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([{ hard: false, what: expect.stringMatching(/speaks PostgreSQL/) }]);
    // The same database on an app that is exposed, or has a health.url, is judged and fails closed.
    const exposed = parseApp({ ...db, protocol: undefined, expose: true });
    const healthy = parseApp({ ...db, protocol: undefined, health: { url: "http://pg:5432/health" } });
    for (const app of [exposed, healthy]) {
      const judged = await scan(app, [await tcp(PG)]);
      expect(judged.ok).toBe(false);
      expect(judged.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/no HTTP answer/) });
    }
  }, 60_000);

  it.runIf(process.platform === "linux")("scopes the declaration to the published port: another socket on the same app stays hard", async () => {
    // The declaration names the app's published port. A second service on the same app that happens to speak PostgreSQL is
    // not covered by it: an unrelated listener must not inherit the database's exemption. The scan's own server listens on
    // the declared port; the other socket, on another port, is not declared and stays closed.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const declared = await tcp(PG);
    const other = await tcp(PG);
    const r = await scan(db, [declared, other], { declared: { service: "app", port: String(declared) } });
    expect(r.ok).toBe(false);
    expect(r.findings.filter((f) => f.hard)).toEqual([expect.objectContaining({ what: expect.stringMatching(new RegExp(`app:${other} on .*no HTTP answer`)) })]);
    expect(r.findings.filter((f) => !f.hard)).toEqual([expect.objectContaining({ what: expect.stringMatching(new RegExp(`app:${declared} on .*speaks PostgreSQL`)) })]);
  }, 60_000);

  it.runIf(process.platform === "linux")("keeps a listener that speaks PostgreSQL and TLS hard, even on an app the registry says serves no HTTP", async () => {
    // The reviewer's case: a multiplexer answers the PostgreSQL handshake on plaintext and also serves TLS on the same port.
    // The plaintext probes never see its HTTP, so a TLS hello must still find it: a port that speaks TLS could be HTTP.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const both = await tcp(`(s) => {
      s.on("data", (d) => {
        if (d[0] === 0x16) return s.end(Buffer.from([0x15, 0x03, 0x03, 0, 2, 2, 40])); // a TLS alert
        if (d[0] === 0x47) return s.destroy();
        if (d.length >= 8 && d.readUInt32BE(0) === 8 && d.readUInt32BE(4) === 80877103) return s.end("N");
        s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]));
      });
    }`);
    const r = await scan(db, [both]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("keeps a listener that offers SSL hard, even on an app the registry says serves no HTTP", async () => {
    // An SSLRequest reply alone is not identification: a TLS listener offers SSL too, and a multiprotocol one can serve
    // HTTPS on the same port without answering the plaintext probes. Only a server that declines SSL and then speaks the
    // PostgreSQL protocol is a database; one that offers SSL (`S`) stays closed, so the gate never skips a port that could be HTTP.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const tls = await tcp(`(s) => {
      s.on("data", (d) => {
        if (d[0] === 0x47) return s.destroy();
        s.end("S");
      });
    }`);
    const r = await scan(db, [tls]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/no HTTP answer/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("reads the SSL refusal on its own connection: trailing bytes after N never supply the startup reply", async () => {
    // A server that declines SSL sends "N" and nothing else. A peer that sends "N" plus a well-formed AuthenticationOk
    // frame must not be identified: those bytes are not a reply to a startup message this probe sent. The probe reads the
    // refusal on one connection and sends the startup message on a fresh one, so bytes after "N" are never parsed. TCP
    // does not preserve write boundaries, so a controlled socket delivers the trailing bytes in one event and in two.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const silent = await tcp(`(s) => s.on("data", () => s.destroy())`); // the raw look gets a closed socket
    // The factory stands in for net.connect: connection 1 answers the SSLRequest with "N" and trailing bytes; connection 2
    // (the startup message) hangs up without an answer, so the port is not identified. The reply is emitted after the probe
    // has attached its listeners, so its "end" is seen.
    const controlled = (firstData: string, secondData: string | null) => `(() => {
      const { EventEmitter } = require("events");
      let n = 0;
      return (host, port) => {
        const e = new EventEmitter();
        const first = ++n === 1;
        e.destroy = () => {};
        e.write = () => {
          setImmediate(() => {
            if (first) {
              for (const d of ${firstData}) e.emit("data", d);
            } else if (${secondData} === null) e.emit("end");
            else e.emit("data", ${secondData});
          });
          return true;
        };
        setImmediate(() => e.emit("connect"));
        return e;
      };
    })()`;
    const frame = "Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])";
    // Coalesced in one read, split into two reads in one tick, and split across the quiet window: every shape must stay hard.
    const coalesced = controlled(`[Buffer.concat([Buffer.from("N"), ${frame}])]`, "null");
    const split = controlled(`[Buffer.from("N"), ${frame}]`, "null");
    const late = `(() => {
      const { EventEmitter } = require("events");
      let n = 0;
      return (host, port) => {
        const e = new EventEmitter();
        const first = ++n === 1;
        e.destroy = () => {};
        e.write = () => {
          setImmediate(() => {
            if (first) { e.emit("data", Buffer.from("N")); setTimeout(() => e.emit("data", ${frame}), 400); }
            else e.emit("end");
          });
          return true;
        };
        setImmediate(() => e.emit("connect"));
        return e;
      };
    })()`;
    for (const pg of [coalesced, split, late]) {
      const r = await scan(db, [silent], { pg });
      expect(r.ok).toBe(false);
      expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/no HTTP answer/) });
    }
    // The strongest case: the refusal chunk carries trailing bytes and the second connection answers the startup message
    // with a valid frame. The refusal is still not one byte, so the port stays hard however good the second reply is.
    const trailingWithReply = controlled(`[Buffer.concat([Buffer.from("N"), ${frame}])]`, frame);
    const r = await scan(db, [silent], { pg: trailingWithReply });
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/no HTTP answer/) });
    // A server that refuses SSL on one connection and answers the startup message on a fresh one is identified: the frame
    // arrives only after this probe sent a startup message, so it is a real PostgreSQL reply, not trailing bytes.
    const answers = controlled(`[Buffer.from("N")]`, frame);
    expect(await scan(db, [silent], { pg: answers })).toMatchObject({ ok: true, findings: [{ hard: false, what: expect.stringMatching(/speaks PostgreSQL/) }] });
  }, 60_000);

  it.runIf(process.platform === "linux")("keeps a truncated PostgreSQL reply hard: a header alone is not a protocol message", async () => {
    // The peer declines SSL and sends the first five bytes of an AuthenticationRequest that claims eight more bytes it never
    // sends, then hangs up. A header is not a message: the gate must wait for the whole frame and stay closed when it never
    // arrives, or a multiplexer could answer one plausible type byte and be exempted on the strength of it.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const truncated = await tcp(`(s) => { s.on("data", (d) => { if (d[0] === 0x47) return s.destroy(); if (d[0] === 0x16) return s.destroy(); if (d.length >= 8 && d.readUInt32BE(0) === 8 && d.readUInt32BE(4) === 80877103) return s.end("N"); s.end(Buffer.from([0x52, 0, 0, 0, 100])); }); }`);
    const r = await scan(db, [truncated]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/no HTTP answer/) });
    // A frame whose body is not the type's structure (an ErrorResponse with no terminator field) is not identification either.
    const malformed = await tcp(`(s) => { s.on("data", (d) => { if (d[0] === 0x47) return s.destroy(); if (d[0] === 0x16) return s.destroy(); if (d.length >= 8 && d.readUInt32BE(0) === 8 && d.readUInt32BE(4) === 80877103) return s.end("N"); s.end(Buffer.from([0x45, 0, 0, 0, 6, 0x53, 0x41])); }); }`);
    expect(await scan(db, [malformed])).toMatchObject({ ok: false, findings: [{ hard: true, what: expect.stringMatching(/no HTTP answer/) }] });
    // The same frame, sent whole, is identified: it is the completeness, not the type byte, that decides.
    const whole = await tcp(`(s) => { s.on("data", (d) => { if (d[0] === 0x47) return s.destroy(); if (d[0] === 0x16) return s.destroy(); if (d.length >= 8 && d.readUInt32BE(0) === 8 && d.readUInt32BE(4) === 80877103) return s.end("N"); s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])); }); }`);
    expect(await scan(db, [whole])).toMatchObject({ ok: true, findings: [{ hard: false, what: expect.stringMatching(/speaks PostgreSQL/) }] });
  }, 60_000);

  it.runIf(process.platform === "linux")("reads the TLS reply across chunks: a split record header still marks the port HTTPS", async () => {
    // Node can deliver the first TLS byte in its own `data` event. A probe that decides on the first chunk would see a
    // one-byte reply, call it not-TLS, and skip the port as PostgreSQL while it also serves HTTPS. The prefix is buffered.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const split = await tcp(`(s) => {
      s.on("data", (d) => {
        if (d[0] === 0x16) { s.write(Buffer.from([0x16])); return setTimeout(() => s.end(Buffer.from([0x03, 0x03, 0, 2, 2, 40])), 100); }
        if (d[0] === 0x47) return s.destroy();
        if (d.length >= 8 && d.readUInt32BE(0) === 8 && d.readUInt32BE(4) === 80877103) return s.end("N");
        s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]));
      });
    }`);
    const r = await scan(db, [split]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("validates a PostgreSQL authentication request's code and payload", async () => {
    // A complete frame is not enough: the AuthenticationRequest's code must be one PostgreSQL sends, with the payload that
    // code requires. An unknown code, or MD5 without its four-byte salt, is a malformed message and not identification.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const frame = (bytes: number[]) => `(s) => { s.on("data", (d) => { if (d[0] === 0x47) return s.destroy(); if (d[0] === 0x16) return s.destroy(); if (d.length >= 8 && d.readUInt32BE(0) === 8 && d.readUInt32BE(4) === 80877103) return s.end("N"); s.end(Buffer.from(${JSON.stringify(bytes)})); }); }`;
    const hard = async (bytes: number[]) => (await scan(db, [await tcp(frame(bytes))])).ok;
    expect(await hard([0x52, 0, 0, 0, 8, 0, 0, 0, 0])).toBe(true); // AuthenticationOk
    expect(await hard([0x52, 0, 0, 0, 8, 0, 0, 0, 3])).toBe(true); // cleartext password
    expect(await hard([0x52, 0, 0, 0, 12, 0, 0, 0, 5, 1, 2, 3, 4])).toBe(true); // MD5 with its salt
    expect(await hard([0x52, 0, 0, 0, 15, 0, 0, 0, 10, 0x53, 0x43, 0x52, 0x41, 0x4d, 0, 0])).toBe(true); // SASL, mechanism list with its own terminator
    expect(await hard([0x52, 0, 0, 0, 8, 0, 0, 0, 99])).toBe(false); // a code PostgreSQL never sends
    expect(await hard([0x52, 0, 0, 0, 12, 0, 0, 0, 0, 1, 2, 3, 4])).toBe(false); // AuthenticationOk with a payload
    expect(await hard([0x52, 0, 0, 0, 12, 0, 0, 0, 3, 1, 2, 3, 4])).toBe(false); // cleartext with a payload
    expect(await hard([0x52, 0, 0, 0, 8, 0, 0, 0, 5])).toBe(false); // MD5 without its salt
    expect(await hard([0x52, 0, 0, 0, 11, 0, 0, 0, 5, 1, 2, 3])).toBe(false); // MD5 with a short salt
    expect(await hard([0x52, 0, 0, 0, 12, 0, 0, 0, 10, 0x53, 0x43, 0x52, 0x41, 0x4d])).toBe(false); // SASL, unterminated list
    expect(await hard([0x52, 0, 0, 0, 14, 0, 0, 0, 10, 0x53, 0x43, 0x52, 0x41, 0x4d, 0])).toBe(false); // SASL, one NUL, no list terminator
    expect(await hard([0x52, 0, 0, 0, 5, 0, 0, 0, 10, 0])).toBe(false); // SASL, an empty mechanism
    expect(await hard([0x52, 0, 0, 0, 12, 0, 0, 0, 11, 1, 2, 3, 4])).toBe(false); // a continuation code on a first reply
  }, 90_000);

  it.runIf(process.platform === "linux")("requires the mandatory fields of a PostgreSQL error or notice reply", async () => {
    // PostgreSQL always sends severity (S/V), SQLSTATE (C) and a message (M). A terminated field list without them is not an
    // ErrorResponse a server sends, so it must not identify the port.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const frame = (bytes: number[]) => `(s) => { s.on("data", (d) => { if (d[0] === 0x47) return s.destroy(); if (d[0] === 0x16) return s.destroy(); if (d.length >= 8 && d.readUInt32BE(0) === 8 && d.readUInt32BE(4) === 80877103) return s.end("N"); s.end(Buffer.from(${JSON.stringify(bytes)})); }); }`;
    const hard = async (bytes: number[]) => (await scan(db, [await tcp(frame(bytes))])).ok;
    const err = (fields: number[]) => [0x45, 0, 0, 0, 5 + fields.length, ...fields, 0];
    expect(await hard(err([0x53, 0x46, 0x41, 0x54, 0x41, 0x4c, 0, 0x43, 0x32, 0x38, 0x50, 0x30, 0x31, 0, 0x4d, 0x62, 0x6f, 0x6f, 0]))).toBe(true); // S C M
    expect(await hard(err([0x56, 0x45, 0x52, 0x52, 0x4f, 0x52, 0, 0x43, 0x32, 0x38, 0x50, 0x30, 0x31, 0, 0x4d, 0x62, 0x6f, 0x6f, 0]))).toBe(true); // V C M
    expect(await hard(err([0x53, 0x46, 0x41, 0x54, 0x41, 0x4c, 0]))).toBe(false); // severity alone
    expect(await hard(err([0x53, 0x46, 0x41, 0x54, 0x41, 0x4c, 0, 0x4d, 0x62, 0x6f, 0x6f, 0]))).toBe(false); // no SQLSTATE
    // The tags are not enough: each required value must be a real one. An empty severity, SQLSTATE or message, or a
    // SQLSTATE that is not five characters, is a malformed reply and stays hard.
    expect(await hard(err([0x53, 0, 0x43, 0x32, 0x38, 0x50, 0x30, 0x31, 0, 0x4d, 0x62, 0x6f, 0x6f, 0]))).toBe(false); // empty severity
    expect(await hard(err([0x53, 0x46, 0x41, 0x54, 0x41, 0x4c, 0, 0x43, 0, 0x4d, 0x62, 0x6f, 0x6f, 0]))).toBe(false); // empty SQLSTATE
    expect(await hard(err([0x53, 0x46, 0x41, 0x54, 0x41, 0x4c, 0, 0x43, 0x32, 0x38, 0x50, 0x30, 0x31, 0, 0x4d, 0]))).toBe(false); // empty message
    expect(await hard(err([0x53, 0x46, 0x41, 0x54, 0x41, 0x4c, 0, 0x43, 0x32, 0x38, 0x50, 0x30, 0, 0x4d, 0x62, 0x6f, 0x6f, 0]))).toBe(false); // 4-character SQLSTATE
    expect(await hard(err([0x53, 0x46, 0x41, 0x54, 0x41, 0x4c, 0, 0x43, 0x32, 0x38, 0x50, 0x30, 0x31, 0x32, 0, 0x4d, 0x62, 0x6f, 0x6f, 0]))).toBe(false); // 6-character SQLSTATE
  }, 90_000);

  // A ClientHello's SNI hostname, read from its structure: record header (5), handshake header (4), version (2), random
  // (32), session id (1 + n), cipher suites (2 + n), compression (1 + n), extensions (2 + n), then each extension's type
  // (2) and length (2). Inside SNI (type 0): list length (2), name type (1), name length (2), name. Null while the hello
  // has not all arrived (a partial read must not be judged), "" when it carries no SNI. A one-byte hostname length lands
  // the name in the wrong place and reads as a different host.
  const SNI_HOST = `(b) => {
    try {
      if (b.length < 5) return null;
      const need = 5 + b.readUInt16BE(3);
      if (b.length < need) return null;
      let i = 5 + 4 + 2 + 32;
      i += 1 + b[i]; // session id
      i += 2 + b.readUInt16BE(i); // cipher suites
      i += 1 + b[i]; // compression
      const end = i + 2 + b.readUInt16BE(i);
      i += 2;
      while (i + 4 <= end) {
        const type = b.readUInt16BE(i), len = b.readUInt16BE(i + 2), at = i + 4;
        if (type === 0 && len >= 5) return b.subarray(at + 5, at + 5 + b.readUInt16BE(at + 3)).toString("ascii");
        i = at + len;
      }
      return "";
    } catch { return null; }
  }`;

  it.runIf(process.platform === "linux")("finds an HTTPS listener that serves only the app's name: the TLS hello carries SNI", async () => {
    // A listener that serves HTTPS only for a recognized hostname closes a hello without SNI. The probe offers the app's
    // name, so such a port is still found and stays hard instead of passing as a database. The server parses the
    // ClientHello's SNI extension, so a malformed hostname length (one byte instead of two) is not read as the name.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const sniOnly = await tcp(`(s) => {
      let got = Buffer.alloc(0);
      const host = ${SNI_HOST};
      s.on("data", (d) => {
        got = Buffer.concat([got, d]);
        if (got[0] === 0x16) { // the TLS hello, on its own connection
          const name = host(got);
          if (name === null) return; // not all arrived yet: judge only the whole hello
          if (name === "warehouse") s.end(Buffer.from([0x15, 0x03, 0x03, 0, 2, 2, 40]));
          else s.destroy();
          return;
        }
        if (got[0] === 0x47) return s.destroy(); // the HTTP GET
        if (got.length >= 8 && got.readUInt32BE(0) === 8 && got.readUInt32BE(4) === 80877103) return s.end("N"); // the SSLRequest
        s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])); // the startup message
      });
    }`);
    const r = await scan(db, [sniOnly]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("finds an HTTPS listener that serves only its default route without SNI: both TLS hellos are tried", async () => {
    // The other side of the same finding: a TLS router that serves its default endpoint when SNI is absent and silently
    // closes an unknown name. A probe that only sends the named hello would miss it, so the unnamed hello is tried too.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const unnamed = await tcp(`(s) => {
      let got = Buffer.alloc(0);
      const host = ${SNI_HOST};
      s.on("data", (d) => {
        got = Buffer.concat([got, d]);
        if (got[0] === 0x16) { // the TLS hello, on its own connection
          const name = host(got);
          if (name === null) return; // not all arrived yet: judge only the whole hello
          if (name) s.destroy(); // a named hello: an unknown name, closed silently as a strict router does
          else s.end(Buffer.from([0x15, 0x03, 0x03, 0, 2, 2, 40])); // no SNI: the default route answers TLS
          return;
        }
        if (got[0] === 0x47) return s.destroy(); // the HTTP GET
        if (got.length >= 8 && got.readUInt32BE(0) === 8 && got.readUInt32BE(4) === 80877103) return s.end("N"); // the SSLRequest
        s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])); // the startup message
      });
    }`);
    const r = await scan(db, [unnamed]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("sends one TLS hello per hostname, so a second name is still probed", async () => {
    // RFC 6066 allows one host_name per server_name list, so two names get separate hellos rather than one invalid list.
    // A listener that drops the multi-name list and serves only the second name still answers that hello and stays hard,
    // where a single combined hello would have missed it. The scan carries both names, as the platform does for an app and
    // its share host; the app itself declares protocol: postgres, so the database probe runs.
    const app = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const shareOnly = await tcp(`(s) => {
      let got = Buffer.alloc(0);
      const host = ${SNI_HOST};
      s.on("data", (d) => {
        got = Buffer.concat([got, d]);
        if (got[0] === 0x16) { // the TLS hello, on its own connection
          const name = host(got);
          if (name === null) return; // not all arrived yet: judge only the whole hello
          if (name === "db.example.com") s.end(Buffer.from([0x15, 0x03, 0x03, 0, 2, 2, 40]));
          else s.destroy(); // the app's name, or no name: close silently
          return;
        }
        if (got[0] === 0x47) return s.destroy(); // the HTTP GET
        if (got.length >= 8 && got.readUInt32BE(0) === 8 && got.readUInt32BE(4) === 80877103) return s.end("N"); // the SSLRequest
        s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])); // the startup message
      });
    }`);
    const r = await scan(app, [shareOnly], { sni: ["warehouse", "db.example.com"] });
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS/) });
  }, 60_000);

  // What a ClientHello offers, read from its structure: the cipher suites in its list, the versions in supported_versions
  // (type 43), the named groups in supported_groups (type 10) and the groups in key_share (type 51). A 1.3-only listener
  // can only negotiate with a hello that offers TLS 1.3 and a key share for a group it accepts, and a 1.2-only listener
  // only with one whose cipher list carries a 1.2 suite; one that offers neither is closed silently, as an unsupported
  // hello is. Null while the hello has not all arrived.
  const HELLO_OFFERS = `(b) => {
    try {
      if (b.length < 5) return null;
      const need = 5 + b.readUInt16BE(3);
      if (b.length < need) return null;
      let i = 5 + 4 + 2 + 32;
      i += 1 + b[i]; // session id
      const suites = [];
      for (let j = i + 2; j + 1 < i + 2 + b.readUInt16BE(i); j += 2) suites.push(b.readUInt16BE(j));
      i += 2 + b.readUInt16BE(i); // cipher suites
      i += 1 + b[i]; // compression
      const end = i + 2 + b.readUInt16BE(i);
      i += 2;
      let v13 = false;
      const groups = new Set(), shares = new Set();
      while (i + 4 <= end) {
        const type = b.readUInt16BE(i), len = b.readUInt16BE(i + 2), at = i + 4;
        if (type === 10) for (let j = at + 2; j + 1 < at + len; j += 2) groups.add(b.readUInt16BE(j));
        if (type === 51) for (let j = at + 2; j + 3 < at + len;) { const g = b.readUInt16BE(j); shares.add(g); j += 4 + b.readUInt16BE(j + 2); }
        if (type === 43) for (let j = at + 1; j + 1 < at + len; j += 2) if (b.readUInt16BE(j) === 0x0304) v13 = true;
        i = at + len;
      }
      return { v13, suites, groups: [...groups], shares: [...shares] };
    } catch { return null; }
  }`;

  it.runIf(process.platform === "linux")("finds a TLS 1.3-only endpoint: the ClientHello offers 1.3 and a key share", async () => {
    // A multiplexer serves PostgreSQL and HTTPS on one port. The plaintext probes identify PostgreSQL, so the port gets a
    // TLS hello too; an endpoint that only speaks TLS 1.3 cannot negotiate with a hello that offers neither 1.3 nor a key
    // share and silently drops it, which would read as a database-only port and be skipped. The hello offers both, so the
    // 1.3-only side answers it and the port stays hard.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const modern = await tcp(`(s) => {
      let got = Buffer.alloc(0);
      const offers = ${HELLO_OFFERS};
      s.on("data", (d) => {
        got = Buffer.concat([got, d]);
        if (got[0] === 0x16) { // the TLS hello, on its own connection
          const o = offers(got);
          if (o === null) return; // not all arrived yet: judge only the whole hello
          if (o.v13 && o.shares.includes(0x001d)) s.end(Buffer.from([0x16, 0x03, 0x03, 0, 2, 2, 40])); // a 1.3-capable endpoint answers
          else s.destroy(); // unsupported hello: closed silently, as a 1.3-only listener does
          return;
        }
        if (got[0] === 0x47) return s.destroy(); // the HTTP GET
        if (got.length >= 8 && got.readUInt32BE(0) === 8 && got.readUInt32BE(4) === 80877103) return s.end("N"); // the SSLRequest
        s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])); // the startup message
      });
    }`);
    const r = await scan(db, [modern], { sni: ["warehouse"] });
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("finds a TLS 1.2-only endpoint: the ClientHello offers a TLS 1.2 suite", async () => {
    // A multiplexer serves PostgreSQL and HTTPS on one port. The plaintext probes identify PostgreSQL, so the port gets a
    // TLS hello too; an endpoint that only speaks TLS 1.2 cannot negotiate with a hello whose cipher list holds 1.3 suites
    // alone and silently drops it, which would read as a database-only port and be skipped. The hello offers 1.2 suites, so
    // the 1.2-only side answers it and the port stays hard.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const legacy = await tcp(`(s) => {
      let got = Buffer.alloc(0);
      const offers = ${HELLO_OFFERS};
      s.on("data", (d) => {
        got = Buffer.concat([got, d]);
        if (got[0] === 0x16) { // the TLS hello, on its own connection
          const o = offers(got);
          if (o === null) return; // not all arrived yet: judge only the whole hello
          if (o.suites.includes(0xc02f)) s.end(Buffer.from([0x16, 0x03, 0x03, 0, 2, 2, 40])); // a 1.2-capable endpoint answers
          else s.destroy(); // unsupported hello: closed silently, as a 1.2-only listener does
          return;
        }
        if (got[0] === 0x47) return s.destroy(); // the HTTP GET
        if (got.length >= 8 && got.readUInt32BE(0) === 8 && got.readUInt32BE(4) === 80877103) return s.end("N"); // the SSLRequest
        s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])); // the startup message
      });
    }`);
    const r = await scan(db, [legacy], { sni: ["warehouse"] });
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("finds a TLS 1.3 listener restricted to secp256r1: the hello offers that group and a share", async () => {
    // A listener that accepts only secp256r1 silently drops a hello whose key shares are all x25519. The hello offers a
    // share for both groups, so such a listener answers and its port stays hard instead of being read as a database.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const p256 = await tcp(`(s) => {
      let got = Buffer.alloc(0);
      const offers = ${HELLO_OFFERS};
      s.on("data", (d) => {
        got = Buffer.concat([got, d]);
        if (got[0] === 0x16) {
          const o = offers(got);
          if (o === null) return;
          if (o.v13 && o.groups.includes(0x0017) && o.shares.includes(0x0017)) s.end(Buffer.from([0x16, 0x03, 0x03, 0, 2, 2, 40]));
          else s.destroy();
          return;
        }
        if (got[0] === 0x47) return s.destroy();
        if (got.length >= 8 && got.readUInt32BE(0) === 8 && got.readUInt32BE(4) === 80877103) return s.end("N");
        s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]));
      });
    }`);
    const r = await scan(db, [p256], { sni: ["warehouse"] });
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("keeps a stalled TLS reply hard: a prefix that never completes still marks the port HTTPS", async () => {
    // A multiplexer answers the PostgreSQL handshake, then begins a TLS record and stalls. The probe must not fall back to
    // "not TLS" because the header never finished: bytes already received are still evidence the port could serve HTTPS.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    const stalled = await tcp(`(s) => {
      s.on("data", (d) => {
        if (d[0] === 0x16) { s.write(Buffer.from([0x16, 0x03])); return; }
        if (d[0] === 0x47) return s.destroy();
        if (d.length >= 8 && d.readUInt32BE(0) === 8 && d.readUInt32BE(4) === 80877103) return s.end("N");
        s.end(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]));
      });
    }`);
    const r = await scan(db, [stalled]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/answers HTTPS/) });
  }, 60_000);

  it.runIf(process.platform === "linux")("keeps an unconfirmed silent socket hard even on an app the registry says serves no HTTP", async () => {
    // Silence is not identification: a server that hangs up on plaintext (an HTTPS listener, say) or never answers is still
    // judged, so the no-HTTP exemption cannot hide a listener that never showed it speaks a database's protocol.
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    for (const code of [`(s) => s.destroy()`, `() => {}`]) {
      const r = await scan(db, [await tcp(code)]);
      expect(r.ok).toBe(false);
      expect(r.findings[0]).toMatchObject({ hard: true, what: expect.stringMatching(/no HTTP answer/) });
    }
  }, 60_000);

  it.runIf(process.platform === "linux")("still judges a socket that answers HTTP, even on an app the registry says serves no HTTP", async () => {
    const db = parseApp({ name: "warehouse", repo: "example-org/x", owner: "a", description: "d", port: 5433, expose: false, protocol: "postgres" });
    // An HTTP server without the identity middleware: the skip may not cover a socket that speaks HTTP.
    const open = await scan(db, [portOf(await starter({}))]);
    expect(open.ok).toBe(false);
    expect(open.findings[0]!.what).toContain(NO_SIGN_IN);
    // With the middleware it is judged and passes, as any other app's socket does.
    expect(await scan(db, [portOf(await starter({ AIDENHQ_APP: "warehouse" }))])).toMatchObject({ ok: true, findings: [] });
  }, 60_000);

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

  it.runIf(process.platform === "linux")("finds a socket nothing declares or exposes, on the address it is bound to", async () => {
    const host = eth0 ?? "127.0.0.1";
    const port = portOf(await starter({}, undefined, host));
    const found = await scan(hello2, [], { keep: [port] });
    expect(found.path.split(" ")).toContain(`app:${port}`);
    expect(found.findings[0]!.what).toContain(`on ${host}: ${NO_SIGN_IN}`);
  }, 120_000);
});
