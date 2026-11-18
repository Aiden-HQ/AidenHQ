import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Platform } from "../src/platform.js";
import { ERROR_CLASSES, MAX_CHECKS, parseChecks, PROBE, PROBE_CLASSES as CLASSES, probeFailure, withoutSamples } from "../src/quality.js";

describe("quality checks from /api/health", () => {
  it("reads bounded checks; no checks is none; anything that didn't evaluate is unknown", () => {
    expect(parseChecks("null")).toEqual({ state: "none" });
    const r = parseChecks(JSON.stringify([{ name: "eta_has_source", ok: false, count: 3, sample: { id: 7, note: "x".repeat(500) } }, { name: "fresh", ok: true }]));
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.checks[0]).toMatchObject({ name: "eta_has_source", ok: false, count: 3 });
    expect(r.checks[0]!.sample!.length).toBe(200);
    expect(r.checks[1]).toEqual({ name: "fresh", ok: true, count: null, sample: null });
    expect(parseChecks(JSON.stringify([{ name: "x", ok: null }])).state).toBe("unknown");
    expect(parseChecks(JSON.stringify([{ name: "a:b", ok: true }])).state).toBe("unknown");
    expect(parseChecks(JSON.stringify(Array.from({ length: MAX_CHECKS + 1 }, (_, n) => ({ name: `c${n}`, ok: true })))).state).toBe("unknown");
    expect(parseChecks("not json").state).toBe("unknown");
    // The internal route (the board, then fleet_status) never carries a sample: app data stays behind app_status.
    expect(JSON.stringify(withoutSamples(r))).not.toContain("xxx");
  });
});

describe("the probe's failure classes", () => {
  const runWith = (prelude: string, url: string) =>
    new Promise<{ code: number | null; stdout: string }>((resolve) =>
      execFile(process.execPath, ["-e", prelude + PROBE, url], (e, stdout) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, stdout })),
    );
  const run = (url: string) => runWith("", url);

  it("prints a bare class for a refused connection, no DNS answer and no status in 5s", async () => {
    const closed = createTcpServer().listen(0, "127.0.0.1");
    await new Promise((r) => closed.once("listening", r));
    const refusedPort = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    expect(await run(`http://127.0.0.1:${refusedPort}/api/health`)).toEqual({ code: 1, stdout: "PROBE connection-refused\n" });

    expect(await run("http://no-such-host.invalid/api/health")).toEqual({ code: 1, stdout: "PROBE no-dns-answer\n" });

    const idle = createTcpServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((r) => idle.once("listening", r));
    const slow = await run(`http://127.0.0.1:${(idle.address() as AddressInfo).port}/api/health`);
    idle.close();
    expect(slow).toEqual({ code: 1, stdout: "PROBE no-status-in-5s\n" });
  }, 20_000);

  // Every code PROBE maps: a fetch that throws it prints that code's class, and nothing else.
  it("prints the class of each mapped error, and request-failed for the rest", async () => {
    const seen = new Set<string>();
    for (const [code, cls] of Object.entries(ERROR_CLASSES)) {
      const reject = `globalThis.fetch = () => Promise.reject(Object.assign(new Error("m"), { code: ${JSON.stringify(code)} }));\n`;
      expect(await runWith(reject, "http://app:8080/api/health")).toEqual({ code: 1, stdout: `PROBE ${cls}\n` });
      seen.add(cls);
    }
    const timeout = `globalThis.fetch = () => Promise.reject(Object.assign(new Error("m"), { name: "TimeoutError" }));\n`;
    expect(await runWith(timeout, "http://app:8080/api/health")).toEqual({ code: 1, stdout: "PROBE no-status-in-5s\n" });
    seen.add("no-status-in-5s");
    const other = `globalThis.fetch = () => Promise.reject(Object.assign(new Error("m"), { code: "EACCES" }));\n`;
    expect(await runWith(other, "http://app:8080/api/health")).toEqual({ code: 1, stdout: "PROBE request-failed\n" });
    seen.add("request-failed");
    // Every class the probe prints is exercised above; helper-not-started is the caller's, docker's exit 125.
    expect([...seen].sort()).toEqual(CLASSES.filter((c) => c !== "helper-not-started").sort());
  });

  it("keeps exit 2 with HTTP <status> and exit 0 with its checks", async () => {
    const app = createHttpServer((req, res) => {
      if (req.url === "/bad") { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ checks: [{ name: "fresh", ok: true }] }));
    }).listen(0, "127.0.0.1");
    await new Promise((r) => app.once("listening", r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    expect(await run(`${base}/bad`)).toEqual({ code: 2, stdout: "HTTP 503" });
    expect(await run(`${base}/api/health`)).toEqual({ code: 0, stdout: JSON.stringify([{ name: "fresh", ok: true }]) });
    app.close();
  });

  it("maps every class, including what only the caller sees, and never echoes a forged line", () => {
    for (const [code, cls] of Object.entries(ERROR_CLASSES)) expect(probeFailure({ stdout: `PROBE ${cls}`, exit: 1 })).toBe(`health probe failed: ${cls}`);
    expect(probeFailure({ stdout: `PROBE ${CLASSES[0]}`, exit: 1 })).toBe(`health probe failed: ${CLASSES[0]}`);
    for (const cls of Object.values(ERROR_CLASSES)) expect(CLASSES).toContain(cls);
    expect(probeFailure({ stdout: "", exit: 125 })).toBe("health probe failed: helper-not-started");
    expect(probeFailure({ stdout: "", exit: 1, killed: true })).toBe("health probe failed: no-status-in-5s");
    expect(probeFailure({ stdout: "", exit: 1 })).toBe("health probe failed: request-failed");
    expect(probeFailure({ stdout: "", exit: 137 })).toBe("health probe failed: request-failed");
    expect(probeFailure({ stdout: "PROBE http://app:8080/api/health?token=abc", exit: 1 })).toBe("health probe failed: request-failed");
    expect(probeFailure({ stdout: "PROBE ConnectionRefusedError: http://app", exit: 125 })).toBe("health probe failed: helper-not-started");
    expect(probeFailure({ stdout: "docker: a warning\nPROBE no-dns-answer\n", exit: 1 })).toBe("health probe failed: no-dns-answer");
    expect(probeFailure({ stdout: "docker: a warning\nPROBE forged-class\n", exit: 1 })).toBe("health probe failed: request-failed");
  });

  // A health url can carry a token in its path and query and a port: the recorded text never has any of them.
  it("records no url, host, port or path from the health url", async () => {
    const closed = createTcpServer().listen(0, "127.0.0.1");
    await new Promise((r) => closed.once("listening", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const url = `http://127.0.0.1:${port}/hooks/s3cret?token=tok123#frag`;
    const { stdout } = await run(url);
    const recorded = probeFailure({ stdout, exit: 1 });
    expect(recorded).toBe("health probe failed: connection-refused");
    for (const leaked of [String(port), "127.0.0.1", "s3cret", "tok123", "http", "/hooks"]) expect(recorded).not.toContain(leaked);
    // Credentials in the url make node's fetch refuse it before any request: still only a class, never the url.
    const creds = probeFailure({ stdout: (await run(`http://user:hunter2@127.0.0.1:${port}/hooks/s3cret?token=tok123`)).stdout, exit: 1 });
    expect(creds).toBe("health probe failed: request-failed");
    for (const leaked of [String(port), "127.0.0.1", "s3cret", "tok123", "hunter2", "user", "/hooks"]) expect(creds).not.toContain(leaked);
  });
});

