// The identity gate (checks.ts identityProbes) against the real starter server, run as the platform runs it.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { finishedJob, IDENTITY_SCRIPT, identityPorts, identityProbes, judgeIdentity, NO_SIGN_IN, noHttpSurface, unprobedServices, type Door, type PortAnswers } from "../src/checks.js";
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
async function gate(app: typeof tailnet, base: string, node = true, sign?: ReturnType<typeof agentSigner>) {
  const forged = forgedIdentity(app.name, sign ?? noKey);
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
  const input = { ports: exposed, ips: o.ips ?? [], tls: true, ...(o.proc ? { proc: o.proc } : {}), probes: probes.map((p) => ({ method: p.method, path: p.path, headers: p.forged ? { [IDENTITY_HEADER]: forged } : {} })) };
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
/** The socket inode of a listening TCP port in this host's table (undefined where /proc/net/tcp isn't readable). */
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
    const dir = mkdtempSync(`${tmpdir()}/keys-`);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(`${dir}/apps.pem`, privateKey.export({ type: "pkcs8", format: "pem" }));
    const x = publicKey.export({ format: "jwk" }).x!;
    const kid = createHash("sha256").update(Buffer.from(x, "base64url")).digest("base64url").slice(0, 16);
    writeFileSync(`${dir}/keys.json`, JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x, kid, iss: "aidenhq-apps" }] }));
    // The starter reads /run/secrets/AIDENHQ_IDENTITY_KEYS by default (not writable here): run the same middleware with
    // this fixture's keys file, so the forged-token path is a real 401 rather than a missing-keys 503.
    const code = `import { createServer } from "node:http";
      import { createIdentity } from ${JSON.stringify(MIDDLEWARE)};
      const protect = createIdentity({ app: "demo", anonymous: true, keysFile: ${JSON.stringify(`${dir}/keys.json`)} }).protect;
      createServer(protect((req, res) => res.end("ok"), { health: "/api/health" })).listen(Number(process.env.PORT), "127.0.0.1");`;
    expect(await gate(tailnet, await starter({ AIDENHQ_APP: "demo", AIDENHQ_ANONYMOUS: "tailnet" }, code), true, agentSigner(`${dir}/apps.pem`))).toMatchObject({ ok: true });
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

  it("the identity gate says NO_SIGN_IN only for a served request, not when every probe errored", () => {
    const probe = (status: number) => ({ probe: { method: "GET" as const, path: "/", forged: true, counts: true }, status });
    const open = judgeIdentity([probe(200)]);
    expect(open.ok).toBe(false);
    expect(open.findings[0]).toMatchObject({ hard: true, verdict: "open", what: expect.stringContaining(NO_SIGN_IN) });

    // Every counted request answered an error: nothing shows the app checks identity, and it is not a confirmed-open app.
    const errored = judgeIdentity([probe(500), { probe: { method: "HEAD" as const, path: "/health", forged: false, counts: true }, status: 502 }]);
    expect(errored.ok).toBe(false);
    expect(errored.findings[0]).toMatchObject({ hard: true, verdict: "errored", what: expect.stringContaining("couldn't confirm") });
    expect(errored.findings[0]!.what).not.toContain(NO_SIGN_IN);

    // A refusal (401/403) is the only answer that lets the gate pass.
    expect(judgeIdentity([probe(401), probe(403)])).toMatchObject({ ok: true, findings: [] });
  });

  it("does not pass an app that answers 503 to every identity probe", async () => {
    const unavailable = await starter({}, `import { createServer } from "node:http";
      createServer((req, res) => { if (req.method === "GET" && req.url === "/api/health") return res.end("ok"); res.writeHead(503); res.end(); }).listen(Number(process.env.PORT), "127.0.0.1");`);
    const r = await gate(shared, unavailable);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ hard: true, verdict: "errored" });
    expect(r.findings[0]!.what).toMatch(/couldn't confirm/);
    expect(r.findings[0]!.what).not.toContain(NO_SIGN_IN);
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

});
