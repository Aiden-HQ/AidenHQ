import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createEngine, type Deps, STOPPED_OPEN, TEARDOWN_FAILED } from "../src/deploy.js";
import { NO_SIGN_IN, judgePage, probeResult } from "../src/checks.js";
import { previewApp } from "../src/previews.js";
import { parseApp } from "../src/registry.js";
import { openStore } from "../src/store.js";

const app = (o: object = {}) => parseApp({ name: "demo", repo: "example-org/x", owner: "a", description: "d", ...o });

// Fake docker: `config` returns a minimal compose file, `up` marks the checked-out sha as running. Health is true for "good" shas.
function setup(good: string[], check?: Deps["check"], identity?: Deps["identity"]) {
  const st = { out: "", running: "", downFails: false, broken: new Set<string>() };
  const t = { now: 0 };
  const src = mkdtempSync(`${tmpdir()}/src-`);
  writeFileSync(`${src}/compose.yaml`, "services:\n  web:\n    image: x\n");
  const store = openStore(":memory:");
  const engine = createEngine({
    store,
    appsData: mkdtempSync(`${tmpdir()}/apps-`),
    secretsDir: "/none",
    hostSecretsDir: "/none",
    identityKeysHostFile: "/none/keys.json", tailnetNode: () => true,
    exec: async (args) => {
      if (args.includes("config")) return '{"services":{"web":{"image":"x"}}}';
      if (args.includes("down") && st.downFails) throw new Error("docker compose down failed");
      if (args.includes("up") && st.broken.has(st.out)) throw new Error("docker compose up failed");
      if (args.includes("up")) st.running = st.out;
      return "";
    },
    checkout: async (_a, sha) => ((st.out = sha ?? "newsha"), { sha: st.out, dir: src }),
    probe: async () => ({ ok: good.includes(st.running), ms: 1 }),
    check,
    identity,
    now: () => t.now,
    sleep: async (ms) => void (t.now += ms),
  });
  return { engine, st, store };
}

