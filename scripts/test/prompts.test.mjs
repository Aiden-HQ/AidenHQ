// Prompt contributions (lean-core 4a, spec §3.1 `prompts`): modules add handbook sections; compile picks each crew agent's by
// `when`/`unless` and orders them first, normal, last, then module, then id. Setup appends the files verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, promptApplies, promptEntries } from "../modules.mjs";
import { handbookParts, laneHandbook, onDemandSections, sizesReport } from "../handbook.mjs";
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
