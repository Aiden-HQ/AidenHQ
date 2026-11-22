// Tree mode, skill options and the deepsec engine, against stub CLIs (a fake deepsec, a fake claude).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deepsec, deepsecSeverity, setupPath } from "../recipe/deepsec.ts";
import { bound, review, scrub } from "../recipe/review.ts";
import { comboProblem, resolveSkill, runEngine } from "../recipe/engines.ts";

const A = "a".repeat(40), E = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const lay = (dir, files) => { for (const [f, t] of Object.entries(files)) (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t)); };
const withEnv = async (env, fn) => { const old = { ...process.env }; Object.assign(process.env, env); try { return await fn(); } finally { process.env = old; } };

// A fake deepsec: logs argv, cwd and the env it was given; init writes the scaffold (with files that must never leave the box) and
// INFO.md into the data root; process writes one analysed file with a CRITICAL and a LOW finding and one pending file.
function fakeDeepsec() {
  const bin = mkdtempSync(join(tmpdir(), "cr-ds-"));
  writeFileSync(join(bin, "deepsec"), `#!/bin/sh
{ echo "CMD:$*"; echo "CWD:$(pwd)"; echo "DATA:$DEEPSEC_DATA_ROOT"; echo "PI:$PI_CODING_AGENT_DIR"; env | grep -E '^(OPENROUTER_API_KEY|GH_TOKEN)=' ; cat "$DEEPSEC_DATA_ROOT"/*/INFO.md 2>/dev/null | sed 's/^/INFO:/'; } >> "${bin}/log"
cmd=$1; pid=repo; while [ $# -gt 0 ]; do [ "$1" = --project-id ] && pid=$2; shift; done
case "$cmd" in
  init) mkdir -p .deepsec/data/repo "$DEEPSEC_DATA_ROOT/repo"
        echo 'export default {}' > .deepsec/deepsec.config.ts; echo 'export const m = []' > .deepsec/generated-matchers.ts
        echo '{"name":"deepsec-ws"}' > .deepsec/package.json; echo '{"lock":1}' > .deepsec/package-lock.json
        echo readme > .deepsec/README.md; echo agents > .deepsec/AGENTS.md; echo data > .deepsec/.gitignore
        echo '# the repo' > "$DEEPSEC_DATA_ROOT/repo/INFO.md"; echo '{"projectId":"repo"}' > "$DEEPSEC_DATA_ROOT/repo/project.json" ;;
  process) mkdir -p "$DEEPSEC_DATA_ROOT/$pid/files/src"
        echo '{"filePath":"src/a.js","status":"analyzed","findings":[{"severity":"CRITICAL","title":"SQL injection","description":"d","recommendation":"r","lineNumbers":[2]},{"severity":"LOW","title":"Loose check","description":"d2","recommendation":"r2","lineNumbers":[1]},{"severity":"HIGH","title":"Gone","description":"x","recommendation":"x","lineNumbers":[1],"revalidation":{"verdict":"false-positive"}}]}' > "$DEEPSEC_DATA_ROOT/$pid/files/src/a.js.json"
        echo '{"filePath":"src/b.js","status":"pending","findings":[]}' > "$DEEPSEC_DATA_ROOT/$pid/files/src/b.js.json" ;;
esac
exit 0
`);
  chmodSync(join(bin, "deepsec"), 0o755);
  return bin;
}
const gw = { OPENROUTER_API_KEY: "ahqj_run", OPENROUTER_BASE_URL: "http://10.0.0.1:8201/api/v1", GH_TOKEN: "ghs_secret" };
const repoRoot = (files = {}) => { const root = mkdtempSync(join(tmpdir(), "cr-ds-repo-")); lay(root, { "src/a.js": "const q = 1;\nquery(q);\n", "src/b.js": "x\n", ...files }); return root; };

