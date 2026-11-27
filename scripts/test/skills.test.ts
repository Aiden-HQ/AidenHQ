// One effective skill list per agent: (skills ∪ overrides.agents.<k>.skills.add) − remove, nothing implicit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.ts";
import { BUNDLE } from "./bundle.ts";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
const settings = { timezone: "UTC", owner_name: "Sam", owner_email: "o@example.com", product_repo: "acme/aidenhq" };

/** An instance with the local module `acme` (agent review-chaser, its `skills`) and its own skill acme.nudge (`skillMeta` frontmatter). */
function instance({ skills, overrides, skillMeta = "" }: { skills?: string[]; overrides?: object; skillMeta?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  const write = (p: string, t: string) => (mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), t));
  write("instance.yaml", YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "github"], settings, ...(overrides ? { overrides } : {}) }));
  const def = { name: "Review Chaser", description: "Chases pull requests waiting on review.", reports_to: "chief-of-staff", model: "~deepseek/deepseek-flash-latest", connections: { primer: "read", github: "read" }, ...(skills ? { skills } : {}) };
  write("modules/acme/module.yaml", YAML.stringify({ name: "acme", description: "Chases reviews.", agents: { "review-chaser": def } }));
  write("modules/acme/agents/review-chaser/AGENTS.md", "# Review Chaser\n\nYou chase reviews.\n");
  write("modules/acme/skills/nudge/SKILL.md", `---\nname: nudge\ndescription: How to nudge a reviewer.\n${skillMeta}---\n\nNudge kindly.\n`);
  return dir;
}
const skillsOf = (dir: string, key: string) => compile(product, dir).paperclip.agents[key].skills ?? [];

test("an agent gets exactly its effective list", () => {
  // Its own module's skill and a grant on primer's connection give nothing: only what it lists.
  assert.deepEqual(skillsOf(instance(), "review-chaser"), []);
  assert.deepEqual(skillsOf(instance({ skills: ["acme.nudge", "primer.primer-docs"] }), "review-chaser"), ["acme.nudge", "primer.primer-docs"]);
  // An override adds to a local agent and removes from a product agent, through the one shape.
  const over = instance({ overrides: { agents: { "review-chaser": { skills: { add: ["acme.nudge"] } }, "chief-of-staff": { skills: { remove: ["tasks.delegate-work"] } } } } });
  assert.deepEqual(skillsOf(over, "review-chaser"), ["acme.nudge"]);
  assert.deepEqual(skillsOf(over, "chief-of-staff"), []);
  // A skill of an available module that isn't enabled (maintainer isn't in the bundle) is dropped; an unknown id fails.
  assert.deepEqual(skillsOf(instance({ skills: ["acme.nudge", "maintainer.report-product-bug"] }), "review-chaser"), ["acme.nudge"]);
  assert.throws(() => compile(product, instance({ skills: ["acme.nope"] })), /agents\.review-chaser\.skills: unknown skill acme\.nope/);
  assert.throws(() => compile(product, instance({ overrides: { agents: { "chief-of-staff": { skills: { add: ["nowhere.x"] } } } } })), /agents\.chief-of-staff\.skills: unknown skill nowhere\.x/);
  assert.throws(() => compile(product, instance({ overrides: { agents: { "chief-of-staff": { skills: ["tasks.delegate-work"] } } } })), /overrides\.agents\.chief-of-staff\.skills: \{ add\?: \[ids\], remove\?: \[ids\] \}/);
});

test("when on a skill fails compile", () => {
  assert.throws(() => compile(product, instance({ skillMeta: "when: { fields: { name: Review Chaser } }\n" })), /module acme: skill nudge: unknown frontmatter when/);
});
