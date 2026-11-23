import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, organisations } from "../modules.ts";
import { MANIFESTS_JSON, manifestsJson } from "../slack-manifest.ts";

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

test("organisations: listed clients reach the board for enabled modules, and only public client values are accepted", () => {
  assert.deepEqual(compile(mods, inst(["flowok"])).points.board.organisations, [{ id: "acme", name: "Acme", domains: ["acme.example.com"], clients: [{ module: "flowok", secret: "flowok_client_id", value: "1234.5678" }] }]);
  assert.equal(compile(mods, inst(["flowadv"])).points.board.organisations, undefined);
  const defs = { m: { secrets: { provided: [{ name: "m_client_id", setup: { label: "Id", pattern: "^[0-9]+$", public_client: true } }, { name: "m_bot_token", setup: { label: "Bot", pattern: "^.+$" } }] } } };
  const org = (clients) => [{ id: "acme", name: "Acme", domains: ["acme.example.com"], clients }];
  assert.throws(() => organisations(org({ m_bot_token: "xoxb" }), defs, defs), /not a module secret marked public_client/);
  assert.throws(() => organisations(org({ m_client_id: "abc" }), defs, defs), /doesn't fit its pattern/);
  assert.deepEqual(organisations(org({ m_client_id: "42" }), defs, {}), []);
  assert.equal(organisations([{ ...org({ m_client_id: "42" })[0], note: "A client ID is public." }], defs, defs)[0].note, undefined);
  assert.throws(() => organisations([{ ...org({ m_client_id: "42" })[0], note: "x".repeat(501) }], defs, defs), /note is a text/);
  assert.throws(() => organisations([{ ...org({ m_client_id: "42" })[0], secrets: {} }], defs, defs), /unknown secrets/);
});

test("slack-live sends the manifest in slack-app-manifest.yml (node scripts/slack-manifest.ts --write)", () => {
  assert.equal(readFileSync(MANIFESTS_JSON, "utf8"), manifestsJson());
});
