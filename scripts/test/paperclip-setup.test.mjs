// An apply pushes the instance repo before it runs this script, so a section literal that doesn't parse leaves the
// instance half-applied. The sections (scripts/prompts/*.md) are where shared handbook text lives: keep them parseable and present.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { section as promptSection } from "../prompts.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "../paperclip-setup.mjs");

test("every MCP server points at the kernel proxy and none is stdio", async () => {
  const { codexMcpBlock } = await import("../modules.mjs");
  const block = codexMcpBlock({ glean: { url: "http://glean-mcp:8085/mcp", auth: "glean_service_key" }, paperclip_tasks: { url: "http://tasks-mcp:8080/mcp", tool_timeout_sec: 600 } });
  assert.match(block, /\[mcp_servers\.glean\]\nurl = "http:\/\/10\.231\.0\.1:3130\/c\/glean\/mcp"\nbearer_token_env_var = "PAPERCLIP_API_KEY"/);
  assert.match(block, /\[mcp_servers\.paperclip_tasks\]\nurl = "http:\/\/10\.231\.0\.1:3130\/c\/paperclip_tasks\/mcp"/);
  assert.doesNotMatch(block, /command|glean-mcp|service_key|X-Agent-Key/);
});

/** A section setup itself still emits: its markdown file under scripts/prompts, as setup reads it. */
const literal = (name) => ({ APP_FOLLOWUP_SECTION: promptSection("app-followup", "") })[name];
/** A module's prompt contribution (modules/<module>/prompts/<id>.md), as setup appends it: verbatim. */
const prompt = (id) => readFileSync(join(dirname(script), "../modules", id.split(".")[0], "prompts", `${id.split(".")[1]}.md`), "utf8");

/** The rule an agent proposes a correction with: the platform module's improving-rules prompt. */
const improving = () => prompt("platform.improving");

// An unattended install or a rerun from a script has no terminal: setup signs in with what ops/setup.sh made the account
// from (the owner's email, the vault's password), and when something is still missing it stops instead of waiting on a prompt.
test("setup never waits on a prompt without a terminal; the owner's email and the vault's password sign it in", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawn } = await import("node:child_process");
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ path: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") return res.end(JSON.stringify({ status: "ok", bootstrapStatus: "bootstrap_pending" }));
      if (req.url === "/api/auth/sign-in/email") { res.statusCode = 401; return res.end("{}"); }
      res.end("{}"); // sign-up without a session cookie: setup stops there
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "pcs-"));
  writeFileSync(join(dir, "paperclip_owner_password"), "vault-pass-123");
  const run = (cfg) => {
    writeFileSync(join(dir, "paperclip.yaml"), cfg);
    writeFileSync(join(dir, ".env"), `AIDENHQ_SECRETS_DIR=${dir}\n`);
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: dir, AIDENHQ_ENV_FILE: join(dir, ".env"), AIDENHQ_PAPERCLIP_CONFIG: join(dir, "paperclip.yaml"), PAPERCLIP_URL: `http://127.0.0.1:${server.address().port}` } });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    return new Promise((r) => child.on("close", (code) => r({ code, err })));
  };
  try {
    const ok = await run("company: { name: work }\nowner_name: Sam\nsettings: { owner_email: { value: sam@example.com } }\n");
    assert.match(ok.err, /no session cookie/, ok.err);
    assert.deepEqual(seen.find((s) => s.path === "/api/auth/sign-up/email").body, { name: "Sam", email: "sam@example.com", password: "vault-pass-123", rememberMe: true });
    const missing = await run("company: { name: work }\n");
    assert.notEqual(missing.code, 0);
    assert.match(missing.err, /no terminal to ask "Paperclip email:"/, missing.err);
  } finally { server.close(); }
});

test("setup: a write the instance does not keep is a failure, not a logged success", async () => {
  // The instance answers 200 and still reads back 7 days (a hidden or operator-managed setting): setup stops.
  const api = async (method) => ({ json: method === "PATCH" ? {} : { backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } } });
  const { ensureBackupRetention } = await import("../modules.mjs");
  await assert.rejects(() => ensureBackupRetention({ api, dailyDays: 3, step: () => {} }), /backup retention did not take: \{"dailyDays":7/);
});

