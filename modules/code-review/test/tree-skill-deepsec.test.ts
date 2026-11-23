// Tree mode, skill options and the deepsec engine, against stub CLIs (a fake deepsec, a fake claude).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deepsec, said } from "../recipe/deepsec.ts";
import { review } from "../recipe/review.ts";

const A = "a".repeat(40), E = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const lay = (dir, files) => { for (const [f, t] of Object.entries(files)) (mkdirSync(dirname(join(dir, f)), { recursive: true }), writeFileSync(join(dir, f), t)); };
const withEnv = async (env, fn) => { const old = { ...process.env }; Object.assign(process.env, env); try { return await fn(); } finally { process.env = old; } };

// A fake deepsec: logs argv, cwd and the env it was given; init writes the scaffold (with files that must never leave the box) and
// INFO.md into the data root; process (or init through process) writes one analysed file with a CRITICAL and a LOW finding and one
// pending file. A `fail` file next to it fails init as deepsec does (its reason a jsonl failure on stdout, stderr empty); a `cap` file
// stops init at its cost cap (exit 3, a limit event) once it processed.
function fakeDeepsec() {
  const bin = mkdtempSync(join(tmpdir(), "cr-ds-"));
  writeFileSync(join(bin, "deepsec"), `#!/bin/sh
{ echo "CMD:$*"; echo "CWD:$(pwd)"; echo "DATA:$DEEPSEC_DATA_ROOT"; echo "PI:$PI_CODING_AGENT_DIR"; env | grep -E '^(OPENROUTER_API_KEY|GH_TOKEN)=' ; cat "$DEEPSEC_DATA_ROOT"/*/INFO.md 2>/dev/null | sed 's/^/INFO:/'; } >> "${bin}/log"
cmd=$1; pid=repo; through=; while [ $# -gt 0 ]; do [ "$1" = --project-id ] && pid=$2; [ "$1" = --through ] && through=$2; shift; done
[ "$cmd" = init ] && [ -f "${bin}/fail" ] && { echo '{"type":"setup_event","event":{"type":"phase-start","phase":"info"}}'; echo '{"type":"failure","code":"Error","message":"Pi assistant error: 401: {\\"message\\":\\"Missing Authentication header\\"}"}'; exit 1; }
[ "$cmd" = init ] && [ "$through" = process ] && cmd=initprocess
case "$cmd" in
  init|initprocess) mkdir -p .deepsec/data/repo "$DEEPSEC_DATA_ROOT/repo"
        echo 'export default {}' > .deepsec/deepsec.config.ts; echo 'export const m = []' > .deepsec/generated-matchers.ts
        echo '{"name":"deepsec-ws"}' > .deepsec/package.json; echo '{"lock":1}' > .deepsec/package-lock.json
        echo readme > .deepsec/README.md; echo agents > .deepsec/AGENTS.md; echo data > .deepsec/.gitignore
        echo '# the repo' > "$DEEPSEC_DATA_ROOT/repo/INFO.md"; echo '{"projectId":"repo"}' > "$DEEPSEC_DATA_ROOT/repo/project.json" ;;
esac
case "$cmd" in
  process|initprocess) mkdir -p "$DEEPSEC_DATA_ROOT/$pid/files/src"
        echo '{"filePath":"src/a.js","status":"analyzed","findings":[{"severity":"CRITICAL","title":"SQL injection","description":"d","recommendation":"r","lineNumbers":[2]},{"severity":"LOW","title":"Loose check","description":"d2","recommendation":"r2","lineNumbers":[1]},{"severity":"HIGH","title":"Gone","description":"x","recommendation":"x","lineNumbers":[1],"revalidation":{"verdict":"false-positive"}}]}' > "$DEEPSEC_DATA_ROOT/$pid/files/src/a.js.json"
        echo '{"filePath":"src/b.js","status":"pending","findings":[]}' > "$DEEPSEC_DATA_ROOT/$pid/files/src/b.js.json" ;;
esac
[ "$cmd" = initprocess ] && [ -f "${bin}/late" ] && { echo '{"type":"failure","code":"Error","message":"AI processing completed with 1 failed batch(es)"}'; exit 1; }
[ "$cmd" = initprocess ] && [ -f "${bin}/cap" ] && { echo '{"type":"limit","code":"COST_LIMIT_REACHED","message":"AI investigation reached the $7.00 cost limit"}'; exit 3; }
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
  const out = await withEnv({ ...gw, PATH: `${bin}:${process.env.PATH}` }, () => deepsec({ root, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "high", max_cost_usd: 7, scratch }));
  const log = readFileSync(join(bin, "log"), "utf8");
  const cmds = log.split("\n").filter((l) => l.startsWith("CMD:")).map((l) => l.slice(4));
  assert.deepEqual(cmds.map((c) => c.split(" ")[0]), ["scan", "process", "revalidate"]);
  assert.match(cmds[1], /--agent pi --model openrouter\/~deepseek\/deepseek-flash-latest --thinking-level high/);
  assert.equal(out.setup, undefined);
  assert.match(log, new RegExp(`DATA:${scratch}/deepsec-[^/]+/data\\n`));
  // Every step runs from the run's own workspace and config, never the checkout's .deepsec (whose config deepsec would load as code).
  assert.deepEqual([...new Set(log.match(/^CWD:.*$/gm))], [`CWD:${realpathSync(scratch)}/${log.match(/DATA:.*\/(deepsec-[^/]+)\/data/)[1]}/w`]);
  assert.match(log, /^INFO:# svc$/m);
  assert.match(log, /^OPENROUTER_API_KEY=ahqj_run$/m);
  assert.doesNotMatch(log, /GH_TOKEN|ghs_secret/);
  const models = JSON.parse(readFileSync(join(log.match(/PI:(.+)/)[1], "models.json"), "utf8"));
  // pi interpolates `$NAME`; a bare name is sent as the key itself (the gateway refused it: 2026-11-23). Named openrouter, pi counts
  // the cost OpenRouter reports, which deepsec's cap needs.
  assert.deepEqual([models.providers.openrouter.baseUrl, models.providers.openrouter.apiKey], ["http://10.0.0.1:8201/api/v1", "$OPENROUTER_API_KEY"]);
  assert.deepEqual(out.review.covered, ["src/a.js"]);
  assert.match(out.review.incomplete, /left 1 file unanalysed \(src\/b\.js\)/);

  // A PR with no .deepsec: init (spend capped at the budget, on the local route), then process --diff over the change. The
  // scan's candidates in files the PR doesn't change (src/b.js) stay pending and are no gap.
  const bin2 = fakeDeepsec(), root2 = repoRoot();
  const git = (...a) => execFileSync("git", ["-C", root2, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();
  git("init", "-q"); git("add", "src/b.js"); git("commit", "-qm", "base");
  const baseSha = git("rev-parse", "HEAD");
  git("add", "src/a.js"); git("commit", "-qm", "change");
  const r2 = await withEnv({ ...gw, PATH: `${bin2}:${process.env.PATH}` }, () => deepsec({ root: root2, target: "pr", base: baseSha, model: "~deepseek/deepseek-flash-latest", effort: "low", max_cost_usd: 3.5, scratch }));
  const cmds2 = readFileSync(join(bin2, "log"), "utf8").split("\n").filter((l) => l.startsWith("CMD:")).map((l) => l.slice(4));
  assert.match(cmds2[0], /^init \.deepsec \. --id repo .*--model-auth local .*--through coverage --max-cost-usd 3\.5 /);
  assert.match(cmds2[1], new RegExp(`^process .*--diff ${baseSha}$`));
  assert.equal(cmds2.length, 2);
  assert.ok(r2.setup);
  assert.equal(r2.review.incomplete, undefined);

  // A tree with no .deepsec: init runs through process under the cap, then only revalidate. At the cap (exit 3): its findings and
  // setup kept, the cap said as a gap, nothing more run.
  for (const cap of [false, true]) {
    const bin3 = fakeDeepsec();
    if (cap) writeFileSync(join(bin3, "cap"), "");
    const r3 = await withEnv({ ...gw, PATH: `${bin3}:${process.env.PATH}` }, () => deepsec({ root: repoRoot(), target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", max_cost_usd: 7, scratch }));
    const cmds3 = readFileSync(join(bin3, "log"), "utf8").split("\n").filter((l) => l.startsWith("CMD:")).map((l) => l.slice(4));
    assert.match(cmds3[0], /^init .*--through process --max-cost-usd 7 /);
    assert.deepEqual(cmds3.map((c) => c.split(" ")[0]), cap ? ["init"] : ["init", "revalidate"]);
    assert.deepEqual([r3.review.covered, r3.review.findings.length, !!r3.setup], [["src/a.js"], 2, true]);
    if (cap) assert.match(r3.review.incomplete, /^deepsec stopped at its \$7 spend cap; deepsec left 1 file unanalysed/);
  }
  // init failing after it set up and processed part (a later batch failed): what it analysed is kept, the failure a gap.
  const bin4 = fakeDeepsec();
  writeFileSync(join(bin4, "late"), "");
  const r4 = await withEnv({ ...gw, PATH: `${bin4}:${process.env.PATH}` }, () => deepsec({ root: repoRoot(), target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", max_cost_usd: 7, scratch }));
  assert.deepEqual([r4.review.covered, r4.review.findings.length, !!r4.setup], [["src/a.js"], 2, true]);
  assert.match(r4.review.incomplete, /^deepsec init: the engine stopped \(exit 1\); it said «AI processing completed with 1 failed batch\(es\)»/);
});

test("a failed deepsec says why in the run's reason: its own error, from its jsonl on stdout, as data", async () => {
  const bin = fakeDeepsec();
  writeFileSync(join(bin, "fail"), "");
  const { ws, out } = treeBox({ "src/a.js": "const q = 1;\n" });
  await assert.rejects(withEnv({ ...gw, PATH: `${bin}:${process.env.PATH}` }, () => review({ spec: treeSpec(), ws, out })),
    /^Error: no finder finished: deepsec init: the engine stopped \(exit 1\); it said «Pi assistant error: 401: \{"message":"Missing Authentication header"\}»$/);
  // Failed batches: the error behind the summary leads, and a 402 is the spend limit.
  const ev = (event) => JSON.stringify({ type: "setup_event", event });
  const stdout = [ev({ type: "progress", phase: "process", message: "Batch 2/3 failed: 402: {\"error\":\"cap_reached\"} (0 in flight, 3/3 done)" }),
    ev({ type: "progress", phase: "process", message: "Processing stopped: quota/credits exhausted (0 analyses, 1 batch(es) failed before stop)" }),
    JSON.stringify({ type: "failure", code: "Error", message: "AI processing completed with 1 failed batch(es)" })].join("\n");
  assert.equal(said({ stdout, stderr: "" }), 'Batch 2/3 failed: 402: {"error":"cap_reached"} (0 in flight, 3/3 done) (AI processing completed with 1 failed batch(es))');
  // A specific terminal error stays as it is; a scan's or process's human output gives stderr and its batch error, both; else stdout.
  assert.equal(said({ stdout: [ev({ type: "progress", message: "Batch 1/2 failed: 402" }), JSON.stringify({ type: "failure", message: "Pi assistant error: 401" })].join("\n"), stderr: "" }), "Pi assistant error: 401");
  assert.equal(said({ stdout: "\x1b[1mBatch 1/4\x1b[0m: Batch 1/4 failed: 402 cap_reached (0 in flight)\nProcessing complete\n", stderr: "" }), "Batch 1/4 failed: 402 cap_reached (0 in flight)");
  assert.equal(said({ stdout: "", stderr: "a\nboom\n" }), "a boom");
  assert.equal(said({ stdout: "Batch 1/2 failed: timeout (0 in flight, 1/2 done)\n", stderr: "Error: 402 cap_reached\n" }), "Error: 402 cap_reached | Batch 1/2 failed: timeout (0 in flight, 1/2 done)");
  assert.equal(said({ stdout: "Batch 1/2 failed: 402 cap_reached\n", stderr: "(node) Warning: x\n" }), "(node) Warning: x | Batch 1/2 failed: 402 cap_reached");
  assert.equal(said({ stdout: "Error: no project\n", stderr: "" }), "Error: no project");
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
  const a = await withEnv({ ...gw, PATH: `${bin}:${process.env.PATH}` }, () => deepsec({ root, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", scratch }));
  const log = readFileSync(join(bin, "log"), "utf8");
  assert.ok(!existsSync(join(outside, "ran")));
  assert.ok(!log.includes("CMD:init") && log.includes("CMD:scan"));
  assert.doesNotMatch(log, /host secret/);
  assert.equal(a.setup, undefined);
  // A committed config that is only a link (to a host file) is "set up": never init, so never read into a setup.
  const bin2 = fakeDeepsec(), root2 = repoRoot();
  mkdirSync(join(root2, ".deepsec"));
  symlinkSync(join(outside, "secret"), join(root2, ".deepsec/deepsec.config.ts"));
  const b = await withEnv({ ...gw, PATH: `${bin2}:${process.env.PATH}` }, () => deepsec({ root: root2, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", scratch }));
  assert.ok(!readFileSync(join(bin2, "log"), "utf8").includes("CMD:init"));
  assert.equal(b.setup, undefined);
  // A repo-root deepsec config (init's cwd would load it as code): refused before anything runs.
  const bin3 = fakeDeepsec(), root3 = repoRoot({ "deepsec.config.ts": "export default {}\n" });
  await assert.rejects(withEnv({ ...gw, PATH: `${bin3}:${process.env.PATH}` }, () => deepsec({ root: root3, target: "tree", model: "~deepseek/deepseek-flash-latest", effort: "low", scratch })), /deepsec\.config\.ts at its root/);
  assert.ok(!existsSync(join(bin3, "log")));
});

function treeBox(files) {
  const root = mkdtempSync(join(tmpdir(), "cr-tree-")), ws = join(root, "ws"), out = join(root, "out");
  mkdirSync(join(out, "home"), { recursive: true });
  lay(ws, files);
  return { ws, out };
}
const treeSpec = (p = {}) => ({ repo: "acme/app", head: A, base: E, incremental_from: E, pr: "1", target: "tree", option: "sec.deepsec", lens: "security", combo: JSON.stringify({ engine: "deepsec", model: "~deepseek/deepseek-flash-latest", effort: "low", max_cost_usd: 150, ignore: ["docs/**"] }), ...p });
