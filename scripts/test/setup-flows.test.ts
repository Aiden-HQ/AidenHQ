import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, organisations } from "../modules.ts";
import { BUNDLE } from "./bundle.ts";

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

test("a board.signins id that isn't its module's name fails", () => {
  assert.throws(() => compile(mods, inst(["signbad"])), /module signbad: a board.signins id is the module's name/);
});

test("the board shares a network with the service a flow pairs through, and only its own module's", () => {
  const { compose } = compile(mods, inst(["flowok"]));
  assert.deepEqual(compose.networks["mod-flowok-board"], { name: "aidenhq-mod-flowok-board", internal: true, ipam: compose.networks["mod-flowok-board"].ipam });
  assert.ok(compose.services.board.networks.includes("mod-flowok-board"));
  assert.ok("mod-flowok-board" in compose.services["flowok-bot"].networks);
  assert.equal(compose.services["flowok-bot"].labels["aidenhq.links"], "board");
  assert.throws(() => compile(mods, inst(["flowstray"])), /pair_url http:\/\/board:3121\/pair is not one of its services/);
});

test("a sign-in is one Connect: ClickHouse asks nothing, Glean asks only its own address, and neither has a setup page", () => {
  const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "clickhouse", "glean", "jira"], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x", product_repo: "acme/aidenhq" } }));
  mkdirSync(join(dir, "agents"));
  const { points, compose } = compile(product, dir);
  const flows = points.board.setup_flows.map((f) => f.module);
  for (const m of ["clickhouse", "glean", "jira"]) assert.ok(!flows.includes(m), `${m} has a setup page`);
  const signIn = (id) => points.board.signins.find((s) => s.id === id);
  assert.equal(signIn("clickhouse").fields, undefined);
  assert.equal(compose.services["clickhouse-mcp"].environment.CLICKHOUSE_MCP_URL, "https://mcp.clickhouse.cloud/mcp");
  assert.deepEqual(signIn("glean").fields.map((f) => f.secret), ["glean_mcp_url"]);
  assert.deepEqual(signIn("jira").fields.map((f) => f.secret), ["jira_url"], "Jira's site is asked for on Connect, not set as a setting");
  assert.ok(compose.services["jira-mcp"], "unconnected, jira-mcp starts and says how to connect");
});

// One test per mode of Grafana, from a fresh install to what the owner sees: the Connect, the settings that apply, the service.
test("Grafana cloud: Connect asks for the stack's address, and the hosted MCP address applies", () => {
  const { points, compose, catalog } = compile(join(dirname(fileURLToPath(import.meta.url)), "../.."), grafanaInstance({}));
  assert.deepEqual(points.board.signins.find((s) => s.id === "grafana").fields.map((f) => f.secret), ["grafana_url"]);
  assert.deepEqual(catalog.find((m) => m.name === "grafana").settings.grafana_mcp_url.when, { grafana_source: "cloud" });
  assert.equal(compose.services["grafana-mcp"].environment.GRAFANA_SOURCE, "cloud");
});

test("Grafana local: Connect asks for nothing, and the service runs on the monitoring module's Grafana", () => {
  const { points, compose } = compile(join(dirname(fileURLToPath(import.meta.url)), "../.."), grafanaInstance({ grafana_source: "local" }));
  assert.deepEqual(points.board.signins.find((s) => s.id === "grafana").fields ?? [], [], "local mode never asks for the Grafana Cloud address");
  assert.equal(compose.services["grafana-mcp"].environment.GRAFANA_SOURCE, "local");
});

function grafanaInstance(settings) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "grafana", "monitoring"], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x", product_repo: "acme/aidenhq", ...settings } }));
  mkdirSync(join(dir, "agents"));
  return dir;
}

test("Primer's Connect follows primer_mode: nothing to give in self-host (the default), the hosted address in connect", () => {
  const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const fields = (settings) => {
    const dir = mkdtempSync(join(tmpdir(), "inst-"));
    writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "primer"], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x", product_repo: "acme/aidenhq", ...settings } }));
    mkdirSync(join(dir, "agents"));
    return compile(product, dir).points.board.signins.find((s) => s.id === "primer").fields;
  };
  assert.deepEqual(fields({}), []);
  assert.deepEqual(fields({ primer_mode: "connect" }).map((f) => f.secret), ["primer_mcp_url"]);
});

test("Primer's setup flow asks the mode first", () => {
  const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "primer"], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x", product_repo: "acme/aidenhq" } }));
  mkdirSync(join(dir, "agents"));
  const flow = compile(product, dir).points.board.setup_flows.find((f) => f.module === "primer");
  assert.equal(flow.choose.setting, "primer_mode");
  assert.deepEqual(flow.choose.options.map((o) => [o.value, o.inputs, o.requires]), [["self-host", undefined, undefined], ["connect", undefined, undefined]]);
});

test("an advanced flow rides on its module's basic one, with its own secrets and pairing", () => {
  const out = compile(mods, inst(["flowadv"]));
  const [flow] = out.points.board.setup_flows;
  assert.equal(out.points.board.setup_flows.length, 1);
  assert.equal(flow.title, "Chat");
  assert.deepEqual(flow.advanced.capabilities, ["a bot people can DM"]);
  assert.deepEqual(flow.advanced.fields.map((f) => f.secret), ["flowadv_bot_token"]);
  assert.equal(flow.advanced.pair_token, "flowadv_pair_token");
  assert.ok(out.compose.services.board.networks.includes("mod-flowadv-board"));
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

// Primer from a fresh install in each exposure mode (docs/design/app-doors.md, The module door): the default bundle runs it
// self-hosted, the gate serves it at the board's host on 8447, and primer-server gets that address for its links.
test("the default bundle's Primer: self-hosted, at the module door in tailscale, public and local, its address passed on", () => {
  const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const at = (exposure, door) => {
    const dir = mkdtempSync(join(tmpdir(), "inst-"));
    writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: BUNDLE, settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@example.com", product_repo: "acme/aidenhq", exposure } }));
    mkdirSync(join(dir, "agents"));
    const out = compile(product, dir, { door });
    return { url: out.compose.services["primer-server"].environment.AIDENHQ_APP_URL, hosts: out.edge.gate.hosts, gate: Boolean(out.compose.services.gate) };
  };
  assert.deepEqual(at("tailscale", { boardUrl: "https://aidenhq.example.ts.net", adminUrl: "https://aidenhq.example.ts.net:8446" }), { url: "https://aidenhq.example.ts.net:8447", hosts: { "aidenhq.example.ts.net": { app: "primer", port: 3141, door: true, origin: "https://aidenhq.example.ts.net:8447" } }, gate: true });
  assert.equal(at("public", { publicIp: "203.0.113.7", boardUrl: "https://203.0.113.7", adminUrl: "https://203.0.113.7:8446" }).url, "https://203.0.113.7:8447");
  assert.equal(at("local", { boardUrl: "http://localhost:3121", adminUrl: "http://localhost:3120" }).url, "http://localhost:3130");
});
