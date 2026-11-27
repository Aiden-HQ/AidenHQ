import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { NO_SIGN_IN, probeResult } from "../src/checks.js";
import { createEngine, STOPPED_OPEN } from "../src/deploy.js";
import { BUILD_ATTEMPTS, healthTick, reconcileTick, WATCH_MS } from "../src/loops.js";
import { type Platform } from "../src/platform.js";
import { parseApp, type App } from "../src/registry.js";
import { openStore } from "../src/store.js";

const quiet = { warn: () => {} };
const TICK = 2 * 60_000;
const FIX = "f".repeat(40);

// The real engine and store on a fake docker (as in deploy.test.ts): `up` runs the checked-out sha; `good` decides health.
// `failure` is the reason the probe recorded (a class, or an HTTP error, which is app-side evidence too). `broken` shas fail in
// `up` like a build or host error does: nothing of that commit ever runs.
function setup(o: { message?: string } = {}) {
  const st = { out: "", running: "", good: new Set<string>(), broken: new Set<string>(), open: new Set<string>(), downFails: false, failure: undefined as string | undefined, app: parseApp({ name: "demo", repo: "example-org/x", owner: "a", description: "d" }) as App };
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
      if (args.includes("up")) {
        if (st.broken.has(st.out)) throw new Error("docker compose -p app-demo failed: buildx Docker CLI plugin not found: falling back to the classic builder");
        st.running = st.out;
      }
      if (args.includes("down") && st.downFails) throw new Error("docker compose down failed");
      if (args.includes("down")) st.running = "";
      return "";
    },
    checkout: async (_a, sha) => ((st.out = sha ?? "newsha"), { sha: st.out, dir: src }),
    probe: async () => ({ ok: st.good.has(st.running), ms: 1 }),
    // `open` shas answer without the platform's sign-in (an app deployed before the identity gate existed).
    identity: async () => probeResult("identity", "/", st.open.has(st.running) ? [{ hard: true, verdict: "open", what: `app:8080 on 127.0.0.1: ${NO_SIGN_IN} (GET / with no identity answered 200)` }] : []),
    now: () => t.now,
    sleep: async (ms) => void (t.now += ms),
  });
  const raised: { kind: string; detail: string }[] = [];
  const p = {
    store,
    engine,
    cfg: { git: {} },
    errors: new Map(),
    apps: () => [st.app],
    probe: async () => ({ ok: st.good.has(st.running), ms: 1 }),
    healthFailure: () => st.failure,
    appAnswered: () => Boolean(st.failure?.startsWith("health answered HTTP")),
    noAutoRollback: async () => /^no-auto-rollback:/im.test(o.message ?? ""),
    notifyPending: async () => {},
    refresh: async () => {},
    syncEdge: async () => {},
    raise: async (name: string, kind: string, detail: string) => {
      if (store.openIncident(name)) return;
      store.addIncident(name, kind, detail);
      raised.push({ kind, detail });
    },
  } as unknown as Platform;
  // v1 deployed long ago; v2 auto-deployed 5 minutes before the clock's start, healthy at the time.
  const clock = { now: Date.now() };
  const deployed = async (ago = 5 * 60_000) => {
    st.good.add("v1").add("v2");
    t.now = clock.now - 2 * WATCH_MS;
    await engine.deploy(st.app, { sha: "v1", by: "reconcile" });
    t.now = clock.now - ago;
    await engine.deploy(st.app, { sha: "v2", by: "auto-deploy" });
  };
  /** n health ticks, TICK apart. */
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++, clock.now += TICK) await healthTick(p, quiet, () => clock.now);
  };
  return { p, st, store, engine, raised, deployed, ticks };
}

