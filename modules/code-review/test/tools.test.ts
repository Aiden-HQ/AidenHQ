// The tools recipe: fake tools (shell commands) over a small checkout; the adapters on real tool output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTools, toolEnv, TOTAL_MINUTES } from "../recipe/tools.ts";
import { loadCatalog, toolSpec } from "../recipe/catalog.ts";
import { readJscpd, readKnip, readLines, readSarif, readScc, readVulture } from "../recipe/sarif.ts";

const A = "a".repeat(40);
function checkout(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cr-tools-")), ws = join(root, "ws"), out = join(root, "out");
  mkdirSync(ws, { recursive: true });
  for (const [f, t] of Object.entries(files)) (mkdirSync(join(ws, f, ".."), { recursive: true }), writeFileSync(join(ws, f), t));
  return { root, ws, out };
}
const spec = (options: object) => ({ repo: "acme/app", head: A, base: A, options: JSON.stringify(options) });
const sarif = (results: object[]) => JSON.stringify({ runs: [{ tool: { driver: { name: "fake" } }, results }] });
const hit = (level: string, line: number, msg = "bad thing") => ({ ruleId: "R1", level, message: { text: `${msg} ${line}` }, locations: [{ physicalLocation: { artifactLocation: { uri: "a.txt" }, region: { startLine: line } } }] });

test("sarif: error -> important, warning and note -> nit; 200 nits kept per option, every important one, the rest counted", async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
  const many = sarif([...Array.from({ length: 250 }, (_, i) => hit(i < 5 ? "error" : "warning", i + 1)), hit("note", 251)]);
  const { ws, out } = checkout({ "a.txt": lines, "out.sarif": many });
  const r = await runTools({ spec: spec({ "sec.fake": { lens: "security", cmd: "cat out.sarif", output: "sarif" } }), ws, out });
  assert.equal(r.target, "tree");
  assert.equal(r.findings.length, 205);
  assert.equal(r.findings.filter((f) => f.severity === "important").length, 5);
  assert.ok(r.findings.every((f) => f.option === "sec.fake" && f.lens === "security" && /^[0-9a-f]{16}$/.test(f.id)));
  assert.equal(r.coverage.dropped["sec.fake"], 46);
  assert.match(String(r.coverage.incomplete), /cut or unplaceable/);
  assert.equal(readSarif(sarif([hit("error", 1)]), "/w", "nit")[0].severity, "nit");
});

