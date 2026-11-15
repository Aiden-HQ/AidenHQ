import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createEngine } from "../src/deploy.js";
import { healthTick, WATCH_MS } from "../src/loops.js";
import type { Platform } from "../src/platform.js";
import { parseApp } from "../src/registry.js";
import { openStore } from "../src/store.js";

const app = parseApp({ name: "demo", repo: "example-org/x", owner: "a", description: "d" });
const quiet = { warn: () => {} };

// The real engine and store on a fake docker (as in deploy.test.ts): `up` runs the checked-out sha; `good` decides health.
function setup() {
  const st = { out: "", running: "", good: new Set<string>() };
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
    apps: () => [app],
    probe: async () => st.good.has(st.running),
    notifyPending: async () => {},
    refresh: async () => {},
    raise: async (name: string, kind: string, detail: string) => {
      if (store.openIncident(name)) return;
      store.addIncident(name, kind, detail);
      raised.push({ kind, detail });
    },
  } as unknown as Platform;
  // v1 deployed long ago; v2 auto-deployed `ago` ms before now, healthy at the time.
  const deployed = async (ago: number) => {
    st.good.add("v1").add("v2");
    t.now = Date.now() - 2 * WATCH_MS;
    await engine.deploy(app, { sha: "v1", by: "reconcile" });
    t.now = Date.now() - ago;
    await engine.deploy(app, { sha: "v2", by: "auto-deploy" });
  };
  return { p, st, store, engine, raised, deployed };
}

describe("post-deploy watch", () => {
  it("rolls a healthy auto-deploy that fails within the window back once, then raises what it did", async () => {
    const { p, st, store, engine, raised, deployed } = setup();
    await deployed(5 * 60_000);
    st.good.delete("v2"); // v2 starts failing its health check
    await healthTick(p, quiet);
    expect(st.running).toBe("v1");
    expect(store.lastDeploy("demo")).toMatchObject({ sha: "v1", by: "watch-rollback", status: "healthy" });
    expect(store.recentDeploys("demo").find((d) => d.sha === "v2")?.status).toBe("rolled_back");
    expect(raised).toEqual([{ kind: "rolled_back", detail: expect.stringMatching(/^v2: health check failing 5 min after its auto-deploy; rolled back to v1/) }]);
    // The next tick finds v1 healthy: the rolled_back incident stays open for the fix, and nothing is rolled back again.
    await healthTick(p, quiet);
    expect(store.openIncident("demo")?.kind).toBe("rolled_back");
    expect(store.recentDeploys("demo")).toHaveLength(3);
    // The bad commit is never a rollback target again.
    await expect(engine.rollback(app, { by: "t" })).rejects.toThrow(/no previous good deploy/);
  });

  it("after the window, or when the rollback target fails too, raises the outage without retrying", async () => {
    const late = setup();
    await late.deployed(WATCH_MS + 60_000);
    late.st.good.delete("v2");
    await healthTick(late.p, quiet);
    expect(late.st.running).toBe("v2");
    expect(late.raised.map((r) => r.kind)).toEqual(["unhealthy"]);

    const both = setup();
    await both.deployed(5 * 60_000);
    both.st.good.clear();
    await healthTick(both.p, quiet);
    expect(both.raised).toEqual([{ kind: "unhealthy", detail: expect.stringMatching(/rollback to v1 also unhealthy$/) }]);
    await healthTick(both.p, quiet);
    expect(both.store.recentDeploys("demo")).toHaveLength(3); // one rollback, no loop
  });
});
