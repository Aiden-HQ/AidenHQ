import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { provisionDatabase } from "../src/database.js";
import { createEngine } from "../src/deploy.js";
import { previewTick, type OpenPr, type PreviewDeps } from "../src/previews.js";
import { parseApp } from "../src/registry.js";
import { openStore } from "../src/store.js";

const REPO = "acme-agents/demo";
const app = parseApp({ name: "demo", repo: REPO, owner: "a", description: "d", port: 8080, health: { url: "http://web:8080/health" }, database: "warehouse", secrets: ["DEMO_DATABASE_URL", "SALT"], api: { callers: ["x"], paths: ["/api"] } });
const sha = (c: string) => c.repeat(40);
const pr = (number: number, o: Partial<OpenPr> = {}): OpenPr => ({ number, sha: sha(String(number % 10)), base: "main", head_repo: REPO, ...o });

// Fake docker (the compose publishes the parent's 8080), the real engine, store, sandbox and database provisioning.
function setup() {
  const t = mkdtempSync(`${tmpdir()}/previews-`);
  const [appsData, secretsDir, gitDir, src] = ["apps", "secrets", "git", "src"].map((d) => (mkdirSync(`${t}/${d}`), `${t}/${d}`)) as [string, string, string, string];
  writeFileSync(`${src}/compose.yaml`, "services:\n  web:\n    image: x\n");
  mkdirSync(`${secretsDir}/demo`);
  writeFileSync(`${secretsDir}/demo/SALT`, "the-live-salt");
  const calls: string[][] = [];
  const sql: string[] = [];
  const dropped: string[] = [];
  const comments: { pr: number; body: string; id?: number | null }[] = [];
  const store = openStore(":memory:");
  const engine = createEngine({
    store, appsData, secretsDir, hostSecretsDir: "/host/secrets", identityKeysHostFile: "/host/keys.json", tailnetNode: () => true,
    exec: async (args) => {
      calls.push(args);
      if (args.includes("config")) return JSON.stringify({ services: { web: { image: "x", ports: [{ mode: "ingress", target: 8080, published: "8080", protocol: "tcp" }] } } });
      if (args[0] === "compose" && args[1] === "ls") return JSON.stringify([{ Name: "app-demo-pr-6" }]);
      return "";
    },
    checkout: async (_a, s) => ({ sha: s!, dir: src }),
    probe: async () => ({ ok: true, ms: 1 }),
    provisionDb: (a) => provisionDatabase(a, { secretsDir, sql: async (q) => void sql.push(q) }),
  });
  let open: OpenPr[] | Error = [];
  const d: PreviewDeps = {
    apps: () => [app], store, engine, secretsDir, gitDir,
    agentsRepo: (r) => r.startsWith("acme-agents/"),
    url: (a) => `https://apps.example.ts.net:${a.port}`,
    syncEdge: async () => undefined,
    dropDb: async (n) => void dropped.push(n),
    github: {
      openPrs: async () => { if (open instanceof Error) throw open; return open; },
      comment: async (_repo, n, body, id) => (comments.push({ pr: n, body, id }), id ?? 100 + n),
    },
    log: { warn: () => undefined, info: () => undefined },
  };
  return { d, engine, store, calls, sql, dropped, comments, appsData, secretsDir, setOpen: (o: OpenPr[] | Error) => void (open = o) };
}

