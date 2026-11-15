import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createEngine } from "../src/deploy.js";
import { healthTick, reconcileTick, WATCH_MS } from "../src/loops.js";
import type { Platform } from "../src/platform.js";
import { parseApp, type App } from "../src/registry.js";
import { openStore } from "../src/store.js";

const quiet = { warn: () => {} };
const TICK = 2 * 60_000;
const FIX = "f".repeat(40);

// The real engine and store on a fake docker (as in deploy.test.ts): `up` runs the checked-out sha; `good` decides health.
// `failure` is what the probe saw when it failed (an HTTP error is app-side evidence; undefined is no answer).
function setup(o: { message?: string } = {}) {
  const st = { out: "", running: "", good: new Set<string>(), failure: undefined as string | undefined, app: parseApp({ name: "demo", repo: "example-org/x", owner: "a", description: "d" }) as App };
  const t = { now: 0 };
  const src = mkdtempSync(`${tmpdir()}/src-`);
  writeFileSync(`${src}/compose.yaml`, "services:\n  web:\n    image: x\n");
  const store = openStore(":memory:");
  const engine = createEngine({
    store,
    appsData: mkdtempSync(`${tmpdir()}/apps-`),
    secretsDir: "/none",
    hostSecretsDir: "/none",
    identityKeysHostFile: "/none/keys.json",
    exec: async (args) => {
      if (args.includes("config")) return '{"services":{"web":{"image":"x"}}}';
      if (args.includes("up")) st.running = st.out;
      return "";
    },
    checkout: async (_a, sha) => ((st.out = sha ?? "newsha"), { sha: st.out, dir: src }),
    probe: async () => st.good.has(st.running),
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
    probe: async () => st.good.has(st.running),
    healthFailure: () => st.failure,
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

  it("never rolls back on probes that got no answer, a No-Auto-Rollback commit, or after the window", async () => {
    const noAnswer = setup();
    await noAnswer.deployed();
    noAnswer.st.good.delete("v2"); // timeouts under load: no app-side evidence
    await noAnswer.ticks(6);
    expect(noAnswer.st.running).toBe("v2");
    expect(noAnswer.raised).toEqual([{ kind: "unhealthy", detail: "health check failing (no answer)" }]);

    const marked = setup({ message: "fix(auth): close the token leak\n\nNo-Auto-Rollback: security fix" });
    await marked.deployed();
    marked.st.good.delete("v2");
    marked.st.failure = "health answered HTTP 503";
    await marked.ticks(6);
    expect(marked.st.running).toBe("v2");
    expect(marked.raised.map((r) => r.kind)).toEqual(["unhealthy"]);

    const late = setup();
    await late.deployed(WATCH_MS + 60_000);
    late.st.good.delete("v2");
    late.st.failure = "health answered HTTP 500";
    await late.ticks(6);
    expect(late.st.running).toBe("v2");
  });

  it("raises the outage without retrying when the rollback target fails too", async () => {
    const { st, store, raised, deployed, ticks } = setup();
    await deployed();
    st.good.clear();
    st.failure = "health answered HTTP 502";
    await ticks(4);
    expect(raised[1]).toEqual({ kind: "unhealthy", detail: expect.stringMatching(/^v2: health answered HTTP 502 on 4 probes .*; rollback to v1 also unhealthy$/) });
    await ticks(6);
    expect(store.recentDeploys("demo")).toHaveLength(3); // one rollback, no loop
    expect(store.recentDeploys("demo")[0]).toMatchObject({ sha: "v1", by: "watch-rollback", status: "failed" });
  });
});
