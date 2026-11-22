import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createPlatform } from "../src/platform.js";
import { buildServer } from "../src/mcp.js";
import { previewApp } from "../src/previews.js";
import type { TlsCheck } from "../src/doors.js";
import { isSensitive, parseApp } from "../src/registry.js";

// The status row is what the board's grader reads for "deployed at the merged commit": it carries the running commit, who
// deployed it and the recent deploy history, so a reader can tell the platform's own auto-deploy from a hand deploy.
describe("status row", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "status-"));
    const registryPath = join(dir, "apps.yaml");
    writeFileSync(registryPath, "apps:\n  - { name: notes, repo: example-org/notes, owner: a, description: d }\n");
    const p = createPlatform(
      { registryPath, modulesRegistryPath: join(dir, "apps.modules.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "missing.pem"), identityKeysHostFile: join(dir, "keys.json"), dbPath: join(dir, "state.sqlite"), urlBase: "", edgeDir: dir, healthImage: "none", git: { appsData: dir, gitDir: dir } },
      { warn: () => {}, info: () => {} },
    );
    return p;
  };

  it("carries the running commit, who deployed it and the recent deploys", async () => {
    const p = setup();
    expect((await p.status(p.find("notes"))).deploys).toEqual([]);
    p.store.addDeploy({ app: "notes", sha: "a".repeat(40), images_json: "[]", by: "reconcile", at: 1, status: "healthy", detail: "" });
    p.store.addDeploy({ app: "notes", sha: "b".repeat(40), images_json: "[]", by: "auto-deploy", at: 2, status: "healthy", detail: "" });
    const row = await p.status(p.find("notes"));
    expect(row).toMatchObject({ name: "notes", repo: "example-org/notes", owner: "a", sha: "b".repeat(40), deployed_by: "auto-deploy", auto_deploy: true });
    expect(row.deploys?.map((d) => [d.sha.slice(0, 1), d.by, d.status])).toEqual([
      ["b", "auto-deploy", "healthy"],
      ["a", "reconcile", "healthy"],
    ]);
  });

  // The row's list is bounded, so the grader looks a merge commit up by exact sha: that read is over every deploy the app
  // ever had, not the newest few, or a merge that deployed would stop being provable once later deploys pushed it out.
  it("looks one exact commit's deploys up over the whole table, past the row's bounded list", async () => {
    const p = setup();
    const old = "c".repeat(40);
    p.store.addDeploy({ app: "notes", sha: old, images_json: "[]", by: "auto-deploy", at: 1, status: "healthy", detail: "" });
    for (let i = 0; i < 10; i++) p.store.addDeploy({ app: "notes", sha: `${i}`.repeat(40), images_json: "[]", by: "auto-deploy", at: 100 + i, status: i === 9 ? "failed" : "healthy", detail: "" });
    expect(p.store.recentDeploys("notes", 20).some((d) => d.sha === old)).toBe(true);
    expect(p.store.recentDeploys("notes").map((d) => d.sha)).not.toContain(old);
    expect(p.store.deploysOf("notes", old).map((d) => [d.sha.slice(0, 1), d.by, d.status])).toEqual([["c", "auto-deploy", "healthy"]]);
    // A commit that was never deployed has no row at all: the reader can tell that from aged-out.
    expect(p.store.deploysOf("notes", "f".repeat(40))).toEqual([]);
  });
});

