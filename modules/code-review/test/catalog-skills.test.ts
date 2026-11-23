// The catalog's skill options against the recipe that runs them and the image that installs them: a spec the recipe refuses, a
// name the image doesn't carry, or a skill missing what its pinned SKILL.md needs fails here, not in a live review (2026-11-23:
// every skill option died on a bare name).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCatalog } from "../recipe/catalog.ts";
import { comboProblem, parseSkill, resolveSkills, runEngine, skillOutcome } from "../recipe/engines.ts";

const catalog = loadCatalog(readFileSync(new URL("../service/src/catalog.json", import.meta.url), "utf8"));
const skillOptions = catalog.filter((o) => o.kind === "skill");
const dockerfile = readFileSync(new URL("../../../services/computer/images/engineer/Dockerfile", import.meta.url), "utf8");
const pinned = new Map([...dockerfile.matchAll(/^\s*skills (\S+) ([0-9a-f]{40});/gm)].map((m) => [m[1], m[2]]));
const plugins = new Set([...dockerfile.matchAll(/for p in ([\w -]+); do cp/g)].flatMap((m) => m[1]!.split(" ")).concat([...dockerfile.matchAll(/\/opt\/review\/plugins\/([\w-]+) /g)].map((m) => m[1]!)));

// What each skill's pinned SKILL.md or command file needs, read at the catalog's pin (2026-11-23): the arguments it takes and the
// Claude Code tools beyond Agent and Bash. A skill listed here can't be configured without them.
// Every skill runs in a checkout of the head as its cwd (skillEngine), which is where these find the repo, its history and their
// report folders (solidity-auditor's `find .` and .solidity-auditor/runs/, ce-code-review's git rev-parse --show-toplevel).
const NEEDS: Record<string, { tools?: string[]; args: RegExp; also?: string[]; uncommitted?: boolean }> = {
  "/compound-engineering:ce-code-review": { args: /^mode:agent base:\{base\}$/ }, // base:<sha> on the current checkout, never a range
  // Its only arguments are review aspects; it finds the change with git status and git diff --name-only (uncommitted changes).
  "/pr-review-toolkit:review-pr": { args: /^(comments|errors tests)$/, uncommitted: true },
  "/differential-review:diff-review": { args: /^HEAD --baseline \{base\}$/ }, // <commit> [--baseline <ref>]
  "/insecure-defaults:audit": { tools: ["Workflow"], args: /^\{root\}$/ }, // its command runs a Workflow over a path: the checkout
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
      assert.equal(s.uncommitted === true, need.uncommitted === true, `${o.id}: ${s.skill} reads the change as uncommitted changes`);
      for (const t of need.tools ?? []) assert.ok(o.run.tools?.includes(t), `${o.id}: ${s.skill} needs the ${t} tool`);
      for (const a of need.also ?? []) assert.ok(s.also?.includes(a), `${o.id}: ${s.skill} loads ${a}`);
    }
    if (s.also?.length) assert.ok(o.run.tools?.includes("Skill"), `${o.id}: a skill that loads others needs the Skill tool`);
    // A skill with no contract above is told what to review: its arguments say so.
    if (!need && !o.unavailable) assert.ok(s.args.length > 20, `${o.id}: ${s.skill} is told what to review`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(NEEDS).sort(), "every contract above is used by a catalog option");
});

test("variant analysis isn't offered: it hunts variants of a bug already found, and a review has none to give it", () => {
  // Its pinned SKILL.md: "Not for initial discovery with no bug in hand."
  assert.match(String(catalog.find((o) => o.id === "cor.variant-analysis")!.unavailable), /bug already found/);
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
  const sk = resolveSkills(tob.run.skills!, "claude-code", { base: "abc123", root: "/ws" }, root);
  assert.equal(sk.invocations.length, 5);
  assert.equal(sk.pluginDirs.length, 5);
  assert.deepEqual(sk.invocations.map((v) => v.split(" ")[0]), ["/audit-context-building:audit-context-building", "/insecure-defaults:audit", "/sharp-edges:sharp-edges", "/fp-check:fp-check", "/differential-review:diff-review"]);
  assert.equal(sk.invocations[1], "/insecure-defaults:audit /ws");
  assert.match(sk.invocations[4]!, /^\/differential-review:diff-review HEAD --baseline abc123/);
});

