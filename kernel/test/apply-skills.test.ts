// The reviewer sees what a skill change steers: an apply that touches a skill names the agents whose compiled effective list
// enables it (the instance compiled at the commit's base and head with the real product), and code beside a SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { createApplyPlanner } from "../src/apply-tier.ts";
import { checkoutTree, skillSides } from "../src/settings-change.ts";
import { skillLines } from "../../scripts/compiler/authority.ts";
import { localApply } from "../../modules/codehost-local/src/apply.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = JSON.parse(readFileSync(join(product, "modules/marketplace.json"), "utf8")).bundle;
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" }).trim();
const REPO = "local/acme-instance";
const skill = (body: string) => `---\nname: nudge\ndescription: How to nudge a reviewer.\n---\n\n${body}\n`;

test("a library-only commit lists its enablers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apply-skills-"));
  const src = join(dir, "src");
  const write = (p: string, t: string) => (mkdirSync(dirname(join(src, p)), { recursive: true }), writeFileSync(join(src, p), t));
  // review-chaser (local) lists library.nudge, chief-of-staff (a product agent) enables it through the override, daily doesn't.
  write("instance.yaml", YAML.stringify({ product: "0".repeat(40), modules: BUNDLE, settings: { timezone: "UTC", owner_name: "Sam", owner_email: "o@example.com", product_repo: "acme/aidenhq" }, overrides: { agents: { "chief-of-staff": { skills: { add: ["library.nudge"] } } } } }));
  const agent = (name: string, skills: string[]) => ({ name, description: `${name} for acme.`, reports_to: "chief-of-staff", model: "~deepseek/deepseek-flash-latest", skills });
  write("modules/acme/module.yaml", YAML.stringify({ name: "acme", description: "Acme's agents.", agents: { "review-chaser": agent("Review Chaser", ["library.nudge"]), daily: agent("Daily", ["tasks.delegate-work"]) } }));
  write("modules/acme/agents/review-chaser/AGENTS.md", "# Review Chaser\n\nYou chase reviews.\n");
  write("modules/acme/agents/daily/AGENTS.md", "# Daily\n\nYou write the daily note.\n");
  write("modules/library/module.yaml", "name: library\ndescription: The agents' own skills and routines.\n");
  write("modules/library/skills/nudge/SKILL.md", skill("Ask once, with the PR link."));
  git(src, "init", "-q");
  git(src, "add", "-A");
  git(src, "commit", "-qm", "init");
  // The commit under review changes only the skill's text.
  git(src, "checkout", "-qb", "settings/wor-1");
  write("modules/library/skills/nudge/SKILL.md", skill("Ask once, with the PR link, and say when you will ask again."));
  git(src, "commit", "-qam", "nudge");
  const sha = git(src, "rev-parse", "HEAD");
  const bare = join(dir, "inst.git");
  git(dir, "clone", "-q", "--bare", src, bare);
  const host = localApply({ bare, instanceRepo: REPO });
  const planner = createApplyPlanner({
    instanceRepo: () => REPO, read: (s) => host.read(s), product: { onMain: async () => true, isAncestor: async () => true, log: async () => "" },
    modules: () => ({}), verifyRelease: async () => null, skills: skillSides({ product, fetch: async () => {}, tree: checkoutTree(bare) }),
  });
  const plan = await planner({ args: { repo: REPO, branch: "settings/wor-1", sha } });
  assert.deepEqual(plan.args.authority, ["skill library.nudge changed; enabled by agent chief-of-staff, review-chaser (review)"]);
  assert.match(plan.card.details, /skill library\.nudge changed; enabled by agent chief-of-staff, review-chaser \(review\)/);
});

test("a skill folder with a script is flagged as code", () => {
  const files = ["modules/library/skills/fetch/SKILL.md", "modules/library/skills/fetch/run.sh", "instance.yaml"];
  assert.deepEqual(skillLines({ files, before: { a: ["tasks.delegate-work"], b: ["library.fetch"] }, after: { a: ["library.fetch", "tasks.delegate-work"], b: [] } }), [
    "skill library.fetch changed; enabled by agent a (review)",
    "skill library.fetch has code: 1 files besides SKILL.md (review)",
    "agent a enables skill library.fetch (review)",
    "agent b stops enabling skill library.fetch",
  ]);
});
