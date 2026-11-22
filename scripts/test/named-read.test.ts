// `named` narrows a read tool out of the read shorthand: a tool tagged read + named is a read on the read path, reachable only
// by a grant that names it. Tagged named without read, or with write or destructive, it fails compile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { compile } from "../modules.ts";
import { toolsFor } from "../../kernel/src/proxy.ts";

const settings = { owner_name: "Sam", owner_email: "me@example.com", timezone: "UTC" };

/** A one-module product with this `connections` and these agents, compiled against a throwaway instance. */
function build(connections, agents = {}) {
  const product = mkdtempSync(join(tmpdir(), "named-product-"));
  mkdirSync(join(product, "modules", "m"), { recursive: true });
  writeFileSync(join(product, "modules", "marketplace.json"), JSON.stringify({ name: "t", owner: { name: "T" }, description: "t", plugins: [{ name: "m", source: "./m" }] }));
  // Every agent runs on an engine: the module brings the one it runs on.
  mkdirSync(join(product, "modules", "m", "bin"));
  writeFileSync(join(product, "modules", "m", "bin", "engine"), "");
  writeFileSync(join(product, "modules", "m", "module.yaml"), YAML.stringify({ name: "m", description: "named reads", connections, agents, providers: { engine: { kind: "e", bin: "bin/engine", box: true } } }));
  for (const key of Object.keys(agents)) {
    mkdirSync(join(product, "modules", "m", "agents", key), { recursive: true });
    writeFileSync(join(product, "modules", "m", "agents", key, "AGENTS.md"), `---\nname: ${key}\ntitle: ${key}\ndescription: The ${key} agent.\n---\n\n${key} handbook\n`);
  }
  const instance = mkdtempSync(join(tmpdir(), "named-instance-"));
  writeFileSync(join(instance, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["m"], settings }));
  return compile(product, instance);
}

const gh = (tools) => ({ gh: { url: "http://gh-mcp:1/mcp", auth: "gh_service_key", tools } });
const GRANT = { key: "keeper", kind: "run", roles: [], tools: {}, credential: "" };

test("a module naming a read+named tool compiles and the agent's tools carry it; a read grant does not", () => {
  const tools = { read: ["issue_list", "repo_tree"], write: ["issue_close"], named: ["repo_tree"] };
  const out = build(gh(tools), { keeper: { adapter: "codex_local", connections: { gh: "read" } }, maintainer: { adapter: "codex_local", connections: { gh: ["issue_list", "repo_tree"] } } });
  assert.deepEqual(out.paperclip.agents.keeper.enabled_tools.gh, ["issue_list"]);
  assert.deepEqual(out.paperclip.agents.maintainer.enabled_tools.gh, ["issue_list", "repo_tree"]);
  // The kernel's own table keeps all three groups and the named list; a named tool is listed only when the grant names it.
  const conn = out.connections.gh;
  assert.deepEqual(conn.tools, { read: ["issue_list", "repo_tree"], write: ["issue_close"], destructive: [], named: ["repo_tree"] });
  const keeper = toolsFor({ ...GRANT, tools: { gh: ["issue_list"] } }, "gh", conn);
  assert.deepEqual([...keeper.listed], ["issue_list", "issue_close"]);
  assert.deepEqual([...keeper.allowed], ["issue_list"]);
  const maintainer = toolsFor({ ...GRANT, tools: { gh: ["issue_list", "repo_tree"] } }, "gh", conn);
  assert.deepEqual([...maintainer.allowed], ["issue_list", "repo_tree"]);
});

test("a read grant carries no named tool, and the proxy would refuse it to a caller that names it only through the shorthand", () => {
  const out = build(gh({ read: ["issue_list", "repo_tree"], write: [], named: ["repo_tree"] }), { keeper: { adapter: "codex_local", connections: { gh: "read" } } });
  assert.deepEqual(out.paperclip.agents.keeper.enabled_tools.gh, ["issue_list"]);
  const keeper = toolsFor({ ...GRANT, tools: { gh: ["issue_list"] } }, "gh", out.connections.gh);
  assert.ok(!keeper.allowed.has("repo_tree"));
  assert.ok(!keeper.listed.has("repo_tree"));
});
