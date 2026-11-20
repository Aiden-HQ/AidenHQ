// Step 4 of "Each run — a labelled issue" states what a brief asks for and what it does with a requirement a recorded
// product decision rules out. These tests hold that paragraph: a brief asks for the product's forward behaviour, owner
// words alone call for migrating old data, and a rejected requirement is dropped and re-scoped on the issue's own task.
// The last case replays step 4 as it stood before the paragraph was added, where the paragraph is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const handbook = readFileSync(new URL("../agents/maintainer/AGENTS.md", import.meta.url), "utf8");

/** Step 4 of "Each run — a labelled issue", whitespace collapsed so a line wrap can't hide a clause. */
function step4(text = handbook) {
  const start = text.indexOf("## Each run — a labelled issue");
  assert.notEqual(start, -1, "the labelled-issue run is in the handbook");
  const rest = text.slice(start);
  const step = rest.indexOf("\n4. For `real`");
  assert.notEqual(step, -1, "step 4 is in the labelled-issue run");
  const body = rest.slice(step + 1);
  const end = body.indexOf("\n5. ");
  assert.notEqual(end, -1, "step 4 ends before step 5");
  return body.slice(0, end).replace(/\s+/g, " ");
}

/** The brief policy paragraph that follows step 4's older briefing duties (repo, sha, path:line, repro). */
function briefPolicy(text = handbook) {
  const step = step4(text);
  const at = step.indexOf("A brief asks for what the product should do from now on");
  return at === -1 ? "" : step.slice(at);
}

test("a brief asks for the product's forward behaviour, and a fresh start is allowed", () => {
  const policy = briefPolicy();
  assert.match(policy, /A brief asks for what the product should do from now on/);
  assert.match(policy, /a new table or a fresh row is the fresh start that is allowed/);
});

test("a back-compat path or a migration is required only from the owner's own words", () => {
  const policy = briefPolicy();
  const condition = policy.indexOf("from the owner's own words");
  assert.notEqual(condition, -1, "the migration duties take the owner's own words");
  for (const duty of ["a back-compat path", "a migration of old data", "an upgrade of an existing table"]) {
    const at = policy.indexOf(duty);
    assert.notEqual(at, -1, `${duty} is named`);
    assert.ok(at < condition, `${duty} is bound to the owner's-words condition`);
  }
});

test("a rejection that quotes a recorded decision drops that requirement and re-scopes the brief", () => {
  const policy = briefPolicy();
  assert.match(policy, /A rejection that quotes a recorded product decision answers the requirement it names/);
  assert.match(policy, /the brief drops that requirement/);
  assert.doesNotMatch(policy, /keeps? (that|the) requirement/, "the rejected requirement is not carried forward");
});

test("the re-scoped brief replaces the brief before it on the issue's own task", () => {
  const policy = briefPolicy();
  assert.match(policy, /the re-scoped brief goes to the issue's own task, where it replaces the brief before it/);
  assert.match(policy, /each requirement reaches the engineer once, on that one task/);
  assert.doesNotMatch(policy, /new task/, "the requirement is never re-filed on a new task");
});

test("the paragraph is the wording merged for the recorded-decision rule", () => {
  assert.equal(
    briefPolicy(),
    "A brief asks for what the product should do from now on, and a new table or a fresh row is the fresh start that is " +
      "allowed. A brief takes a back-compat path, a migration of old data or an upgrade of an existing table from the " +
      "owner's own words, carrying that request in their words. A rejection that quotes a recorded product decision " +
      "answers the requirement it names: the brief drops that requirement, and the re-scoped brief goes to the issue's " +
      "own task, where it replaces the brief before it — each requirement reaches the engineer once, on that one task.",
  );
});

test("each case fails against the paragraph before the merge that added it", () => {
  const before = [
    "4. For `real`, brief the engineer: an Engineer.",
    "   The brief names the repo, the symptom, the sha, the `path:line`, the repro and the exact change wanted.",
    "",
    "5. The fix is its PR, merged.",
  ].join("\n");
  const run = `## Each run — a labelled issue\n\n${before}`;
  assert.equal(briefPolicy(run), "", "the old step 4 has no policy paragraph");
});
