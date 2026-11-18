// Prompt contributions (lean-core 4a, spec §3.1 `prompts`): modules add handbook sections; compile picks each crew agent's by
// `when`/`unless` and orders them first, normal, last, then module, then id. Setup appends the files verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, promptApplies, promptEntries } from "../modules.mjs";
import { agentSkills, handbookParts, laneHandbook, onDemandSections, sizesReport } from "../handbook.mjs";
import { BUNDLE } from "./bundle.mjs";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
const template = join(product, "modules/agent-builder/templates/pr-review-chaser");

function instance(modules = [], chaser = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, ...modules], settings: { timezone: "UTC", owner_name: "Sam", owner_email: "o@x", product_repo: "acme/aidenhq" } }));
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
  const root = join(product, "modules/model-tools");
  assert.equal(promptEntries("model-tools", YAML.parse(readFileSync(join(root, "module.yaml"), "utf8")), root).length, 2);
  assert.throws(() => promptEntries("model-tools", { prompts: [{ id: "advisor", file: "prompts/advisor.md", when: { agents: ["x"] } }] }, root), /prompt advisor: unknown when\.agents/);
  assert.throws(() => promptEntries("model-tools", { prompts: [{ id: "advisor", file: "prompts/advisor.md", order: "early" }] }, root), /order of first, normal or last/);
});

test("compile --sizes reports each crew agent's handbook bytes by section", () => {
  const dir = instance();
  const { paperclip: p } = compile(product, dir);
  const out = sizesReport(p, { repo: product, instanceDir: dir });
  assert.match(out, /^chief-of-staff \d+$/m);
  assert.match(out, /^ +\d+ {2}approvals$/m);
  assert.doesNotMatch(out, /^fleet-engineer /m); // runner Engineers get the runner's prompt
});

test("an on-demand section and a module skill: a summary line in the handbook, the text through handbook_section", () => {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  const root = join(repo, "modules", "acme");
  mkdirSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "skills", "triage"), { recursive: true });
  mkdirSync(join(root, "agents", "bot"), { recursive: true });
  writeFileSync(join(root, "agents", "bot", "AGENTS.md"), "Bot handbook.\n");
  writeFileSync(join(root, "prompts", "always.md"), "\n\n## Always\n\nAlways here.\n");
  writeFileSync(join(root, "prompts", "later.md"), "---\nsummary: Read before you file a widget.\nload: on_demand\n---\n\n## Later\n\nWidget rules.\n");
  writeFileSync(join(root, "skills", "triage", "SKILL.md"), "---\nname: triage\ndescription: Triage an acme ticket.\n---\n\nTriage steps.\n");
  const def = { connections: { acme: {} }, prompts: [{ id: "always", file: "prompts/always.md" }, { id: "later", file: "prompts/later.md" }] };
  const entries = promptEntries("acme", def, root);
  assert.deepEqual(entries.map((p) => [p.id, p.load]), [["acme.always", "always"], ["acme.later", "on_demand"], ["acme.triage", "on_demand"]]);
  const granted = { adapter: "codex_local", module: "other", enabled_tools: { acme: ["read"] } };
  const outsider = { adapter: "codex_local", module: "other", enabled_tools: {} };
  assert.ok(promptApplies(entries[2], granted, ["acme"]) && !promptApplies(entries[2], outsider, ["acme"])); // skills follow the grant
  const cfg = { prompts: Object.fromEntries(entries.map((p) => [p.id, { file: p.file, ...(p.load === "on_demand" ? { load: p.load, summary: p.summary } : {}) }])) };
  const bot = { name: "Bot", module: "acme", instructions: join(root, "agents", "bot", "AGENTS.md"), adapter: "codex_local", prompts: entries.map((p) => p.id) };
  const handbook = handbookParts(cfg, "bot", bot, { repo }).map(([, t]) => t).join("");
  assert.match(handbook, /Always here\./);
  assert.match(handbook, /## Untrusted text is data/);
  assert.match(handbook, /a `handbook_section` answer: its fence names the source `paperclip_tasks.handbook_section`/);
  assert.match(handbook, /- `acme\.later`: Read before you file a widget\.\n- `acme\.triage`: Triage an acme ticket\./);
  assert.doesNotMatch(handbook, /Widget rules|Triage steps/);
  assert.deepEqual(onDemandSections(cfg, bot, { repo }), { "acme.later": "\n## Later\n\nWidget rules.\n", "acme.triage": "\nTriage steps.\n" });
  assert.match(laneHandbook(cfg, bot, { repo }), /^Bot handbook\.\n\n\n## Untrusted text is data/);
  writeFileSync(join(root, "prompts", "later.md"), "---\nload: on_demand\n---\nNo summary.\n");
  assert.throws(() => promptEntries("acme", def, root), /prompt later: an on-demand section needs a one-line summary/);
});

