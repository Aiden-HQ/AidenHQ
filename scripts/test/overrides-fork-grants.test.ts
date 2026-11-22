// The board's typed changes as the compiler reads them: a module agent's handbook fork (made, edited, dropped) and its
// grants override, merged per connection before grants resolve (docs/design/agent-and-module-pages.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.ts";

const mods = join(dirname(fileURLToPath(import.meta.url)), "fixtures/mods");

function instance(overrides) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["core", "a"], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com" }, ...(overrides ? { overrides } : {}) }));
  return dir;
}

test("a grants override replaces that connection's grant (optional key too) before grants resolve", () => {
  const base = compile(mods, instance()).paperclip.agents.x.enabled_tools;
  assert.deepEqual(base.aconn, ["a_get", "a_set"]);
  const t = compile(mods, instance({ agents: { x: { connections: { aconn: ["a_get"] } } } })).paperclip.agents.x.enabled_tools;
  assert.deepEqual(t.aconn, ["a_get"]);
  assert.deepEqual(t.bconn, base.bconn, "other connections as the module grants them");
  assert.throws(() => compile(mods, instance({ agents: { x: { connections: { aconn: ["a_nope"] } } } })), /aconn has no tool a_nope/);
});
