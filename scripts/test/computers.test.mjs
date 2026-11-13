// Agent computers: the switch, what the launcher is told, and the Codex config a computer agent gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";
import { computerAdapterConfig, computersConfig, ensureComputers, validateImages, GATEWAY_URL } from "../computers.mjs";
import { assertNoShell } from "../no-shell.mjs";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
function inst(overrides) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x" }, overrides }));
  mkdirSync(join(dir, "agents"));
  return dir;
}

test("the instance switches one agent on; the launcher learns the image tag and the connections it may reach", () => {
  const r = compile(product, inst({ agents: { assistant: { image: "agent-base" } } }));
  assert.equal(r.paperclip.agents.assistant.image, "agent-base");
  const c = computersConfig(r.paperclip, product);
  assert.match(c.images["agent-base"], /^aidenhq\/computer-agent-base:[0-9a-f]{12}$/);
  assert.deepEqual(c.connections.apps, { url: "http://apps-mcp:8090/mcp", tool_timeout_sec: 600 });
  assert.equal(c.connections.slack_live.bearer_secret, "slack_live_mcp_token");
  // The board token is host-only: the stdio tasks bridge runs in the box without it.
  assert.ok(!c.connections.paperclip_tasks.env_vars.includes("AIDENHQ_BOARD_TOKEN"));
  assert.ok(c.connections.paperclip_tasks.env_vars.includes("PAPERCLIP_API_KEY"));
});

test("not yet in a computer: an agent in trial (its limits run inside the box); one that messages the owner may (replies land via the launcher)", () => {
  assert.throws(() => validateImages({ x: { image: "agent-base", trial: true } }), /in trial/);
  const r = compile(product, inst({ agents: { "app-maintainer": { image: "agent-base" } } }));
  assert.equal(r.paperclip.agents["app-maintainer"].image, "agent-base");
  assert.ok(r.paperclip.agents["app-maintainer"].enabled_tools.slack_live.includes("notify_owner"));
});

test("the design module: the UI/UX engineer runs in a computer with repo-checkout; only it may post design-review", () => {
  const dir = inst();
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["design"], settings: { timezone: "Europe/London", owner_name: "Sam", instance_name: "acme", owner_email: "o@x" } }));
  const r = compile(product, dir);
  const d = r.paperclip.agents["ui-designer"];
  assert.equal(d.image, "agent-base");
  assert.deepEqual(d.roles, ["repo-checkout", "design-review"]);
  assert.ok(d.enabled_tools.github.includes("commit_status_set"));
  // The tool is in github's write list, so a `github: write` grant lists it too: github-mcp checks the role.
  assert.ok(!r.paperclip.agents.assistant.roles.includes("design-review"));
  assert.equal(computersConfig(r.paperclip, product).agents_org, "aidenhq-acme");
  assert.equal(r.compose.services["github-mcp"].environment.GITHUB_AGENTS_ORG, "aidenhq-acme");
});

test("an unknown image, or a runner agent, fails compile", () => {
  assert.throws(() => compile(product, inst({ agents: { "app-maintainer": { image: "kali" } } })), /image must be one of agent-base, engineer/);
  assert.throws(() => compile(product, inst({ agents: { "fleet-engineer": { image: "engineer" } } })), /runner agents don't get a computer yet/);
});

test("a computer agent: shell on, Codex's sandbox off, the model via the gateway on the run token, no real key, no scoping args", () => {
  const r = compile(product, inst({ agents: { assistant: { image: "agent-base" } } }));
  const a = r.paperclip.agents.assistant;
  const cfg = computerAdapterConfig({ codexArgs: r.paperclip.codex_args, agent: a, timeoutSec: 1200, dummyOpenAiSecretId: "dummy" });
  const args = cfg.extraArgs.join(" ");
  assert.match(args, /--sandbox danger-full-access/);
  assert.doesNotMatch(args, /shell_tool=false|unified_exec=false|read-only|mcp_servers\./);
  assert.match(args, new RegExp(`model_providers\\.or\\.base_url="${GATEWAY_URL}/api/v1"`));
  assert.match(args, /model_providers\.or\.env_key="AIDENHQ_RUN_TOKEN"/);
  assert.match(args, /features\.apps=false/);
  assert.match(args, /web_search="live"/); // the default rides in codex_args
  const off = computerAdapterConfig({ codexArgs: r.paperclip.codex_args, agent: { ...a, web_search: "disabled" }, timeoutSec: 1200, dummyOpenAiSecretId: "dummy" }).extraArgs;
  assert.deepEqual(off.slice(-2), ["-c", 'web_search="disabled"']); // an agent's own setting comes last, so it wins
  assert.deepEqual(Object.keys(cfg.env), ["OPENAI_API_KEY"]);
  assert.equal(cfg.model, a.model);
});

test("rollback: without image: an agent on our environment goes back to local; another environment is left alone", async () => {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push([method, path, body]);
    if (path.endsWith("/environments")) return { json: [{ id: "env-ours", name: "AidenHQ computer", status: "active" }] };
    return { json: {} };
  };
  const cfg = { agents: { m: { name: "M" }, n: { name: "N" } } };
  const agents = { m: { id: "a-m", defaultEnvironmentId: "env-ours" }, n: { id: "a-n", defaultEnvironmentId: "env-theirs" } };
  await ensureComputers({ api, companyId: "c", cfg, agents, step: () => {} });
  assert.deepEqual(calls.filter(([m]) => m === "PATCH"), [["PATCH", "/api/agents/a-m", { defaultEnvironmentId: null }]]);
});

test("a computer agent with the launcher down fails setup loudly", async () => {
  const api = async () => ({ json: [] });
  await assert.rejects(ensureComputers({ api, companyId: "c", cfg: { agents: { m: { name: "M", image: "agent-base" } } }, agents: {}, step: () => {}, launcherUrl: "http://127.0.0.1:9" }),
    /the computer launcher isn't answering/);
});

test("a tool-only agent whose final Codex args turn the shell on, drop the read-only sandbox or bypass it fails setup", () => {
  const ok = ["--sandbox", "read-only", "-c", "features.shell_tool=false", "-c", "features.unified_exec=false", "-c", "features.apps=false"];
  assertNoShell("a", ok, false);
  assert.throws(() => assertNoShell("a", [...ok, "-c", "features.shell_tool=true"], false), /shell_tool is true/); // later wins
  assert.throws(() => assertNoShell("a", ["--sandbox", "danger-full-access", ...ok.slice(2)], false), /danger-full-access/);
  assert.throws(() => assertNoShell("a", ok, true), /dangerouslyBypass/);
  for (const x of [["--config=features.shell_tool=true"], ["-cfeatures.shell_tool=true"], ["-p", "x"], ["-c", "features={shell_tool=true}"], ["-c", 'sandbox_permissions=["disk-full-write-access"]'], ["-c", "profile=x"], ["--enable", "x"]])
    assert.throws(() => assertNoShell("a", [...ok, ...x], false), /not allowed|table or list/); // anything not allowlisted fails closed
  assertNoShell("a", [...ok, "-c", 'mcp_servers.apps.enabled_tools=["app_list"]'], false);
  assert.throws(() => assertNoShell("a", [...ok, "-c", "features.computer_use=true"], false), /features off only/);
  assert.throws(() => assertNoShell("a", ok.slice(2), false), /sandbox is unset/);
  // The compiled core config passes.
  assertNoShell("core", compile(product, inst()).paperclip.codex_args, false);
});

