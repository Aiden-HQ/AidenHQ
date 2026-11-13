import { test } from "node:test";
import assert from "node:assert/strict";
import { probeConfig } from "../agent-probe.mjs";

const codexArgs = ["--sandbox", "read-only", "-c", 'model_providers.or.base_url="http://10.231.0.1:8201/api/v1"'];

test("an OpenCode runner agent's check runs opencode on the model gateway with the harness key; a Codex agent's runs plain codex", () => {
  const oc = probeConfig("opencode_local", { model: "openrouter/x/y" }, { codexArgs, harnessSecretId: "s-1" });
  assert.equal(oc.command, "opencode"); // with codex, Paperclip's opencode probe fails on --format and the agent stays paused
  assert.deepEqual(oc.env.OPENROUTER_API_KEY, { type: "secret_ref", secretId: "s-1", version: "latest" });
  assert.deepEqual(JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT.value), { provider: { openrouter: { options: { baseURL: "http://10.231.0.1:8201/api/v1" } } } });
  assert.throws(() => probeConfig("opencode_local", {}, { codexArgs: [], harnessSecretId: "s-1" }), /model gateway/);

  const cx = probeConfig("codex_local", { extraArgs: ["-c", "mcp_servers.slack.enabled=false", "--sandbox", "read-only"] }, { codexArgs });
  assert.equal(cx.command, "codex");
  assert.deepEqual(cx.extraArgs, ["--sandbox", "read-only"]);
});
