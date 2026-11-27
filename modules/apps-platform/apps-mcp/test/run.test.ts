import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { createEngine } from "../src/deploy.js";
import { parseApp } from "../src/registry.js";
import { assertOwner, runArgv, scriptCommand } from "../src/run.js";
import { openStore } from "../src/store.js";

const app = parseApp({ name: "demo", repo: "example-org/x", owner: "app-maintainer", description: "d" });
const pkg = JSON.stringify({ scripts: { "seed:backfill": "node dist/scripts/seed-backfill.js", migrate: "node dist/scripts/migrate.js" } });

describe("app_run validation", () => {
  it("runs only a script the app's package.json declares, by a plain name", () => {
    expect(scriptCommand(pkg, "seed:backfill")).toBe("node dist/scripts/seed-backfill.js");
    expect(() => scriptCommand(pkg, "seed")).toThrow(/no script "seed"/);
    for (const bad of ["-v", "x; rm -rf /", "Seed", "a b", "$(id)", ""]) expect(() => scriptCommand(pkg, bad)).toThrow(/bad script name/);
    expect(() => scriptCommand(undefined, "migrate")).toThrow(/no package.json/);
  });
  it("only the app's owner may ask", () => {
    expect(() => assertOwner(app, "app-maintainer")).not.toThrow();
    expect(() => assertOwner(app, "chief-of-staff")).toThrow(/only demo's owner/);
  });
  it("execs argv, never a shell string", () => {
    expect(runArgv("app", "seed:backfill", 600_000)).toEqual(["exec", "-T", "-e", "npm_config_cache=/tmp/.npm", "-e", "npm_config_update_notifier=false", "app", "timeout", "-k", "10", "600", "npm", "run", "seed:backfill"]);
    expect(() => runArgv("app", "x;id", 1000)).toThrow();
  });
});

describe("engine.run", () => {
  it("runs npm run <script> in the deployed service with a timeout, and reports a failure with its output", async () => {
    const calls: { args: string[]; o?: { timeout?: number } }[] = [];
    const src = mkdtempSync(`${tmpdir()}/src-`);
    writeFileSync(`${src}/compose.yaml`, "services:\n  app:\n    image: x\n");
    let fail = false;
    const engine = createEngine({
      store: openStore(":memory:"),
      appsData: mkdtempSync(`${tmpdir()}/apps-`),
      secretsDir: "/none",
      hostSecretsDir: "/none",
      identityKeysHostFile: "/none/keys.json", tailnetNode: () => true,
      exec: async (args, o) => {
        calls.push({ args, o });
        if (args.includes("config")) return '{"services":{"app":{"image":"x"}}}';
        if (args.includes("exec") && fail) throw Object.assign(new Error("docker compose -p failed: boom"), { stdout: "partial\n", killed: false });
        return args.includes("exec") ? "seeded 3 rows\n" : "";
      },
      checkout: async () => ({ sha: "v1", dir: src }),
      probe: async () => ({ ok: true, ms: 1 }),
    });
    await engine.deploy(app, { by: "t" });
    expect(await engine.run(app, { script: "seed:backfill", service: "", sha: "v1", timeoutMs: 600_000 })).toEqual({ ok: true, timed_out: false, output: "seeded 3 rows\n" });
    const ex = calls.find((c) => c.args.includes("exec"))!;
    expect(ex.args.slice(-10)).toEqual(["-e", "npm_config_update_notifier=false", "app", "timeout", "-k", "10", "600", "npm", "run", "seed:backfill"]);
    expect(ex.args.slice(0, 3)).toEqual(["compose", "-p", "app-demo"]);
    expect(ex.o?.timeout).toBe(630_000);
    fail = true;
    expect(await engine.run(app, { script: "seed:backfill", service: "app", sha: "v1", timeoutMs: 1000 })).toMatchObject({ ok: false, output: expect.stringContaining("partial") });
    await expect(engine.run(app, { script: "seed:backfill", service: "app", sha: "v0", timeoutMs: 1000 })).rejects.toThrow(/not the approved v0/);
  });
});
