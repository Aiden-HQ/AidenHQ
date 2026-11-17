// GATE_CORE covers every file in a gate directory, and every entry still names a file (lean-core 0a).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_CORE, coverageProblems } from "../../../modules/platform/src/check.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
// The product's files and the official modules at ./modules (their own repository since 5b, put there at its pin).
const modules = readdirSync(join(repoRoot, "modules"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(repoRoot, join(e.parentPath, e.name))).filter((f) => !/(^|\/)(node_modules|\.git|dist)\//.test(f) && f !== "modules/.sha");
const files = [...execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 << 20, encoding: "utf8" }).split("\0").filter(Boolean), ...modules];
const moved = (from, to) => files.map((f) => (f === from ? to : f));

test("every gate file is covered and every entry is used", () => assert.deepEqual(coverageProblems(files), []));

test("a moved gate file fails", () => {
  const problems = coverageProblems(moved("services/runner/src/state.ts", "services/runner/src/store.ts"));
  assert.ok(problems.includes("uncovered: services/runner/src/store.ts"));
  assert.ok(problems.some((p) => p.startsWith("dead entry: ^services\\/runner\\/src\\/state")));
});

test("a renamed board gate file fails", () => {
  const problems = coverageProblems(moved("services/board/src/fleet.ts", "services/board/src/fleets.ts"));
  assert.ok(problems.includes("dead entry: ^services\\/board\\/src\\/fleet\\.ts$"));
});

// origin/main's GATE_CORE before the split (tiers.mjs at a9f2ae66).
const OLD = [
  /^services\/runner\/src\/(tiers|review|authorize|merges|apply|netjail|state|config|github-app|git|main|engines|workspace|files|commands)\.(mjs|ts)$/,
  /^scripts\/computers\.(mjs|ts)$/,
  /^services\/runner\/test\/reviewer-cases\//,
  /^services\/runner\/scripts\/reviewer-eval\.(mjs|ts)$/,
  /^modules\/core\/security\//,
  /(^|\/)agent-auth\.ts$/,
  /^scripts\/(modules|paperclip-setup|no-shell)\.(mjs|ts)$/,
  /^services\/board\/src\/(approvals|app|fleet|accounts|session)\.ts$/,
  /^services\/computer\//,
  /^services\/gateway\//,
  /^ops\//,
  /^scripts\/verify-security\.sh$|^scripts\/supply-chain\/|^\.gitleaks\.toml$/,
  /(^|\/)\.github\//,
];

test("the split keeps every file the old list gated; the only additions are the lean files, the engine modules, the SDK, the kernel (the gateway moved in), the SDK caller and executor copies, the apps platform's kinds and executor (2d), primer.publish's manifest and executor (2e), agents.mjs (commands.mjs renamed), the eval-receipt gate, the channel modules (2f), the reviewer module with the runner's request side (3c), the board's kernel sign-in client (3g), the runner's card text and plan (3b) and graded done's finish check, which left the board's app.ts (3h)", () => {
  const gated = (list) => files.filter((f) => list.some((g) => g.test(f)));
  const before = gated(OLD);
  const after = gated(GATE_CORE);
  assert.deepEqual(before.filter((f) => !after.includes(f)), []);
  const added = after.filter((f) => !before.includes(f));
  assert.ok(added.length > 0 && added.every((f) => f.startsWith("scripts/lean/") || f === "scripts/test/lean.test.mjs" || f === "services/runner/test/gate-coverage.test.mjs" || f.startsWith("kernel/sdk/") || f.startsWith("kernel/") || /(^|\/)aidenhq-sdk\/(caller|executor)\.ts$/.test(f) || f.startsWith("modules/apps-platform/") || f === "modules/apps-platform/apps-mcp/src/executor.ts" || f === "modules/primer/module.yaml" || f === "modules/primer/connections/primer-mcp/src/publish.ts" || /^modules\/engine-[^/]+\//.test(f) || f === "services/runner/src/agents.mjs" || f === "services/runner/src/evalgate.ts" || /^modules\/channel-[^/]+\//.test(f) || f.startsWith("modules/ai-reviewer/") || f === "services/runner/src/review-request.mjs" || f === "services/shared/review-files.mjs" || f === "services/runner/src/siblings.ts" || f === "services/runner/src/progress.ts" || f === "services/board/src/kernel-auth.ts" || f === "services/runner/src/cards.ts" || f.startsWith("modules/codehost-github/") || f.startsWith("modules/platform/") || f === "modules/engineering/src/merge-queue.mjs" || f.startsWith("modules/grading/")), added.join(", "));
});