describe("post-deploy watch", () => {
  it("rolls back only after consecutive app-side failures over five minutes, once, and says why", async () => {
    const { p, st, store, engine, raised, deployed, ticks } = setup();
    await deployed();
    st.good.delete("v2");
    st.failure = "health answered HTTP 500";
    await ticks(3); // three failures, but only four minutes apart: the outage is raised, nothing rolled back
    expect(st.running).toBe("v2");
    expect(raised.map((r) => r.kind)).toEqual(["unhealthy"]);
    await ticks(1);
    expect(st.running).toBe("v1");
    expect(store.lastDeploy("demo")).toMatchObject({ sha: "v1", by: "watch-rollback", status: "healthy" });
    expect(store.recentDeploys("demo").find((d) => d.sha === "v2")?.status).toBe("rolled_back");
    expect(raised[1]).toEqual({ kind: "rolled_back", detail: expect.stringMatching(/^v2: health answered HTTP 500 on 4 probes over 6 min, from 5 min after its auto-deploy; rolled back to v1/) });
    // The next tick finds v1 healthy: the rolled_back incident stays open for the fix, and nothing is rolled back again.
    await ticks(1);
    expect(store.openIncident("demo")?.kind).toBe("rolled_back");
    expect(store.recentDeploys("demo")).toHaveLength(3);
    // The bad commit is never a rollback target again.
    await expect(engine.rollback(st.app, { by: "t" })).rejects.toThrow(/no previous good deploy/);
    // The app isn't wedged on v1: the next commit on the branch auto-deploys and closes the incident.
    st.app = { ...st.app, pin: FIX };
    st.good.add(FIX);
    await reconcileTick(p, quiet);
    expect(store.lastDeploy("demo")).toMatchObject({ sha: FIX, by: "auto-deploy", status: "healthy" });
    expect(store.openIncident("demo")).toBeUndefined();
  });

  it("stops the app when a deploy refused for answering without sign-in would roll back to a version that does too", async () => {
    const { p, st, store, ticks, deployed } = setup();
    await deployed(); // v1 and v2 went out before the identity gate: both answer without sign-in
    st.open.add("v1").add("v2").add("v3");
    st.good.add("v3"); // healthy, but refused by the identity gate
    store.addIncident("demo", "deploy_failed", "deploy of v2x rolled_back, rolled back to v2"); // an earlier refused commit's
    st.app = { ...st.app, pin: "v3" };
    await reconcileTick(p, quiet);
    expect(st.running).toBe(""); // down, not left serving v2
    expect(store.lastDeploy("demo")).toMatchObject({ sha: "v3", status: "failed", detail: expect.stringMatching(new RegExp(`^${STOPPED_OPEN} \\(as does the rollback target v2\\)`)) });
    expect(store.openIncident("demo")).toMatchObject({ kind: "deploy_failed", detail: expect.stringContaining(STOPPED_OPEN) });
    expect(store.goodDeploys("demo").map((g) => g.sha)).toEqual(["v1"]); // v2 is never a rollback target again
    await ticks(3);
    expect(st.running).toBe(""); // nothing brings it back
    // A protected rollback target still takes over as before.
    st.open.delete("v1");
    st.app = { ...st.app, pin: "v4" };
    st.good.add("v4");
    st.open.add("v4");
    await reconcileTick(p, quiet);
    expect(store.lastDeploy("demo")).toMatchObject({ sha: "v1", status: "healthy", by: "auto-rollback" });
    expect(st.running).toBe("v1");
  });

  it("raises a failed teardown once across retries of the same commit", async () => {
    const { p, st, store, raised, deployed } = setup();
    await deployed();
    st.broken.add("v1").add("v2").add(FIX);
    st.downFails = true;
    st.app = { ...st.app, pin: FIX };
    for (let i = 0; i < BUILD_ATTEMPTS; i++) await reconcileTick(p, quiet);
    expect(store.lastDeploy("demo")).toMatchObject({ sha: FIX, status: "build_failed", detail: expect.stringContaining("teardown failed") });
    expect(raised.filter((r) => r.detail.includes("teardown failed"))).toHaveLength(1);
  });

  // A retry whose outcome is no longer that teardown replaces the incident: the stale warning must not outlive it.
  it("replaces a teardown incident when a retry's outcome is no longer that teardown", async () => {
    const { p, st, store, raised, deployed } = setup();
    await deployed();
    st.broken.add("v1").add("v2").add(FIX);
    st.downFails = true;
    st.app = { ...st.app, pin: FIX };
    await reconcileTick(p, quiet);
    expect(store.openIncident("demo")?.detail).toContain("teardown failed");
    st.downFails = false; // the retry's teardown now succeeds
    await reconcileTick(p, quiet);
    expect(raised.filter((r) => r.detail.includes("teardown failed"))).toHaveLength(1);
    expect(store.openIncident("demo")?.detail).not.toContain("teardown failed");
  });

  // Dedupe follows the open incident, not the commit: a teardown failure after the app recovered and its incident closed
  // pages again, even on the same commit.
  it("raises a torn-down commit again once its incident has closed", async () => {
    const { p, st, store, raised, deployed } = setup();
    await deployed();
    st.broken.add("v1").add("v2").add(FIX);
    st.downFails = true;
    st.app = { ...st.app, pin: FIX };
    await reconcileTick(p, quiet);
    expect(raised.filter((r) => r.detail.includes("teardown failed"))).toHaveLength(1);
    store.closeIncident("demo");
    await reconcileTick(p, quiet);
    expect(raised.filter((r) => r.detail.includes("teardown failed"))).toHaveLength(2);
  });

});
