// A merge queue stopped by red required checks: the receipt names each check with its conclusion and the failing step's
// error, so the delegator can tell a red diff from a stale base without running `gh pr checks` themselves.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance } from "../src/merge-gate.mjs";
import { newQueue } from "../../engineering/src/merge-queue.mjs";

const HEAD = "ab12".repeat(10);
const url = "https://github.com/acme/app/pull/1";
const at = (min) => new Date(Date.parse("2026-11-18T10:00:00Z") + min * 60_000);

const run = (name, conclusion, databaseId) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, databaseId, checkSuite: { workflowRun: { databaseId: 900 } } });
// A commit status (an outside service's, not an Actions job): it has a `context` instead of a `name`, and no job to read.
const status = (context, state, description) => ({ __typename: "StatusContext", context, state, description });
const rollup = (nodes) => ({ state: nodes.some((n) => ["FAILURE", "CANCELLED"].includes(n.conclusion ?? n.state)) ? "FAILURE" : "SUCCESS", contexts: { nodes } });
const prAt = (nodes) => ({
  id: "PR_1", number: 1, title: "a change", url, state: "OPEN", isDraft: false, reviewDecision: "APPROVED",
  mergeStateStatus: "UNSTABLE", headRefOid: HEAD, headRefName: "fix/a", baseRefName: "main", isCrossRepository: false,
  latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] },
  commits: { nodes: [{ commit: { statusCheckRollup: rollup(nodes) } }] },
  baseRef: { target: { oid: "base", statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [run("tests", "SUCCESS", 1)] } } } },
});

function fakeGithub(pr, { jobs = {}, reruns = {} } = {}) {
  return {
    jobs,
    async pr() {
      return { repository: { defaultBranchRef: { name: "main" }, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, pullRequest: pr } };
    },
    async job(repo, check) {
      return jobs[check.name] ?? { steps: [{ name: "Run tests", conclusion: "FAILURE" }], annotations: [] };
    },
    async reruns() {
      return reruns;
    },
    async rerun() {
      throw new Error("no re-run expected in this test");
    },
  };
}

const queue = () => newQueue([{ repo: "acme/app", number: 1, url, head: HEAD }], { gapMinutes: 0, now: at(0) });

test("a failed required check is named with its conclusion and the failing step's error", async () => {
  const error = "AssertionError: expected 2 to equal 3";
  const gh = fakeGithub(prAt([run("tests", "SUCCESS", 1), run("env", "FAILURE", 10)]), {
    jobs: { env: { steps: [{ name: "Run the integration tests", conclusion: "FAILURE" }], annotations: [{ annotation_level: "failure", message: error }] } },
  });
  const q = queue();
  const step = await advance(q, { github: gh, now: at(1), cardIsReview: () => true });

  assert.equal(step.done, "stopped");
  const said = step.say[0];
  assert.match(said, /\*\*Stopped the merges:\*\* #1 has failing checks/, "the existing header keeps matching");
  assert.match(said, /`env` — FAILURE/, "the check and its conclusion");
  assert.match(said, /step `Run the integration tests` failed/, "the failing step");
  assert.match(said, new RegExp(error), "the error output");
  assert.doesNotMatch(said, /`tests` — /, "a green check is not listed");
});

test("two failed checks are both named", async () => {
  const gh = fakeGithub(prAt([run("tests", "SUCCESS", 1), run("env", "FAILURE", 10), run("lint", "TIMED_OUT", 11)]), {
    jobs: {
      env: { steps: [{ name: "Run tests", conclusion: "FAILURE" }], annotations: [{ annotation_level: "failure", message: "one test failed" }] },
      lint: { steps: [{ name: "Lint", conclusion: "FAILURE" }], annotations: [{ annotation_level: "failure", message: "prettier: code style issues found" }] },
    },
  });
  const step = await advance(queue(), { github: gh, now: at(1), cardIsReview: () => true });

  const said = step.say[0];
  assert.match(said, /`env` — FAILURE/);
  assert.match(said, /`lint` — TIMED_OUT/);
  assert.match(said, /one test failed/);
  assert.match(said, /code style issues found/);
});

test("a rollup red only from a cancelled check names it CANCELLED, not as a failure", async () => {
  // The run was already re-run once at this head and the new job was cancelled too: no failed check, and nothing to re-run.
  const gh = fakeGithub(prAt([run("tests", "SUCCESS", 1), run("packages", "CANCELLED", 22)]), { reruns: { packages: { head: HEAD, id: 21 } } });
  const step = await advance(queue(), { github: gh, now: at(1), cardIsReview: () => true });

  const said = step.say[0];
  assert.match(said, /`packages` — CANCELLED/);
  assert.doesNotMatch(said, /`packages` — FAILURE/);
  assert.doesNotMatch(said, /step `/, "a cancelled check judged nothing, so it has no failing step to quote");
});

test("a failed commit status is named by its context, with the description GitHub gave it", async () => {
  const gh = fakeGithub(prAt([status("security/snyk", "FAILURE", "1 vulnerable dependency: lodash")]));
  const step = await advance(queue(), { github: gh, now: at(1), cardIsReview: () => true });

  const said = step.say[0];
  assert.match(said, /`security\/snyk` — FAILURE/);
  assert.match(said, /1 vulnerable dependency: lodash/);
  assert.doesNotMatch(said, /step `/, "a commit status has no job to read");
});

test("GitHub's own words render as text: an annotation's Markdown is escaped", async () => {
  // Whoever can push to the repo writes a check's annotation; a link or an image in it must not render in the receipt.
  const gh = fakeGithub(prAt([run("env", "FAILURE", 10)]), {
    jobs: { env: { steps: [{ name: "Run tests", conclusion: "FAILURE" }], annotations: [{ annotation_level: "failure", message: "see [the docs](https://example.com) ![shot](https://example.com/x.png)" }] } },
  });
  const step = await advance(queue(), { github: gh, now: at(1), cardIsReview: () => true });

  const said = step.say[0];
  assert.ok(said.includes("see \\[the docs\\](https://example.com)"), "the brackets are escaped, so nothing renders");
  assert.ok(!/[^\\]\[[^\]]*\]\(/.test(said), "no unescaped link survives");
});

