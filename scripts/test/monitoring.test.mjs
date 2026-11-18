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
import { BUNDLE } from "./bundle.mjs";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
function instance(modules, settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, ...modules], settings: { timezone: "UTC", owner_name: "Sam", owner_email: "o@example.com", product_repo: "acme/aidenhq", ...settings } }));
  mkdirSync(join(dir, "agents"));
  return dir;
}

const M = ["prometheus", "node-exporter", "cadvisor", "alertmanager", "grafana", "mcp-grafana"].map((k) => `monitoring-${k}`);
test("monitoring: services, fleet-ops, secrets, data dirs and loopback-only ports", () => {
  const r = compile(product, instance(["monitoring"], { monitoring_retention: "45d" }));
  const s = r.compose.services;
  for (const k of M) {
    assert.ok(s[k], k);
    if (s[k].build) assert.match(readFileSync(join(s[k].build, "Dockerfile"), "utf8"), /^FROM \S+@sha256:[0-9a-f]{64}$/m, `${k}: base pinned by digest`);
    else assert.match(s[k].image, /@sha256:[0-9a-f]{64}$/, `${k} pinned by digest`);
  }
  assert.ok(r.catalog.find((m) => m.name === "fleet-ops").enabled, "fleet-ops comes along");
  assert.ok(s["monitoring-prometheus"].command.includes("--storage.tsdb.retention.time=45d"));
  assert.deepEqual(s.board.secrets.filter((x) => x === "monitoring_token"), ["monitoring_token"]);
  assert.equal(s.board.environment.MONITORING_TOKEN_FILE, "/run/secrets/monitoring_token");
  assert.deepEqual(r.generatedSecrets.filter((x) => /monitoring|grafana/.test(x)), ["grafana_service_key", "monitoring_token", "grafana_admin_password"]);
  assert.ok(r.optionalSecrets.includes("grafana_service_account_token"));
  assert.deepEqual(r.dataDirs.filter((d) => d.startsWith("modules/monitoring/")).sort(), ["modules/monitoring/alertmanager", "modules/monitoring/grafana", "modules/monitoring/prometheus", "modules/monitoring/textfile"]);
  const published = M.flatMap((k) => (s[k].ports ?? []).map((p) => `${k} ${p}`));
  assert.deepEqual(published, ["monitoring-grafana 127.0.0.1:3131:3000"]);
  assert.equal(s["monitoring-grafana"].environment.GF_AUTH_ANONYMOUS_ENABLED, "false");
  assert.equal(s["monitoring-node-exporter"].user, "65534:65534");
  // privileged: [host-metrics]: read-only host /, /sys and /proc for the two collectors, nothing else.
  assert.deepEqual(M.flatMap((k) => (s[k].volumes ?? []).filter((v) => !v.includes("/modules/monitoring/"))), ["/:/host:ro,rslave", "/sys:/sys:ro", "/proc:/rootfs/proc:ro"]);
  for (const k of M) assert.ok(!JSON.stringify(s[k]).includes("docker.sock"), `${k}: no Docker socket`);
  for (const n of ["mod-monitoring", "mod-monitoring-board"]) assert.equal(r.compose.networks[n].internal, true, n);
  // Nothing unauthenticated sits on the backplane: Prometheus and Alertmanager meet the board on their own network, and
  // mcp-grafana meets grafana-mcp on the grafana module's.
  const nets = Object.fromEntries(M.map((k) => [k, Object.keys(s[k].networks).sort()]));
  assert.deepEqual(nets, {
    "monitoring-prometheus": ["mod-monitoring", "mod-monitoring-board"], "monitoring-alertmanager": ["mod-monitoring", "mod-monitoring-board"], "monitoring-mcp-grafana": ["mod-grafana", "mod-monitoring"],
    "monitoring-node-exporter": ["mod-monitoring"], "monitoring-cadvisor": ["mod-monitoring"], "monitoring-grafana": ["mod-monitoring", "mod-monitoring-egress"],
  });
  assert.ok(s.board.networks.includes("mod-monitoring-board")); // added to the root compose's backplane and egress
});
