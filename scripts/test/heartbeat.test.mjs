// Heartbeats: `heartbeat: true | <hours>` compiles to one staggered routine per agent (every heartbeat_hours, default 4),
// the shared handbook section names the Fleet issues task, and task_approvals reads a task's cards from the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";
import { BUNDLE } from "./bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const product = join(here, "../..");
const template = join(product, "modules/agent-builder/templates/pr-review-chaser");

function instance(agents = {}, modules = [], dir = mkdtempSync(join(tmpdir(), "inst-")), settings = {}, overrides = undefined) {
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, ...modules], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x", product_repo: "acme/aidenhq", ...settings }, ...(overrides ? { overrides } : {}) }));
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
  assert.ok(r.paperclip.agents["chief-of-staff"].enabled_tools.paperclip_tasks.includes("task_approvals"));
});

test("heartbeat cadence: the instance setting, an agent's hours, an override", () => {
  const tools = { paperclip_tasks: ["task_list", "task_comments", "task_approvals", "task_comment", "task_finish"] };
  const r = compile(product, instance({ chaser: { heartbeat: 2, connections: tools } }, [], undefined, { heartbeat_hours: 6 }, { agents: { architect: { heartbeat: false }, "app-maintainer": { heartbeat: 12 } } }));
  assert.equal(r.paperclip.routines["heartbeat-chaser"].title, "Heartbeat: chaser");
  assert.match(r.paperclip.routines["heartbeat-chaser"].schedules[0].cron, / \*\/2 \* \* \*$/);
  assert.match(r.paperclip.routines["heartbeat-chief-of-staff"].schedules[0].cron, / \*\/6 \* \* \*$/);
  assert.match(r.paperclip.routines["heartbeat-app-maintainer"].schedules[0].cron, / \*\/12 \* \* \*$/);
  assert.ok(!r.paperclip.routines["heartbeat-architect"]);
  assert.throws(() => compile(product, instance({ chaser: { heartbeat: 5, connections: tools } })), /chaser: heartbeat is true, false or hours/);
  assert.throws(() => compile(product, instance({}, [], undefined, { heartbeat_hours: 5 })), /settings.heartbeat_hours/);
  assert.throws(() => compile(product, instance({ chaser: { heartbeat: true } })), /chaser: heartbeat needs paperclip_tasks: task_approvals/);
  const mods = join(here, "fixtures/mods");
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ modules: ["core", "runnerheartbeat"], settings: { timezone: "UTC", owner_name: "Sam", owner_email: "o@x" } }));
  assert.throws(() => compile(mods, dir), /eng: a runner-dispatched agent can't have a heartbeat/);
});

test("quiet start: module schedules compile paused and heartbeats off until an override turns one on; unset changes nothing", () => {
  const tools = { paperclip_tasks: ["task_list", "task_comments", "task_approvals", "task_comment", "task_finish"] };
  const chaser = { chaser: { heartbeat: 2, connections: tools } };
  const before = compile(product, instance(chaser));
  const quiet = compile(product, instance(chaser, [], undefined, { quiet_start: "on", spend_day_usd: 10 }));
  for (const [key, r] of Object.entries(before.paperclip.routines)) {
    if (key.startsWith("heartbeat-") && key !== "heartbeat-chaser") continue;
    // A module routine with a schedule waits; one fired by an event, and an instance agent's own routines, are as before.
    const own = before.paperclip.agents[r.agent].module === "instance";
    assert.equal(quiet.paperclip.routines[key].status, r.schedules?.length && !own ? "paused" : r.status, key);
  }
  assert.deepEqual(Object.keys(quiet.paperclip.routines).filter((k) => k.startsWith("heartbeat-")), ["heartbeat-chaser"]);
  assert.equal(quiet.paperclip.agents["chief-of-staff"].heartbeat, false);
  assert.equal(quiet.gateway.install_day_usd, 10);
  assert.ok(Object.values(before.paperclip.routines).every((r) => r.status !== "paused"), "unset: nothing paused");
  assert.equal(before.gateway.install_day_usd, undefined);

  const on = compile(product, instance({}, [], undefined, { quiet_start: "on" }, { routines: { "daily-brief": { status: "active" } }, agents: { "chief-of-staff": { heartbeat: true } } }));
  assert.equal(on.paperclip.routines["daily-brief"].status, "active");
  assert.ok(on.paperclip.routines["heartbeat-chief-of-staff"].status !== "paused");
  assert.equal(on.paperclip.routines["coach-review"].status, "paused");
});