test("a failed tool is listed with its stderr tail, the run carries on, and it is never clean; a scanner's exit code alone is no failure", async () => {
  const { ws, out } = checkout({ "a.py": "import os\n" });
  const r = await runTools({
    ws, out, minutes: 0.02,
    spec: spec({
      "x.crash": { lens: "correctness", cmd: "echo 'boom: tool missing' >&2; exit 127", output: "sarif" },
      "x.hang": { lens: "correctness", cmd: "sleep 20", output: "vulture" },
      "x.garbage": { lens: "correctness", cmd: "echo not json", output: "sarif" },
      "maint.vulture": { lens: "maintainability", cmd: "echo \"a.py:1: unused import 'os' (90% confidence)\"; exit 3", output: "vulture", exits: [0, 3] },
    }),
  });
  assert.deepEqual(r.coverage.failed.map((f) => f.id), ["x.crash", "x.hang", "x.garbage"]);
  assert.match(r.coverage.failed[0].why, /exit 127.*boom: tool missing/);
  assert.match(r.coverage.failed[1].why, /timed out/);
  assert.match(r.coverage.failed[2].why, /isn't sarif/);
  assert.deepEqual(r.findings.map((f) => [f.option, f.lens, f.severity, f.line]), [["maint.vulture", "maintainability", "nit", 1]]);
  assert.deepEqual(r.coverage.options, ["maint.vulture"]);
  assert.match(String(r.coverage.incomplete), /3 tools failed/);
});

test("tool env has no OPENROUTER_API_KEY, spec or result path, and a tool really runs without them", async () => {
  const env = toolEnv({ PATH: "/bin", HOME: "/h", OPENROUTER_API_KEY: "sk-or-secret-secret", OPENROUTER_BASE_URL: "http://gw", AIDENHQ_SPEC: "/s", AIDENHQ_RESULT: "/r", GITHUB_TOKEN: "t" }, "/tmp/x");
  assert.deepEqual(Object.keys(env).filter((k) => /OPENROUTER|AIDENHQ|TOKEN/.test(k)), []);
  assert.equal(env.PATH, "/bin");
  const { ws, out } = checkout({ "a.txt": "x\n" });
  const r = await runTools({ ws, out, env: { PATH: process.env.PATH, HOME: out, OPENROUTER_API_KEY: "sk-or-secret-secret" }, spec: spec({ "x.env": { lens: "security", cmd: "echo \"a.txt:1: key=${OPENROUTER_API_KEY:-absent} (60% confidence)\"", output: "vulture" } }) });
  assert.match(r.findings[0].title, /key=absent/);
  // The word "undefined" survives (scrub's default secret is the unset model key), a key-shaped string doesn't.
  const key = ["sk", "abcdefghijklmnopqrstuvwx"].join("-"); // built, so no secret scanner flags this file
  const k = await runTools({ ws, out, spec: spec({ "x.k": { lens: "security", cmd: `echo "a.txt:1: undefined variable ${key} (60% confidence)"`, output: "vulture" } }) });
  assert.equal(k.findings[0].title, "undefined variable [redacted]");
});

test("adapters read the real output of knip, jscpd, vulture, scc and the line tools", () => {
  const knip = readKnip(JSON.stringify({ issues: [{ file: "src/lib.js", exports: [{ name: "neverUsed", line: 2 }], files: [], duplicates: [[{ name: "a" }, { name: "b" }]] }, { file: "src/orphan.js", files: [{ name: "src/orphan.js" }] }, { file: "package.json", dependencies: [{ name: "left-pad" }] }] }));
  assert.deepEqual(knip.map((f) => [f.path, f.line, f.title]), [["src/lib.js", 2, "Unused export: neverUsed"], ["src/lib.js", 1, "Duplicate export: a = b"], ["src/orphan.js", 1, "Unused file: src/orphan.js"], ["package.json", 1, "Unused dependency: left-pad"]]);
  const dup = readJscpd(JSON.stringify({ duplicates: [{ lines: 11, tokens: 150, fragment: "x", firstFile: { name: "src/dup_a.js", start: 1, end: 11 }, secondFile: { name: "src/dup_b.js", start: 1, end: 11 } }] }), "/w");
  assert.deepEqual([dup[0].path, dup[0].line, dup[0].end_line], ["src/dup_a.js", 1, 11]);
  assert.deepEqual(readVulture("dead.py:2: unused function 'unused_fn' (60% confidence)\n").map((f) => [f.path, f.line, f.title]), [["dead.py", 2, "unused function 'unused_fn'"]]);
  assert.equal(readVulture("").length, 0);
  const scc = readScc(JSON.stringify([{ Name: "TS", Files: [{ Location: "a.ts", Lines: 900, Code: 700, Complexity: 120 }, { Location: "b.ts", Lines: 10, Code: 9, Complexity: 2 }] }]));
  assert.deepEqual(scc.map((f) => f.path), ["a.ts"]);
  const lines = readLines("src/bad.js:2:7: Variable 'unused' is declared but never used. [Error/eslint(no-unused-vars)]\nsrc/w.js:1:1: odd thing [Warning/x]\n.github/workflows/ci.yml:7:23: injection [expression]\nm.sql:1:0: warning: require-lock-timeout missing\n  |\n7 |   code\n");
  assert.deepEqual(lines.map((f) => [f.path, f.line, f.severity]), [["src/bad.js", 2, "important"], ["src/w.js", 1, "nit"], [".github/workflows/ci.yml", 7, "important"], ["m.sql", 1, "nit"]]);
  assert.throws(() => readKnip("{}"), /no issues/);
});

test("exit codes: one outside `exits` fails even with a report (a partial scan); a found-something code with no finding fails; garbage line output fails", async () => {
  const { ws, out } = checkout({ "a.txt": "x\n" });
  const r = await runTools({
    ws, out,
    spec: spec({
      "x.partial": { lens: "security", cmd: `echo '${sarif([hit("error", 1)])}'; exit 1`, output: "sarif" },
      "x.found": { lens: "correctness", cmd: "echo 'a.txt:1:1: bad [Error/x]'; exit 1", output: "gcc", exits: [0, 1] },
      "x.silent": { lens: "correctness", cmd: "exit 1", output: "gcc", exits: [0, 1] },
      "x.crashed": { lens: "correctness", cmd: "echo 'Failed to parse configuration file'", output: "gcc" },
      "x.sized": { lens: "maintainability", cmd: "echo \"a.txt:1: unused function 'f' (60% confidence, 4 lines)\"; exit 3", output: "vulture", exits: [0, 3] },
    }),
  });
  assert.deepEqual(r.coverage.failed.map((f) => f.id), ["x.partial", "x.silent", "x.crashed"]);
  assert.deepEqual(r.coverage.options, ["x.found", "x.sized"]);
  assert.deepEqual(r.findings.map((f) => [f.option, f.title]), [["x.found", "bad [Error/x]"], ["x.sized", "unused function 'f'"]]);
});

test("squawk's 0-based gcc lines (its upstream sample) land one lower through the catalog command; its errors fail", async () => {
  const opt = toolSpec(loadCatalog(readFileSync(join(import.meta.dirname, "../catalog.json"), "utf8")))["perf.squawk"];
  const { root, ws, out } = checkout({ "db/migrations/1.sql": "ALTER TABLE t ADD COLUMN c int NOT NULL;\nSELECT 1;\n", "db/migrations/2.sql": "bad\n" });
  const bin = join(root, "bin");
  mkdirSync(bin);
  // squawk 2.72.0: exit 1 for violations (lines on stdout) and for errors (stderr only).
  writeFileSync(join(bin, "squawk"), '#!/bin/sh\ncase "$3" in *1.sql) echo "$3:0:0: warning: require-lock-timeout missing lock_timeout"; echo "$3:1:0: warning: x y"; exit 1;; *) echo "error: cannot read" >&2; exit 1;; esac\n');
  chmodSync(join(bin, "squawk"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: out };
  const r = await runTools({ ws, out, env, spec: spec({ "perf.squawk": opt }) });
  assert.match(r.coverage.failed[0]?.why ?? "", /exit 2/);
  const { ws: ws2, out: out2 } = checkout({ "db/migrations/1.sql": "ALTER TABLE t ADD COLUMN c int NOT NULL;\nSELECT 1;\n" });
  const ok = await runTools({ ws: ws2, out: out2, env, spec: spec({ "perf.squawk": opt }) });
  assert.deepEqual(ok.findings.map((f) => [f.path, f.line]), [["db/migrations/1.sql", 1], ["db/migrations/1.sql", 2]]);
});

test("a tool sees no link out of the checkout", async () => {
  const { root, ws, out } = checkout({ "a.txt": "x\n" });
  writeFileSync(join(root, "secret"), "TOPSECRET\n");
  symlinkSync(join(root, "secret"), join(ws, "leak"));
  const r = await runTools({ ws, out, spec: spec({ "x.read": { lens: "security", cmd: "echo \"a.txt:1: $(cat leak 2>/dev/null || echo none) (60% confidence)\"", output: "vulture" } }) });
  assert.equal(r.findings[0].title, "none");
});

test("a tool that leaves a process holding stderr doesn't hold the run; tools past the run's time don't start", async () => {
  const { ws, out } = checkout({ "a.txt": "x\n" });
  const t0 = Date.now();
  const escape = `node -e 'require("child_process").spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "ignore", 2] }).unref()'; echo "a.txt:1: done (60% confidence)"`;
  const r = await runTools({ ws, out, minutes: 0.5, spec: spec({ "x.escape": { lens: "correctness", cmd: escape, output: "vulture" } }) });
  assert.ok(Date.now() - t0 < 10_000, "ended without waiting for the escaped process");
  assert.deepEqual(r.coverage.options, ["x.escape"]);
  const late = await runTools({ ws, out, totalMinutes: 0.0001, spec: spec({ "x.late": { lens: "correctness", cmd: "true", output: "vulture" } }) });
  assert.match(late.coverage.failed[0].why, /not run/);
  assert.ok(TOTAL_MINUTES < 180 - 10, "the run's time stays under the check's timeout_min with room for the box");
});

test("the tools check reviews a whole tree only; runs_code tools run last", async () => {
  const { ws, out } = checkout({ "new.txt": "changed\n" });
  await assert.rejects(runTools({ ws, out, spec: { repo: "acme/app", head: A, base: "b".repeat(40), options: "{}" } }), /whole tree/);
  const r = await runTools({
    ws, out,
    spec: spec({
      "x.code": { lens: "maintainability", cmd: "echo 'new.txt:1:1: second [Error/x]'; exit 1", output: "gcc", exits: [0, 1], runs_code: true },
      "x.lint": { lens: "correctness", cmd: "printf 'new.txt:1:1: fresh [Error/x]\\n'", output: "gcc" },
    }),
  });
  assert.equal(r.target, "tree");
  assert.deepEqual(r.findings.map((f) => [f.option, f.path, f.severity]), [["x.lint", "new.txt", "important"], ["x.code", "new.txt", "important"]]);
  assert.equal(r.coverage.incomplete, null);
});
