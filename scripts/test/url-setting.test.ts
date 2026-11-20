// A connection URL set from the board (an instance setting, docs/design/settings-changes.md): the check, and the value
// reaching the connection's service through compile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, migrateSettings } from "../modules.ts";
import { BUNDLE } from "./bundle.ts";
import { urlSettingProblem } from "../../services/shared/url-setting.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("a URL setting: https, a public host, the declared host, no credentials", () => {
  const ok = (v, host) => assert.equal(urlSettingProblem(v, host), null, v);
  const bad = (v, re, host) => assert.match(urlSettingProblem(v, host) ?? "", re, v);
  ok("");
  ok("https://acme-be.glean.com/mcp/default", "*.glean.com");
  ok("https://mcp.atlassian.com/v2/mcp?tools=all", "mcp.atlassian.com");
  bad("http://acme-be.glean.com/mcp", /https/);
  bad("https://user:pw@acme.glean.com/mcp", /user name or password/);
  bad("https://acme.glean.com/mcp?api_key=abc", /credentials/);
  bad("https://${AIDENHQ_SECRET}.glean.com/mcp", /\$/);
  bad("https://evil.example.com/mcp", /glean\.com/, "*.glean.com");
  bad("https://glean.com.evil.example.com/", /glean\.com/, "*.glean.com");
  bad("https://localhost/mcp", /public host/);
  bad("https://localhost./mcp", /trailing dot/);
  bad("https://LOCALHOST/mcp", /public host/);
  bad("https://10.0.0.5/mcp", /public host/);
  bad("https://paperclip:3100/api", /public host/);
  bad(`https://a.glean.com/${"x".repeat(600)}`, /at most/);
});

function instance(settings) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "hubspot", "grafana", "monitoring", "ci"], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@example.com", product_repo: "acme/aidenhq", ...settings } }));
  mkdirSync(join(dir, "agents"));
  return dir;
}

test("a saved URL reaches the connection's service; a bad one fails compile", () => {
  const url = "https://mcp.hubspot.com/custom";
  const r = compile(repo, instance({ hubspot_mcp_url: url }));
  assert.equal(r.compose.services["hubspot-mcp"].environment.HUBSPOT_MCP_URL, url);
  const hubspot = r.catalog.find((m) => m.name === "hubspot");
  assert.deepEqual({ type: hubspot.settings.hubspot_mcp_url.type, host: hubspot.settings.hubspot_mcp_url.host }, { type: "url", host: "mcp.hubspot.com" });
  assert.throws(() => compile(repo, instance({ hubspot_mcp_url: "https://evil.example.com/mcp" })), /settings\.hubspot_mcp_url: the host must be/);
});

test("a setting's pattern and values hold, in the mode where it applies", () => {
  // Observe mode for a pattern: a value that worked before an upgrade compiles, with a warning naming the setting and its rule.
  const warns = (settings, re) => assert.match(compile(repo, instance(settings)).warnings.join("\n"), re);
  warns({ slack_post_channels: ["general"] }, /settings\.slack_post_channels: .*general.* doesn't match.*using the default until it is fixed/);
  // ...and the value goes no further: the service gets the default.
  assert.equal(compile(repo, instance({ ci_runner_repos: "a/b; rm -rf /" })).compose.services["ci-runner"]?.environment.AIDENHQ_CI_REPOS, "Aiden-HQ/AidenHQ Aiden-HQ/aidenhq-modules Aiden-HQ/aidenhq-distro");
  assert.throws(() => compile(repo, instance({ heartbeat_hours: 5 })), /settings\.heartbeat_hours: each must be/);
  assert.match(compile(repo, instance({ upstream: "prs" })).warnings.join("\n"), /upstream: prs was removed in this release: treated as issues/);
  warns({ maintainer_repos: [{ repo: "not-a-repo" }] }, /settings\.maintainer_repos/);
  compile(repo, instance({ maintainer_repos: [{ repo: "acme/app" }, "acme/other"] }));
  // grafana_mcp_url applies only in cloud mode: a bad value in local mode is not asked of anyone.
  assert.throws(() => compile(repo, instance({ grafana_source: "cloud", grafana_mcp_url: "https://evil.example.com/mcp" })), /settings\.grafana_mcp_url: the host must be/);
  compile(repo, instance({ grafana_source: "local", grafana_mcp_url: "https://evil.example.com/mcp" }));
});

test("an upgrade moves removed settings into their secrets and names every dropped key", () => {
  const vault = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(vault, "paperclip_auth_secret"), "x");
  writeFileSync(join(vault, "jira_url"), "");
  writeFileSync(join(vault, "glean_mcp_url"), "https://kept.glean.com/mcp");
  const pat = { jira_url: "^https://[a-z0-9-]+\\.atlassian\\.net/?$", glean_mcp_url: "^https://[a-z0-9.-]+\\.glean\\.com/mcp/?$" };
  const lines = migrateSettings({ jira_url: "https://acme.atlassian.net", glean_mcp_url: "https://old.glean.com/mcp", owner_email: "o@example.com", grafana_url: "https://evil.example.com" }, vault, { ...pat, grafana_url: "^https://[a-z0-9-]+\\.grafana\\.net/?$" }).join("\n");
  assert.match(lines, /setting grafana_url not migrated: .*re-enter it on Connect/);
  assert.equal(existsSync(join(vault, "grafana_url")), false);
  assert.equal(readFileSync(join(vault, "jira_url"), "utf8").trim(), "https://acme.atlassian.net");
  assert.equal(readFileSync(join(vault, "glean_mcp_url"), "utf8").trim(), "https://kept.glean.com/mcp");
  assert.match(lines, /migrated setting jira_url → secret jira_url; remove jira_url from instance\.yaml/);
  assert.match(lines, /glean_mcp_url.*the secret wins/);
  assert.match(lines, /setting owner_email was removed in this release: ignored/);
});
