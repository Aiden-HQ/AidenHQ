// The Red Teamer alerts the owner only when the call is theirs (a credential only they can create, or accepting
// exposure the fleet cannot fix); a finding whose fix task is already filed belongs on that task and the log, never
// in an owner alert.
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
