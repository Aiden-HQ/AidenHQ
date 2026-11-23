// The catalog's skill options against the recipe that runs them and the image that installs them: a spec the recipe refuses, or
// names the image doesn't carry, fails here, not in a live review (2026-11-23: every skill option died on a bare name).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCatalog } from "../recipe/catalog.ts";
import { parseSkill, resolveSkills } from "../recipe/engines.ts";

const catalog = loadCatalog(readFileSync(new URL("../service/src/catalog.json", import.meta.url), "utf8"));
const skillOptions = catalog.filter((o) => o.kind === "skill");
const dockerfile = readFileSync(new URL("../../../services/computer/images/engineer/Dockerfile", import.meta.url), "utf8");
const pinned = new Map([...dockerfile.matchAll(/^\s*skills (\S+) ([0-9a-f]{40});/gm)].map((m) => [m[1], m[2]]));
const plugins = new Set([...(/for p in ([\w -]+); do cp/.exec(dockerfile)?.[1] ?? "").split(" "), ...[...dockerfile.matchAll(/\/opt\/review\/plugins\/([\w-]+) /g)].map((m) => m[1])]);

test("every skill option's specs pass the recipe's own parser and name what the image installs, at the catalog's pin", () => {
  assert.ok(skillOptions.length > 10);
  for (const o of skillOptions) {
    for (const spec of o.run.skills!) {
      const p = parseSkill(spec);
      if ("repo" in p) {
        assert.equal(`${p.owner}/${p.repo}`, o.source.repo, `${o.id}: ${spec} is a skill of its source repo`);
        assert.equal(pinned.get(o.source.repo), o.source.version, `${o.id}: the image pins ${o.source.repo} at the catalog's version`);
      } else if (p.plugin) assert.ok(plugins.has(p.plugin), `${o.id}: the image installs plugin ${p.plugin}`);
      else assert.fail(`${o.id}: ${spec} is a bare /<name>; use <owner>/<repo>:<name> or /<plugin>:<command>`);
    }
  }
});

test("the old bare names are refused by the catalog's parser", () => {
  assert.throws(() => parseSkill("ce-code-review"), /is \/<name>, \/<plugin>:<command> or <owner>\/<repo>:<name>/);
  assert.throws(() => parseSkill("audit-context-building insecure-defaults"), /is \/<name>/);
});

test("a multi-skill option yields every skill, each from its own folder, in order", () => {
  const tob = catalog.find((o) => o.id === "sec.tob-audit")!;
  assert.equal(tob.run.skills!.length, 5);
  const root = mkdtempSync(join(tmpdir(), "cr-skills-"));
  for (const s of tob.run.skills!) {
    const name = s.split(":")[1]!;
    const f = join(root, "skills", "trailofbits__skills", "plugins", name, "skills", name, "SKILL.md");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "---\nname: x\n---\n");
  }
  const sk = resolveSkills(tob.run.skills!, "claude-code", root);
  assert.deepEqual(sk.invocations, ["/audit-context-building", "/insecure-defaults", "/sharp-edges", "/fp-check", "/differential-review"]);
  assert.equal(sk.skillDirs.length, 5);
  assert.deepEqual(resolveSkills(tob.run.skills!, "codex", root).invocations.slice(0, 2), ["$audit-context-building", "$insecure-defaults"]);
  assert.throws(() => resolveSkills(["trailofbits/skills:no-such-skill"], "claude-code", root), /isn't installed from trailofbits\/skills/);
});

test("a plugin skill is a plugin folder, invoked by its spec", () => {
  const root = mkdtempSync(join(tmpdir(), "cr-skills-"));
  mkdirSync(join(root, "plugins", "compound-engineering"), { recursive: true });
  assert.deepEqual(resolveSkills(["/compound-engineering:ce-code-review"], "claude-code", root),
    { invocations: ["/compound-engineering:ce-code-review"], skillDirs: [], pluginDirs: [join(root, "plugins", "compound-engineering")] });
});