test("a repo skill is its folder, invoked by name; its companions are linked, not invoked", () => {
  const root = mkdtempSync(join(tmpdir(), "cr-skills-"));
  for (const n of ["a", "b"]) { const f = join(root, "skills", "o__r", "x", n, "SKILL.md"); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, "---\nname: x\n---\n"); }
  const sk = resolveSkills([{ skill: "o/r:a", args: "{base}..HEAD", also: ["o/r:b"] }], "claude-code", { base: "abc", root: "/ws" }, root);
  assert.deepEqual(sk.invocations, ["/a abc..HEAD"]);
  assert.deepEqual(sk.skillDirs, [join(root, "skills", "o__r", "x", "a"), join(root, "skills", "o__r", "x", "b")]);
  assert.deepEqual(resolveSkills([{ skill: "o/r:a", args: "" }], "codex", { base: "abc", root: "/ws" }, root).invocations, ["$a"]);
  assert.throws(() => resolveSkills([{ skill: "o/r:none", args: "" }], "claude-code", { base: "abc", root: "/ws" }, root), /isn't installed from o\/r/);
});

test("a plugin skill is a plugin folder, invoked by its spec", () => {
  const root = mkdtempSync(join(tmpdir(), "cr-skills-"));
  mkdirSync(join(root, "plugins", "compound-engineering"), { recursive: true });
  assert.deepEqual(resolveSkills([{ skill: "/compound-engineering:ce-code-review", args: "mode:agent base:{base}" }], "claude-code", { base: "abc", root: "/ws" }, root),
    { invocations: ["/compound-engineering:ce-code-review mode:agent base:abc"], uncommitted: [false], skillDirs: [], pluginDirs: [join(root, "plugins", "compound-engineering")] });
});

