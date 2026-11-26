import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createEngine, type Deps, STOPPED_OPEN, STOPPED_UNCONFIRMED, TEARDOWN_FAILED } from "../src/deploy.js";
import { NO_SIGN_IN, judgePage, probeResult } from "../src/checks.js";
import { previewApp } from "../src/previews.js";
import { parseApp } from "../src/registry.js";
import { openStore } from "../src/store.js";

const app = (o: object = {}) => parseApp({ name: "demo", repo: "example-org/x", owner: "a", description: "d", ...o });

// Fake docker: `config` returns a minimal compose file, `up` marks the checked-out sha as running. Health is true for "good" shas.
function setup(good: string[], check?: Deps["check"], identity?: Deps["identity"]) {
  const st = { out: "", running: "", downFails: false, broken: new Set<string>(), exposed: 0, deployed: [] as { app: string; id: number; sha: string }[] };
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
    expose: async () => void st.exposed++,
    deployed: async (a, e) => void st.deployed.push({ app: a.name, ...e }),
    now: () => t.now,
    sleep: async (ms) => void (t.now += ms),
  });
  return { engine, st, store };
}

describe("deploy engine", () => {
  it("rolls back a bad deploy to the previous sha", async () => {
    const { engine, st } = setup(["v1"]);
    await engine.deploy(app(), { sha: "v1", by: "t" });
    expect(await engine.deploy(app(), { sha: "v2", by: "t" })).toMatchObject({ sha: "v2", status: "rolled_back", previous: "v1" });
    expect(st.running).toBe("v1");
  });
  it("a healthy deploy says app.deployed once per deploy row; a rolled-back one, a rollback and a redeploy's retry don't double it", async () => {
    const { engine, st } = setup(["v1", "v3"]);
    await engine.deploy(app(), { sha: "v1", by: "t" });
    await engine.deploy(app(), { sha: "v2", by: "t" }); // rolled back: no event, nor for its auto-rollback
    await engine.deploy(app(), { sha: "v3", by: "t" });
    await engine.rollback(app(), { by: "t" });
    await engine.deploy(app(), { sha: "v3", by: "t" }); // the same sha again: its own row, its own event
    expect(st.deployed.map((e) => e.sha)).toEqual(["v1", "v3", "v3"]);
    expect(new Set(st.deployed.map((e) => e.id)).size).toBe(3);
  });
  it("a healthy deploy that answers without the platform's sign-in is rolled back, and says so; a probe that can't run fails too", async () => {
    let st!: { running: string };
    const r0 = setup(["v1", "v2", "v3"], undefined, async () => {
      if (st.running === "v3") throw new Error("docker trouble");
      return probeResult("identity", "/", st.running === "v2" ? [{ hard: true, verdict: "open", what: NO_SIGN_IN }] : []);
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
    const r0 = setup(["v1", "v2"], undefined, async () => probeResult("identity", "/", open ? [{ hard: true, verdict: "open", what: NO_SIGN_IN }] : []));
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    open = true; // v1 predates the gate: it answers without sign-in now
    const synced = r0.st.exposed;
    const r = await r0.engine.rollback(app(), { by: "t" });
    expect(r).toMatchObject({ sha: "v1", status: "failed", stopped: STOPPED_OPEN });
    // The stop is confirmed, so nothing runs: the app is not published, and the edge is re-read now rather than on a tick.
    expect(r0.store.publishable("demo")).toBe(false);
    expect(r0.st.exposed).toBe(synced + 1);
    await expect(r0.engine.rollback(app(), { by: "t" })).rejects.toThrow(/no previous good deploy/);
  });
  it("a rollback target whose down failed stays healthy history and says the teardown failed", async () => {
    let open = false;
    const r0 = setup(["v1", "v2"], undefined, async () => probeResult("identity", "/", open ? [{ hard: true, verdict: "open", what: NO_SIGN_IN }] : []));
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    open = true; // v1 predates the gate: it answers without sign-in now
    r0.st.downFails = true;
    const synced = r0.st.exposed;
    const r = await r0.engine.rollback(app(), { by: "t" });
    expect(r).toMatchObject({ sha: "v1", status: "failed", stopped: `${STOPPED_OPEN}; ${TEARDOWN_FAILED}` });
    expect(r0.store.goodDeploys("demo").find((g) => g.sha === "v1")?.status).toBe("healthy");
    expect(r0.store.goodDeploys("demo").find((g) => g.sha === "v1")?.disqualified).toBe(1); // found open: never a target again
    expect(r0.store.running("demo")).toBe("v1"); // the failed down may still be serving it
    // A failed down may leave v1 serving, and v2's healthy row proves nothing about what is up: the route is withdrawn,
    // whatever else is in the history, until a deploy records healthy again.
    expect(r0.store.publishable("demo")).toBe(false);
    expect(r0.store.withheld("demo")).toBe(TEARDOWN_FAILED);
    expect(r0.st.exposed).toBe(synced + 1); // the deploy asked the edge to sync right away
    // A later healthy deploy proves what is up and serves again.
    r0.st.downFails = false;
    open = false;
    await r0.engine.deploy(app(), { sha: "v3", by: "t" });
    expect(r0.store.withheld("demo")).toBeUndefined();
    expect(r0.store.publishable("demo")).toBe(true);
  });
  it("a healthy deploy that lifts a teardown hold republishes the app in the same call", async () => {
    const { engine, st, store } = setup(["v1", "v2"]);
    await engine.deploy(app(), { sha: "v1", by: "t" });
    store.withhold("demo", TEARDOWN_FAILED, 1); // a failed teardown left what is up unproven
    expect(store.publishable("demo")).toBe(false);
    expect(store.unwithhold("demo")).toBe(true); // a hold was there, so the caller re-reads the edge
    expect(store.unwithhold("demo")).toBe(false); // nothing left to lift, so no further sync is claimed
    store.withhold("demo", TEARDOWN_FAILED, 2);
    const synced = st.exposed;
    await engine.deploy(app(), { sha: "v2", by: "t" }); // healthy: the proof of what is up
    expect(store.withheld("demo")).toBeUndefined();
    expect(st.exposed).toBeGreaterThanOrEqual(synced + 1); // the edge was re-read when the hold lifted
    expect(store.publishable("demo")).toBe(true);
  });
  it("a target found open with a failed down is not re-admitted by a later health-only rollback", async () => {
    let open = false;
    let st!: { running: string };
    const r0 = setup(["v1", "v2"], undefined, async () => {
      return probeResult("identity", "/", open && st.running === "v1" ? [{ hard: true, verdict: "open", what: NO_SIGN_IN }] : []);
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
  it("a probe that cannot run leaves the healthy rollback target serving, and the next attempt re-probes it", async () => {
    let armed = false;
    let unconfirmed = true;
    let st!: { running: string };
    // A probe that never got an answer (a timeout, no route to the container): a platform fault, not a finding about the app.
    const unconfirmedId = () => probeResult("identity", "/", [{ hard: true, verdict: "unconfirmed", what: "couldn't confirm the app refuses requests without the platform's sign-in: GET / got no answer" }]);
    const r0 = setup(["v1", "v2", "v3"], undefined, async () => {
      if (!armed) return probeResult("identity", "/", []); // v1's own deploy
      if (st.running === "v1") return unconfirmed ? unconfirmedId() : probeResult("identity", "/", []); // the rollback target, before and after its probe recovers
      return probeResult("identity", "/", [{ hard: true, verdict: "open", what: NO_SIGN_IN }]); // v2 and v3 are refused
    });
    st = r0.st;
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    armed = true;
    const r = await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    expect(r.status).toBe("failed");
    expect(r.stopped).toBeUndefined(); // nothing that passed health is torn down for a probe that could not run
    expect(r.previous).toBeUndefined();
    expect(r0.store.running("demo")).toBe("v1"); // the target is still the running revision
    expect(r0.store.recentDeploys("demo").filter((d) => d.by === "auto-rollback")).toHaveLength(0); // never recorded healthy
    const target = r0.store.goodDeploys("demo").find((g) => g.sha === "v1");
    expect(target?.status).toBe("healthy");
    expect(target?.disqualified).toBeFalsy(); // a probe that couldn't run proves nothing about the target
    // The probe recovers: another refused commit rolls back to the same target, probed again and accepted this time.
    unconfirmed = false;
    expect(await r0.engine.deploy(app(), { sha: "v3", by: "t" })).toMatchObject({ sha: "v3", status: "rolled_back", previous: "v1" });
  });
  it("a hard identity finding with no verdict is not accepted as a healthy rollback", async () => {
    let armed = false;
    let st!: { running: string };
    // identityPorts' own failures (a required port with no HTTP answer, an unreadable process) carry no verdict; they prove
    // nothing about the target, so they may never let it be recorded healthy.
    const noVerdict = () => probeResult("identity", "app:8080", [{ hard: true, what: "couldn't confirm the app refuses requests without the platform's sign-in: app:8080 on 127.0.0.1: couldn't confirm: no HTTP answer (silent)" }]);
    const r0 = setup(["v1", "v2"], undefined, async () => {
      if (!armed) return probeResult("identity", "/", []); // v1's own deploy
      if (st.running === "v1") return noVerdict(); // the rollback target cannot be probed
      return probeResult("identity", "/", [{ hard: true, verdict: "open", what: NO_SIGN_IN }]);
    });
    st = r0.st;
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    armed = true;
    const r = await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    expect(r).toMatchObject({ sha: "v2", status: "failed" });
    expect(r0.store.recentDeploys("demo").filter((d) => d.by === "auto-rollback")).toHaveLength(0); // never recorded healthy
    expect(r0.store.running("demo")).toBe("v1"); // left running (a platform fault), for the next attempt to probe
  });
  it("a rollback target that answers only errors is stopped, disqualified, and its route withdrawn at once", async () => {
    let armed = false;
    let st!: { running: string };
    // A 404/500 on every identity probe shows nothing about whether the app checks identity, but the target is not safe to serve.
    const erroredId = () => probeResult("identity", "/", [{ hard: true, verdict: "errored", what: "couldn't confirm the app refuses requests without the platform's sign-in: every request without a valid identity errored" }]);
    const r0 = setup(["v1", "v2"], undefined, async () => {
      if (!armed) return probeResult("identity", "/", []); // v1's own deploy
      if (st.running === "v1") return erroredId(); // the rollback target cannot be confirmed
      return probeResult("identity", "/", [{ hard: true, verdict: "open", what: NO_SIGN_IN }]); // v2 is refused
    });
    st = r0.st;
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    armed = true;
    r0.st.downFails = true;
    const synced = r0.st.exposed;
    const r = await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    expect(r).toMatchObject({ status: "failed", stopped: `${STOPPED_UNCONFIRMED}; ${TEARDOWN_FAILED}` });
    expect(r0.store.publishable("demo")).toBe(false); // nothing unverified stays routed
    expect(r0.store.goodDeploys("demo").find((g) => g.sha === "v1")?.disqualified).toBe(1); // never a target again
    expect(r0.st.exposed).toBe(synced + 1); // the edge was re-read at once, not left to the next reconcile tick
  });
  it("a rollback target that answers only errors is never chosen again by a later deploy or rollback", async () => {
    let armed = false;
    let st!: { running: string };
    const erroredId = () => probeResult("identity", "/", [{ hard: true, verdict: "errored", what: "couldn't confirm the app refuses requests without the platform's sign-in: every request without a valid identity errored" }]);
    const r0 = setup(["v1", "v2", "v3"], undefined, async () => {
      if (!armed) return probeResult("identity", "/", []); // v1's own deploy
      if (st.running === "v1") return erroredId(); // v1 answers every identity probe with an error
      return probeResult("identity", "/", [{ hard: true, verdict: "open", what: NO_SIGN_IN }]);
    });
    st = r0.st;
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    armed = true;
    expect(await r0.engine.deploy(app(), { sha: "v2", by: "t" })).toMatchObject({ sha: "v2", status: "failed", stopped: STOPPED_UNCONFIRMED });
    // A confirmed stop puts v1 in the rolled_back history, so neither usableGood() nor rollbackTarget() can pick it again.
    expect(r0.store.recentDeploys("demo", 10).find((g) => g.sha === "v1")).toMatchObject({ status: "rolled_back", detail: expect.stringContaining(STOPPED_UNCONFIRMED) });
    // The next refused commit has no other good deploy to return to: nothing is started, and no stop/start cycle begins.
    const again = await r0.engine.deploy(app(), { sha: "v3", by: "t" });
    expect(again).toMatchObject({ sha: "v3", status: "failed" });
    expect(again.stopped).toBeUndefined(); // no target was started, so none was stopped either
    expect(r0.store.running("demo")).toBeUndefined();
    expect(r0.store.recentDeploys("demo", 20).filter((d) => d.sha === "v1" && d.by === "auto-rollback")).toHaveLength(0); // v1 was never re-applied
  });
  it("an unconfirmed identity check on a manual rollback target fails that attempt, and a later one re-probes it", async () => {
    let id = 0;
    let unconfirmed = true;
    // The probe throws, so the platform cannot say anything about the target either way: it stays up and is probed again.
    const r0 = setup(["v1", "v2"], undefined, async () => {
      if (++id >= 3 && unconfirmed) throw new Error("docker exec timed out");
      return probeResult("identity", "/", []);
    });
    await r0.engine.deploy(app(), { sha: "v1", by: "t" });
    await r0.engine.deploy(app(), { sha: "v2", by: "t" });
    const r = await r0.engine.rollback(app(), { by: "t" });
    expect(r.status).toBe("failed");
    expect(r.stopped).toBeUndefined(); // nothing that passed health is torn down for a probe that could not run
    expect(r0.store.running("demo")).toBe("v1"); // left serving, for the next attempt to probe
    expect(r0.store.goodDeploys("demo").find((g) => g.sha === "v1")?.disqualified).toBeFalsy();
    unconfirmed = false;
    expect(await r0.engine.rollback(app(), { by: "t" })).toMatchObject({ sha: "v1", status: "healthy" });
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

  it("records the no-HTTP verdict only for a healthy deploy whose own identity probe proved it", async () => {
    // The verdict is the deploy's, not the shape's: the identity check's own `noHttpProven` field is the only source, and
    // only a healthy row keeps it, so a probe that never ran (or a build that never came up) leaves it absent.
    const proven = setup(["v1"], undefined, async () => ({ ...probeResult("identity", "app:5433", [{ hard: false, what: "app:5433 on 127.0.0.1: not probed: not HTTP, not TLS" }]), noHttpProven: true }));
    await proven.engine.deploy(app({ stateful: true, expose: false, port: 5433, health: {} }), { sha: "v1", by: "t", allowStateful: true });
    expect(proven.store.deploysOf("demo", "v1")[0]?.no_http_proven).toBe(1);
    const unproven = setup(["v1"], undefined, async () => probeResult("identity", "app:5433", [{ hard: false, what: "app:5433 on 127.0.0.1: not probed: not HTTP, not TLS" }]));
    await unproven.engine.deploy(app({ stateful: true, expose: false, port: 5433, health: {} }), { sha: "v1", by: "t", allowStateful: true });
    expect(unproven.store.deploysOf("demo", "v1")[0]?.no_http_proven).toBeFalsy();
    // A deploy that never came up has no probe of what is up, so its row never carries the verdict.
    const failed = setup(["v1"], undefined, async () => ({ ...probeResult("identity", "app:5433", []), noHttpProven: true }));
    await failed.engine.deploy(app(), { sha: "v1", by: "t" });
    await failed.engine.deploy(app(), { sha: "v2", by: "t" });
    expect(failed.store.deploysOf("demo", "v2")[0]?.status).toBe("rolled_back");
    expect(failed.store.deploysOf("demo", "v2")[0]?.no_http_proven).toBeFalsy();
  });
  it("refuses a stateful app without approval", async () => {
    const { engine } = setup(["v1"]);
    await expect(engine.deploy(app({ stateful: true }), { sha: "v1", by: "t" })).rejects.toThrow(/stateful/);
  });
});

// The health finding and the deploy record name the probe's failure class, and app_check reports its own probe: a live
// failure in milliseconds must not read like a deploy's grace wait.