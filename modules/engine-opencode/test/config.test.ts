import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS } from "./fakes.ts";
import { modelLimits, opencodeConfig } from "../src/config.ts";

const spec: any = {
  contract: "engine@1", job: "j", agent: "a", task: "t", prompt: "P", env: [], limits: { timeout_s: 0 }, web: false,
  model: { base_url: "http://gw:8200/api/v1", token_env: "AIDENHQ_RUN_TOKEN", id: "~deepseek/deepseek-flash-latest", effort: "high", models: ["openrouter/moonshotai/kimi-k3.1-pro"] },
  mcp: [{ name: "github", url: "http://gw/c/github/mcp", token_env: "AIDENHQ_RUN_TOKEN", tools: ["x"], tool_timeout_s: 60 }],
  sandbox: { kind: "box", writable: [], network: true },
};

const listing = (data: unknown[]) => (async () => new Response(JSON.stringify({ object: "list", data }))) as typeof fetch;
const limits = await modelLimits(spec, "tok", listing(MODELS));

test("builds the config from the job", () => {
  const c = opencodeConfig(spec, { plugins: ["opencode-shell-strategy@1.2.3"], stateDir: "/s", limits });
  assert.deepEqual(Object.keys(c.provider.aidenhq.models), ["~deepseek/deepseek-flash-latest", "moonshotai/kimi-k3.1-pro"]);
  assert.equal(c.model, "aidenhq/~deepseek/deepseek-flash-latest");
  assert.equal(c.provider.aidenhq.models["~deepseek/deepseek-flash-latest"]!.options!.reasoningEffort, "high");
  // each model's own window, compacting at 80% of it with nothing further reserved
  assert.deepEqual(c.provider.aidenhq.models["~deepseek/deepseek-flash-latest"]!.limit, { context: 1_000_000, input: 800_000, output: 65_536 });
  assert.deepEqual(c.provider.aidenhq.models["moonshotai/kimi-k3.1-pro"]!.limit, { context: 262_144, input: 209_715, output: 65_536 });
  // a small window leaves room for the output opencode asks for (32k) below the threshold
  const small = opencodeConfig(spec, { plugins: [], stateDir: "/s", limits: { ...limits, "moonshotai/kimi-k3.1-pro": { context: 65_536, output: 65_536 } } });
  assert.equal(small.provider.aidenhq.models["moonshotai/kimi-k3.1-pro"]!.limit.input, 33_536);
  assert.deepEqual(c.compaction, { auto: true, reserved: 0 });
  assert.equal(c.provider.aidenhq.options.baseURL, "http://gw:8200/api/v1");
  assert.equal(c.mcp.github!.headers["X-Agent-Key"], "{env:AIDENHQ_RUN_TOKEN}");
  assert.equal(c.mcp.github!.timeout, 60000);
  assert.equal(c.permission.webfetch, "deny");
  assert.deepEqual(c.instructions, ["/s/AGENTS.md"]);
  assert.equal(c.autoupdate, false);
  assert.deepEqual(c.plugin, ["opencode-shell-strategy@1.2.3"]);
  assert.doesNotMatch(JSON.stringify(c), /ahqj_|sk-or/);
});

test("every plugin in plugins.json is pinned exactly", () => {
  const { plugins } = JSON.parse(readFileSync(join(import.meta.dirname, "../plugins.json"), "utf8"));
  assert.ok(plugins.length > 0);
  const deps = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")).dependencies;
  assert.deepEqual(Object.fromEntries(plugins.map((p: string) => [p.slice(0, p.lastIndexOf("@")), p.slice(p.lastIndexOf("@") + 1)])), deps, "package.json (and its lock) pin exactly plugins.json");
  for (const p of plugins) assert.match(p, /^(@[a-z0-9-]+\/)?[a-z0-9.-]+@\d+\.\d+\.\d+$/, `${p} is not name@x.y.z`);
});

test("a model the gateway doesn't size stops the session at start", async () => {
  await assert.rejects(modelLimits(spec, "tok", listing([MODELS[0]])), /no context window for model moonshotai\/kimi-k3.1-pro/);
  await assert.rejects(modelLimits(spec, "tok", listing([...MODELS.slice(0, 1), { id: "moonshotai/kimi-k3.1-pro", context_length: 0, max_completion_tokens: 0 }])), /no context window/);
});
