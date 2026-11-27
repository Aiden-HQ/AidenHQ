import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, moduleReads, modulePages, organisations } from "../modules.ts";
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

test("a map secret's declared fields reach the kernel's setup entry (a key field's own cap)", () => {
  const out = compile(mods, inst(["mapok"]));
  const entry = out.kernelModules.setup.find((f: { secret: string }) => f.secret === "mapok_keys");
  assert.deepEqual(entry.fields, [{ name: "label", kind: "text" }, { name: "private_key", kind: "key", maxLength: 4096 }, { name: "passphrase", kind: "password" }]);
  // Two of a module's pages may declare the same secret only with one field table: the kernel takes one per secret.
  assert.throws(() => compile(mods, inst(["mapdup"])), /secret_maps mapdup_keys is declared again with other fields/);
  // A secret no page declares carries none: its kernel cap stays 300.
  const plain = compile(mods, inst(["flowok"])).kernelModules.setup.find((f: { secret: string }) => f.secret === "flowok_bot_token");
  assert.equal(plain.fields, undefined);
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

test("board.pages: a module's Fleet page compiles onto its own connection, and a destructive view tool is refused", () => {
  const out = compile(mods, inst(["pageok"]));
  assert.deepEqual(out.points.board.pages, [{ id: "notes", title: "Notes", icon: "list", order: 10, connection: "pageok-mcp", view: "ui://pageok/page", tools: ["pageok_notes", "pageok_configure"], module: "pageok" }]);
  assert.deepEqual(out.connections["pageok-mcp"].views, { "ui://pageok/page": ["pageok_notes", "pageok_configure"], "read:notes_today": ["pageok_notes"] });
  const conns = () => ({ "pageok-mcp": { module: "pageok", tools: { read: ["pageok_notes"], write: [], destructive: ["pageok_wipe"] } } });
  const page = { id: "notes", module: "pageok", connection: "pageok-mcp", view: "ui://pageok/page", tools: ["pageok_notes"], settings: ["mine", "other"] };
  assert.throws(() => modulePages([page], conns(), {}, (_m, k) => k === "mine"), /setting other isn't declared by pageok or a module it requires/);
  assert.doesNotThrow(() => modulePages([{ ...page, view: "ui://pageok/page2" }], conns(), {}, () => true));
  // secret_maps: the module's own `setup:` secret, keys from one of its own settings.
  const mapped = (m: object) => [{ ...page, settings: [], secret_maps: [{ secret: "pageok_logins", keys_from: "targets.apps[].name", fields: [{ name: "user", label: "User", kind: "text" }], ...m }] }];
  const own = { setting: (_m: string, k: string) => k === "targets", secret: (_m: string, n: string) => n === "pageok_logins" };
  assert.doesNotThrow(() => modulePages(mapped({}), conns(), {}, () => true, own));
  assert.throws(() => modulePages(mapped({ secret: "other_secret" }), conns(), {}, () => true, own), /secret_maps other_secret isn't a `setup:` secret of pageok/);
  assert.throws(() => modulePages(mapped({ keys_from: "elsewhere.apps[].name" }), conns(), {}, () => true, own), /keys_from elsewhere.apps\[\].name isn't a setting of pageok/);
  assert.throws(() => modulePages([{ id: "notes", module: "pageok", connection: "pageok-mcp", view: "ui://pageok/page", tools: ["pageok_wipe"] }], conns()), /pageok_wipe isn't a read or write tool/);
  assert.throws(() => modulePages([{ id: "notes", module: "pageok", connection: "pageok-mcp", view: "ui://pageok/page", tools: ["pageok_configure"] }], { "pageok-mcp": { module: "pageok", tools: { read: [], write: ["pageok_configure"], destructive: [] } } }, { "pageok.set": { tools: ["pageok-mcp.pageok_configure"] } }), /is write kind pageok.set's/);
});

test("board.reads: a read compiles onto its connection's views as read:<id>; a write tool is refused", () => {
  const conns = () => ({ "pageok-mcp": { module: "pageok", tools: { read: ["pageok_notes"], write: ["pageok_configure"], destructive: [] } } });
  const c = conns();
  moduleReads([{ id: "x", module: "pageok", connection: "pageok-mcp", tool: "pageok_notes" }], c);
  assert.deepEqual(c["pageok-mcp"].views, { "read:x": ["pageok_notes"] });
  assert.throws(() => moduleReads([{ id: "x", module: "pageok", connection: "pageok-mcp", tool: "pageok_configure" }], conns()), /board.reads x: pageok_configure isn't a read tool/);
  assert.throws(() => moduleReads([{ id: "x", module: "other", connection: "pageok-mcp", tool: "pageok_notes" }], conns()), /isn't one of its own/);
});
