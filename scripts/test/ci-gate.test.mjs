// The app CI template's code-review gate (modules/core/templates/ci/.github/codegenie-gate.mjs): what blocks a merge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { verdict } from "../../modules/core/templates/ci/.github/codegenie-gate.mjs";

const finding = (severity, title) => ({ severity, title, path: "src/a.ts", anchor: { line: 3 }, finalBody: `${title} body` });
const review = (findings, extra = {}) => JSON.stringify({ findings, summaryOnlyFindings: [], coverage: { partial: false }, health: { status: "completed" }, ...extra });

test("high or critical findings block; the rest are listed as not blocking", () => {
  const v = verdict(0, review([finding("high", "Null deref"), finding("medium", "Slow loop")], { summaryOnlyFindings: [finding("critical", "SQL injection")] }), "abcdef123");
  assert.equal(v.block, true);
  assert.match(v.body, /2 blocking findings on `abcdef1`/);
  assert.match(v.body, /\*\*Not blocking\*\*[\s\S]*Slow loop/);
});

test("only smaller findings pass, and are still posted", () => {
  const v = verdict(0, review([finding("medium", "Slow loop"), finding("low", "Edge case")]));
  assert.equal(v.block, false);
  assert.equal(v.quiet, false);
  assert.match(v.body, /Edge case/);
});

test("no findings pass quietly", () => {
  const v = verdict(0, review([]));
  assert.deepEqual([v.block, v.quiet], [false, true]);
});

test("a partial review with nothing high or critical passes with a note; no coverage at all blocks", () => {
  const partial = verdict(0, review([finding("medium", "Salt default")], { coverage: { partial: true, reasons: ["1 verification incomplete"] }, health: { status: "incomplete" } }));
  assert.equal(partial.block, false);
  assert.match(partial.body, /partly done/);
  const none = verdict(0, review([], { coverage: { unavailable: true, reasons: ["budget stopped"] } }));
  assert.equal(none.block, true);
  assert.match(none.body, /incomplete.*re-run/);
});

test("a failed review, a non-zero exit or unreadable output blocks", () => {
  assert.equal(verdict(1, review([])).block, true);
  assert.equal(verdict(0, "not json").block, true);
  assert.equal(verdict(0, review([], { health: { status: "failed", diagnostics: [{ reason: "no credentials" }] } })).body.includes("no credentials"), true);
});

test("questions the reviewer couldn't settle (health unresolved) don't block: they are listed for a human", () => {
  const v = verdict(0, review([], { health: { status: "unresolved", unresolvedCount: 1 }, needsHumanAttention: [{ question: "Is the cache key per user?", files: ["src/a.ts"], reason: "can't see callers" }] }), "abcdef123");
  assert.equal(v.block, false);
  assert.doesNotMatch(v.body, /incomplete/);
  assert.match(v.body, /Is the cache key per user\?/);
});

// The workflow's Review and Verdict steps, run as bash in a scratch repo (npx is a stub that records being called).
test("a tiny change in non-sensitive files skips the code review and passes; a sensitive or larger one is reviewed", () => {
  const steps = YAML.parse(readFileSync(new URL("../../modules/core/templates/ci/.github/workflows/ci.yml", import.meta.url), "utf8")).jobs["code-review"].steps;
  const script = (name) => steps.find((s) => s.name === name).run;
  const run = (file, lines) => {
    const dir = mkdtempSync(join(tmpdir(), "ci-skip-"));
    const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir }).toString().trim();
    g("init", "-q");
    writeFileSync(join(dir, "README.md"), "x\n");
    g("add", ".");
    g("commit", "-qm", "base");
    const base = g("rev-parse", "HEAD");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, file), Array.from({ length: lines }, (_, i) => `line ${i}\n`).join(""));
    g("add", "src");
    g("commit", "-qm", "change");
    const bin = mkdtempSync(join(tmpdir(), "ci-bin-"));
    writeFileSync(join(bin, "npx"), `#!/bin/sh\ntouch "${join(bin, "called")}"\n`);
    chmodSync(join(bin, "npx"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASE_SHA: base, HEAD_SHA: g("rev-parse", "HEAD"), PR_LABELS: "", GITHUB_ENV: join(bin, "env"), RUNNER_TEMP: bin };
    writeFileSync(env.GITHUB_ENV, "");
    execFileSync("bash", ["-e", "-c", script("Review")], { cwd: dir, env });
    const skipped = readFileSync(env.GITHUB_ENV, "utf8").includes("CODE_REVIEW_SKIPPED=1");
    const passed = skipped ? execFileSync("bash", ["-e", "-c", script("Verdict")], { cwd: dir, env: { ...env, CODE_REVIEW_SKIPPED: "1" } }).toString() : "";
    return { reviewed: existsSync(join(bin, "called")), skipped, passed };
  };
  const tiny = run("src/a.ts", 5);
  assert.deepEqual([tiny.reviewed, tiny.skipped], [false, true]);
  assert.match(tiny.passed, /not reviewed, and it passes/);
  assert.equal(run("src/auth.ts", 5).reviewed, true, "a sensitive path");
  assert.equal(run("src/a.ts", 25).reviewed, true, "20 lines or more");
});

test("the Verdict step runs the gate from the default branch tip, not the PR's recorded base", () => {
  const steps = YAML.parse(readFileSync(new URL("../../modules/core/templates/ci/.github/workflows/ci.yml", import.meta.url), "utf8")).jobs["code-review"].steps;
  const script = steps.find((s) => s.name === "Verdict").run;
  const remote = mkdtempSync(join(tmpdir(), "ci-remote-"));
  const g = (dir, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir }).toString().trim();
  g(remote, "init", "-q", "-b", "main");
  mkdirSync(join(remote, ".github"));
  writeFileSync(join(remote, ".github", "codegenie-gate.mjs"), 'console.log("gate from base"); process.exit(1);\n');
  g(remote, "add", ".");
  g(remote, "commit", "-qm", "base gate");
  const base = g(remote, "rev-parse", "HEAD");
  writeFileSync(join(remote, ".github", "codegenie-gate.mjs"), 'console.log("gate from default branch tip");\n');
  g(remote, "add", ".");
  g(remote, "commit", "-qm", "new gate");

  const work = mkdtempSync(join(tmpdir(), "ci-work-"));
  g(work, "init", "-q", "-b", "main");
  g(work, "remote", "add", "origin", remote);
  g(work, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
  g(work, "checkout", "-q", base);
  const bin = mkdtempSync(join(tmpdir(), "ci-verdict-"));
  writeFileSync(join(bin, "review.json"), "{}");
  const env = { ...process.env, GITHUB_TOKEN: "test-token", DEFAULT_BRANCH: "main", HEAD_SHA: base, PR_NUMBER: "1", GITHUB_REPOSITORY: "x/y", RUNNER_TEMP: bin };
  const out = execFileSync("bash", ["-e", "-c", script], { cwd: work, env }).toString();
  assert.match(out, /gate from default branch tip/);
  assert.doesNotMatch(out, /gate from base/);
});
