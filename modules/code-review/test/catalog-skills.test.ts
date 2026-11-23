// The catalog's skill options against the recipe that runs them and the image that installs them: a spec the recipe refuses, a
// name the image doesn't carry, or a skill missing what its pinned SKILL.md needs fails here, not in a live review (2026-11-23:
// every skill option died on a bare name).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCatalog } from "../recipe/catalog.ts";
import { comboProblem, parseSkill, resolveSkills } from "../recipe/engines.ts";

const catalog = loadCatalog(readFileSync(new URL("../service/src/catalog.json", import.meta.url), "utf8"));
const skillOptions = catalog.filter((o) => o.kind === "skill");
const dockerfile = readFileSync(new URL("../../../services/computer/images/engineer/Dockerfile", import.meta.url), "utf8");
const pinned = new Map([...dockerfile.matchAll(/^\s*skills (\S+) ([0-9a-f]{40});/gm)].map((m) => [m[1], m[2]]));
const plugins = new Set([...dockerfile.matchAll(/for p in ([\w -]+); do cp/g)].flatMap((m) => m[1]!.split(" ")).concat([...dockerfile.matchAll(/\/opt\/review\/plugins\/([\w-]+) /g)].map((m) => m[1]!)));

// What each skill's pinned SKILL.md or command file needs, read at the catalog's pin (2026-11-23): the arguments it takes and the
// Claude Code tools beyond Agent and Bash. A skill listed here can't be configured without them.
const NEEDS: Record<string, { tools?: string[]; args: RegExp; also?: string[] }> = {
  "/compound-engineering:ce-code-review": { args: /^mode:agent base:\{base\}$/ }, // a branch or base:<sha>, never a range
  "/pr-review-toolkit:review-pr": { args: /^(comments|errors tests)$/ }, // the command's review aspects
  "/differential-review:diff-review": { args: /^HEAD --baseline \{base\}$/ }, // <commit> [--baseline <ref>]
  "/insecure-defaults:audit": { tools: ["Workflow"], args: /^\.$/ }, // its command runs a Workflow over a path
  "pashov/skills:solidity-auditor": { args: /^--loop 1$/ }, // else it asks how many passes and waits
  "mattpocock/skills:improve-codebase-architecture": { tools: ["Skill"], args: /^$/, also: ["mattpocock/skills:codebase-design"] }, // loads codebase-design through the Skill tool
};

test("every skill option's specs pass the recipe's own parser and name what the image installs, at the catalog's pin", () => {
  assert.ok(skillOptions.length > 10);
  for (const o of skillOptions) {
    assert.equal(comboProblem({ engine: `skill:${o.id}`, harness: o.run.harness, skills: o.run.skills, tools: o.run.tools, model: "~deepseek/deepseek-flash-latest", effort: "high" }), undefined, o.id);
    for (const spec of [...o.run.skills!.map((x) => x.skill), ...o.run.skills!.flatMap((x) => x.also ?? [])]) {
      const p = parseSkill(spec);
      if (p.owner) {
        assert.equal(`${p.owner}/${p.repo}`, o.source.repo, `${o.id}: ${spec} is a skill of its source repo`);
        assert.equal(pinned.get(o.source.repo), o.source.version, `${o.id}: the image pins ${o.source.repo} at the catalog's version`);
      } else if (p.plugin) assert.ok(plugins.has(p.plugin), `${o.id}: the image installs plugin ${p.plugin}`);
      else assert.fail(`${o.id}: ${spec} is a bare /<name>; use <owner>/<repo>:<name> or /<plugin>:<command>`);
    }
  }
});

test("a skill is configured with the arguments and tools its pinned file needs", () => {
  const seen = new Set<string>();
  for (const o of skillOptions) for (const s of o.run.skills!) {
    const need = NEEDS[s.skill];
    if (need) {
      seen.add(s.skill);
      assert.match(s.args, need.args, `${o.id}: ${s.skill} arguments`);
      for (const t of need.tools ?? []) assert.ok(o.run.tools?.includes(t), `${o.id}: ${s.skill} needs the ${t} tool`);
      for (const a of need.also ?? []) assert.ok(s.also?.includes(a), `${o.id}: ${s.skill} loads ${a}`);
    }
    if (s.also?.length) assert.ok(o.run.tools?.includes("Skill"), `${o.id}: a skill that loads others needs the Skill tool`);
    // A skill with no contract above is told what to review: its arguments say so.
    if (!need && !o.unavailable) assert.ok(s.args.length > 20, `${o.id}: ${s.skill} is told what to review`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(NEEDS).sort(), "every contract above is used by a catalog option");
});

test("the old bare names are refused by the catalog's parser", () => {
  assert.throws(() => parseSkill("ce-code-review"), /is \/<name>, \/<plugin>:<command> or <owner>\/<repo>:<name>/);
  assert.throws(() => parseSkill("audit-context-building insecure-defaults"), /is \/<name>/);
});

test("a multi-skill option yields every skill with its own arguments, in order", () => {
  const tob = catalog.find((o) => o.id === "sec.tob-audit")!;
  assert.equal(tob.run.skills!.length, 5);
  const root = mkdtempSync(join(tmpdir(), "cr-skills-"));
  for (const s of tob.run.skills!) mkdirSync(join(root, "plugins", parseSkill(s.skill).plugin!), { recursive: true });
  const sk = resolveSkills(tob.run.skills!, "claude-code", "abc123", root);
  assert.equal(sk.invocations.length, 5);
  assert.equal(sk.pluginDirs.length, 5);
  assert.deepEqual(sk.invocations.map((v) => v.split(" ")[0]), ["/audit-context-building:audit-context-building", "/insecure-defaults:audit", "/sharp-edges:sharp-edges", "/fp-check:fp-check", "/differential-review:diff-review"]);
  assert.equal(sk.invocations[4], "/differential-review:diff-review HEAD --baseline abc123");
});

test("a repo skill is its folder, invoked by name; its companions are linked, not invoked", () => {
  const root = mkdtempSync(join(tmpdir(), "cr-skills-"));
  for (const n of ["a", "b"]) { const f = join(root, "skills", "o__r", "x", n, "SKILL.md"); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, "---\nname: x\n---\n"); }
  const sk = resolveSkills([{ skill: "o/r:a", args: "{base}..HEAD", also: ["o/r:b"] }], "claude-code", "abc", root);
  assert.deepEqual(sk.invocations, ["/a abc..HEAD"]);
  assert.deepEqual(sk.skillDirs, [join(root, "skills", "o__r", "x", "a"), join(root, "skills", "o__r", "x", "b")]);
  assert.deepEqual(resolveSkills([{ skill: "o/r:a", args: "" }], "codex", "abc", root).invocations, ["$a"]);
  assert.throws(() => resolveSkills([{ skill: "o/r:none", args: "" }], "claude-code", "abc", root), /isn't installed from o\/r/);
});

test("a plugin skill is a plugin folder, invoked by its spec", () => {
  const root = mkdtempSync(join(tmpdir(), "cr-skills-"));
  mkdirSync(join(root, "plugins", "compound-engineering"), { recursive: true });
  assert.deepEqual(resolveSkills([{ skill: "/compound-engineering:ce-code-review", args: "mode:agent base:{base}" }], "claude-code", "abc", root),
    { invocations: ["/compound-engineering:ce-code-review mode:agent base:abc"], skillDirs: [], pluginDirs: [join(root, "plugins", "compound-engineering")] });
});