// The caller's record: a failed probe always leaves one reason, a class only, and exit 2 keeps the app's HTTP answer.
describe("the platform records the probe's reason", () => {
  const withDocker = async (script: string, fn: (p: Platform) => Promise<void>) => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createPlatform } = await import("../src/platform.js");
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    writeFileSync(join(dir, "docker"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "docker"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      const registryPath = join(dir, "apps.yaml");
      writeFileSync(registryPath, "apps:\n  - { name: notes, repo: example-org/notes, owner: a, description: d, health: { url: 'http://web:8080/hooks/s3cret?token=tok123' } }\n");
      await fn(createPlatform(
        { registryPath, modulesRegistryPath: join(dir, "m.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "x.pem"), identityKeysHostFile: join(dir, "k.json"), dbPath: join(dir, "s.sqlite"), urlBase: "", edgeDir: dir, healthImage: "sha256:ownimage", git: { appsData: dir, gitDir: dir } },
        { warn: () => {}, info: () => {} },
      ));
    } finally {
      process.env.PATH = path;
    }
  };

  it("records `health probe failed: <class>` on a failed probe, and nothing from the url", async () => {
    await withDocker(`echo "PROBE connection-refused"\nexit 1`, async (p) => {
      const r = await p.probe(p.find("notes"));
      expect(r.ok).toBe(false);
      expect(r.ms).toBeGreaterThanOrEqual(0);
      const why = p.healthFailure(p.find("notes"))!;
      expect(why).toBe("health probe failed: connection-refused");
      for (const leaked of ["8080", "web", "s3cret", "tok123", "/hooks"]) expect(why).not.toContain(leaked);
    });
  });

  it("records helper-not-started for a helper docker could not start, and keeps exit 2's HTTP text", async () => {
    await withDocker(`echo "Unable to find image sha256:ownimage locally"\nexit 125`, async (p) => {
      expect((await p.probe(p.find("notes"))).ok).toBe(false);
      expect(p.healthFailure(p.find("notes"))).toBe("health probe failed: helper-not-started");
    });
    await withDocker(`echo "HTTP 503"\nexit 2`, async (p) => {
      expect((await p.probe(p.find("notes"))).ok).toBe(false);
      expect(p.healthFailure(p.find("notes"))).toBe("health answered HTTP 503");
      expect(p.appAnswered(p.find("notes"))).toBe(true);
    });
  });
});
