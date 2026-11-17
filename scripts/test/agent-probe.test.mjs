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

// Without a model key Paperclip's probe can only fail and it retries by itself every minute: setup used to wait 3 minutes
// for each of 9 agents in turn (27 minutes of a first install). It stops at the first failed probe.
test("the wait for Paperclip's check ends at its first failed probe, not after 3 minutes", async () => {
  const { awaitVerified } = await import("../agent-probe.mjs");
  let slept = 0;
  const sleep = async (t) => { slept += t; };
  const states = (...xs) => { let i = 0; return async () => xs[Math.min(i++, xs.length - 1)]; };
  assert.equal(await awaitVerified(states({ lifecycleState: "verifying" }, { lifecycleState: "verifying", lifecycleError: "The execution test did not pass." }), { sleep }), "failed");
  assert.equal(slept, 2000);
  assert.equal(await awaitVerified(states({ lifecycleState: "preparing" }, { lifecycleState: "ready" }), { sleep }), "verified");
  slept = 0;
  assert.equal(await awaitVerified(states({ lifecycleState: "verifying" }), { sleep, ms: 10_000 }), "timeout");
  assert.equal(slept, 10_000);
});
