// The eval's reuse by content: a whole run that passed covers the same module content, so a second run spends nothing; any
// changed file runs it again. Run on a copy of the module, as on the host, with no model key (a run that isn't covered stops
// at the missing key).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { contentKey, recordReceipt } from "../scripts/reviewer-eval.ts";

const root = mkdtempSync(join(tmpdir(), "reval-"));
after(() => rmSync(root, { recursive: true, force: true }));
const mod = join(root, "ai-reviewer"), state = join(root, "state");
cpSync(join(import.meta.dirname, ".."), mod, { recursive: true, filter: (s) => !s.includes("node_modules") });
const run = (...args: string[]) => {
  const env = { ...process.env, XDG_STATE_HOME: state };
  delete env.OPENROUTER_API_KEY;
  delete env.EVAL_RESULT;
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(mod, "scripts/reviewer-eval.ts"), ...args], { env, encoding: "utf8" });
};

it("a passing run covers the same content; a changed file or --force runs it again", () => {
  recordReceipt(contentKey(mod), { passed: 112, total: 112 }, join(state, "aidenhq/reviewer-eval-receipts.json"));
  const covered = run();
  assert.equal(covered.status, 0);
  assert.match(covered.stdout, /already covered by the passing run of .* \(112\/112\)/);
  assert.match(run("--force").stderr, /OPENROUTER_API_KEY is not set/, "--force runs it");
  appendFileSync(join(mod, "service/security/policy/02-scope.md"), "\nOne more rule.\n");
  const changed = run();
  assert.equal(changed.status, 2);
  assert.match(changed.stderr, /OPENROUTER_API_KEY is not set/);
});
