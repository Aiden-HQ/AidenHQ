// V4: sharing a local module, end to end (docs/design/sharing.md). The board's preview, then the owner's Save bound to its
// digest, source, repo, ref and base; the kernel exports again and files his own github.publish_module (fileKernel `owner`);
// the record is revalidated by the real code host's plan and executed by its commit assembly against a fake GitHub (an
// in-process REST and bare repos). Memory, the profile, secrets and setting values never leave; a tip moved after the Save
// fails it ("preview again"); an agent can't file it; a private repo, a flagged export, a changed module and a different
// digest are refused. The published folder then installs from that marketplace with its routine paused.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { kernelRecords } from "../src/records.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { SETTINGS, openRecords } from "../../../kernel/src/records.ts";
import { createWrites } from "../../../kernel/src/writes.ts";
import { createCodehost } from "../../../kernel/src/codehost.ts";
import { createSettingsChanges } from "../../../kernel/src/settings-change.ts";
import { createSharing, vaultValues } from "../../../kernel/src/module-share.ts";
import { createService } from "../../../modules/github/service/src/service.ts";
import { compile, writeKinds } from "../../../scripts/modules.ts";
import { githubWrites } from "../../../modules/github/test/fake-github-writes.ts";

const repoRoot = join(import.meta.dirname, "../../..");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8", env: ENV }).trim();
const listen = (h: Parameters<typeof createServer>[1]) => new Promise<{ s: Server; url: string; port: number }>((ok) => { const s = createServer(h); s.listen(0, "127.0.0.1", () => { const port = (s.address() as AddressInfo).port; ok({ s, url: `http://127.0.0.1:${port}`, port }); }); });

// Planted at runtime: a vault secret, an instance setting value, a memory fact and a profile line.
const SECRET = `tok${randomBytes(12).toString("hex")}`;
const ENV_SECRET = `pw${randomBytes(6).toString("hex")}`;
const FACT = `the acme quarterly review moves to thursdays ${randomBytes(4).toString("hex")}`;
const PROFILE = `Prefers short replies before noon ${randomBytes(4).toString("hex")}`;
const SETTING = `acme-agents-${randomBytes(4).toString("hex")}`;

const root = mkdtempSync(join(tmpdir(), "share-e2e-"));
const MODULE = {
  name: "review-chaser", description: "Chases pull request reviews",
  agents: { chaser: { name: "Chaser", description: "Chases PR reviews until they land", model: "openrouter/acme-model", reports_to: "chief-of-staff", image: "acme/box" } },
  routines: {
    "chase-daily": { title: "Chase daily", description: "Chase the open reviews.", agent: "chaser", schedules: [{ cron: "5 9 * * *" }] },
    "digest-for-cos": { title: "Digest for the chief", description: "A digest.", agent: "chief-of-staff", schedules: [{ cron: "7 9 * * *" }] },
  },
};

