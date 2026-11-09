import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createEngine } from "../src/deploy.js";
import { parseApp } from "../src/registry.js";
import { openStore } from "../src/store.js";

const app = (o: object = {}) => parseApp({ name: "demo", repo: "example-org/x", owner: "a", description: "d", ...o });

// Fake docker: `config` returns a minimal compose file, `up` marks the checked-out sha as running. Health is true for "good" shas.
function setup(good: string[]) {
  const st = { out: "", running: "" };
  const t = { now: 0 };
  const src = mkdtempSync(`${tmpdir()}/src-`);
  writeFileSync(`${src}/compose.yaml`, "services:\n  web:\n    image: x\n");
  const engine = createEngine({
    store: openStore(":memory:"),
    appsData: mkdtempSync(`${tmpdir()}/apps-`),
    secretsDir: "/none",
    hostSecretsDir: "/none",
    exec: async (args) => {
      if (args.includes("config")) return '{"services":{"web":{"image":"x"}}}';
      if (args.includes("up")) st.running = st.out;
      return "";
    },
    checkout: async (_a, sha) => ((st.out = sha ?? "newsha"), { sha: st.out, dir: src }),
    probe: async () => good.includes(st.running),
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
  it("a first deploy that never gets healthy is stopped, not looped", async () => {
    const { engine } = setup([]);
    expect((await engine.deploy(app(), { sha: "v1", by: "t" })).status).toBe("failed");
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
});
