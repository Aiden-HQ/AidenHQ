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
import { comboProblem, parseSkill, resolveSkills, runEngine, shellGuard, skillOutcome } from "../recipe/engines.ts";

const catalog = loadCatalog(readFileSync(new URL("../service/src/catalog.json", import.meta.url), "utf8"));
const skillOptions = catalog.filter((o) => o.kind === "skill");
const dockerfile = readFileSync(new URL("../../../services/computer/images/engineer/Dockerfile", import.meta.url), "utf8");
const pinned = new Map([...dockerfile.matchAll(/^\s*skills (\S+) ([0-9a-f]{40});/gm)].map((m) => [m[1], m[2]]));
const plugins = new Set([...dockerfile.matchAll(/for p in ([\w -]+); do cp/g)].flatMap((m) => m[1]!.split(" ")).concat([...dockerfile.matchAll(/\/opt\/review\/plugins\/([\w-]+) /g)].map((m) => m[1]!)));

// What each skill's pinned SKILL.md or command file needs, read at the catalog's pin (2026-11-23): the arguments it takes and the
// Claude Code tools beyond Agent and Bash. A skill listed here can't be configured without them.
// Every skill runs in a checkout of the head as its cwd (skillEngine), which is where these find the repo, its history and their
// report folders (solidity-auditor's `find .` and .solidity-auditor/runs/, ce-code-review's git rev-parse --show-toplevel).
// `tree`: its contract in a whole-repo review (base: the empty tree's commit), or false when it reviews only a change.
const NEEDS: Record<string, { tools?: string[]; args: RegExp; also?: string[]; uncommitted?: boolean; tree?: RegExp | false }> = {
  // base:<sha> on the current checkout, never a range. Its pinned scope.md takes any commit as base: (git merge-base HEAD <base>,
  // else the base itself, then git diff <base>), and it has no directory mode: in a whole-repo review the base is the empty tree's
  // commit, so every file is the change.
  "/compound-engineering:ce-code-review": { args: /^mode:agent base:\{base\}$/, tree: /^mode:agent base:\{base\}$/ },
  // Its only arguments are review aspects; it finds the change with git status and git diff --name-only (uncommitted changes).
  "/pr-review-toolkit:review-pr": { args: /^(comments|errors tests)$/, uncommitted: true },
  "/differential-review:diff-review": { args: /^HEAD --baseline \{base\}$/, tree: false }, // <commit> [--baseline <ref>]: a diff only
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
    // A whole-repo review (one_off) runs its tree contract: the one above, else arguments about the whole repo, never "the change".
    if (!o.modes.includes("one_off") || o.unavailable) continue;
    if (need?.tree !== undefined) {
      assert.equal(s.tree === false, need.tree === false, `${o.id}: ${s.skill} runs on a whole repo`);
      if (need.tree) assert.match(s.tree ?? s.args, need.tree, `${o.id}: ${s.skill} whole-repo arguments`);
    } else if (s.tree !== false) assert.doesNotMatch(s.tree ?? s.args, /\{base\}|\bchange\b/, `${o.id}: ${s.skill} has a whole-repo contract`);
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
  // A whole-repo review: the four that read a tree, each with its whole-repo arguments; the diff review is left out.
  const tree = resolveSkills(tob.run.skills!, "claude-code", { base: "abc123", root: "/ws", target: "tree" }, root);
  assert.deepEqual(tree.invocations.map((v) => v.split(" ")[0]), ["/audit-context-building:audit-context-building", "/insecure-defaults:audit", "/sharp-edges:sharp-edges", "/fp-check:fp-check"]);
  assert.ok(tree.invocations.every((v) => !v.includes("abc123")), "no change range in a whole-repo review");
  assert.throws(() => resolveSkills([{ skill: "/differential-review:diff-review", args: "x", tree: false }], "claude-code", { base: "a", root: "/ws", target: "tree" }, root), /none of the option's skills runs on a whole repo/);
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
// `dead`: the shell's error text; the fake's every Bash call fails with it, then it hangs (a run that would burn its time).
function fakeRun(o: { commands?: string[] | null; tool?: boolean; restate: string; dead?: string }) {
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
  const dead = o.dead === undefined ? "" : [1, 2].map((n) => `printf '%s\\n' '${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `b${n}`, name: "Bash", input: { command: "git status" } }] } })}'
printf '%s\\n' '${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `b${n}`, is_error: true, content: o.dead }] } })}'`).join("\n") + "\nsleep 30";
  const result = (r: string) => JSON.stringify({ type: "result", subtype: "success", session_id: "s", result: r }).replace(/'/g, "'\\''");
  writeFileSync(join(bin, "claude"), `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$(echo "$2" | head -1 | cut -c1-20)" "$PWD" "$(git rev-parse HEAD)" "$(git diff --name-only | tr '\\n' ' ')" >> '${log}'
cp "$CLAUDE_CONFIG_DIR/settings.json" '${bin}/settings.json'
test "$CLAUDE_CONFIG_DIR" = "$HOME/.claude" && echo "\${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB-unset}" > '${bin}/scrub'
${init}
${dead}
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
  return { root, base, head, run, turns, scrub: () => readFileSync(join(bin, "scrub"), "utf8").trim(), settings: () => JSON.parse(readFileSync(join(bin, "settings.json"), "utf8")) };
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

test("Claude Code runs with its own sandbox off (gVisor refuses its network namespace), in the recipe's jail instead", async () => {
  const f = fakeRun({ restate: ran(true) });
  assert.equal((await f.run([{ skill: "/p:one", args: "" }])).cause, undefined);
  assert.deepEqual(f.settings(), { sandbox: { enabled: false } }); // in the config dir claude reads (HOME/.claude)
  assert.equal(f.scrub(), "unset", "its env scrub makes Claude Code require a sandbox gVisor can't start");
});

test("a run whose shell can't run ends at once, never spending the review", async () => {
  const t0 = Date.now();
  const f = fakeRun({ restate: ran(true), dead: "Exit code 1\nbwrap: loopback: Failed RTM_NEWADDR: No child processes" });
  const r = await f.run([{ skill: "/p:one", args: "" }, { skill: "/p:two", args: "" }]);
  assert.match(String(r.cause), /the shell can't run commands \(bwrap: loopback/);
  assert.equal(r.read, false);
  assert.equal(f.turns().length, 1, "no later skill or restate turn");
  assert.ok(Date.now() - t0 < 15_000, "killed, not waited out");
});

test("the shell guard: a known dead shell, or the first commands failing with one same error, ends the run; one that worked disarms it", () => {
  const g = shellGuard();
  assert.equal(g(false, "Exit code 1\ngrep: a: No such file"), undefined);
  assert.match(String(g(false, "bwrap: Creating new namespace failed")), /can't run commands/);
  // A command's own output that mentions the sandbox (a diff of this very file) is a command that ran.
  assert.equal(shellGuard()(false, "Exit code 1\ndiff --git a/x b/x\n+bwrap: loopback: Failed RTM_NEWADDR"), undefined);
  assert.equal(shellGuard()(false, "Exit code 1\nbwrap: loopback: Failed RTM_NEWADDR\n(a saved log)\ncheck failed"), undefined);
  // Commands that ran and failed quietly (grep with no match) or differently are a skill's business.
  const quiet = shellGuard();
  for (let i = 0; i < 9; i++) assert.equal(quiet(false, i % 2 ? "Exit code 1" : `Exit code 2\nrg: f${i}: not found`), undefined);
  // Only the first commands count: a first failure unlike the next ones is a shell that runs.
  const later = shellGuard();
  for (const o of ["Exit code 1\nno such file", "Exit code 128\nfatal: bad revision", "Exit code 128\nfatal: bad revision", "Exit code 128\nfatal: bad revision"]) assert.equal(later(false, o), undefined);
  const same = shellGuard();
  assert.equal(same(false, "Exit code 126\nsh: permission denied"), undefined);
  assert.equal(same(false, "Exit code 126\nsh: permission denied"), undefined);
  assert.match(String(same(false, "Exit code 126\nsh: permission denied")), /first 3 commands all failed with the same error \(sh: permission denied\)/);
  const worked = shellGuard();
  assert.equal(worked(true, "ok"), undefined);
  for (let i = 0; i < 9; i++) assert.equal(worked(false, "bwrap: x"), undefined);
});

// The real Claude Code binary (where it is installed: the engineer image, a developer's machine) with the recipe's own settings,
// against a stub model that asks for one Bash command: the command runs and its output comes back (2026-11-23: inside the box
// Claude Code's sandbox failed every command with "bwrap: loopback").
// It runs where claude is installed (the engineer image under gVisor, a developer's machine).
const hasClaude = (() => { try { execFileSync("sh", ["-c", "command -v claude"]); return true; } catch { return false; } })();
test("a Claude Code run's shell executes a command", { skip: !hasClaude && "claude isn't here" }, async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      const last = j.messages?.at(-1)?.content;
      const result = Array.isArray(last) ? last.find((c: { type?: string }) => c.type === "tool_result") : undefined;
      const block = !j.tools?.length ? { type: "text", text: "ok" }
        : result ? { type: "text", text: `RESULT ${JSON.stringify(result.content)} error=${result.is_error === true}` }
        : { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: `echo shell-$((6*7)) > out.txt && cat out.txt`, description: "probe" } };
      const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
      const msg = { id: "msg_1", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } };
      if (!j.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...msg, content: [block], stop_reason: stop })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, d: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
      ev("message_start", { message: msg });
      ev("content_block_start", { index: 0, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
      ev("content_block_delta", { index: 0, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
      ev("message_stop", {});
      res.end();
    });
  });
  const repo = mkdtempSync(join(tmpdir(), "cr-shell-"));
  execFileSync("git", ["init", "-q", repo]);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const saved = { base: process.env.OPENROUTER_BASE_URL, key: process.env.OPENROUTER_API_KEY };
  Object.assign(process.env, { OPENROUTER_BASE_URL: url, OPENROUTER_API_KEY: "test-token" });
  try {
    const r = await runEngine("claude-code", { prompt: "run the probe", instructions: "x", model: "m/m", effort: "low", root: repo, base: "HEAD", minutes: 2, scratch: mkdtempSync(join(tmpdir(), "cr-scratch-")) });
    assert.equal(r.cause, undefined);
    assert.match(r.message, /RESULT .*shell-42.* error=false/);
  } finally {
    for (const [k, v] of [["OPENROUTER_BASE_URL", saved.base], ["OPENROUTER_API_KEY", saved.key]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    server.close();
  }
});