// Crew agents (Paperclip runs) get their skills only through Paperclip's skill sync: a fake Paperclip that, like the real one,
// imports only from its managed root (as the container sees it) and accepts unknown keys on sync without complaint.
test("setup: crew agents get exactly their skills, a dropped one leaves, and a key Paperclip doesn't list fails", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { ensureCrewSkills } = await import("../modules.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "skills-"));
  const skill = (module, name) => {
    const dir = join(tmp, "modules", module, "skills", name);
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
    writeFileSync(join(dir, "references", "more.md"), "more");
    symlinkSync("/etc/hosts", join(dir, "link"));
    return dir;
  };
  const root = join(tmp, "data", "paperclip", "instances", "default", "skills", "c1");
  const mounted = "/paperclip/instances/default/skills/c1";
  const skills = { "engineering.write-code": { dir: skill("engineering", "write-code") }, "apps-platform.design-system": { dir: skill("apps-platform", "design-system") } };
  const lib = new Map(); // key → skill, Paperclip's company library
  const stored = {}; // agent id → paperclipSkillSync.desiredSkills
  const calls = [];
  let listDrops = "";
  const api = async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === "/api/companies/c1/skills/import") {
      assert.ok(body.source.startsWith(`${mounted}/`), body.source);
      const slug = body.source.slice(mounted.length + 1);
      assert.ok(existsSync(join(root, slug, "SKILL.md")), `${slug} copied before its import`);
      const s = { key: `local/abc/${slug}`, slug };
      lib.set(s.key, s);
      return { json: { imported: [s], warnings: [] } };
    }
    if (path === "/api/companies/c1/skills") return { json: [{ key: "paperclipai/paperclip/paperclip", slug: "paperclip" }, ...[...lib.values()].filter((s) => s.slug !== listDrops)] };
    const sync = /^\/api\/agents\/(\w+)\/skills\/sync$/.exec(path);
    if (sync) { assert.equal(body.mode, "replace"); stored[sync[1]] = body.desiredSkills; return { json: {} }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const agentOf = (id) => ({ id, adapterConfig: stored[id] ? { paperclipSkillSync: { desiredSkills: stored[id] } } : {} });
  const run = (agentSkills) => {
    const cfg = { skills, agents: { coder: { skills: agentSkills.coder }, designer: { skills: agentSkills.designer }, chat: {}, engineer: { dispatch: "runner", skills: ["engineering.write-code"] } } };
    const agents = { coder: agentOf("a1"), designer: agentOf("a2"), chat: agentOf("a3"), engineer: agentOf("a4") };
    calls.length = 0;
    return ensureCrewSkills({ api, companyId: "c1", cfg, agents, root, mounted, step: () => {} });
  };

  await run({ coder: ["apps-platform.design-system", "engineering.write-code"], designer: ["apps-platform.design-system"] });
  // Each distinct skill copied whole (its references, never a link) and imported once, from the container's path.
  assert.deepEqual(calls.filter(([, p]) => p.endsWith("/import")).map(([, , b]) => b.source).sort(), [`${mounted}/design-system`, `${mounted}/write-code`]);
  assert.ok(existsSync(join(root, "write-code", "references", "more.md")));
  assert.ok(!existsSync(join(root, "write-code", "link")));
  assert.deepEqual(stored, { a1: ["local/abc/design-system", "local/abc/write-code"], a2: ["local/abc/design-system"] });

  // A smaller set replaces the larger one; an agent whose set is unchanged is left alone (a new set is a new Codex home).
  await run({ coder: ["engineering.write-code"], designer: ["apps-platform.design-system"] });
  assert.deepEqual(stored.a1, ["local/abc/write-code"]);
  assert.deepEqual(calls.filter(([, p]) => p.endsWith("/sync")).map(([, p]) => p), ["/api/agents/a1/skills/sync"]);
  // An agent whose last skill goes is synced to none.
  await run({ coder: ["engineering.write-code"], designer: [] });
  assert.deepEqual(stored.a2, []);

  // Paperclip doesn't list an imported skill: the apply fails naming it, before any agent is synced.
  listDrops = "write-code";
  await assert.rejects(() => run({ coder: ["engineering.write-code"], designer: ["apps-platform.design-system"] }), /engineering\.write-code/);
  assert.ok(!calls.some(([, p]) => p.endsWith("/sync")));

  // Two modules' skills of one name would share a folder and a Paperclip slug: refused, naming both.
  listDrops = "";
  skills["design.write-code"] = { dir: skill("design", "write-code") };
  await assert.rejects(() => run({ coder: ["engineering.write-code"], designer: ["design.write-code"] }), /design\.write-code.*engineering\.write-code|engineering\.write-code.*design\.write-code/);
});
