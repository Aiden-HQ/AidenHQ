// The monitoring module compiles into compose: its services, Fleet Ops brought along (alerts open Fleet Ops tasks), its
// secrets and data dirs, the board's monitoring token, Grafana on loopback only, every image pinned by digest; and the
// grafana connection can point at the local Grafana for agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
function instance(modules, settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules, settings: { timezone: "UTC", owner_name: "Sam", owner_email: "o@example.com", ...settings } }));
  mkdirSync(join(dir, "agents"));
  return dir;
}

test("monitoring: services, fleet-ops, secrets, data dirs and loopback-only ports", () => {
  const r = compile(product, instance(["monitoring"], { monitoring_retention: "45d" }));
  const s = r.compose.services;
  for (const k of ["prometheus", "node-exporter", "cadvisor", "alertmanager", "grafana", "mcp-grafana"]) {
    assert.ok(s[k], k);
    assert.match(s[k].image, /@sha256:[0-9a-f]{64}$/, `${k} pinned by digest`);
  }
  assert.ok(r.catalog.find((m) => m.name === "fleet-ops").enabled, "fleet-ops comes along");
  assert.ok(s.prometheus.command.includes("--storage.tsdb.retention.time=45d"));
  assert.deepEqual(s.board.secrets.filter((x) => x === "monitoring_token"), ["monitoring_token"]);
  assert.equal(s.board.environment.MONITORING_TOKEN_FILE, "/run/secrets/monitoring_token");
  assert.deepEqual(r.generatedSecrets.filter((x) => /monitoring|grafana/.test(x)), ["monitoring_token", "grafana_admin_password"]);
  assert.ok(r.optionalSecrets.includes("grafana_service_account_token"));
  assert.deepEqual(r.dataDirs.filter((d) => d.startsWith("monitoring/")), ["monitoring/textfile", "monitoring/prometheus", "monitoring/alertmanager", "monitoring/grafana"]);
  const published = Object.entries(s).filter(([k]) => ["prometheus", "node-exporter", "cadvisor", "alertmanager", "grafana", "mcp-grafana"].includes(k)).flatMap(([k, v]) => (v.ports ?? []).map((p) => `${k} ${p}`));
  assert.deepEqual(published, ["grafana 127.0.0.1:3131:3000"]);
  assert.equal(s.grafana.environment.GF_AUTH_ANONYMOUS_ENABLED, "false");
  assert.equal(s["node-exporter"].user, "65534:65534");
  for (const k of ["prometheus", "node-exporter", "cadvisor", "alertmanager", "grafana", "mcp-grafana"]) assert.ok(!JSON.stringify(s[k]).includes("docker.sock"), `${k}: no Docker socket`);
  for (const n of ["monitoring", "monitoring-board", "grafana-local"]) assert.equal(r.compose.networks[n].internal, true, n);
  // Nothing unauthenticated sits on the backplane: Prometheus and Alertmanager meet the board on their own network, and
  // mcp-grafana meets grafana-mcp on another.
  const nets = Object.fromEntries(["prometheus", "alertmanager", "mcp-grafana", "node-exporter", "cadvisor", "grafana"].map((k) => [k, [...s[k].networks].sort()]));
  assert.deepEqual(nets, { prometheus: ["monitoring", "monitoring-board"], alertmanager: ["monitoring", "monitoring-board"], "mcp-grafana": ["grafana-local", "monitoring"], "node-exporter": ["monitoring"], cadvisor: ["monitoring"], grafana: ["egress", "monitoring"] });
  assert.deepEqual(s.board.networks, ["monitoring-board"]); // added to the root compose's backplane and egress
});

test("monitoring off: none of it", () => {
  const r = compile(product, instance([]));
  assert.equal(r.compose.services.prometheus, undefined);
  assert.deepEqual(r.dataDirs.filter((d) => d.startsWith("monitoring/")), []);
});

test("grafana_source: local points grafana-mcp at the monitoring module's Grafana, and agents can be granted it", () => {
  const r = compile(product, instance(["monitoring", "grafana"], { grafana_source: "local" }));
  assert.equal(r.compose.services["grafana-mcp"].environment.GRAFANA_SOURCE, "local");
  assert.ok(r.compose.services["grafana-mcp"].networks.includes("grafana-local"));
  assert.deepEqual(r.paperclip.mcp_servers.grafana.tools.write, []);
  assert.ok(r.paperclip.mcp_servers.grafana.tools.read.includes("query_prometheus"));
});

test("alert rules: identifier names, a severity each, and only the critical ones the board has an owner sentence for", () => {
  const rules = YAML.parse(readFileSync(join(product, "modules/monitoring/prometheus/rules.yml"), "utf8")).groups.flatMap((g) => g.rules).filter((r) => r.alert); // recording rules (record:) are not alerts
  for (const r of rules) {
    assert.match(r.alert, /^[A-Za-z][A-Za-z0-9_]*$/);
    assert.ok(["warning", "critical"].includes(r.labels?.severity), r.alert);
    assert.ok(r.annotations?.summary, r.alert);
  }
  const board = readFileSync(join(product, "services/board/src/monitoring.ts"), "utf8");
  const sentences = [...board.matchAll(/^\s+(\w+): "/gm)].map((m) => m[1]);
  assert.deepEqual(rules.filter((r) => r.labels.severity === "critical").map((r) => r.alert.toLowerCase()).sort(), sentences.sort());
  // Alertmanager posts every alert, resolved too, to the board with the monitoring token.
  const am = YAML.parse(readFileSync(join(product, "modules/monitoring/alertmanager/alertmanager.yml"), "utf8"));
  assert.deepEqual(am.receivers.map((r) => r.webhook_configs.map((w) => [w.url, w.send_resolved, w.http_config.authorization.credentials_file])), [[["http://board:3122/internal/alerts", true, "/run/secrets/monitoring_token"]]]);
});
