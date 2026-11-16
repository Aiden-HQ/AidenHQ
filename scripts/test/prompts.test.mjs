// Prompt contributions (lean-core 4a, spec §3.1 `prompts`): modules add handbook sections; compile picks each crew agent's by
// `when`/`unless` and orders them first, normal, last, then module, then id. Setup appends the files verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
const template = join(product, "modules/agent-builder/templates/pr-review-chaser");

function instance(modules = [], chaser = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules, settings: { timezone: "UTC", owner_name: "Sam", owner_email: "o@x" } }));
  mkdirSync(join(dir, "agents", "chaser"), { recursive: true });
  writeFileSync(join(dir, "agents", "chaser", "agent.yaml"), YAML.stringify({ ...YAML.parse(readFileSync(join(template, "agent.yaml"), "utf8")), ...chaser }));
  writeFileSync(join(dir, "agents", "chaser", "AGENTS.md"), readFileSync(join(template, "AGENTS.md"), "utf8"));
  return dir;
}

test("each crew agent gets the module sections whose conditions hold, in order", () => {
  const tasks = { paperclip_tasks: ["task_current", "task_comment", "task_finish", "task_create"] };
  const { paperclip: p } = compile(product, instance(["design", "fleet-ops", "engineering"], { connections: tasks, trial_writes: ["paperclip_tasks.task_create"] }));
  const cos = p.agents["chief-of-staff"].prompts;
  assert.deepEqual(cos.slice(0, 6), ["chief-of-staff.asking", "chief-of-staff.how-we-work", "chief-of-staff.progress", "chief-of-staff.replying", "platform.improving", "platform.improving-fleet-ops"]);
  assert.ok(cos.includes("engineering.delegating-design") && cos.indexOf("engineering.delegating-design") === cos.indexOf("engineering.delegating") + 1);
  assert.equal(cos.at(-1), "chief-of-staff.heartbeat"); // last; memory.memory follows only with a memory.md
  assert.ok(!p.agents["ui-designer"].prompts.includes("engineering.delegating-design")); // the design module's own agents
  assert.ok(p.agents["fleet-ops"].prompts.includes("platform.improving") && !p.agents["fleet-ops"].prompts.includes("platform.improving-fleet-ops"));
  assert.ok(!p.agents.chaser.prompts.includes("platform.improving")); // in trial
  assert.equal(p.agents["fleet-engineer"].prompts, undefined); // runner Engineers get the runner's prompt
  assert.match(readFileSync(p.prompts["memory.memory"].file, "utf8"), /^\n\n## What you've learned\n\n[\s\S]*\{\{memory\}\}\n$/);
  assert.equal(p.prompts["memory.memory"].lane, true);
});

test("a prompt with an unknown field or test fails compile", () => {
  const copy = mkdtempSync(join(tmpdir(), "prod-"));
  cpSync(product, copy, { recursive: true, filter: (s) => !/node_modules|\.git$|\/data$|config\.next/.test(s) });
  const file = join(copy, "modules/model-tools/module.yaml");
  const def = YAML.parse(readFileSync(file, "utf8"));
  writeFileSync(file, YAML.stringify({ ...def, prompts: [{ ...def.prompts[0], when: { agents: ["x"] } }] }));
  assert.throws(() => compile(copy, instance()), /prompt advisor: when\.agents isn't a test/);
});
