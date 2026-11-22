// A connection URL set from the board (an instance setting, docs/design/settings-changes.md): the check, and the value
// reaching the connection's service through compile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { urlSettingProblem } from "../../services/shared/url-setting.ts";

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
