// The Red Teamer alerts the owner only when the call is theirs (a credential only they can create, or accepting
// exposure the fleet cannot fix). A finding whose fix task is already filed goes on that task and the log rather
// than the owner, unless that fix is blocked on such a decision, which the run must then alert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");

function handbook() {
  return readFileSync(join(product, "modules/security/agents/red-teamer/AGENTS.md"), "utf8");
}

function moduleYaml() {
  return readFileSync(join(product, "modules/security/module.yaml"), "utf8");
}

function section(text: string, heading: string) {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const end = text.indexOf("\n## ", start + heading.length);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

test("the alert rule names the owner-only decisions", () => {
  const text = handbook();
  assert.match(
    text,
    /Alert the owner only when the call is theirs/,
    "the alert rule: only a credential or accepting exposure is the owner's call",
  );
  assert.match(
    text,
    /never send the owner a finding the fleet is already fixing/,
    "the alert rule: a finding with a fix task is never an owner alert",
  );
  assert.doesNotMatch(
    text,
    /per run listing new high or critical findings/,
    "the alert rule: no per-run listing of new high or critical findings to the owner",
  );
});

test("the exception survives a fix task", () => {
  const reporting = section(handbook(), "## Reporting a finding");
  assert.ok(reporting, "the handbook has a `## Reporting a finding` section");
  assert.match(
    reporting,
    /A fix task does not cancel the exception/,
    "the exception survives a fix task: a blocked credential or accept-exposure call is still the owner's alert",
  );
  assert.match(
    reporting,
    /that alert is the owner's call/,
    "the exception reads in the reporting rule itself, not only elsewhere in the handbook",
  );
});

test("a blocked owner decision is alerted, not just allowed", () => {
  const reporting = section(handbook(), "## Reporting a finding");
  assert.match(
    reporting,
    /that alert is required, not optional/,
    "the blocked owner decision must be alerted: the rule permits the alert and the run must send it",
  );
  assert.match(
    reporting,
    /names every new or changed blocker still open when you send it/,
    "one alert carries every blocked decision: a second blocker must not go unreported under the one-alert cap",
  );
  assert.match(
    reporting,
    /send at most one `notify` \(`kind: alert`\) per run after the last target/,
    "the alert waits for the last target: a later target's blocker still belongs in the same alert",
  );
  assert.match(
    section(handbook(), "## Daily pass"),
    /check open fix tasks for an owner-only blocker first and send the alert "Reporting a finding" calls for \(its new-or-changed rule applies here too\)/,
    "the no-change exit sends the alert, not just checks, and reuses the new-or-changed rule instead of restating it",
  );
  assert.match(
    reporting,
    /including from open fix tasks and on a run that changed nothing/,
    "blocker discovery also reads open fix tasks, even on a run with no changes: a new owner dependency must not be missed",
  );
});

test("the tools bullet scopes notify alerts to an owner-only decision", () => {
  const text = handbook();
  const bullet = text.split("\n").find((line) => line.includes("**`notify`:**"));
  assert.ok(bullet, "the tools section states what `notify` is for");
  assert.match(
    bullet,
    /`kind: alert` only for an owner-only decision/,
    "the tools bullet: `kind: alert` is for an owner-only decision only",
  );
});

test("Done when asks every owner alert to name an owner-only decision", () => {
  const done = section(handbook(), "## Done when");
  assert.ok(done, "the handbook has a `## Done when` section");
  assert.match(
    done,
    /every owner alert sent this run names an owner-only decision/,
    "the alert rule: each owner alert sent this run names an owner-only decision",
  );
});

test("the weekly routine defers the owner alert to the handbook", () => {
  assert.doesNotMatch(
    moduleYaml(),
    /notify \(kind alert\)/,
    "a routine's own prompt must defer the owner alert to the handbook; a severity-based alert line there reintroduces the defect the handbook rule removes",
  );
});
