// The DevOps Engineer's host one-off rule: the handbook points to the operations procedure, and that procedure keeps the
// whole action under the apply lock and keeps stateful data and live paths out of scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const flat = (s) => s.replace(/\s+/g, " ");
const handbook = readFileSync(new URL("../../modules/apps-platform/agents/app-maintainer/AGENTS.md", import.meta.url), "utf8");
const operations = readFileSync(new URL("../../docs/operations.md", import.meta.url), "utf8");

/** A top-level section's body: from its `## ` heading to the next `## ` heading. */
function section(text, heading) {
  const at = text.indexOf(`\n## ${heading}\n`);
  assert.notEqual(at, -1, `the document has a "## ${heading}" section`);
  const body = text.slice(at + 1);
  const end = body.indexOf("\n## ", 1);
  return end === -1 ? body : body.slice(0, end);
}

test("the DevOps Engineer's handbook sends host one-offs to the operations procedure", () => {
  const rule = flat(section(handbook, "Host one-offs outside an app"));
  assert.match(rule, /You have no host shell/, "the handbook says the agent cannot run a host one-off");
  assert.match(rule, /`docs\/operations\.md`/, "the handbook links the procedure");
  assert.match(rule, /`## Host one-offs`/, "the handbook names the procedure's section");
  assert.match(rule, /Never delete an app's, the warehouse's or any other stateful data/, "the handbook keeps stateful data out of scope");
});

test("the operations procedure holds the whole one-off under the apply lock", () => {
  const procedure = flat(section(operations, "Host one-offs"));
  assert.match(procedure, /flock data\/apply\.lock -c '<the one-off>'/, "the whole one-off runs under the apply lock");
  assert.match(procedure, /Never delete stateful data/, "stateful data is excluded");
  assert.match(procedure, /Never remove a path a live job is using/, "live paths are excluded");
});