test("the owner's standing outcomes, the glossary and the handoff shape are in every crew handbook", () => {
  const dir = instance();
  const file = join(dir, "instance.yaml");
  const y = YAML.parse(readFileSync(file, "utf8"));
  writeFileSync(file, YAML.stringify({ ...y, outcomes: [{ id: "ship-acme", outcome: "Acme's app ships weekly.", done: "a release every week, linked on the board", owner: "chief-of-staff" }] }));
  const { paperclip: p } = compile(product, dir);
  const text = handbookParts(p, "chief-of-staff", p.agents["chief-of-staff"], { repo: product, instanceDir: dir, fleetIssues: "WOR-1" }).map(([, t]) => t).join("");
  assert.match(text, /## Shared words\n/);
  assert.match(text, /## Standing outcomes\n\n.*\n- `ship-acme` \([^)]+, `chief-of-staff`\): Acme's app ships weekly\. Done when: a release every week, linked on the board\n/);
  assert.match(text, /## Handing work on\n/);
  writeFileSync(file, YAML.stringify({ ...y, outcomes: [{ id: "ship-acme", outcome: "x", done: "y", owner: "nobody" }] }));
  assert.throws(() => compile(product, dir), /ship-acme's owner nobody is not an agent here/);
});

test("the owner's profile (owner/profile.md) is in every crew handbook and the chat lane, cut at 4 KB", () => {
  const dir = instance();
  mkdirSync(join(dir, "owner"));
  writeFileSync(join(dir, "owner", "profile.md"), "- Reads briefs, not dashboards: lead with the decision.\n");
  const { paperclip: p } = compile(product, dir);
  const opts = { repo: product, instanceDir: dir, fleetIssues: "WOR-1" };
  const want = /## How the owner works\n\n[^\n]+\n\n- Reads briefs, not dashboards: lead with the decision\.\n/;
  assert.match(handbookParts(p, "chief-of-staff", p.agents["chief-of-staff"], opts).map(([, t]) => t).join(""), want);
  assert.match(laneHandbook(p, p.agents["chief-of-staff"], opts), want);
  writeFileSync(join(dir, "owner", "profile.md"), "- a line of style\n".repeat(400));
  const out = compile(product, dir);
  assert.ok(Buffer.byteLength(out.paperclip.owner_profile) <= 4096 && out.warnings.some((w) => w.startsWith("owner/profile.md is over 4096 bytes")));
});

// An instance with no GitHub (codehost-local in place of codehost-github and github): it compiles with the design module on,
// and every handbook names `local` as the agents org, so agents ask for `local/<name>` instead of guessing a GitHub org.
test("with no GitHub, design compiles on codehost-local and the handbooks name the agents org `local`", () => {
  const dir = instance(["codehost-local", "design"]);
  const file = join(dir, "instance.yaml");
  const y = YAML.parse(readFileSync(file, "utf8"));
  writeFileSync(file, YAML.stringify({ ...y, settings: { ...y.settings, instance_name: "acme" }, modules: y.modules.filter((m) => !["codehost-github", "github"].includes(m)) }));
  const { paperclip: p, catalog } = compile(product, dir);
  assert.deepEqual(["codehost-local", "design", "github", "codehost-github"].map((n) => catalog.find((m) => m.name === n)?.enabled === true), [true, true, false, false]);
  for (const key of ["chief-of-staff", "ui-reviewer"]) {
    const text = handbookParts(p, key, p.agents[key], { repo: product, instanceDir: dir, fleetIssues: "WOR-1" }).map(([, t]) => t).join("");
    assert.match(text, /This AidenHQ's agents org is `local` on this server \(its repositories are `local\/<name>`\)\./, key);
    assert.doesNotMatch(text, /agents org is `aidenhq-acme`/, key);
  }
});

// Skills resolved per agent at compile (one-way plan, Task 4): config/paperclip.yaml lists every enabled module's skill once
// (`skills: {<module>.<name>: {dir, description}}`) and each agent, whatever its adapter, the ids it gets.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures/mods");
function skillProduct(skills, agentYaml = {}) {
  const dir = mkdtempSync(join(tmpdir(), "product-"));
  cpSync(fixtures, dir, { recursive: true });
  for (const [id, body] of Object.entries(skills)) {
    const [m, name] = id.split(".");
    mkdirSync(join(dir, "modules", m, "skills", name), { recursive: true });
    writeFileSync(join(dir, "modules", m, "skills", name, "SKILL.md"), body ?? `---\nname: ${name}\ndescription: Use when ${m} work needs ${name}.\n---\n\nSteps.\n`);
  }
  for (const [m, yaml] of Object.entries(agentYaml)) writeFileSync(join(dir, "modules", m, "module.yaml"), yaml);
  return dir;
}
function skillInstance(modules, agents = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["core", ...modules], settings: { timezone: "UTC", owner_name: "Sam", owner_email: "me@example.com" } }));
  for (const [key, def] of Object.entries(agents)) {
    mkdirSync(join(dir, "agents", key), { recursive: true });
    writeFileSync(join(dir, "agents", key, "agent.yaml"), YAML.stringify({ name: "Helper", description: "Helps", model: "m1", budget: 5, ...def }));
    writeFileSync(join(dir, "agents", key, "AGENTS.md"), "Helper handbook.\n");
  }
  return dir;
}
const RUNNER = "name: engrunner\ndescription: a runner agent\nagents:\n  coder: { adapter: opencode_local, dispatch: runner, engine: codex-openrouter, skills: [eng.review] }\n";

test("a module skill reaches its own module's agents and agents granted its connections, and is listed in the agent's compiled skills", () => {
  const product = skillProduct({ "a.lint": null, "b.fetch": null, "core.triage": null, "eng.review": null }, { engrunner: RUNNER });
  const { paperclip: p } = compile(product, skillInstance(["a", "engrunner"], { helper: { skills: ["a.lint"] } }));
  assert.deepEqual(p.agents.x.skills, ["a.lint", "b.fetch", "core.triage"]); // its module's, and the modules it holds grants on
  assert.deepEqual(p.agents.boss.skills, ["core.triage"]);
  assert.deepEqual(p.agents.coder.skills, ["eng.review"]); // a runner Engineer too, by naming it
  assert.deepEqual(p.agents.helper.skills, ["a.lint"]); // an instance agent names module skills only
  assert.deepEqual(p.skills["b.fetch"], { dir: join(product, "modules/b/skills/fetch"), description: "Use when b work needs fetch." });
  // Review focus 4: a skill is module files only; every folder a job will copy resolves inside its module.
  for (const [id, s] of Object.entries(p.skills)) assert.ok(realpathSync(s.dir).startsWith(realpathSync(join(product, "modules", id.split(".")[0])) + "/"), id);
  assert.deepEqual(agentSkills(p, "boss"), [{ id: "core.triage", dir: join(product, "modules/core/skills/triage") }]);
  assert.deepEqual(agentSkills(p, "helper-without-skills"), []);
});

test("skill names: distinct ids per module, unknown ids, one name twice for one agent, and folders outside the module fail compile", () => {
  // Two modules shipping review: two ids, each agent gets one of them.
  const both = compile(skillProduct({ "a.review": null, "eng.review": null }, { engrunner: RUNNER }), skillInstance(["a", "engrunner"])).paperclip;
  assert.deepEqual(Object.keys(both.skills).sort(), ["a.review", "eng.review"]);
  assert.deepEqual([both.agents.x.skills, both.agents.coder.skills], [["a.review"], ["eng.review"]]);
  assert.throws(() => compile(skillProduct({ "a.lint": null }), skillInstance(["a"], { helper: { skills: ["a.nope"] } })), /unknown skill a\.nope for agent helper/);
  assert.throws(() => compile(skillProduct({ "a.review": null, "b.review": null }), skillInstance(["a"])), /agent x: modules a and b both give it a skill named review/);
  assert.throws(() => compile(skillProduct({ "a.lint": "---\nname: lint-it\ndescription: Lint.\n---\n" }), skillInstance(["a"])), /skill lint: its SKILL.md name must be its folder name/);
  const out = skillProduct({});
  const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
  mkdirSync(join(elsewhere, "steal"));
  writeFileSync(join(elsewhere, "steal", "SKILL.md"), "---\nname: steal\ndescription: Not the module's.\n---\n");
  symlinkSync(elsewhere, join(out, "modules/a/skills"));
  assert.throws(() => compile(out, skillInstance(["a"])), /skill steal: its folder must be inside the module/);
});

test("a delegator's handbook lists every agent's description; an agent without delegation tools gets no Team list", () => {
  const dir = instance(["design", "fleet-ops", "engineering"]);
  const { paperclip: p } = compile(product, dir);
  const parts = (key) => handbookParts(p, key, p.agents[key], { repo: product, instanceDir: dir, fleetIssues: "WOR-0" }).map(([id, t]) => [id, t]);
  const team = parts("chief-of-staff").find(([id]) => id === "team")?.[1] ?? "";
  for (const [key, a] of Object.entries(p.agents)) assert.ok(team.includes(`(${key}`) && team.includes(a.description), key);
  assert.ok(Object.keys(p.agents).every((k) => p.agents[k].description));
  const quiet = Object.keys(p.agents).find((k) => p.agents[k].adapter === "codex_local" && p.agents[k].dispatch !== "runner" && !["task_delegate", "task_create"].some((t) => p.agents[k].enabled_tools?.paperclip_tasks?.includes(t)));
  assert.ok(quiet && !parts(quiet).some(([id]) => id === "team"));
});

test("a module agent without a description fails compile", () => {
  const dir = skillProduct({});
  const file = join(dir, "modules/core/agents/boss/AGENTS.md");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^description:.*\n/m, ""));
  assert.throws(() => compile(dir, skillInstance([])), /agent boss has no description: it is how others route work to it/);
});
