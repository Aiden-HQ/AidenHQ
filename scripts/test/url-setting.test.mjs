// A connection URL set from the board (an instance setting, docs/design/settings-changes.md): the check, and the value
// reaching the connection's service through compile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";
import { BUNDLE } from "./bundle.mjs";
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
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: BUNDLE, settings: { timezone: "Europe/London", owner_name: "Sam", owner_slack_user_id: "U1", owner_email: "o@example.com", product_repo: "acme/aidenhq", ...settings } }));
  mkdirSync(join(dir, "agents"));
  return dir;
}

test("a saved URL reaches the connection's service; a bad one fails compile", () => {
  const url = "https://acme-be.glean.com/mcp/default";
  const r = compile(repo, instance({ glean_mcp_url: url }));
  assert.equal(r.compose.services["glean-mcp"].environment.GLEAN_MCP_URL, url);
  const glean = r.catalog.find((m) => m.name === "glean");
  assert.deepEqual({ type: glean.settings.glean_mcp_url.type, host: glean.settings.glean_mcp_url.host }, { type: "url", host: "*.glean.com" });
  assert.equal(compile(repo, instance({})).compose.services["glean-mcp"].environment.GLEAN_MCP_URL, "", "not set: the connection is off");
  assert.throws(() => compile(repo, instance({ glean_mcp_url: "https://evil.example.com/mcp" })), /settings\.glean_mcp_url: the host must be/);
});