describe("sharing a local module (V4)", () => {
  // The instance repo: a bare origin and the kernel's checkout of it.
  const src = join(root, "inst-src"), bare = join(root, "inst.git"), checkout = join(root, "checkout");
  const commitInstance = (files: Record<string, string>, msg: string) => {
    for (const [p, t] of Object.entries(files)) { mkdirSync(join(src, p, ".."), { recursive: true }); writeFileSync(join(src, p), t); }
    git(src, "add", "-A"); git(src, "commit", "-qm", msg); git(src, "push", "-q", bare, "main");
  };
  // "GitHub": the destination marketplaces as bare repos, and its REST answers.
  const gh = (slug: string) => join(root, "github", `${slug}.git`);
  const market = "acme/agents-market";
  let onRepoRead: (() => void) | undefined;
  // GitHub's signed commits and refs over the bare repos: a share lands as GitHub's own commit.
  const ghWrites = githubWrites(gh);
  const ghRest = async (method: string, path: string, body?: unknown) => {
    const wrote = ghWrites(method, path, body);
    if (wrote) return wrote;
    if (method === "GET" && path === `/repos/${market}`) { const f = onRepoRead; onRepoRead = undefined; f?.(); return { status: 200, body: { default_branch: "main", private: false } }; }
    if (method === "GET" && path === "/repos/acme/private-stuff") return { status: 200, body: { default_branch: "main", private: true } };
    return { status: 404, body: { message: "fake GitHub: no route" } };
  };
  const moveTip = (slug: string) => {
    const w = mkdtempSync(join(root, "mv-"));
    git(root, "clone", "-q", gh(slug), w);
    writeFileSync(join(w, "README.md"), `moved ${randomBytes(4).toString("hex")}\n`);
    git(w, "add", "-A"); git(w, "commit", "-qm", "someone else"); git(w, "push", "-q", "origin", "main");
  };
  const tip = (slug: string) => git(gh(slug), "rev-parse", "main");

  const servers: Server[] = [];
  let board = "";
  let records: ReturnType<typeof openRecords>;
  let writes: ReturnType<typeof createWrites>;
  const notices: string[] = [];

  beforeAll(async () => {
    mkdirSync(src);
    git(src, "init", "-q");
    git(root, "init", "-q", "--bare", bare);
    commitInstance({
      "instance.yaml": "settings:\n  timezone: UTC\n",
      "owner/profile.md": `# Owner\n\n- ${PROFILE}\n`,
      "modules/review-chaser/module.yaml": YAML.stringify(MODULE),
      "modules/review-chaser/agents/chaser/AGENTS.md": "You chase pull request reviews until each one lands.\n",
      "modules/review-chaser/skills/chase/SKILL.md": "---\nname: chase\ndescription: how to chase a review\n---\nAsk once, then again a day later.\n",
      "modules/review-chaser/memory.md": `- ${FACT}\n`,
      "modules/library/module.yaml": "name: library\n",
    }, "init");
    git(root, "clone", "-q", bare, checkout);
    for (const slug of [market, "acme/private-stuff"]) {
      git(root, "init", "-q", "--bare", gh(slug));
      const seed = mkdtempSync(join(root, "seed-"));
      git(seed, "init", "-q");
      writeFileSync(join(seed, "marketplace.json"), `${JSON.stringify({ name: "acme", plugins: [{ name: "other", source: "./other" }] }, null, 2)}\n`);
      git(seed, "add", "-A"); git(seed, "commit", "-qm", "market"); git(seed, "push", "-q", gh(slug), "main");
    }
    // The compiled config and the vault the kernel reads.
    const config = join(root, "config");
    mkdirSync(config);
    writeFileSync(join(config, "paperclip.yaml"), YAML.stringify({
      settings: { github_fleet_org: { value: SETTING, set: true }, timezone: { value: "UTC", set: false } },
      agents: { chaser: { module: "review-chaser", tier: "local", enabled_tools: { paperclip_tasks: ["task_get", "task_comment"] } } },
      mcp_servers: { paperclip_tasks: { tools: { read: ["task_get"], write: ["task_comment"] } } },
    }));
    writeFileSync(join(config, "modules.json"), JSON.stringify([{ name: "review-chaser", tier: "local", enabled: true }, { name: "library", tier: "local", enabled: true }, { name: "github", tier: "official", enabled: true }]));
    const vault = join(root, "vault");
    mkdirSync(join(vault, "github-app"), { recursive: true });
    // A vault file holding the secret inside it (a JSON credential): its value is still found when copied alone.
    writeFileSync(join(vault, "github-app", "key"), JSON.stringify({ client_id: "Iv1.example", private_token: SECRET }));
    // And an env-style vault file: its quoted value is found alone.
    writeFileSync(join(vault, "jira.env"), `JIRA_TOKEN="${ENV_SECRET}"\n`);

    // What the backplane does (its routes are thin), with lifecycle pieces made below with these routes (the board's key), and an executor's outcome.
    const kernel = await listen(async (req, res) => {
      let text = "";
      for await (const c of req) text += c;
      const b = text ? JSON.parse(text) : {};
      const send = (status: number, j: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(j));
      const out = /^\/v1\/writes\/(k-[0-9a-f]{16})\/outcome$/.exec(String(req.url));
      if (out) return send(writes.outcome(out[1]!, b.ok, b.text, b.objects) ? 200 : 409, {});
      if (String(req.url).startsWith("/v1/objects")) return send(200, { ours: false });
      if (req.headers.authorization !== "Bearer board-key") return send(401, {});
      try {
        if (req.url === "/v1/modules/share/preview") return send(200, await sharing.preview(b));
        if (req.url === "/v1/modules/share") return send(200, await sharing.share(b));
      } catch (e) { return send((e as { status?: number }).status ?? 502, { error: { code: "refused", type: "refused", message: (e as Error).message } }); }
      send(404, {});
    });
    servers.push(kernel.s);
    let sharing: ReturnType<typeof createSharing>;
    // The code host, as the github module runs it: its real executor and commit assembly, GitHub faked.
    const access = {
      connected: () => true, scopes: () => ["repo"], status: () => ({ scopes: ["repo"], problems: [] }), token: async () => "tok",
      identity: async () => ({ login: "owner1", name: "Owner One", email: "1+owner1@users.noreply.github.com" }),
      rest: async (method: string, path: string, body?: unknown) => ({ ...(await ghRest(method, path, body)), headers: new Headers() }), graphql: async () => ({}),
      // The chooser (github-mcp client.ts actorFor) with no App: every write is the owner's, through the same fake.
      actorFor: async () => ({ kind: "owner", key: "owner", identity: () => access.identity(), rest: (m: string, p: string, b?: unknown) => access.rest(m, p, b), gitToken: () => access.token() }),
    };
    const handle = createService({ key: "ch-key", kernelUrl: kernel.url, cacheDir: join(root, "cache"), access: access as never, remoteUrl: gh, fleetOrg: "acme-agents", instanceRepo: "acme/acme-instance", productRepo: "acme/aidenhq", reviewGate: async () => undefined } as never);
    const svc = await listen((req, res) => void handle(req, res));
    servers.push(svc.s);

    // The kernel: the write kind as compiled from the github module, its records, the write lifecycle and the share routes.
    const def = YAML.parse(readFileSync(join(repoRoot, "modules/github/module.yaml"), "utf8"));
    const kinds = writeKinds("github", def, join(repoRoot, "modules/github"), {}, {}, ["github", "ship"]);
    const resolver = { resolve: async (u: string) => ({ host: "127.0.0.1", port: svc.port, path: new URL(u).pathname }), forget: () => {} };
    records = openRecords(join(root, "kernel.db"));
    writes = createWrites({ records, registry: () => kinds, connections: () => ({}), secret: () => "ch-key", resolver: resolver as never, replay: async () => ({ ok: false, text: "" }), onTask: { open: async () => true, notify: async (_t, text) => void notices.push(text) } });
    const settings = createSettingsChanges({
      product: repoRoot, configDir: config, instanceRepo: () => "acme/acme-instance", main: async () => ({ base: "", texts: new Map() }),
      task: async () => ({ identifier: "WOR-9", status: "todo", createdByUserId: "owner-user", labels: [{ name: "settings-change" }] }), owner: async () => "owner-user",
      filed: () => false, write: async () => ({ sha: "" }), file: async () => ({ id: "", tier: 0, state: "" }),
      credentialAccount: async (c) => ("board" in c && c.board === "ahqu_owner" ? "acct-1" : undefined),
    });
    const codehost = createCodehost({ grants: () => [], repos: () => ({}), kind: () => kinds["github.publish_module"], secret: () => "ch-key", resolver: resolver as never });
    sharing = createSharing({
      instanceDir: checkout, configDir: config, instanceRepo: () => "acme/acme-instance", secrets: () => vaultValues(vault), memory: () => [FACT],
      tip: (b) => codehost.publishTip(b), ownerTask: settings.ownerTask,
      filed: (task) => records.list(["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"], 50, { task, kinds: ["github.publish_module"] }).length > 0,
      file: (args, task, owner) => writes.fileKernel("github.publish_module", { args, task, requester: SETTINGS, owner }),
    });

    // The board, signed in as the owner, filing each save as his own settings task.
    const pc = {
      me: async () => "owner-user", agents: async () => [], labels: async () => [{ id: "l1", name: "settings-change", color: "#000" }], company: async () => ({ issuePrefix: "WOR" }),
      createIssue: async (b: Record<string, unknown>) => ({ id: randomUUID(), identifier: "WOR-9", ...b }), addComment: async () => ({}), updateIssue: async () => ({}),
    } as unknown as Paperclip;
    const k = kernelRecords({ url: kernel.url, token: "board-key" });
    const app = createApp({ paperclip: pc, store: new Store(":memory:"), records: { ...fakeRecords(), sharePreview: k.sharePreview, share: k.share }, log: pino({ level: "silent" }), allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "acct-1", role: "admin" }), accounts: { sessionOf: async () => ({ token: "ahqu_owner" }), names: async () => [] } as never });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    board = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    servers.push(app);
  });
  afterAll(() => { for (const s of servers) s.close(); });

  const post = (path: string, body: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const u = new URL(path, board);
    const req = request({ host: u.hostname, port: u.port, method: "POST", path: u.pathname, headers: { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1" } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c)).on("end", () => resolve({ status: res.statusCode ?? 0, body: out ? JSON.parse(out) : null }));
    });
    req.on("error", reject).end(JSON.stringify(body));
  });
  const preview = (repo = market) => post("/api/modules/share/preview", { module: "review-chaser", repo, ref: "main" });
  const save = (p: any, o: Record<string, unknown> = {}) => post("/api/settings/change", { changes: [{ kind: "share", module: p.module, repo: p.repo, ref: p.ref, source: p.source, base: p.base, digest: p.digest, ...o }] });
  const settled = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const r = records.get(id)!;
      if (!["owner", "approved", "claimed"].includes(r.state)) return r;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error(`record ${id} never settled`);
  };
  const tree = (rev: string) => git(gh(market), "ls-tree", "-r", "--name-only", rev).split("\n");

  it("publishes exactly the preview, bound to the owner's save; memory, profile, secrets and settings never leave", async () => {
    const p = await preview();
    expect(p.status).toBe(200);
    expect(p.body.findings).toEqual([]);
    expect(p.body.base).toBe(tip(market));
    expect(p.body.removes).toEqual([]);
    expect(p.body.files.map((f: any) => f.path)).toEqual(["agents/chaser/AGENTS.md", "module.yaml", "skills/chase/SKILL.md"]);
    expect(p.body.notShared.map((n: any) => n.path).sort()).toEqual(["memory.md", "module.yaml agents.chaser.image", "module.yaml agents.chaser.reports_to", "module.yaml routines.digest-for-cos"]);
    expect([p.body.isolation, p.body.grants.chaser]).toEqual(["trusted", ["paperclip_tasks.task_comment", "paperclip_tasks.task_get"]]);
    const shown = Object.fromEntries(p.body.files.map((f: any) => [f.path, f.text]));

    const s = await save(p.body);
    expect(s.status).toBe(200);
    const r = await settled(s.body.record);
    expect([r.state, r.decided_by, r.via, r.outcome?.ok]).toEqual(["done", "account:acct-1", "save", true]);
    const head = tip(market);
    expect(tree(head)).toEqual(["marketplace.json", "review-chaser/agents/chaser/AGENTS.md", "review-chaser/module.yaml", "review-chaser/skills/chase/SKILL.md"]);
    for (const [path, text] of Object.entries(shown)) expect(git(gh(market), "show", `${head}:review-chaser/${path}`)).toBe(String(text).trimEnd());
    expect(JSON.parse(git(gh(market), "show", `${head}:marketplace.json`)).plugins).toEqual([{ name: "other", source: "./other" }, { name: "review-chaser", source: "./review-chaser" }]);
    const everything = git(gh(market), "grep", "-h", "-e", ".", head, "--");
    for (const never of [SECRET, FACT, PROFILE, SETTING, "chief-of-staff", "acme/box"]) expect(everything).not.toContain(never);

    // The round trip: another instance adds that marketplace at the published commit; the agent comes in, its routine paused.
    const inst = mkdtempSync(join(root, "importer-"));
    writeFileSync(join(inst, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["core", "review-chaser@acme"], marketplaces: [{ name: "acme", source: { source: "url", url: gh(market) }, sha: head }], settings: { timezone: "UTC", owner_name: "Sam", owner_email: "me@example.com" } }));
    const out = compile(join(repoRoot, "scripts/test/fixtures/mods"), inst, { fetch: { cacheDir: mkdtempSync(join(root, "sources-")) } });
    expect(out.paperclip.agents.chaser).toMatchObject({ module: "review-chaser", tier: "declared", isolation: "trusted" });
    expect(out.paperclip.agents.chaser.reports_to).toBeUndefined();
    expect(out.paperclip.routines["chase-daily"].status).toBe("paused");
  });

  it("a tip moved after the Save fails at execution: preview again, nothing written", async () => {
    const p = await preview();
    // The filing's plan reads the repo once; the revalidating plan's read moves the branch first.
    let reads = 0;
    const moved = () => { if (++reads === 2) moveTip(market); else onRepoRead = moved; };
    onRepoRead = moved;
    const s = await save(p.body);
    expect(s.status).toBe(200);
    const r = await settled(s.body.record);
    expect([r.state, r.outcome?.ok]).toEqual(["failed", false]);
    expect(r.outcome?.text).toMatch(/preview again/i);
    expect(records.list(["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"], 50, { task: r.task })).toHaveLength(1);
    expect(git(gh(market), "log", "-1", "--format=%s", "main")).toBe("someone else");
    // Moved before the Save: refused at filing.
    const q = await preview();
    moveTip(market);
    expect(await save(q.body)).toMatchObject({ status: 422, body: { error: expect.stringMatching(/moved since your preview/) } });
  });

  it("refuses what differs from the preview, a private repo, a flagged export and any filer but the owner's save", async () => {
    // A private destination: shown, and refused at the Save.
    const priv = await preview("acme/private-stuff");
    expect(priv.body.private).toBe(true);
    expect(await save(priv.body)).toMatchObject({ status: 422, body: { error: expect.stringMatching(/private/) } });
    // Another digest than the preview's.
    const p = await preview();
    expect(await save(p.body, { digest: "0".repeat(64) })).toMatchObject({ status: 422, body: { error: expect.stringMatching(/preview again/) } });
    // The module changed after the preview.
    commitInstance({ "modules/review-chaser/agents/chaser/AGENTS.md": "You chase reviews, politely.\n" }, "handbook");
    expect(await save(p.body)).toMatchObject({ status: 422, body: { error: expect.stringMatching(/changed since your preview/) } });
    // A secret pasted into a skill: the preview names it and holds the text back; the Save is refused.
    // So is a memory fact, a profile line or a setting value copied into a handbook.
    commitInstance({
      "modules/review-chaser/skills/chase/SKILL.md": `---\nname: chase\ndescription: how\n---\nUse ${Buffer.from(SECRET).toString("base64")} to log in.\n`,
      "modules/review-chaser/agents/chaser/AGENTS.md": `Remember: ${FACT}. ${PROFILE}. Post in ${SETTING}.\n`,
      "modules/review-chaser/skills/chase/notes.md": `Jira: ${ENV_SECRET}\n`,
    }, "oops");
    const flagged = await preview();
    expect(flagged.body.findings).toEqual([
      { file: "agents/chaser/AGENTS.md", rule: "setting-value", detail: "the value of the setting github_fleet_org" },
      { file: "agents/chaser/AGENTS.md", rule: "memory-fact", detail: "a fact from an agent's memory" },
      { file: "agents/chaser/AGENTS.md", rule: "profile-fact", detail: "a line of the owner's profile" },
      { file: "skills/chase/SKILL.md", rule: "secret-value", detail: "a vault secret's value" },
      { file: "skills/chase/notes.md", rule: "secret-value", detail: "a vault secret's value" },
    ]);
    expect(flagged.body.files.every((f: any) => f.text === undefined)).toBe(true);
    for (const never of [SECRET, ENV_SECRET, FACT, PROFILE, SETTING]) expect(JSON.stringify(flagged.body)).not.toContain(never);
    expect(await save(flagged.body)).toMatchObject({ status: 422, body: { error: expect.stringMatching(/not shared/) } });
    // No job, module or kernel filing without the owner's save files a publish.
    const args = { repo: market, ref: "main", base: tip(market), source: p.body.source, module: "review-chaser", files: [{ path: "module.yaml", text: "name: review-chaser\n" }], digest: p.body.digest };
    const job = { kind: "run" as const, agent: "a1", key: "engineer", name: "Engineer", roles: [], task: "t1", job: "j-0000000000000001", tools: {}, writes: ["github.publish_module"] };
    await expect(writes.request(job, { kind: "github.publish_module", args })).rejects.toMatchObject({ status: 403 });
    await expect(writes.request({ kind: "module", module: "github", roles: [], tools: {} }, { kind: "github.publish_module", args, task: "t1" })).rejects.toMatchObject({ status: 403 });
    await expect(writes.fileKernel("github.publish_module", { args, task: "t1", requester: SETTINGS })).rejects.toMatchObject({ status: 403 });
  });
});
