// The board's typed changes as the compiler reads them: a module agent's handbook fork (made, edited, dropped) and its
// grants override, merged per connection before grants resolve (docs/design/agent-and-module-pages.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";
import { readInstructions } from "../handbook.mjs";

const mods = join(dirname(fileURLToPath(import.meta.url)), "fixtures/mods");
const BLOB = "c".repeat(40);

function instance(overrides) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["core", "a"], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com" }, ...(overrides ? { overrides } : {}) }));
  return dir;
}
const handbook = (dir) => {
  const { paperclip } = compile(mods, dir);
  return readInstructions(paperclip, paperclip.agents.x, { repo: mods, instanceDir: dir });
};

test("a handbook fork: made, edited, dropped; each compiles, and the agent reads the fork while it is set", () => {
  const dir = instance();
  const module = handbook(dir);
  mkdirSync(join(dir, "agents", "x"), { recursive: true });
  writeFileSync(join(dir, "agents", "x", "AGENTS.md"), "# Mine\n\nForked words.\n");
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ ...YAML.parse(readFileSync(join(dir, "instance.yaml"), "utf8")), overrides: { agents: { x: { handbook_fork: BLOB } } } }));
  assert.match(handbook(dir), /Forked words\./);
  assert.equal(compile(mods, dir).paperclip.agents.x.handbook_fork, BLOB);
  writeFileSync(join(dir, "agents", "x", "AGENTS.md"), "# Mine\n\nEdited words.\n");
  assert.match(handbook(dir), /Edited words\./);
  // Update: the file and the override go together, and the module's handbook is back.
  rmSync(join(dir, "agents", "x"), { recursive: true });
  const { overrides, ...rest } = YAML.parse(readFileSync(join(dir, "instance.yaml"), "utf8"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify(rest));
  assert.equal(handbook(dir), module);
  // A fork without its file is refused.
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ ...rest, overrides: { agents: { x: { handbook_fork: BLOB } } } }));
  assert.throws(() => compile(mods, dir), /missing agents\/x\/AGENTS\.md/);
});

test("a grants override replaces that connection's grant (optional key too) before grants resolve", () => {
  const base = compile(mods, instance()).paperclip.agents.x.enabled_tools;
  assert.deepEqual(base.aconn, ["a_get", "a_set"]);
  const t = compile(mods, instance({ agents: { x: { connections: { aconn: ["a_get"] } } } })).paperclip.agents.x.enabled_tools;
  assert.deepEqual(t.aconn, ["a_get"]);
  assert.deepEqual(t.bconn, base.bconn, "other connections as the module grants them");
  assert.throws(() => compile(mods, instance({ agents: { x: { connections: { aconn: ["a_nope"] } } } })), /aconn has no tool a_nope/);
});

test("a per-module pin of an official module is refused: the product pin moves the official modules", () => {
  const dir = instance();
  const i = YAML.parse(readFileSync(join(dir, "instance.yaml"), "utf8"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ ...i, modules: ["core", { id: "a", sha: "1".repeat(40) }] }));
  assert.throws(() => compile(mods, dir), /official module is part of the product: pin the product/);
});
