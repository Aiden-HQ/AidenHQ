// ui-review end to end against a stub browser: with a baseline, a PR whose diff introduces no new finding passes while the
// page keeps the gaps its base had; a regression it does introduce still fails it, and with no baseline everything blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const script = join(here, "../images/agent-base/ui-review");
const stub = join(here, "fixtures/agent-browser-stub.cjs");

/** Run ui-review into a fresh folder; returns its exit code, report.md and report.json. */
function review(out, { paths = "/features", baseline = null, ...env } = {}) {
  let code = 0;
  const args = [script, "http://127.0.0.1:9", "--paths", paths, "--out", out, "--widths", "390", "--modes", "light"];
  if (baseline) args.push("--baseline", baseline);
  try {
    execFileSync("node", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENT_BROWSER: stub, ...env } });
  } catch (e) {
    code = e.status;
  }
  return { code, md: readFileSync(join(out, "report.md"), "utf8"), json: JSON.parse(readFileSync(join(out, "report.json"), "utf8")) };
}

test("a PR that introduces nothing passes while the base's gaps stay backlog", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-review-"));
  const before = join(dir, "before"), after = join(dir, "after");
  // The base commit: the page it already has, with its text under 12px.
  const base = review(before, { STUB_TINY: "2" });
  assert.equal(base.code, 1, "the base has blockers of its own");
  assert.equal(base.json.blocking.length, 1);
  // The PR: a date computation, no layout change. The same finding is the page's, not the PR's.
  const head = review(after, { STUB_TINY: "2", baseline: before });
  assert.equal(head.code, 0, "a diff that touches no layout isn't failed for the page's old gaps");
  assert.deepEqual(head.json.blocking, []);
  assert.equal(head.json.preexisting.length, 1);
  assert.match(head.md, /## Blocking: none found by the automated checks/);
  assert.match(head.md, /## Already on this base \(1\): not this change's/);
});

test("a regression on a surface the base had right still fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-review-"));
  const before = join(dir, "before"), regressed = join(dir, "regressed");
  const base = review(before, { STUB_TINY: "2" });
  assert.equal(base.code, 1);
  // A PR that adds a sideways scroll on a page the base had right: that one is its own.
  const bad = review(regressed, { STUB_TINY: "2", STUB_OVERFLOW: "24", baseline: before });
  assert.equal(bad.code, 1);
  assert.equal(bad.json.blocking.length, 1);
  assert.match(bad.json.blocking[0], /scrolls sideways by 24px/);
  assert.equal(bad.json.preexisting.length, 1, "the base's finding stays backlog");
});

test("matching is one-for-one: a second instance of the same defect on the head is the head's", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-review-"));
  const before = join(dir, "before"), twice = join(dir, "twice");
  const base = review(before, { STUB_TINY_TEXT: ".tiny-0" });
  assert.equal(base.json.blocking.length, 1);
  // The head reports the identical finding twice (the same path reviewed twice): one cancels, one is its own.
  const head = review(twice, { STUB_TINY_TEXT: ".tiny-0", paths: "/features,/features", baseline: before });
  assert.equal(head.code, 1);
  assert.equal(head.json.blocking.length, 1);
  assert.equal(head.json.preexisting.length, 1);
});

test("no baseline report: nothing can be told apart, so every finding blocks (fail closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-review-"));
  const empty = join(dir, "empty"), after = join(dir, "after");
  mkdirSync(empty);
  const head = review(after, { STUB_TINY: "2", baseline: empty });
  assert.equal(head.code, 1, "a baseline folder with no report.json isn't a baseline");
  assert.equal(head.json.blocking.length, 1);
  assert.equal(head.json.preexisting.length, 0);
});

test("the UI Reviewer's spec scopes the verdict to what the PR changed", () => {
  const handbook = readFileSync(new URL("../../../modules/design/agents/ui-reviewer/AGENTS.md", import.meta.url), "utf8");
  const checklist = readFileSync(new URL("../../../modules/core/design-system/review-checklist.md", import.meta.url), "utf8");
  // One rule in each: what the PR introduced or regressed blocks, what the base already had does not.
  assert.match(handbook, /Judge the diff against its base: what this PR introduced or regressed blocks/);
  assert.match(handbook, /a defect the base already had is\s+backlog, not this PR's/);
  assert.match(handbook, /with no baseline run[^]*every finding still blocks/);
  assert.match(handbook, /what this PR introduced or regressed is\s+blocking, what the base already had is backlog/);
  // And the checklist says the same in its own intro, without touching what its block list is for.
  assert.match(checklist, /It judges a pull request against its\s+base: what the PR introduced or regressed blocks/);
  assert.match(checklist, /a finding the base already had is not this PR's/);
  assert.match(checklist, /"already on this base"/);
  // The rewritten guidance's point still stands: a change is not failed for its shell, layout or palette.
  assert.match(checklist, /not that it uses a\s+particular shell, block, palette or layout/);
});
