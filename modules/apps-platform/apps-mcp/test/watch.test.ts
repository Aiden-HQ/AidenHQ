import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NO_SIGN_IN, probeResult } from "../src/checks.js";
import { createEngine, STOPPED_OPEN } from "../src/deploy.js";
import { BUILD_ATTEMPTS, healthTick, reconcileTick, WATCH_MS } from "../src/loops.js";
import { fireReached, type Platform } from "../src/platform.js";
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
    identity: async () => probeResult("identity", "/", st.open.has(st.running) ? [{ hard: true, what: `app:8080 on 127.0.0.1: ${NO_SIGN_IN} (GET / with no identity answered 200)` }] : []),
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

  it("never rolls back on a probe failure with no app-side evidence, a No-Auto-Rollback commit, or after the window", async () => {
    const noAnswer = setup();
    await noAnswer.deployed();
    noAnswer.st.good.delete("v2"); // the probe's own network path failed: no app-side evidence
    noAnswer.st.failure = "health probe failed: connection-refused";
    await noAnswer.ticks(6);
    expect(noAnswer.st.running).toBe("v2");
    expect(noAnswer.raised).toEqual([{ kind: "unhealthy", detail: "health probe failed: connection-refused" }]);

    // A helper container that never started is a platform fault: raised with its class, never rolled back.
    const helper = setup();
    await helper.deployed();
    helper.st.good.delete("v2");
    helper.st.failure = "health probe failed: helper-not-started";
    await helper.ticks(6);
    expect(helper.st.running).toBe("v2");
    expect(helper.raised).toEqual([{ kind: "unhealthy", detail: "health probe failed: helper-not-started" }]);

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

  it("keeps a failed deploy's incident open through healthy checks on the old version, until a fixed deploy is healthy", async () => {
    const { p, st, store, ticks, deployed } = setup();
    await deployed();
    st.app = { ...st.app, pin: "v3" }; // v3 fails its deploy and is rolled back to v2
    await reconcileTick(p, quiet);
    expect(st.running).toBe("v2");
    expect(store.openIncident("demo")?.kind).toBe("deploy_failed");
    await ticks(3); // v2 is healthy again, but the bad commit is not fixed
    expect(store.openIncident("demo")?.kind).toBe("deploy_failed");
    st.app = { ...st.app, pin: FIX };
    st.good.add(FIX);
    await reconcileTick(p, quiet);
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

  // A build or host error (the docker CLI plugin missing, a full disk) is not the commit's fault: an auto-deploy that never
  // got to run must not mark its commit as deployed for good, or nothing retries it and no healthy auto-deploy can exist.
  it("retries a commit whose build failed, and a later attempt deploys it", async () => {
    const { p, st, store, deployed } = setup();
    await deployed();
    st.app = { ...st.app, pin: FIX };
    st.good.add(FIX);
    st.broken.add(FIX);
    await reconcileTick(p, quiet);
    expect(store.deploysOf("demo", FIX)).toMatchObject([{ by: "auto-deploy", status: "build_failed" }]);
    expect(store.lastDeploy("demo")).toMatchObject({ sha: "v2", by: "auto-rollback", status: "healthy" });
    expect(st.running).toBe("v2"); // rolled back: nothing of the broken build runs
    await reconcileTick(p, quiet); // the next poll tries the same commit again
    expect(store.deploysOf("demo", FIX)).toHaveLength(2);
    st.broken.delete(FIX); // the host is fixed: the retry deploys it, by the platform's own auto-deploy
    await reconcileTick(p, quiet);
    expect(store.lastDeploy("demo")).toMatchObject({ sha: FIX, by: "auto-deploy", status: "healthy" });
    expect(store.openIncident("demo")).toBeUndefined();
  });

  it("stops retrying a commit whose build keeps failing, and never retries one that failed health", async () => {
    const { p, st, store, deployed } = setup();
    await deployed();
    st.app = { ...st.app, pin: FIX };
    st.broken.add(FIX);
    for (let i = 0; i < BUILD_ATTEMPTS + 2; i++) await reconcileTick(p, quiet);
    expect(store.deploysOf("demo", FIX)).toHaveLength(BUILD_ATTEMPTS);

    // An app-side failure (the deploy ran and failed health) stays a one-shot: it was the commit, not the host.
    const other = setup();
    await other.deployed();
    other.st.app = { ...other.st.app, pin: FIX };
    for (let i = 0; i < 3; i++) await reconcileTick(other.p, quiet);
    expect(other.store.deploysOf("demo", FIX)).toHaveLength(1);
    expect(other.store.lastDeploy("demo")).toMatchObject({ sha: "v2", status: "healthy" });
  });

  // The first deploy of an app has nothing to fall back on, but a host error there is no more the commit's own than any other.
  it("retries a first deploy whose build failed, and a later attempt deploys it", async () => {
    const { p, st, store } = setup();
    st.app = { ...st.app, pin: FIX };
    st.good.add(FIX);
    st.broken.add(FIX);
    await reconcileTick(p, quiet);
    expect(store.deploysOf("demo", FIX)).toMatchObject([{ by: "reconcile", status: "build_failed" }]);
    expect(store.lastDeploy("demo")?.status).toBe("build_failed");
    st.broken.delete(FIX);
    await reconcileTick(p, quiet);
    expect(store.lastDeploy("demo")).toMatchObject({ sha: FIX, by: "auto-deploy", status: "healthy" });
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
});

describe("incident webhook", () => {
  it("counts as delivered only when Paperclip made the routine run a task, so a refused one is fired again next tick", () => {
    expect(fireReached(202, { status: "issue_created", linkedIssueId: "i1" })).toBe(true);
    expect(fireReached(202, { status: "coalesced", linkedIssueId: "i0" })).toBe(true);
    // Paperclip answers 202 with a failed run when the DevOps Engineer can't be invoked: no task was made.
    expect(fireReached(202, { status: "failed", linkedIssueId: null, failureReason: "Agent is not invokable in its current state" })).toBe(false);
    expect(fireReached(202, { status: "ignored", linkedIssueId: null })).toBe(false);
    expect(fireReached(409, undefined)).toBe(false); // the routine is paused: fired again once it is resumed
    expect(fireReached(500, undefined)).toBe(false);
  });
});
