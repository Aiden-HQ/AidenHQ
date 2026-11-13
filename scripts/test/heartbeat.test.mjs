// Heartbeats: `heartbeat: true | <hours>` compiles to one staggered routine per agent (every heartbeat_hours, default 4),
// the shared handbook section names the Fleet issues task, and task_approvals reads a task's cards from the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const product = join(here, "../..");
const template = join(product, "modules/core/templates/pr-review-chaser");

function instance(agents = {}, modules = [], dir = mkdtempSync(join(tmpdir(), "inst-")), settings = {}, overrides = undefined) {
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules, settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x", ...settings }, ...(overrides ? { overrides } : {}) }));
  mkdirSync(join(dir, "agents"));
  for (const [key, yaml] of Object.entries(agents)) {
    mkdirSync(join(dir, "agents", key));
    writeFileSync(join(dir, "agents", key, "agent.yaml"), YAML.stringify({ ...YAML.parse(readFileSync(join(template, "agent.yaml"), "utf8")), ...yaml }));
    writeFileSync(join(dir, "agents", key, "AGENTS.md"), readFileSync(join(template, "AGENTS.md"), "utf8"));
  }
  return dir;
}

test("heartbeat compiles to one staggered 4-hourly routine per opted-in agent on Flash at low effort", () => {
  const r = compile(product, instance());
  const keys = ["chief-of-staff", "architect", "app-maintainer"];
  const minutes = new Set();
  for (const key of keys) {
    const rt = r.paperclip.routines[`heartbeat-${key}`];
    assert.equal(rt.title, `Heartbeat: ${key}`);
    assert.equal(rt.agent, key);
    assert.equal(rt.concurrency, "skip_if_active");
    assert.match(rt.description, /Heartbeats/);
    assert.equal(rt.model, "~deepseek/deepseek-flash-latest");
    assert.equal(rt.reasoning_effort, "low");
    assert.equal(rt.schedules.length, 1);
    const [s] = rt.schedules;
    const m = Number(s.cron.split(" ")[0]);
    assert.equal(s.cron, `${m} */4 * * *`);
    assert.equal(s.timezone, "Europe/London");
    assert.equal(s.label, "heartbeat"); // setup matches triggers by label
    minutes.add(m);
  }
  assert.equal(minutes.size, keys.length, "staggered");
  assert.ok(!Object.keys(r.paperclip.routines).some((k) => k.startsWith("catch-up-")));
  assert.ok(!r.paperclip.routines["heartbeat-assistant"]);
  assert.equal(r.paperclip.wake_ups, "on");
  assert.ok(r.paperclip.agents["chief-of-staff"].enabled_tools.paperclip_tasks.includes("task_approvals"));
});

test("heartbeat cadence: the instance setting, an agent's hours, an override; catch_up is refused naming heartbeat", () => {
  const tools = { paperclip_tasks: ["task_list", "task_comments", "task_approvals", "task_comment", "task_finish"] };
  const r = compile(product, instance({ chaser: { heartbeat: 2, connections: tools } }, [], undefined, { heartbeat_hours: 6 }, { agents: { architect: { heartbeat: false }, "app-maintainer": { heartbeat: 12 } } }));
  assert.equal(r.paperclip.routines["heartbeat-chaser"].title, "Heartbeat: chaser");
  assert.match(r.paperclip.routines["heartbeat-chaser"].schedules[0].cron, / \*\/2 \* \* \*$/);
  assert.match(r.paperclip.routines["heartbeat-chief-of-staff"].schedules[0].cron, / \*\/6 \* \* \*$/);
  assert.match(r.paperclip.routines["heartbeat-app-maintainer"].schedules[0].cron, / \*\/12 \* \* \*$/);
  assert.ok(!r.paperclip.routines["heartbeat-architect"]);
  assert.throws(() => compile(product, instance({ chaser: { catch_up: true, connections: tools } })), /chaser: catch_up was renamed heartbeat/);
  assert.throws(() => compile(product, instance({ chaser: { heartbeat: 5, connections: tools } })), /chaser: heartbeat is true, false or hours/);
  assert.throws(() => compile(product, instance({}, [], undefined, { heartbeat_hours: 5 })), /settings.heartbeat_hours/);
  assert.throws(() => compile(product, instance({ chaser: { heartbeat: true } })), /chaser: heartbeat needs paperclip_tasks: task_approvals/);
  const mods = join(here, "fixtures/mods");
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ modules: ["runnerheartbeat"], settings: { timezone: "UTC", owner_email: "o@x" } }));
  assert.throws(() => compile(mods, dir), /eng: a runner-dispatched agent can't have a heartbeat/);
});

test("task_list mine: your open work incl. incident runs and chats handed back to the owner; not heartbeat runs or this run", async () => {
  const asked = [];
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const send = (x) => res.end(JSON.stringify(x));
    if (req.url === "/api/agents/me") return send({ id: "me", name: "Aiden" });
    if (req.url === "/api/companies/c") return send({ defaultResponsibleUserId: "owner" });
    asked.push(req.url);
    const q = new URL(req.url, "http://x").searchParams;
    if (q.get("assigneeAgentId") === "me") return send([
      { id: "a", identifier: "WOR-1", title: "App incident", assigneeAgentId: "me" },
      { id: "cur", identifier: "WOR-2", title: "Heartbeat: chief-of-staff", assigneeAgentId: "me" },
      { id: "c", identifier: "WOR-3", title: "Heartbeat: chief-of-staff", assigneeAgentId: "me" },
    ]);
    send([
      { id: "d", identifier: "WOR-4", title: "Build the app", assigneeUserId: "owner", description: "hi\n\n<!-- aidenhq-chat-agent:me -->" },
      { id: "e", identifier: "WOR-5", title: "Someone else's chat", assigneeUserId: "owner", description: "hi\n\n<!-- aidenhq-chat-agent:other -->" },
    ]);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const grants = join(mkdtempSync(join(tmpdir(), "grants-")), "grants.json");
  writeFileSync(grants, JSON.stringify({ agents: { me: { key: "chief-of-staff", roles: [], tools: { paperclip_tasks: ["task_list"] } } } }));
  const child = spawn(process.execPath, [join(product, "services/paperclip-tasks-mcp/paperclip-tasks-mcp.mjs")], {
    env: { ...process.env, PAPERCLIP_API_URL: url, PAPERCLIP_API_KEY: "k", PAPERCLIP_COMPANY_ID: "c", PAPERCLIP_TASK_ID: "cur", AIDENHQ_GRANTS_FILE: grants },
  });
  let out = "";
  const reply = new Promise((resolve) => child.stdout.on("data", (d) => { out += d; const line = out.split("\n").find((l) => l.includes('"id":1')); if (line) resolve(JSON.parse(line)); }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_list", arguments: { mine: true } } }) + "\n");
  const r = await reply;
  child.kill();
  server.close();
  assert.ok(!asked[0].includes("excludeRoutineExecutions")); // incident runs are routine runs
  assert.deepEqual(JSON.parse(r.result.content[0].text).tasks.map((t) => t.identifier), ["WOR-1", "WOR-4"]);
});