// A repo with a base commit and a head commit that changes a.txt, and a fake `claude` on PATH. Each turn the fake appends one line
// to its log: the task, its cwd, the checkout's HEAD and its uncommitted files; it prints `init` (its slash commands), `tool` (a
// tool call, when set) and answers the restate turn with `restate`.
function fakeRun(o: { commands?: string[] | null; tool?: boolean; restate: string }) {
  const root = mkdtempSync(join(tmpdir(), "cr-repo-")), bin = mkdtempSync(join(tmpdir(), "cr-claude-")), scratch = mkdtempSync(join(tmpdir(), "cr-scratch-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q");
  writeFileSync(join(root, "a.txt"), "one\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "a.txt"), "two\n");
  writeFileSync(join(root, "b.txt"), "new\n");
  writeFileSync(join(root, ".gitignore"), "*.log\n");
  writeFileSync(join(root, ":c.log"), "forced\n"); // ignored, force-added, a name git would read as pathspec magic
  git("add", "."); git("--literal-pathspecs", "add", "-f", "--", ":c.log"); git("commit", "-qm", "head");
  const head = git("rev-parse", "HEAD");
  mkdirSync(join(root, "plugins", "p"), { recursive: true });
  const log = join(bin, "log");
  const init = o.commands === null ? "" : `echo '${JSON.stringify({ type: "system", subtype: "init", session_id: "s", slash_commands: o.commands ?? ["p:one", "p:two"] })}'`;
  const tool = o.tool === false ? "" : `echo '${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } })}'`;
  const result = (r: string) => JSON.stringify({ type: "result", subtype: "success", session_id: "s", result: r }).replace(/'/g, "'\\''");
  writeFileSync(join(bin, "claude"), `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$(echo "$2" | head -1 | cut -c1-20)" "$PWD" "$(git rev-parse HEAD)" "$(git diff --name-only | tr '\\n' ' ')" >> '${log}'
${init}
case "$2" in
  "Now restate"*) echo '${result(o.restate)}' ;;
  *) ${tool}
     echo '${result("done")}' ;;
esac
`);
  chmodSync(join(bin, "claude"), 0o755);
  const run = async (skills: { skill: string; args: string; uncommitted?: boolean }[]) => {
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try { return await runEngine("skill:x", { prompt: "", instructions: "x", model: "m/m", effort: "low", root, base, minutes: 1, scratch, own: true, harness: "claude-code", skills, skillsRoot: root }); } finally { process.env.PATH = path; }
  };
  const turns = () => readFileSync(log, "utf8").trim().split("\n").map((l) => { const [task, cwd, at, dirty] = l.split("|"); return { task, cwd, at, dirty: dirty!.trim() }; });
  return { root, base, head, run, turns };
}
const ran = (...r: boolean[]) => JSON.stringify({ findings: [], stale_guidance: [], skills: r.map((x, i) => ({ skill: `/p:${["one", "two"][i]}`, ran: x, why: x ? "" : "it found no change to review" })) });

test("a skill runs in a checkout of the head; one that reads uncommitted changes sees the change as them, for its turn only", async () => {
  const f = fakeRun({ restate: ran(true, true) });
  const r = await f.run([{ skill: "/p:one", args: "base:{base} at {root}", uncommitted: true }, { skill: "/p:two", args: "" }]);
  assert.equal(r.cause, undefined);
  assert.equal(r.read, true);
  assert.equal(r.incomplete, undefined);
  const [one, two, restate] = f.turns();
  assert.notEqual(one!.cwd, f.root, "never the review's own checkout");
  assert.ok(one!.cwd!.endsWith("/repo"));
  assert.equal(readFileSync(join(one!.cwd!, "a.txt"), "utf8"), "two\n", "the head's files");
  assert.match(one!.task!, /^\/p:one base:[0-9a-f]{7}/);
  assert.deepEqual([one!.at, one!.dirty], [f.base, ".gitignore :c.log a.txt b.txt"], "uncommitted: HEAD at the base, the change (added files too) uncommitted");
  assert.deepEqual([two!.at, two!.dirty, two!.cwd], [f.head, "", one!.cwd], "the next skill: the head, clean, same checkout");
  assert.deepEqual([restate!.at, restate!.dirty], [f.head, ""]);
});

test("a skill that didn't review the code is never a clean review", async () => {
  // It answered, but said it couldn't find its scope: the restate says so.
  const skipped = await fakeRun({ restate: ran(false, false) }).run([{ skill: "/p:one", args: "" }, { skill: "/p:two", args: "" }]);
  assert.match(String(skipped.cause), /no skill reviewed the code \(\/p:one: it found no change/);
  assert.equal(skipped.read, false);
  // One of two skipped: a review, incomplete.
  const half = await fakeRun({ restate: ran(true, false) }).run([{ skill: "/p:one", args: "" }, { skill: "/p:two", args: "" }]);
  assert.equal(half.read, true);
  assert.match(String(half.incomplete), /\/p:two: it found no change/);
  // A restate with empty findings and no word on the skills, or the skill's own failed status, is no review.
  for (const restate of [JSON.stringify({ findings: [], stale_guidance: [] }), JSON.stringify({ status: "failed", reason: "no base" })]) {
    const r = await fakeRun({ restate }).run([{ skill: "/p:one", args: "" }]);
    assert.match(String(r.cause), /didn't say whether each skill reviewed the code/);
    assert.equal(r.read, false);
  }
  // A skill that called no tool read nothing, whatever the restate claims; one Claude Code doesn't list, or a run that lists none,
  // didn't run.
  assert.match(String((await fakeRun({ tool: false, restate: ran(true) }).run([{ skill: "/p:one", args: "" }])).cause), /no skill reviewed the code \(\/p:one: it called no tool/);
  assert.match(String((await fakeRun({ commands: ["other"], restate: ran(true) }).run([{ skill: "/p:one", args: "" }])).cause), /has no skill p:one/);
  assert.match(String((await fakeRun({ commands: null, restate: ran(true) }).run([{ skill: "/p:one", args: "" }])).cause), /has no skill p:one/);
});

test("the restated skill list is read in order and must cover every skill", () => {
  const r = { message: "", read: true };
  assert.match(String(skillOutcome({ ...r, message: ran(true) }, ["/p:one", "/p:two"]).cause), /didn't say/);
  assert.equal(skillOutcome({ ...r, message: "```json\n" + ran(true, true) + "\n```" }, ["/p:one", "/p:two"]).read, true);
});
