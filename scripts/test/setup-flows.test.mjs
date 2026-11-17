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
  assert.deepEqual(flow.fields, [{ secret: "flowok_bot_token", label: "Bot token", pattern: "^[0-9]+$", help: "Digits only." }]);
  assert.ok(out.generatedSecrets.includes("flowok_pair_token"));
  assert.ok(out.compose.services.board.secrets.includes("flowok_pair_token"));
  assert.throws(() => compile(mods, inst(["flowbad"])), /names a secret without setup/);
});

test("the board shares a network with the service a flow pairs through, and only its own module's", () => {
  const { compose } = compile(mods, inst(["flowok"]));
  assert.deepEqual(compose.networks["mod-flowok-board"], { name: "aidenhq-mod-flowok-board", internal: true, ipam: compose.networks["mod-flowok-board"].ipam });
  assert.ok(compose.services.board.networks.includes("mod-flowok-board"));
  assert.ok("mod-flowok-board" in compose.services["flowok-bot"].networks);
  assert.equal(compose.services["flowok-bot"].labels["aidenhq.links"], "board");
  assert.throws(() => compile(mods, inst(["flowstray"])), /pair_url http:\/\/board:3121\/pair is not one of its services/);
});