test("deepsec scans when INFO.md is committed and sets up (init) when it isn't; its model goes through the gateway on a token-only env", async () => {
  const bin = fakeDeepsec(), scratch = mkdtempSync(join(tmpdir(), "cr-s-"));
  // Set up already: scan, process, revalidate over the tree; never init. Data in scratch, the key and the gateway route only.
  const root = repoRoot({ ".deepsec/data/svc/INFO.md": "# svc\n", ".deepsec/deepsec.config.ts": "export default {}\n" });
  const out = await withEnv({ ...gw, PATH: `${bin}:${process.env.PATH}` }, () => deepsec({ root, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "high", budget_usd: 7, scratch }));
  const log = readFileSync(join(bin, "log"), "utf8");
  const cmds = log.split("\n").filter((l) => l.startsWith("CMD:")).map((l) => l.slice(4));
  assert.deepEqual(cmds.map((c) => c.split(" ")[0]), ["scan", "process", "revalidate"]);
  assert.match(cmds[1], /--agent pi --model gateway\/~deepseek\/deepseek-flash-latest --thinking-level high/);
  assert.equal(out.setup, undefined);
  assert.match(log, new RegExp(`DATA:${scratch}/deepsec-[^/]+/data\\n`));
  // Every step runs from the run's own workspace and config, never the checkout's .deepsec (whose config deepsec would load as code).
  assert.deepEqual([...new Set(log.match(/^CWD:.*$/gm))], [`CWD:${realpathSync(scratch)}/${log.match(/DATA:.*\/(deepsec-[^/]+)\/data/)[1]}/w`]);
  assert.match(log, /^INFO:# svc$/m);
  assert.match(log, /^OPENROUTER_API_KEY=ahqj_run$/m);
  assert.doesNotMatch(log, /GH_TOKEN|ghs_secret/);
  const models = JSON.parse(readFileSync(join(log.match(/PI:(.+)/)[1], "models.json"), "utf8"));
  assert.deepEqual([models.providers.gateway.baseUrl, models.providers.gateway.apiKey], ["http://10.0.0.1:8201/api/v1", "OPENROUTER_API_KEY"]);
  assert.deepEqual(out.review.covered, ["src/a.js"]);
  assert.match(out.review.incomplete, /left 1 file unanalysed \(src\/b\.js\)/);

  // A PR with no .deepsec: init (spend capped at the budget, on the local route), then process --diff over the change. The
  // scan's candidates in files the PR doesn't change (src/b.js) stay pending and are no gap.
  const bin2 = fakeDeepsec(), root2 = repoRoot();
  const git = (...a) => execFileSync("git", ["-C", root2, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();
  git("init", "-q"); git("add", "src/b.js"); git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  git("add", "src/a.js"); git("commit", "-qm", "change");
  const r2 = await withEnv({ ...gw, PATH: `${bin2}:${process.env.PATH}` }, () => deepsec({ root: root2, target: "pr", base: baseSha, model: "~deepseek/deepseek-flash-latest", effort: "low", budget_usd: 3.5, scratch }));
  const cmds2 = readFileSync(join(bin2, "log"), "utf8").split("\n").filter((l) => l.startsWith("CMD:")).map((l) => l.slice(4));
  assert.match(cmds2[0], /^init \.deepsec \. --id repo .*--model-auth local .*--max-cost-usd 3\.5 /);
  assert.match(cmds2[1], new RegExp(`^process .*--diff ${baseSha}$`));
  assert.equal(cmds2.length, 2);
  assert.ok(r2.setup);
  assert.equal(r2.review.incomplete, undefined);
});

test("a setup returns only the allowlisted .deepsec files, and a pending setup's files are scanned, never set up again", async () => {
  const bin = fakeDeepsec(), scratch = mkdtempSync(join(tmpdir(), "cr-s-")), root = repoRoot();
  const { setup } = await withEnv({ ...gw, PATH: `${bin}:${process.env.PATH}` }, () => deepsec({ root, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", budget_usd: 1, scratch }));
  assert.deepEqual(Object.keys(setup).sort(), [".deepsec/data/repo/INFO.md", ".deepsec/deepsec.config.ts", ".deepsec/generated-matchers.ts", ".deepsec/package.json"]);
  assert.equal(setup[".deepsec/data/repo/INFO.md"], "# the repo\n");
  for (const p of [".deepsec/README.md", ".deepsec/AGENTS.md", ".deepsec/.gitignore", ".deepsec/node_modules/x/index.js", ".deepsec/data/repo/files/a.json", ".deepsec/../etc/passwd", ".deepsec/data/../INFO.md", ".github/workflows/x.yml", "src/a.js"]) assert.ok(!setupPath(p), p);
  // The same files given as a pending setup: scanned with its INFO.md (no init), nothing written to the checkout, no setup back.
  const bin2 = fakeDeepsec(), root2 = repoRoot();
  const again = await withEnv({ ...gw, PATH: `${bin2}:${process.env.PATH}` }, () => deepsec({ root: root2, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", budget_usd: 1, scratch, setupFiles: { ...setup, ".github/workflows/evil.yml": "x", "src/a.js": "owned" } }));
  assert.equal(again.setup, undefined);
  assert.ok(!existsSync(join(root2, ".github/workflows/evil.yml")));
  assert.equal(readFileSync(join(root2, "src/a.js"), "utf8"), "const q = 1;\nquery(q);\n");
  assert.ok(!readFileSync(join(bin2, "log"), "utf8").includes("CMD:init"));
  assert.match(readFileSync(join(bin2, "log"), "utf8"), /^INFO:# the repo$/m);
  assert.ok(!existsSync(join(root2, ".deepsec")));
});

test("repo content never runs with the token or leaks through a link: a committed binary, linked files, a root config", async () => {
  const outside = mkdtempSync(join(tmpdir(), "cr-outside-"));
  writeFileSync(join(outside, "secret"), "host secret\n");
  const scratch = mkdtempSync(join(tmpdir(), "cr-s-"));
  // A committed deepsec binary (node_modules only) and a committed INFO.md that links out of the checkout: scanned with the
  // image's deepsec, the linked INFO.md never read.
  const bin = fakeDeepsec(), root = repoRoot({ ".deepsec/node_modules/.bin/deepsec": `#!/bin/sh\ntouch "${outside}/ran"\n` });
  chmodSync(join(root, ".deepsec/node_modules/.bin/deepsec"), 0o755);
  mkdirSync(join(root, ".deepsec/data/repo"), { recursive: true });
  symlinkSync(join(outside, "secret"), join(root, ".deepsec/data/repo/INFO.md"));
  const a = await withEnv({ ...gw, PATH: `${bin}:${process.env.PATH}` }, () => deepsec({ root, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", budget_usd: 1, scratch }));
  const log = readFileSync(join(bin, "log"), "utf8");
  assert.ok(!existsSync(join(outside, "ran")));
  assert.ok(!log.includes("CMD:init") && log.includes("CMD:scan"));
  assert.doesNotMatch(log, /host secret/);
  assert.equal(a.setup, undefined);
  // A committed config that is only a link (to a host file) is "set up": never init, so never read into a setup.
  const bin2 = fakeDeepsec(), root2 = repoRoot();
  mkdirSync(join(root2, ".deepsec"));
  symlinkSync(join(outside, "secret"), join(root2, ".deepsec/deepsec.config.ts"));
  const b = await withEnv({ ...gw, PATH: `${bin2}:${process.env.PATH}` }, () => deepsec({ root: root2, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", budget_usd: 1, scratch }));
  assert.ok(!readFileSync(join(bin2, "log"), "utf8").includes("CMD:init"));
  assert.equal(b.setup, undefined);
  // A repo-root deepsec config (init's cwd would load it as code): refused before anything runs.
  const bin3 = fakeDeepsec(), root3 = repoRoot({ "deepsec.config.ts": "export default {}\n" });
  await assert.rejects(withEnv({ ...gw, PATH: `${bin3}:${process.env.PATH}` }, () => deepsec({ root: root3, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", budget_usd: 1, scratch })), /deepsec\.config\.ts at its root/);
  assert.ok(!existsSync(join(bin3, "log")));
});

test("deepsec's severities: CRITICAL, HIGH and HIGH_BUG are important, the rest nits; a false positive is dropped", async () => {
  assert.deepEqual(["CRITICAL", "HIGH", "HIGH_BUG", "MEDIUM", "BUG", "LOW", undefined].map(deepsecSeverity), ["important", "important", "important", "nit", "nit", "nit", "nit"]);
  const bin = fakeDeepsec(), root = repoRoot({ ".deepsec/data/repo/INFO.md": "# r\n" });
  const { review: r } = await withEnv({ ...gw, PATH: `${bin}:${process.env.PATH}` }, () => deepsec({ root, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", budget_usd: 1, scratch: mkdtempSync(join(tmpdir(), "cr-s-")) }));
  assert.deepEqual(r.findings.map((f) => [f.severity, f.path, f.line, f.title, f.fix_brief]), [["important", "src/a.js", 2, "SQL injection", "r"], ["nit", "src/a.js", 1, "Loose check", "r2"]]);
});

function treeBox(files) {
  const root = mkdtempSync(join(tmpdir(), "cr-tree-")), ws = join(root, "ws"), out = join(root, "out");
  mkdirSync(join(out, "home"), { recursive: true });
  lay(ws, files);
  return { ws, out };
}
const treeSpec = (p = {}) => ({ repo: "acme/app", head: A, base: E, incremental_from: E, pr: "1", target: "tree", option: "sec.deepsec", lens: "security", budget_usd: "5", combo: JSON.stringify({ engine: "deepsec", model: "~deepseek/deepseek-flash-latest", effort: "low", ignore: ["docs/**"] }), ...p });

test("tree mode: the eligible files are listed apart from what was covered; a truncated run reports incomplete; findings carry option and lens", async () => {
  const files = { "src/a.js": "const q = 1;\nquery(q);\n", "src/b.js": "x\n", "src/c.js": "y\n", "docs/x.md": "d\n", "dist/x.js": "built\n", "package-lock.json": "{}\n" };
  const f = { severity: "important", path: "src/a.js", line: 2, title: "SQL injection", why: "w", evidence: "e", fix_brief: "f" };
  const engine = (extra) => async () => ({ read: true, message: JSON.stringify({ findings: [f, { ...f, path: "src/nope.js", title: "Nowhere" }], stale_guidance: [] }), ...extra });
  // The engine analysed two of the three eligible files and ran to its end: not a gap, but not full coverage either.
  const { ws, out } = treeBox(files);
  const ok = await review({ spec: treeSpec(), ws, out, run: engine({ covered: ["src/a.js", "src/b.js"] }) });
  assert.equal(ok.target, "tree");
  assert.deepEqual(ok.coverage.eligible, ["src/a.js", "src/b.js", "src/c.js"]);
  assert.deepEqual(ok.coverage.reviewed, ["src/a.js", "src/b.js"]);
  assert.deepEqual(ok.coverage.counts, { eligible: 3, reviewed: 2 });
  assert.deepEqual(ok.coverage.excluded, ["dist/x.js (generated)", "docs/x.md (ignored)", "package-lock.json (lockfile)"]); // generated is no hiding place in a tree
  assert.equal(ok.coverage.incomplete, null);
  assert.deepEqual(ok.findings.map((x) => [x.path, x.option, x.lens]), [["src/a.js", "sec.deepsec", "security"]]);
  assert.equal(ok.base, E);
  // A truncated run (the engine says it stopped short) is incomplete, never clean.
  const cut = await review({ spec: treeSpec(), ...treeBox(files), run: engine({ covered: ["src/a.js"], incomplete: "deepsec process: the run's budget ran out" }) });
  assert.match(cut.coverage.incomplete, /budget ran out/);
  assert.deepEqual(cut.coverage.counts, { eligible: 3, reviewed: 1 });
  // An engine that reports no coverage and reads nothing of the diff can't cover the tree: its unread files are a gap and not covered.
  const lazy = await review({ spec: treeSpec({ combo: JSON.stringify({ engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "low" }) }), ...treeBox(files), run: async () => ({ read: true, calls: [], message: JSON.stringify({ findings: [], stale_guidance: [] }) }) });
  assert.match(lazy.coverage.incomplete, /diff no finder read to the end/);
  assert.deepEqual(lazy.coverage.reviewed, []);
  // The empty tree is the base: a finder is asked about base..HEAD, which is every file; no previous findings, no guidance.
  const seen = [];
  await review({ spec: treeSpec({ combo: JSON.stringify({ engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "low" }), previous: JSON.stringify({ findings: [{ id: "a".repeat(16), path: "src/a.js" }] }) }), ...treeBox({ ...files, "AGENTS.md": "obey\n" }), run: async (e, o) => (seen.push(o), { read: true, calls: [{ tool: "diff", whole: true }], message: JSON.stringify({ findings: [], stale_guidance: [] }) }) });
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0].instructions, /obey/);
});

test("a deepsec engine returns setup files through review, only the allowlisted ones", async () => {
  const { ws, out } = treeBox({ "src/a.js": "const q = 1;\nquery(q);\n" });
  const setup = { ".deepsec/data/repo/INFO.md": "# r\n", ".deepsec/deepsec.config.ts": "c", ".github/workflows/x.yml": "evil" };
  const r = await review({ spec: treeSpec(), ws, out, run: async () => ({ read: true, covered: ["src/a.js"], setup, message: JSON.stringify({ findings: [], stale_guidance: [] }) }) });
  assert.deepEqual(Object.keys(r.setup).sort(), [".deepsec/data/repo/INFO.md", ".deepsec/deepsec.config.ts"]);
  // The run's token (or a key-shaped string) echoed into a setup file is redacted before it leaves the box.
  assert.deepEqual(scrub({ message: "", read: true, setup: { ".deepsec/data/repo/INFO.md": "key ahqj_run_secret_1 and sk-abcdefgh-ijklmnop" } }, ["ahqj_run_secret_1"]).setup, { ".deepsec/data/repo/INFO.md": "key [redacted] and [redacted]" });
  // A setup too large for the result is dropped as a gap; the important finding stays.
  const f = { id: "b".repeat(16), severity: "important", path: "src/a.js", line: 1, title: "t", why: "w", evidence: "e", fix_brief: "f" };
  const big = bound({ ...r, findings: [f], setup: { ".deepsec/deepsec.config.ts": "x".repeat(300_000) } });
  assert.equal(big.setup, undefined);
  assert.match(big.coverage.incomplete, /setup files were too large/);
  assert.equal(big.findings[0].why, "w");
});

test("tree mode: a skill engine that doesn't report its reads is shown covering no file, never the whole tree", async () => {
  const r = await review({ spec: treeSpec({ combo: JSON.stringify({ engine: "skill:sec.x", harness: "claude-code", skill: "/security-audit", model: "~deepseek/deepseek-flash-latest", effort: "low" }) }), ...treeBox({ "src/a.js": "a\n", "src/b.js": "b\n" }),
    run: async () => ({ read: true, untracked: "/security-audit reads the code its own way", message: JSON.stringify({ findings: [], stale_guidance: [] }) }) });
  assert.deepEqual([r.coverage.eligible, r.coverage.reviewed, r.coverage.counts], [["src/a.js", "src/b.js"], [], { eligible: 2, reviewed: 0 }]);
  assert.match(r.coverage_note, /its own way/);
});

test("a skill option runs the installed skill in its harness over the range, then restates its findings in the same session; only that skill is loaded", async () => {
  const skills = mkdtempSync(join(tmpdir(), "cr-skills-"));
  lay(skills, { "skills/cloudflare__security-audit-skill/skills/security-audit/SKILL.md": "# audit\n", "skills/mattpocock__skills/skills/engineering/code-review/SKILL.md": "# mp\n", "skills/other__repo/code-review/SKILL.md": "# other\n", "plugins/pr-review-toolkit/.claude-plugin/plugin.json": "{}" });
  const sk = resolveSkill("cloudflare/security-audit-skill:security-audit", "claude-code", skills);
  assert.equal(sk.invocation, "/security-audit");
  assert.equal(sk.skillDirs[0], join(skills, "skills/cloudflare__security-audit-skill/skills/security-audit"));
  assert.equal(resolveSkill("mattpocock/skills:code-review", "codex", skills).invocation, "$code-review");
  assert.deepEqual(resolveSkill("/pr-review-toolkit:review-pr", "claude-code", skills).pluginDirs, [join(skills, "plugins/pr-review-toolkit")]);
  assert.deepEqual(resolveSkill("/code-review", "claude-code", join(skills, "none")), { invocation: "/code-review", skillDirs: [], pluginDirs: [] }); // the harness's own command
  assert.throws(() => resolveSkill("mattpocock/skills:nope", "claude-code", skills), /isn't installed/);
  assert.throws(() => resolveSkill("/pr-review-toolkit:review-pr", "codex", skills), /isn't installed for codex/);
  assert.throws(() => resolveSkill("../x", "claude-code", skills), /skill "\.\.\/x" is/);
  assert.match(comboProblem({ engine: "skill:sec.cloudflare", model: "~deepseek/deepseek-flash-latest", effort: "high" }), /names its harness/);
  assert.equal(comboProblem({ engine: "skill:sec.cloudflare", harness: "claude-code", skill: "/security-audit", model: "~deepseek/deepseek-flash-latest", effort: "high" }), undefined);
  assert.match(comboProblem({ engine: "skill:x", harness: "claude-code", skill: "/a", model: "~deepseek/deepseek-flash-latest", effort: "minimal" }), /effort for claude-code/);

  const bin = mkdtempSync(join(tmpdir(), "cr-claude-"));
  writeFileSync(join(bin, "claude"), `#!/bin/sh
n=$(ls "${bin}"/turn-* 2>/dev/null | wc -l | tr -d ' ')
{ pwd; for a in "$@"; do echo "ARG:$a"; done; ls "$CLAUDE_CONFIG_DIR/skills" 2>/dev/null | sed 's/^/SKILL:/'; readlink "$CLAUDE_CONFIG_DIR/skills/security-audit" | sed 's/^/LINK:/'; env | grep -E '^GH_TOKEN='; } > "${bin}/turn-$n"
if [ "$n" = 0 ]; then
  echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s-1","result":"audit notes"}'
else
  echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s-1","result":"{\\"findings\\": [], \\"stale_guidance\\": []}"}'
fi
`);
  chmodSync(join(bin, "claude"), 0o755);
  const r = await withEnv({ ...gw, PATH: `${bin}:${process.env.PATH}` }, () => runEngine("skill:sec.cloudflare", { prompt: "Review: answer JSON", instructions: "brief", model: "anthropic/claude-sonnet-5.5", effort: "high", root: "/workspace", base: E, minutes: 1, scratch: mkdtempSync(join(tmpdir(), "cr-s-")), own: true, harness: "claude-code", skill: "cloudflare/security-audit-skill:security-audit", skillsRoot: skills, target: "tree" }));
  const [t1, t2] = [readFileSync(join(bin, "turn-0"), "utf8"), readFileSync(join(bin, "turn-1"), "utf8")];
  assert.match(t1, new RegExp(`ARG:/security-audit ${E}\\.\\.HEAD\\n`));
  assert.match(t2, /ARG:--resume\nARG:s-1/);
  assert.match(t2, /ARG:Now restate every finding of that run/);
  for (const t of [t1, t2]) {
    assert.match(t, /^SKILL:security-audit$/m); // only the selected skill is in the run's skills folder
    assert.doesNotMatch(t, /code-review|GH_TOKEN/);
    assert.ok(!t.split("\n")[0].startsWith("/workspace"), "its cwd is empty, never the repo");
  }
  assert.equal(r.read, true);
  assert.match(r.untracked, /\/security-audit reads the code its own way/);
  assert.equal(JSON.parse(r.message).findings.length, 0);
});

test("any committed file under .deepsec means scan, not init; scrub ignores an unset key", async () => {
  const bin = fakeDeepsec(), root = repoRoot({ ".deepsec/deepsec.config.ts": "export default {}\n" });
  const out = await withEnv({ ...gw, PATH: `${bin}:${process.env.PATH}` }, () => deepsec({ root, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", budget_usd: 1, scratch: mkdtempSync(join(tmpdir(), "cr-s-")) }));
  assert.ok(!readFileSync(join(bin, "log"), "utf8").includes("CMD:init"));
  assert.equal(out.setup, undefined);
  const { scrub } = await import("../recipe/review.ts");
  const old = process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_API_KEY;
  try { assert.equal(scrub({ message: "undefined behaviour", read: true }).message, "undefined behaviour"); } finally { if (old !== undefined) process.env.OPENROUTER_API_KEY = old; }
});