describe("PR previews", () => {
  it("deploys the newest same-repo PRs apart from the live app, and removes a closed one entirely", async () => {
    const s = setup();
    // A fork's PR and one into another branch never get a preview; of the rest, the newest three.
    s.setOpen([pr(7), pr(3), pr(9, { head_repo: "someone/demo" }), pr(4, { base: "dev" }), pr(5), pr(6)]);
    await previewTick(s.d);
    expect(s.store.previews().map((r) => [r.pr, r.status])).toEqual([[5, "healthy"], [6, "healthy"], [7, "healthy"]]);

    const row = s.store.previews().find((r) => r.pr === 7)!;
    expect(row.port).toBeGreaterThanOrEqual(39100);
    const compose = JSON.parse(readFileSync(`${s.appsData}/.platform/demo-pr-7/compose.sandboxed.json`, "utf8"));
    const web = compose.services.web;
    expect(web.ports).toEqual([expect.objectContaining({ published: String(row.port), host_ip: "127.0.0.1" })]); // not the live 8080
    expect(web.environment.AIDENHQ_APP).toBe("demo-pr-7"); // the gate's and apps-mcp's tokens for the live app don't fit it
    expect(Object.keys(compose.networks)).toEqual(["app-demo-pr-7", "c-apps_warehouse"]);
    expect(compose.secrets.DATABASE_URL.file).toBe("/host/secrets/demo-pr-7/DATABASE_URL");
    // Its own warehouse login and schema, under every database URL name the app declared; a placeholder for the rest.
    for (const k of ["DATABASE_URL", "DEMO_DATABASE_URL"]) expect(readFileSync(`${s.secretsDir}/demo-pr-7/${k}`, "utf8")).toMatch(/^postgres:\/\/app_demo_pr_7:/);
    expect(s.sql.join("\n")).not.toMatch(/\bapp_demo\b(?!_pr)/);
    expect(readFileSync(`${s.secretsDir}/demo-pr-7/SALT`, "utf8")).not.toBe("the-live-salt");
    expect(s.comments.find((c) => c.pr === 7)?.body).toContain(`https://apps.example.ts.net:${row.port}`);
    expect(s.store.lastDeploy("demo")).toBeUndefined(); // the live app's deploy history is untouched

    // #7 merges and #8 opens: #7 goes (containers, volumes, images, schema, secrets), #8 comes; a GitHub outage changes nothing.
    s.setOpen([pr(8), pr(5), pr(6)]);
    await previewTick(s.d);
    expect(s.store.previews().map((r) => r.pr)).toEqual([5, 6, 8]);
    expect(s.calls).toContainEqual(expect.arrayContaining(["-p", "app-demo-pr-7", "down", "--volumes", "--rmi", "local"]));
    expect(s.dropped).toEqual(["demo-pr-7"]);
    expect(existsSync(`${s.secretsDir}/demo-pr-7`)).toBe(false);
    expect(existsSync(`${s.appsData}/.platform/demo-pr-7`)).toBe(false);
    expect(s.comments.at(-2)).toMatchObject({ pr: 7, id: 107 }); // its comment edited, not a new one
    s.setOpen(new Error("502"));
    await previewTick(s.d);
    expect(s.store.previews().map((r) => r.pr)).toEqual([5, 6, 8]);
  });

  it("a comment GitHub refused is posted on a later tick, without redeploying", async () => {
    const s = setup();
    const comment = s.d.github.comment;
    s.d.github.comment = async () => { throw new Error("502"); };
    s.setOpen([pr(6)]);
    await previewTick(s.d);
    s.d.github.comment = comment;
    const ups = s.calls.filter((c) => c.includes("up")).length;
    await previewTick(s.d);
    expect(s.comments.map((c) => c.pr)).toEqual([6]);
    expect(s.calls.filter((c) => c.includes("up")).length).toBe(ups);
  });

  it("the deploy loop's reap leaves previews alone", async () => {
    const s = setup();
    s.setOpen([pr(6)]);
    await previewTick(s.d);
    s.calls.length = 0;
    await s.engine.reap(new Set(["demo"]));
    expect(s.calls.some((c) => c.includes("down"))).toBe(false);
  });

  it("the registry keeps preview names and ports for previews", () => {
    expect(() => parseApp({ name: "demo-pr-2", repo: REPO, owner: "a", description: "d" })).toThrow(/previews/);
    expect(() => parseApp({ name: "demo", repo: REPO, owner: "a", description: "d", port: 39150 })).toThrow(/previews/);
  });
});
