import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { lint, lintDir } from "../supply-chain/fork-lint.ts";
import { claTicked, exempt, section, triageComment } from "../community.ts";

const body = (cla) => `## What changed\nx\n\n## Why\n<!-- hint -->\nbecause\n\n## Evidence\nnpm test ok\n\n## Origin\ninstance=acme agent=eng\n\n## Checklist\n\n- [${cla}] I have read [CLA.md](../CLA.md) and agree\n`;
const pr = (o = {}) => ({ title: "fix(board): a thing", body: body("x"), user: { type: "User" }, head: { repo: { full_name: "alice/AidenHQ" } }, ...o });

test("the CLA box is the signature; comments and bots and maintainers don't count", () => {
  assert.equal(claTicked(body("x")), true);
  assert.equal(claTicked(body(" ")), false);
  assert.equal(claTicked("<!-- - [x] CLA.md -->"), false);
  assert.equal(exempt(pr(), "Aiden-HQ/AidenHQ"), false);
  assert.equal(exempt(pr({ user: { type: "Bot" } }), "Aiden-HQ/AidenHQ"), true);
  assert.equal(exempt(pr({ head: { repo: { full_name: "Aiden-HQ/AidenHQ" } } }), "Aiden-HQ/AidenHQ"), true);
});

test("triage lists facts and never approves", () => {
  assert.equal(section(body("x"), "Why"), "because");
  const ok = triageComment({ pr: pr(), files: ["services/board/src/a.ts"] });
  assert.match(ok, /\[x\] Touches no gate/);
  assert.match(ok, /not an approval/);
  const bad = triageComment({ pr: pr({ title: "oops", body: "" }), files: ["kernel/x.ts", ".github/workflows/ci.yml"] });
  assert.match(bad, /\[ \] Title/);
  assert.match(bad, /\[ \] CLA/);
  assert.match(bad, /Touches gate or CI files \(2\)/);
  assert.doesNotMatch(bad, /approved|lgtm/i);
});

// A fork's PR must never reach a self-hosted runner (scripts/supply-chain/fork-lint.ts): our workflows pass, a job that
// can name one without the fork guard fails, and the triage path holds no review or merge call.
const wfs = (jobs, on = { pull_request: null }) => YAML.stringify({ on, jobs });
test("workflow lint: fork PRs stay off self-hosted runners", () => {
  assert.deepEqual(lintDir(fileURLToPath(new URL("../../.github/workflows", import.meta.url))), []);
  const ours = "${{ fromJSON('[\"self-hosted\", \"aidenhq\"]') }}";
  const guarded = "${{ github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-latest' || fromJSON('[\"self-hosted\"]') }}";
  assert.equal(lint(wfs({ a: { "runs-on": ["self-hosted", "aidenhq"] } })).length, 1);
  assert.equal(lint(wfs({ a: { "runs-on": ours } })).length, 1);
  assert.equal(lint(wfs({ a: { "runs-on": guarded } })).length, 0);
  assert.equal(lint(wfs({ a: { "runs-on": ours, if: "github.event.pull_request.head.repo.full_name == github.repository" } })).length, 0);
  assert.equal(lint(wfs({ a: { "runs-on": "ubuntu-latest" } })).length, 0);
  assert.equal(lint(wfs({ a: { "runs-on": ours } }, { push: null })).length, 0);
  assert.equal(lint(wfs({ a: { "runs-on": guarded } }, { pull_request_target: null })).length, 1);
  assert.equal(lint(wfs({ a: { "runs-on": "ubuntu-latest", steps: [{ uses: "x", with: { ref: "${{ github.event.pull_request.head.sha }}" } }] } }, { pull_request_target: null })).length, 1);
});

test("the triage path labels and comments; it has no review or merge call", () => {
  const src = readFileSync(new URL("../community.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\/(reviews|merge)\b|"APPROVE"/);
});