describe("deploy engine", () => {
  it("drain waits for a deploy in flight and refuses new ones", async () => {
    const { engine, release } = (() => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const src = mkdtempSync(`${tmpdir()}/src-`);
      writeFileSync(`${src}/compose.yaml`, "services:\n  web:\n    image: x\n");
      const engine = createEngine({
        store: openStore(":memory:"), appsData: mkdtempSync(`${tmpdir()}/apps-`), secretsDir: "/none", hostSecretsDir: "/none", identityKeysHostFile: "/none/keys.json", tailnetNode: () => true,
        exec: async (args) => (args.includes("config") ? '{"services":{"web":{"image":"x"}}}' : args.includes("up") ? (await gate, "") : ""),
        checkout: async () => ({ sha: "v1", dir: src }),
        probe: async () => ({ ok: true, ms: 1 }),
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      });
      return { engine, release };
    })();
    const deploying = engine.deploy(app(), { sha: "v1", by: "t" });
    await new Promise((r) => setTimeout(r, 20)); // inside `compose up`
    let drained = false;
    const draining = engine.drain(60_000).then(() => (drained = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(drained).toBe(false); // still waiting on the build
    await expect(engine.deploy(app({ name: "other" }), { sha: "v2", by: "t" })).rejects.toThrow(/shutting down/);
    release();
    expect((await deploying).status).toBe("healthy"); // the deploy finished, not killed
    await draining;
    expect(drained).toBe(true);
  });

  it("rolls back a bad deploy to the previous sha", async () => {
    const { engine, st } = setup(["v1"]);
    await engine.deploy(app(), { sha: "v1", by: "t" });
    expect(await engine.deploy(app(), { sha: "v2", by: "t" })).toMatchObject({ sha: "v2", status: "rolled_back", previous: "v1" });
    expect(st.running).toBe("v1");
  });
  it("a healthy deploy that answers without the platform's sign-in is rolled back, and says so; a probe that can't run fails too", async () => {
    let st!: { running: string };
    const r0 = setup(["v1", "v2", "v3"], undefined, async () => {
      if (st.running === "v3") throw new Error("docker trouble");
      return probeResult("identity", "/", st.running === "v2" ? [{ hard: true, what: NO_SIGN_IN }] : []);
    });
    st = r0.st;
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    const r = await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    expect(r).toMatchObject({ status: "rolled_back", previous: "v1" });
    expect(r.checks?.find((c) => c.probe === "identity")?.findings[0]?.what).toBe(NO_SIGN_IN);
    expect(st.running).toBe("v1");
    expect(await r0.engine.deploy(app(), { sha: "v3", by: "t" })).toMatchObject({ status: "rolled_back" });
  });
  it("a manual rollback to a commit that answers without sign-in stops it and never targets it again", async () => {
    let open = false;
    const r0 = setup(["v1", "v2"], undefined, async () => probeResult("identity", "/", open ? [{ hard: true, what: NO_SIGN_IN }] : []));
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    open = true; // v1 predates the gate: it answers without sign-in now
    const r = await r0.engine.rollback(app(), { by: "t" });
    expect(r).toMatchObject({ sha: "v1", status: "failed", stopped: STOPPED_OPEN });
    await expect(r0.engine.rollback(app(), { by: "t" })).rejects.toThrow(/no previous good deploy/);
  });
  it("a rollback target whose down failed stays healthy history and says the teardown failed", async () => {
    let open = false;
    const r0 = setup(["v1", "v2"], undefined, async () => probeResult("identity", "/", open ? [{ hard: true, what: NO_SIGN_IN }] : []));
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    open = true; // v1 predates the gate: it answers without sign-in now
    r0.st.downFails = true;
    const r = await r0.engine.rollback(app(), { by: "t" });
    expect(r).toMatchObject({ sha: "v1", status: "failed", stopped: `${STOPPED_OPEN}; ${TEARDOWN_FAILED}` });
    expect(r0.store.goodDeploys("demo").find((g) => g.sha === "v1")?.status).toBe("healthy");
    expect(r0.store.goodDeploys("demo").find((g) => g.sha === "v1")?.disqualified).toBe(1); // found open: never a target again
    expect(r0.store.running("demo")).toBe("v1"); // the failed down may still be serving it
  });
  it("a target found open with a failed down is not re-admitted by a later health-only rollback", async () => {
    let open = false;
    let st!: { running: string };
    const r0 = setup(["v1", "v2"], undefined, async () => {
      return probeResult("identity", "/", open && st.running === "v1" ? [{ hard: true, what: NO_SIGN_IN }] : []);
    });
    st = r0.st;
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    open = true;
    r0.st.downFails = true;
    await r0.engine.rollback(app(), { by: "t" }); // v1 found open; its down failed
    open = false;
    r0.st.downFails = false;
    const r = await r0.engine.deploy(app(), { sha: "v3", by: "t" }); // v3 fails health only, so no identity re-probe
    expect(r).toMatchObject({ sha: "v3", status: "rolled_back", previous: "v2" });
    expect(st.running).toBe("v2");
  });
  it("an unconfirmed identity check on an auto-rollback target is not reported as rolled back", async () => {
    let id = 0;
    const unconfirmed = () => probeResult("identity", "/", [{ hard: true, what: "couldn't confirm the app refuses requests without the platform's sign-in: every request without a valid identity errored" }]);
    const r0 = setup(["v1", "v2"], undefined, async () => {
      id++;
      if (id === 1) return probeResult("identity", "/", []); // v1 deploy
      if (id === 2) return probeResult("identity", "/", [{ hard: true, what: NO_SIGN_IN }]); // v2 is refused
      return unconfirmed(); // the rollback target v1 cannot be confirmed
    });
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    const r = await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    expect(r.status).toBe("failed");
    expect(r.stopped).toBeUndefined();
    expect(r.previous).toBeUndefined();
    expect(r0.store.recentDeploys("demo").filter((d) => d.by === "auto-rollback")).toHaveLength(0); // never recorded healthy
    expect(r0.store.goodDeploys("demo").find((g) => g.sha === "v1")?.disqualified).toBe(1); // never reused as a target
  });
  it("an unconfirmed identity check on a manual rollback target is not reported as healthy", async () => {
    let id = 0;
    const r0 = setup(["v1", "v2"], undefined, async () => (++id >= 3 ? probeResult("identity", "/", [{ hard: true, what: "couldn't confirm the app refuses requests without the platform's sign-in: every request without a valid identity errored" }]) : probeResult("identity", "/", [])));
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    const r = await r0.engine.rollback(app(), { by: "t" });
    expect(r.status).toBe("failed");
    expect(r.stopped).toBeUndefined();
    expect(r0.store.goodDeploys("demo").find((g) => g.sha === "v1")?.disqualified).toBe(1); // never reused as a target
  });
  it("a disqualified newest target does not hide an older good rollback target", async () => {
    const { engine, store } = setup(["v1", "v2", "v3"]);
    await engine.deploy(app(), { sha: "v1", by: "t" });
    await engine.deploy(app(), { sha: "v2", by: "t" });
    await engine.deploy(app(), { sha: "v3", by: "t" });
    store.disqualify(store.goodDeploys("demo").find((g) => g.sha === "v3")!.id, "found open");
    const r = await engine.rollback(app(), { by: "t" });
    expect(r).toMatchObject({ sha: "v2", status: "healthy", previous: "v3" });
  });
  it("a rollback that could not start reports the teardown failure and keeps no previous revision", async () => {
    const { engine, st, store } = setup(["v1", "v2"]);
    await engine.deploy(app(), { sha: "v1", by: "t" });
    await engine.deploy(app(), { sha: "v2", by: "t" });
    st.broken.add("v1");
    st.downFails = true;
    const r = await engine.rollback(app(), { by: "t" });
    expect(r).toMatchObject({ sha: "v1", status: "build_failed", stopped: TEARDOWN_FAILED });
    expect(r.previous).toBeUndefined();
    expect(store.running("demo")).toBeUndefined();
    expect(store.lastDeploy("demo")?.detail).toContain(TEARDOWN_FAILED);
  });
  it("a failed preview whose compose down fails reports the teardown failure", async () => {
    const { engine, st, store } = setup([]);
    st.downFails = true;
    const r = await engine.preview(previewApp(app({ port: 8080 }), 1, 39100), "v1");
    expect(r).toMatchObject({ sha: "v1", ok: false, stopped: TEARDOWN_FAILED });
    expect(r.why).toContain(TEARDOWN_FAILED);
    expect(store.lastDeploy("demo-pr-1")?.detail).toContain(TEARDOWN_FAILED);
    expect(store.running("demo-pr-1")).toBe("v1");
  });
  it("a healthy deploy whose page answers 500 is rolled back, and says why", async () => {
    // v2 is healthy, but its render check finds the incident's signals: the deploy rolls back to v1.
    const { engine, st } = setup(["v1", "v2"], async () => [probeResult("render", "/", st.running === "v2" ? [{ hard: true, what: "the page answered 500" }] : [])]);
    await engine.deploy(app(), { sha: "v1", by: "t" });
    const r = await engine.deploy(app(), { sha: "v2", by: "t" });
    expect(r).toMatchObject({ status: "rolled_back", previous: "v1" });
    expect(r.checks?.find((c) => c.probe === "render")?.ok).toBe(false);
    expect(st.running).toBe("v1");
  });
  it("a healthy deploy whose page renders unstyled or logs a console error stays up with warnings, first deploy included", async () => {
    const facts = { path: "/", status: 200, console: ["boom"], sheets: [{ href: "/a.css", applied: false }] };
    const { engine, st } = setup(["v1", "v2"], async () => [probeResult("render", "/", judgePage(facts, true))]);
    expect(await engine.deploy(app(), { sha: "v1", by: "t" })).toMatchObject({ status: "healthy" });
    const r = await engine.deploy(app(), { sha: "v2", by: "t" });
    expect(r.status).toBe("healthy");
    expect(r.checks?.find((c) => c.probe === "render")?.findings).toHaveLength(2);
    expect(st.running).toBe("v2");
  });
  it("a first deploy that never gets healthy is stopped, not looped", async () => {
    const { engine } = setup([]);
    expect((await engine.deploy(app(), { sha: "v1", by: "t" })).status).toBe("failed");
  });
  it("a first deploy whose compose down fails keeps the running row and records the teardown failure", async () => {
    const { engine, st, store } = setup([]);
    st.downFails = true;
    const r = await engine.deploy(app(), { sha: "v1", by: "t" });
    expect(r).toMatchObject({ status: "failed", stopped: TEARDOWN_FAILED });
    expect(store.running("demo")).toBe("v1");
    expect(store.lastDeploy("demo")?.detail).toContain(TEARDOWN_FAILED);
    expect(store.lastDeploy("demo")?.detail).not.toContain("stopped (no previous good deploy)");
  });
  it("refuses a concurrent deploy", async () => {
    const { engine } = setup(["v1"]);
    const first = engine.deploy(app(), { sha: "v1", by: "t" });
    await expect(engine.deploy(app(), { sha: "v1", by: "t" })).rejects.toThrow(/deploy in progress/);
    await first;
  });
  it("refuses a stateful app without approval", async () => {
    const { engine } = setup(["v1"]);
    await expect(engine.deploy(app({ stateful: true }), { sha: "v1", by: "t" })).rejects.toThrow(/stateful/);
  });
  it("without a health url, a container that restarts during the grace period is not healthy", async () => {
    // The probe sees a running container (it is, between crashes), but `docker inspect` shows its RestartCount rising.
    const run = async (restartsAfter: number) => {
      const t = { now: 0, ticks: 0 };
      const src = mkdtempSync(`${tmpdir()}/src-`);
      writeFileSync(`${src}/compose.yaml`, "services:\n  web:\n    image: x\n");
      const engine = createEngine({
        store: openStore(":memory:"), appsData: mkdtempSync(`${tmpdir()}/apps-`), secretsDir: "/none", hostSecretsDir: "/none", identityKeysHostFile: "/none/keys.json", tailnetNode: () => true,
        exec: async (args) => (args.includes("config") ? '{"services":{"web":{"image":"x"}}}' : args.includes("ps") ? "c1\n" : args.includes("inspect") ? `c1 true ${t.ticks > 3 ? restartsAfter : 0}\n` : ""),
        checkout: async () => ({ sha: "v1", dir: src }),
        probe: async () => ({ ok: true, ms: 1 }),
        now: () => t.now,
        sleep: async (ms) => void ((t.now += ms), t.ticks++),
      });
      return engine.deploy(app(), { sha: "v1", by: "t" });
    };
    expect((await run(0)).status).toBe("healthy");
    expect((await run(2)).status).toBe("failed");
  });
});

// The health finding and the deploy record name the probe's failure class, and app_check reports its own probe: a live
// failure in milliseconds must not read like a deploy's grace wait.
describe("health failure detail", () => {
  const health = (extra: object = {}) => app({ port: 8080, health: { url: "http://app:8080/api/health" }, ...extra });

  const engineWith = (opts: { live?: { ok: boolean; ms: number }; failure?: string } = {}) => {
    const src = mkdtempSync(`${tmpdir()}/src-`);
    writeFileSync(`${src}/compose.yaml`, "services:\n  web:\n    image: x\n");
    const t = { now: 0 };
    const store = openStore(":memory:");
    const engine = createEngine({
      store, appsData: mkdtempSync(`${tmpdir()}/apps-`), secretsDir: "/none", hostSecretsDir: "/none", identityKeysHostFile: "/none/keys.json", tailnetNode: () => true,
      exec: async (args) => (args.includes("config") ? '{"services":{"web":{"image":"x"}}}' : ""),
      checkout: async () => ({ sha: "v1", dir: src }),
      probe: async () => opts.live ?? ({ ok: false, ms: 1 }),
      probeFailure: () => opts.failure,
      now: () => t.now,
      sleep: async (ms) => void (t.now += ms),
    });
    return { engine, store };
  };

  it("a deploy that never gets healthy records the probe's class, not just that the wait ran out", async () => {
    const { engine, store } = engineWith({ failure: "health probe failed: connection-refused" });
    const r = await engine.deploy(health(), { sha: "v1", by: "t" });
    expect(r.status).toBe("failed");
    expect(store.lastDeploy("demo")?.detail).toBe("not healthy within 60s: health probe failed: connection-refused; stopped (no previous good deploy)");
    expect(r.checks?.find((c) => c.probe === "health")).toMatchObject({ ok: false, findings: [{ hard: true, what: "not healthy within 60s: health probe failed: connection-refused" }] });
  });

  // The health url can carry a token in its path, query or port: the recorded finding and summary carry none of it.
  it("keeps every part of the health url out of the finding and the deploy record", async () => {
    const url = "http://app:8080/hooks/s3cret?token=tok123";
    const { engine, store } = engineWith({ failure: "health probe failed: no-dns-answer" });
    await engine.deploy(app({ port: 8080, health: { url } }), { sha: "v1", by: "t" });
    const detail = store.lastDeploy("demo")!.detail;
    expect(detail).toBe("not healthy within 60s: health probe failed: no-dns-answer; stopped (no previous good deploy)");
    for (const leaked of ["8080", "app", "s3cret", "tok123", "http", "/hooks"]) expect(detail).not.toContain(leaked);
    const finding = await engine.check(app({ port: 8080, health: { url } }), {});
    for (const leaked of ["8080", "app:", "s3cret", "tok123", "/hooks"]) expect(JSON.stringify(finding)).not.toContain(leaked);
  });

  it("app_check reports its own probe's result and duration, so it can't be read as the deploy's wait", async () => {
    const { engine } = engineWith({ live: { ok: false, ms: 118 }, failure: "health probe failed: no-dns-answer" });
    await engine.deploy(health(), { sha: "v1", by: "t" }); // the deploy record app_check's `deployed` needs
    const checks = await engine.check(health(), {});
    expect(checks.find((c) => c.probe === "health")).toMatchObject({
      ok: false,
      probe_ms: 118,
      live: true,
      findings: [{ hard: true, what: "health probe failed: no-dns-answer (118ms)" }],
    });
  });

  it("an exit-2 HTTP error keeps its own reason, and a healthy app_check is live too", async () => {
    const answered = engineWith({ live: { ok: false, ms: 20 }, failure: "health answered HTTP 503" });
    await answered.engine.deploy(health(), { sha: "v1", by: "t" });
    expect((await answered.engine.check(health(), {})).find((c) => c.probe === "health")).toMatchObject({ findings: [{ hard: true, what: "health answered HTTP 503 (20ms)" }] });

    const ok = engineWith({ live: { ok: true, ms: 12 } });
    await ok.engine.deploy(health(), { sha: "v1", by: "t" });
    expect((await ok.engine.check(health(), {})).find((c) => c.probe === "health")).toMatchObject({ ok: true, probe_ms: 12, live: true, findings: [] });
  });
});
