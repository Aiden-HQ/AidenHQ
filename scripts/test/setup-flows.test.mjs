import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";

const mods = join(dirname(fileURLToPath(import.meta.url)), "fixtures/mods");
const inst = (modules) => {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["core", ...modules], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com" } }));
  mkdirSync(join(dir, "agents"));
  return dir;
};

test("setup flows compile with their module and refuse undeclared secrets", () => {
  const out = compile(mods, inst(["flowok"]));
  const [flow] = out.points.board.setup_flows;
  assert.equal(flow.module, "flowok");
  assert.equal(flow.pair_token, "flowok_pair_token");
  assert.ok(out.generatedSecrets.includes("flowok_pair_token"));
  assert.ok(out.compose.services.board.secrets.includes("flowok_pair_token"));
  assert.throws(() => compile(mods, inst(["flowbad"])), /names a secret without setup/);
});
