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
