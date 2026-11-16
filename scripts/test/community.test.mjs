import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import YAML from "yaml";
import { claTicked, exempt, section, triageComment } from "../community.mjs";

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

// A fork's PR must never reach a self-hosted runner: any job that can name one guards it on the fork check, and PR-target
// workflows run only on GitHub-hosted runners without checking out the PR.
test("workflow lint: fork PRs stay off self-hosted runners", () => {
  const dir = new URL("../../.github/workflows/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
    const text = readFileSync(new URL(f, dir), "utf8");
    const wf = YAML.parse(text);
    const target = Object.keys(wf.on ?? wf[true] ?? {}).includes("pull_request_target");
    for (const [name, job] of Object.entries(wf.jobs)) {
      const runs = JSON.stringify(job["runs-on"]);
      if (target) {
        assert.equal(runs, '"ubuntu-latest"', `${f}/${name}: pull_request_target must use a GitHub-hosted runner`);
        for (const s of job.steps ?? []) assert.ok(!/head\.(sha|ref)/.test(JSON.stringify(s.with ?? {})), `${f}/${name}: never check out the PR head`);
      }
      if (runs.includes("self-hosted")) assert.match(runs, /head\.repo\.full_name != github\.repository && 'ubuntu-latest'/, `${f}/${name}: needs the fork guard`);
    }
  }
});