// A panel is an app pinned into the board's nav: the status row carries its label and the app's own URL (the gate's host
// for a shared app), which is all the board needs to link to it. Pinning is sensitive, so an agent proposes it as a card.
describe("panel", () => {
  it("reaches the board through the status row with the shared app's URL, and only an apply may set it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panel-"));
    const registryPath = join(dir, "apps.yaml");
    writeFileSync(registryPath, "apps:\n  - { name: reading, repo: example-org/reading, owner: a, description: d, port: 4100, panel: Reading list, share: { host: reading.example.com, aud: aud-reading-1 } }\n");
    const p = createPlatform(
      { registryPath, modulesRegistryPath: join(dir, "apps.modules.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "missing.pem"), identityKeysHostFile: join(dir, "keys.json"), dbPath: join(dir, "state.sqlite"), urlBase: "", edgeDir: dir, healthImage: "none", git: { appsData: dir, gitDir: dir } },
      { warn: () => {}, info: () => {} },
    );
    expect(await p.status(p.find("reading"))).toMatchObject({ panel: "Reading list", url: "https://reading.example.com" });
    const plain = { name: "notes", repo: "example-org/notes", owner: "a", description: "d" };
    expect(isSensitive(parseApp({ ...plain, panel: "Notes" }), [])).toBe(true);
    expect(() => parseApp({ ...plain, panel: "<script>" })).toThrow(/panel label/);
    expect(() => parseApp({ ...plain, panel: "approvals" })).toThrow(/board's own tabs/);
  });

  // Without the apps' tailnet node an app requires a signed identity and no browser door mints one, so it gets no URL (a
  // loopback link would only be refused), and previews.ts makes no preview; with the node, both open on it.
  it("gives an app and its previews the apps node's URL only when the node is the instance's door", async () => {
    const dir = mkdtempSync(join(tmpdir(), "status-"));
    const registryPath = join(dir, "apps.yaml");
    writeFileSync(registryPath, "apps:\n  - { name: notes, repo: local/notes, owner: a, description: d, port: 8123 }\n");
    const make = (urlBase: string, node: string) => {
      writeFileSync(join(dir, "apps-node"), node);
      return createPlatform(
        { registryPath, modulesRegistryPath: join(dir, "apps.modules.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "missing.pem"), identityKeysHostFile: join(dir, "keys.json"), dbPath: join(dir, "state.sqlite"), urlBase, appsNodeFile: join(dir, "apps-node"), edgeDir: dir, healthImage: "none", git: { appsData: dir, gitDir: dir } },
        { warn: () => {}, info: () => {} },
      );
    };
    const local = make("", "none\n");
    expect(await local.status(local.find("notes"))).toMatchObject({ url: undefined, unpublished: expect.stringMatching(/No browser door/) });
    expect(local.previewUrl(previewApp(local.find("notes")!, 3, 39100))).toBeUndefined();
    const tailnet = make("https://acme-apps.example.ts.net", "tailnet\n");
    expect(await tailnet.status(tailnet.find("notes"))).toMatchObject({ url: "https://acme-apps.example.ts.net:8123" });
    expect(await tailnet.status(tailnet.find("notes"))).not.toHaveProperty("unpublished");
    expect(tailnet.previewUrl(previewApp(tailnet.find("notes")!, 3, 39100))).toBe("https://acme-apps.example.ts.net:39100");
  });
});

// Doors (src/doors.ts; docs/design/app-doors.md): without the node, the gate serves each exposed app at <app>.<base> to
// admins. The row links it only once the door opens: the app is served (once healthy) and, on a public install, its
// certificate verifies; otherwise it says why. The doors file the gate reads holds exactly the served apps.
describe("doors", () => {
  const make = (gate: object | undefined, tls: TlsCheck = async () => false) => {
    const dir = mkdtempSync(join(tmpdir(), "doors-"));
    const registryPath = join(dir, "apps.yaml");
    writeFileSync(registryPath, "apps:\n  - { name: notes, repo: local/notes, owner: a, description: d, port: 8123 }\n  - { name: quiet, repo: local/quiet, owner: a, description: d, port: 8124, expose: false }\n");
    writeFileSync(join(dir, "apps-node"), "none\n");
    if (gate) writeFileSync(join(dir, "gate.json"), JSON.stringify(gate));
    const p = createPlatform(
      { registryPath, modulesRegistryPath: join(dir, "apps.modules.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "missing.pem"), identityKeysHostFile: join(dir, "keys.json"), dbPath: join(dir, "state.sqlite"), urlBase: "", appsNodeFile: join(dir, "apps-node"), gateFile: join(dir, "gate.json"), doorsFile: join(dir, "doors.json"), edgeDir: dir, healthImage: "none", git: { appsData: dir, gitDir: dir }, tlsCheck: tls },
      { warn: () => {}, info: () => {} },
    );
    return { p, dir };
  };
  const healthy = (p: ReturnType<typeof createPlatform>, app: string) => p.store.addDeploy({ app, sha: "a".repeat(40), images_json: "[]", by: "auto-deploy", at: 1, status: "healthy", detail: "" });

  it("local: http://<app>.localhost:3130 once the app is served; the doors file names only served, exposed apps", async () => {
    const { p, dir } = make({ doors: { base: "localhost", file: "/previews/doors.json", signin: "http://127.0.0.1:3120" }, origin: { scheme: "http", port: 3130 } });
    expect(await p.status(p.find("notes"))).toMatchObject({ url: undefined, unpublished: expect.stringMatching(/deployed healthy/) });
    healthy(p, "notes");
    healthy(p, "quiet");
    const row = await p.status(p.find("notes"));
    expect(row).toMatchObject({ url: "http://notes.localhost:3130" });
    expect(row).not.toHaveProperty("unpublished");
    expect((await p.status(p.find("quiet"))).url).toBeUndefined();
    await p.syncEdge().catch(() => {}); // the apps node isn't there; the doors file is written first
    expect(JSON.parse(readFileSync(join(dir, "doors.json"), "utf8"))).toEqual({ notes: 8123 });
  });

  it("public: the sslip.io URL only after a verified handshake for that name; until then, why", async () => {
    const asked: string[][] = [];
    let ok = false;
    const { p } = make({ doors: { base: "203-0-113-7.sslip.io", file: "/previews/doors.json", signin: "https://203.0.113.7:8446" } }, async (host: string, ip: string) => (asked.push([host, ip]), ok));
    healthy(p, "notes");
    expect(await p.status(p.find("notes"))).toMatchObject({ url: undefined, unpublished: expect.stringMatching(/certificate.*Ask Aiden/) });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked[0]).toEqual(["notes.203-0-113-7.sslip.io", "203.0.113.7"]);
    ok = true; // a failed check is retried only after a while: a fresh platform stands in for the wait
    const later = make({ doors: { base: "203-0-113-7.sslip.io", file: "/previews/doors.json", signin: "https://203.0.113.7:8446" } }, async () => true).p;
    healthy(later, "notes");
    await later.status(later.find("notes"));
    await new Promise((r) => setTimeout(r, 0));
    expect(await later.status(later.find("notes"))).toMatchObject({ url: "https://notes.203-0-113-7.sslip.io" });
  });
});

// A preview that can't stay up says why: app_status carries the reason a failed preview recorded, and a healthy one
// carries no reason key at all.
describe("app_status previews", () => {
  const make = () => {
    const dir = mkdtempSync(join(tmpdir(), "previews-status-"));
    const registryPath = join(dir, "apps.yaml");
    writeFileSync(registryPath, "apps:\n  - { name: notes, repo: local/notes, owner: a, description: d, port: 8123 }\n");
    const p = createPlatform(
      { registryPath, modulesRegistryPath: join(dir, "apps.modules.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "missing.pem"), identityKeysHostFile: join(dir, "keys.json"), dbPath: join(dir, "state.sqlite"), urlBase: "", edgeDir: dir, healthImage: "none", git: { appsData: dir, gitDir: dir } },
      { warn: () => {}, info: () => {} },
    );
    return p;
  };
  const callStatus = async (p: ReturnType<typeof createPlatform>) => {
    const server = buildServer(p, { id: "id", key: "reader", name: "reader", roles: [] }, { dir: "", pushUrl: "" }, async () => {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const r = (await client.callTool({ name: "app_status", arguments: { name: "notes" } })) as { content: { text: string }[] };
    await client.close();
    return JSON.parse(r.content[0]!.text) as { previews: Record<string, unknown>[] };
  };

  it("a failed preview's reason reaches the payload; a healthy one carries no reason key", async () => {
    const p = make();
    p.store.putPreview({ name: "notes-pr-4", app: "notes", pr: 4, port: 39100, sha: "a".repeat(40), status: "failed", at: 1, comment_id: 104, reason: "its build failed: exit 1" });
    p.store.putPreview({ name: "notes-pr-5", app: "notes", pr: 5, port: 39101, sha: "b".repeat(40), status: "healthy", at: 2, comment_id: 105, reason: null });
    const { previews } = await callStatus(p);
    expect(previews).toEqual([
      { pr: 4, sha: "a".repeat(40), state: "failed", url: undefined, reason: "its build failed: exit 1" },
      { pr: 5, sha: "b".repeat(40), state: "healthy", url: undefined },
    ]);
    expect(previews[1]).not.toHaveProperty("reason");
  });

  it("the cached row /internal/status serves carries no preview reason", async () => {
    const p = make();
    p.store.putPreview({ name: "notes-pr-4", app: "notes", pr: 4, port: 39100, sha: "a".repeat(40), status: "failed", at: 1, comment_id: 104, reason: "its build failed: exit 1" });
    await p.refresh(p.find("notes"));
    const cached = p.cached(p.find("notes")) as { previews: Record<string, unknown>[] };
    expect(cached.previews).toEqual([{ pr: 4, sha: "a".repeat(40), state: "failed", url: undefined }]);
    expect(cached.previews[0]).not.toHaveProperty("reason");
    // The authorized app_status call still carries it.
    expect((await callStatus(p)).previews[0]).toMatchObject({ reason: "its build failed: exit 1" });
  });
});
