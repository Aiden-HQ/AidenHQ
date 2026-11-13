// The grader's evidence for a PR deliverable: pending evidence (no PR, checks running, merges still going, a card open) waits;
// a merged PR is bound to its merge commit, and several PRs to a version that fits the board's 200 characters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gather, grade, graderModels } from "../src/grade.mjs";

const pr = ({ state = "OPEN", check = "SUCCESS", head = "h".repeat(40), merge = "m".repeat(40) } = {}) => ({
  repository: { pullRequest: { state, headRefOid: head, baseRefName: "main", mergeCommit: state === "MERGED" ? { oid: merge } : null, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: check === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: check }] } } } }] } } },
});
const ref = "https://github.com/acme/app/pull/7";
const own = { repo: "acme/app", number: 7, url: ref };
const deps = (over = {}) => ({ busy: () => "", approvals: async () => [], taskPrs: async () => [own], pr: async () => pr(), diff: async () => "+x", comments: async () => [], attachments: async () => [], ...over });

test("pending evidence waits; a merged PR is bound to its merge commit", async () => {
  assert.match((await gather({ kind: "pr", ref: "" }, deps({ taskPrs: async () => [] }))).awaiting, /no pull request/);
  assert.match((await gather({ kind: "pr", ref }, deps({ pr: async () => pr({ check: "PENDING" }) }))).awaiting, /checks still running/);
  assert.match((await gather({ kind: "pr", ref }, deps({ busy: () => "its merges are still running" }))).awaiting, /merges/);
  assert.match((await gather({ kind: "pr", ref }, deps({ approvals: async () => [{ id: "A1", action: "merge", state: "pending" }] }))).awaiting, /card is still open/);
  const merged = await gather({ kind: "pr", ref }, deps({ pr: async () => pr({ state: "MERGED" }) }));
  assert.equal(merged.version, `acme/app#7@${"m".repeat(40)}`);
  assert.match(merged.facts[0], /merged into main.*checks: test green/);
  const long = [1, 2, 3, 4].map((n) => ({ repo: "acme/a-rather-long-repository-name", number: n, url: `https://github.com/acme/a-rather-long-repository-name/pull/${n}` }));
  const many = await gather({ kind: "pr", ref: "acme/a-rather-long-repository-name" }, deps({ taskPrs: async () => long }));
  assert.match(many.version, /^prs:[0-9a-f]{16}$/);
});

test("only the task's own PRs are read; an open PR the runner can't merge waits", async () => {
  const read = [];
  const spy = deps({ pr: async (repo, n) => (read.push(`${repo}#${n}`), pr()) });
  // A ref naming someone else's PR is never fetched.
  assert.match((await gather({ kind: "pr", ref: "https://github.com/other/secret/pull/1" }, spy)).awaiting, /no pull request/);
  assert.deepEqual(read, []);
  assert.ok((await gather({ kind: "pr", ref: "acme/app#7" }, spy)).version);
  assert.deepEqual(read, ["acme/app#7"]);
  // Outside the agents org and the product repo: open is not yet gradable; merged is.
  const outside = (state) => gather({ kind: "pr", ref: "" }, deps({ ownRepo: () => false, pr: async () => pr({ state }) }));
  assert.match((await outside("OPEN")).awaiting, /not merged yet/);
  assert.ok((await outside("MERGED")).version);
  assert.ok((await gather({ kind: "pr", ref: "" }, deps({ ownRepo: () => true }))).version, "an open PR the runner or owner merges is gradable");
});

test("the grader is never the author's family: GLM first, Kimi for a GLM author", () => {
  assert.deepEqual(graderModels("openrouter/~deepseek/deepseek-flash-latest"), ["~z-ai/glm-latest", "moonshotai/kimi-k3.1-pro"]);
  assert.deepEqual(graderModels("z-ai/glm-5.3"), ["moonshotai/kimi-k3.1-pro"]);
  assert.deepEqual(graderModels("moonshotai/kimi-k3.1-pro"), ["~z-ai/glm-latest"]);
});

test("corrupt or empty criteria are a retryable grading failure, never a verdict", async () => {
  const rubric = ["merged into main", "checks green", "the test covers it"];
  const ask = async () => ({ content: JSON.stringify({ verdict: "needs_revision", criteria: [
    { id: " criterion is this...) its [ j. 7  green]7.", met: "no", evidence: "garbage" },
    { id: "}, {. >: uncertainty]]", met: "unknown", evidence: "garbage" },
    { id: "+\\build  7 next-agent.", met: "no", evidence: "garbage" },
  ] }) });
  const v = await grade({ rubric, deliverable: { kind: "pr", ref: "" }, facts: [], data: {}, request: "", authorModel: "openrouter/~deepseek/deepseek-flash-latest", ask });
  assert.equal(v.outcome, "grading_failed");
  assert.deepEqual(v.criteria, []);

  for (const criteria of [
    [],
    [{ id: "1", met: "yes", evidence: "a" }, { id: "1", met: "yes", evidence: "b" }, { id: "2", met: "yes", evidence: "c" }],
    [{ id: "0", met: "yes", evidence: "a" }, { id: "1", met: "yes", evidence: "b" }, { id: "2", met: "yes", evidence: "c" }],
    [{ id: "1", met: "yes", evidence: "" }, { id: "2", met: "yes", evidence: "b" }, { id: "3", met: "yes", evidence: "c" }],
  ]) {
    const bad = await grade({ rubric, deliverable: { kind: "pr", ref: "" }, facts: [], data: {}, request: "", authorModel: "", ask: async () => ({ content: JSON.stringify({ verdict: "satisfied", criteria }) }) });
    assert.equal(bad.outcome, "grading_failed", JSON.stringify(criteria));
  }
  const emptyRubric = await grade({ rubric: [], deliverable: { kind: "report", ref: "" }, facts: [], data: {}, request: "", authorModel: "", ask });
  assert.equal(emptyRubric.outcome, "grading_failed");
});

test("parseable criteria still take the genuine satisfied and needs_revision paths", async () => {
  const rubric = ["merged into main", "checks green", "the test covers it"];
  const answer = (met, verdict = met.every((m) => m === "yes") ? "satisfied" : "needs_revision") => ({ content: JSON.stringify({ verdict, criteria: met.map((m, i) => ({ id: String(i + 1), met: m, evidence: `criterion ${i + 1} evidence` })) }) });
  const needs = await grade({ rubric, deliverable: { kind: "pr", ref: "" }, facts: [], data: {}, request: "", authorModel: "", ask: async () => answer(["yes", "no", "yes"]) });
  assert.equal(needs.outcome, "needs_revision");
  assert.deepEqual(needs.criteria.map((c) => c.met), ["yes", "no", "yes"]);
  const pass = await grade({ rubric, deliverable: { kind: "pr", ref: "" }, facts: [], data: {}, request: "", authorModel: "", ask: async () => answer(["yes", "yes", "yes"]) });
  assert.equal(pass.outcome, "satisfied");
});
