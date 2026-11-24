import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { opencodeConfig } from "../src/config.ts";

const spec: any = {
  contract: "engine@1", job: "j", agent: "a", task: "t", prompt: "P", env: [], limits: { timeout_s: 0 }, web: false,
  model: { base_url: "http://gw:8200/api/v1", token_env: "AIDENHQ_RUN_TOKEN", id: "~deepseek/deepseek-flash-latest", effort: "high", models: ["openrouter/moonshotai/kimi-k3.1-pro"] },
  mcp: [{ name: "github", url: "http://gw/c/github/mcp", token_env: "AIDENHQ_RUN_TOKEN", tools: ["x"], tool_timeout_s: 60 }],
  sandbox: { kind: "box", writable: [], network: true },
};

test("builds the config from the job", () => {
  const c = opencodeConfig(spec, { plugins: ["opencode-shell-strategy@1.2.3"], stateDir: "/s" });
  assert.deepEqual(Object.keys(c.provider.aidenhq.models), ["~deepseek/deepseek-flash-latest", "moonshotai/kimi-k3.1-pro"]);
  assert.equal(c.model, "aidenhq/~deepseek/deepseek-flash-latest");
  assert.equal(c.provider.aidenhq.models["~deepseek/deepseek-flash-latest"]!.options!.reasoningEffort, "high");
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
