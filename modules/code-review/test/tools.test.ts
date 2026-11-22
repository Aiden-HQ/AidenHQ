// The tools recipe: fake tools (shell commands) over a small checkout; the adapters on real tool output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTools, toolEnv } from "../recipe/tools.ts";

const A = "a".repeat(40);
function checkout(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cr-tools-")), ws = join(root, "ws"), out = join(root, "out");
  mkdirSync(ws, { recursive: true });
  for (const [f, t] of Object.entries(files)) (mkdirSync(join(ws, f, ".."), { recursive: true }), writeFileSync(join(ws, f), t));
  return { root, ws, out };
}
const spec = (options: object) => ({ repo: "acme/app", head: A, base: A, options: JSON.stringify(options) });
const sarif = (results: object[]) => JSON.stringify({ runs: [{ tool: { driver: { name: "fake" } }, results }] });

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

test("a tool sees no link out of the checkout", async () => {
  const { root, ws, out } = checkout({ "a.txt": "x\n" });
  writeFileSync(join(root, "secret"), "TOPSECRET\n");
  symlinkSync(join(root, "secret"), join(ws, "leak"));
  const r = await runTools({ ws, out, spec: spec({ "x.read": { lens: "security", cmd: "echo \"a.txt:1: $(cat leak 2>/dev/null || echo none) (60% confidence)\"", output: "vulture" } }) });
  assert.equal(r.findings[0].title, "none");
});
