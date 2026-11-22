import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createEngine, type Deps } from "../src/deploy.js";
import { NO_SIGN_IN, probeResult } from "../src/checks.js";
import { parseApp } from "../src/registry.js";
import { openStore } from "../src/store.js";

const app = (o: object = {}) => parseApp({ name: "demo", repo: "example-org/x", owner: "a", description: "d", ...o });

// Fake docker: `config` returns a minimal compose file, `up` marks the checked-out sha as running. Health is true for "good" shas.
function setup(good: string[], check?: Deps["check"], identity?: Deps["identity"]) {
  const st = { out: "", running: "" };
  const t = { now: 0 };
  const src = mkdtempSync(`${tmpdir()}/src-`);
  writeFileSync(`${src}/compose.yaml`, "services:\n  web:\n    image: x\n");
  const engine = createEngine({
    store: openStore(":memory:"),
    appsData: mkdtempSync(`${tmpdir()}/apps-`),
    secretsDir: "/none",
    hostSecretsDir: "/none",
    identityKeysHostFile: "/none/keys.json", tailnetNode: () => true,
    exec: async (args) => {
      if (args.includes("config")) return '{"services":{"web":{"image":"x"}}}';
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
  return { engine, st };
}

describe("deploy engine", () => {
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
  it("a first deploy that never gets healthy is stopped, not looped", async () => {
    const { engine } = setup([]);
    expect((await engine.deploy(app(), { sha: "v1", by: "t" })).status).toBe("failed");
  });
  it("refuses a stateful app without approval", async () => {
    const { engine } = setup(["v1"]);
    await expect(engine.deploy(app({ stateful: true }), { sha: "v1", by: "t" })).rejects.toThrow(/stateful/);
  });
});

// The health finding and the deploy record name the probe's failure class, and app_check reports its own probe: a live
// failure in milliseconds must not read like a deploy's grace wait.