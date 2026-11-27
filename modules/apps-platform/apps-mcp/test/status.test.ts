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
import { canaryContent, type CanaryResult } from "../src/canary.js";

// The status row carries the running commit, who
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
        { registryPath, modulesRegistryPath: join(dir, "apps.modules.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "missing.pem"), identityKeysHostFile: join(dir, "keys.json"), dbPath: join(dir, "state.sqlite"), urlBase, appsNodeFile: join(dir, "apps-node"), edgeDir: dir, healthImage: "none", git: { appsData: dir, gitDir: dir }, nodeStatus: async () => ({ BackendState: "Running" }) },
        { warn: () => {}, info: () => {} },
      );
    };
    const local = make("", "none\n");
    expect(await local.status(local.find("notes"))).toMatchObject({ url: undefined, unpublished: expect.stringMatching(/No browser door/) });
    expect(local.previewUrl(previewApp(local.find("notes")!, 3, 39100))).toBeUndefined();
    const tailnet = make("https://acme-apps.example.ts.net", "tailnet\n");
    await tailnet.syncEdge().catch(() => {}); // the node's login state is read first (a stub: Running)
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
  const healthy = (p: ReturnType<typeof createPlatform>, app: string) => {
    p.store.addDeploy({ app, sha: "a".repeat(40), images_json: "[]", by: "auto-deploy", at: 1, status: "healthy", detail: "" });
    p.store.setRunning(app, "a".repeat(40)); // every healthy path (apply, rollback) sets it; a confirmed stop clears it
  };

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

  // A target found answering without sign-in stays a `healthy` row (its `down` failed), but it must not be published or
  // offered as a URL: nothing that failed the identity gate keeps a route.
  it("withdraws the route of an app whose only healthy deploy is disqualified", async () => {
    const { p, dir } = make({ doors: { base: "localhost", file: "/previews/doors.json", signin: "http://127.0.0.1:3120" }, origin: { scheme: "http", port: 3130 } });
    healthy(p, "notes");
    await p.syncEdge().catch(() => {});
    expect(JSON.parse(readFileSync(join(dir, "doors.json"), "utf8"))).toEqual({ notes: 8123 });
    p.store.disqualify(p.store.goodDeploys("notes")[0]!.id, "stopped: answers without the platform's sign-in; teardown failed");
    expect(await p.status(p.find("notes"))).toMatchObject({ url: undefined, unpublished: expect.stringMatching(/deployed healthy/) });
    await p.syncEdge().catch(() => {});
    expect(JSON.parse(readFileSync(join(dir, "doors.json"), "utf8"))).toEqual({});
  });

  // A `down` that failed may leave an unverified revision serving, and another healthy row in the history proves nothing
  // about what is up now: the route stays withdrawn until a deploy is recorded healthy.
  it("withholds the route after a failed teardown, whatever else is in the healthy history", async () => {
    const { p, dir } = make({ doors: { base: "localhost", file: "/previews/doors.json", signin: "http://127.0.0.1:3120" }, origin: { scheme: "http", port: 3130 } });
    healthy(p, "notes");
    p.store.addDeploy({ app: "notes", sha: "b".repeat(40), images_json: "[]", by: "auto-deploy", at: 2, status: "healthy", detail: "" });
    expect(p.store.goodDeploys("notes")).toHaveLength(2);
    p.store.withhold("notes", "teardown failed: it may still be serving");
    expect(await p.status(p.find("notes"))).toMatchObject({ url: undefined, unpublished: expect.stringMatching(/deployed healthy/) });
    await p.syncEdge().catch(() => {});
    expect(JSON.parse(readFileSync(join(dir, "doors.json"), "utf8"))).toEqual({});
    p.store.unwithhold("notes"); // a deploy recorded healthy
    expect(await p.status(p.find("notes"))).toMatchObject({ url: "http://notes.localhost:3130" });
  });

  // A target that was stopped because its identity could not be confirmed is a confirmed stop: nothing runs, so the app
  // must not stay published (the edge would point at a compose project that is gone: 502s, and a route to nothing).
  it("unpublishes an app once its only healthy deploy is disqualified", async () => {
    const { p } = make({ doors: { base: "localhost", file: "/previews/doors.json", signin: "http://127.0.0.1:3120" }, origin: { scheme: "http", port: 3130 } });
    healthy(p, "notes");
    expect(p.store.publishable("notes")).toBe(true);
    p.store.disqualify(p.store.goodDeploys("notes")[0]!.id, "stopped: its identity could not be confirmed");
    expect(p.store.publishable("notes")).toBe(false);
    expect(await p.status(p.find("notes"))).toMatchObject({ url: undefined });
  });

  // The doors file is how the gate decides what the app serves: a withheld app must lose its door even when another
  // app's generated Compose file cannot be read while syncEdge builds the targets.
  it("closes a withheld app's door even when another app's Compose file cannot be read", async () => {
    const { p, dir } = make({ doors: { base: "localhost", file: "/previews/doors.json", signin: "http://127.0.0.1:3120" }, origin: { scheme: "http", port: 3130 } });
    healthy(p, "notes");
    await p.syncEdge().catch(() => {});
    expect(JSON.parse(readFileSync(join(dir, "doors.json"), "utf8"))).toEqual({ notes: 8123 });
    p.store.withhold("notes", "teardown failed: it may still be serving");
    // A second publishable app makes syncEdge read Compose files for its target list, where a read can throw; the doors
    // file is written first, so the withheld app's door closes regardless.
    p.store.addDeploy({ app: "quiet", sha: "a".repeat(40), images_json: "[]", by: "auto-deploy", at: 1, status: "healthy", detail: "" });
    await p.syncEdge().catch(() => {});
    expect(JSON.parse(readFileSync(join(dir, "doors.json"), "utf8"))).not.toHaveProperty("notes");
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

describe("app_page_canary registration", () => {
  // docs/design/access.md §Test-user sign-in: the tool exists only on an instance that names a test user. A default install
  // lists no tool it can never run (no listener binds, no session mints).
  const tools = async (gateFile?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "canary-tool-"));
    const registryPath = join(dir, "apps.yaml");
    writeFileSync(registryPath, "apps:\n  - { name: notes, repo: local/notes, owner: a, description: d }\n");
    const p = createPlatform(
      { registryPath, modulesRegistryPath: join(dir, "apps.modules.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "missing.pem"), identityKeysHostFile: join(dir, "keys.json"), dbPath: join(dir, "state.sqlite"), urlBase: "", edgeDir: dir, healthImage: "none", git: { appsData: dir, gitDir: dir }, ...(gateFile ? { gateFile } : {}) },
      { warn: () => {}, info: () => {} },
    );
    const server = buildServer(p, { id: "id", key: "reader", name: "reader", roles: [] }, { dir: "", pushUrl: "" }, async () => {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const r = await client.listTools();
    await client.close();
    return r.tools;
  };
  const names = async (gateFile?: string) => (await tools(gateFile)).map((t) => t.name);

  it("is absent with no test user, and present once the setting is compiled in", async () => {
    expect(await names()).not.toContain("app_page_canary");
    const dir = mkdtempSync(join(tmpdir(), "canary-gate-"));
    const gateFile = join(dir, "gate.json");
    writeFileSync(gateFile, JSON.stringify({ test_user: { email: "canary@aidenhq.test", apps: ["notes"] } }));
    expect(await names(gateFile)).toContain("app_page_canary");
    // Previews alone are not a test user.
    const other = join(dir, "gate2.json");
    writeFileSync(other, JSON.stringify({ previews: { file: "x", ports: [39000, 39100] } }));
    expect(await names(other)).not.toContain("app_page_canary");
  });

  it("keeps its contract: name, action, text, optional path and width in, the submission's result fields out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-schema-"));
    const gateFile = join(dir, "gate.json");
    writeFileSync(gateFile, JSON.stringify({ test_user: { email: "canary@aidenhq.test", apps: ["notes"] } }));
    const tool = (await tools(gateFile)).find((t) => t.name === "app_page_canary")!;
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["action", "name", "path", "text", "width"]);
    expect((schema.required ?? []).sort()).toEqual(["action", "name", "text"]);
    // The result is the canary's own answer (canaryContent): meta fields and, when it took one, the screenshot.
    const r = { ok: true, status: 200, finalUrl: "http://notes.canary.localhost:3132/", pageTitle: "Notes", notify: "fired" as const, notifyStatus: 204, reference: "R-1", submittedAt: new Date().toISOString(), session: { id: "s", expires: "", revoked: true } };
    const content = canaryContent(r as CanaryResult);
    const text = content.content[0];
    expect(text?.type).toBe("text");
    const meta = JSON.parse(String(text && "text" in text ? text.text : "").split("\n")[0]!);
    expect(meta).toMatchObject({ notify: "fired", notifyStatus: 204, reference: "R-1", submittedAt: r.submittedAt, session: { revoked: true } });
  });
});
