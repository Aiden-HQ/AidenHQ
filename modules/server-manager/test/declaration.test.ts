// module.yaml as the compiler and the reviewer read it (spec §3): the page, the connection's tags and timeout, the validate host,
// the two write kinds with no routed tool, the agent's exact grants, and the secret map's own field. A drift here is a spec
// violation, so each line is asserted rather than trusted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const YAML = createRequire(join(root, "../../scripts/package.json"))("yaml") as { parse: (s: string) => any };
const def = YAML.parse(readFileSync(join(root, "module.yaml"), "utf8"));

test("the module requires board and warehouse, and asks for the kernel's tasks and wake roles only", () => {
  assert.deepEqual(def.requires, ["board", "warehouse"]);
  assert.deepEqual(def.roles.requests, ["kernel.tasks", "kernel.wake"]);
});

test("the connection is the module's own, untrusted, with the 1800 s tool timeout and check tagged named", () => {
  const c = def.connections["server-manager"];
  assert.equal(c.url, "http://server-manager-ssh:8103/mcp");
  assert.equal(c.auth, "server_manager_service_key");
  assert.equal(c.returns, "untrusted");
  assert.equal(c.tool_timeout_sec, 1800);
  assert.deepEqual(c.tools.read, ["server_manager_config", "server_manager_status", "server_manager_check"]);
  assert.deepEqual(c.tools.write, ["server_manager_patch", "server_manager_reboot", "server_manager_host_key_reset"]);
  assert.deepEqual(c.tools.named, ["server_manager_check"]);
});

test("validate.post names the service's services.run key, and the executor is the same service", () => {
  assert.equal(def.validate.post, "http://ssh:8103/validate");
  assert.equal(def.validate.auth, "server_manager_service_key");
  assert.equal(def.providers.executor.url, "http://server-manager-ssh:8103/aidenhq/v1/executor");
  assert.equal(def.providers.executor.auth, "server_manager_service_key");
});

test("both write kinds declare tools: [] (a view cannot call a routed tool) and a schema, at floor 0", () => {
  for (const kind of ["patch", "reboot"]) {
    const w = def.writes[kind];
    assert.deepEqual(w.tools, []);
    assert.equal(w.floor, 0);
    assert.equal(w.args, `schemas/${kind}.json`);
  }
});

test("the agent's grants are exactly the spec's, and its heartbeat is the backstop", () => {
  const a = def.agents["server-manager"];
  assert.deepEqual(a.skills, ["server-manager.maintenance", "tasks.delegate-work"]);
  assert.equal(a.department, "platform");
  assert.equal(a.model, "~deepseek/deepseek-flash-latest");
  assert.equal(a.timeout_sec, 1200);
  assert.equal(a.heartbeat, 4);
  assert.deepEqual(a.connections["server-manager"], ["server_manager_config", "server_manager_status", "server_manager_check"]);
  assert.deepEqual(a.connections.apps, ["web_view", "app_view"]);
  assert.deepEqual(a.connections.paperclip_tasks, ["task_current", "task_get", "task_comments", "task_comment", "task_block", "task_finish", "task_list", "task_approvals"]);
  // The agent has no write: a patch and a reboot always come from a schedule or the owner's click.
  for (const t of ["server_manager_patch", "server_manager_reboot", "server_manager_host_key_reset"]) assert.ok(!a.connections["server-manager"].includes(t));
});

test("servers_machines is an entry list with a pattern, the owner's to write, and nothing is scheduled", () => {
  const s = def.settings.servers_machines;
  assert.equal(s.entry, "name");
  assert.equal(s.pattern, "^[a-z0-9][a-z0-9-]{0,31}$");
  assert.deepEqual(s.writers, ["owner"]);
  assert.deepEqual(s.default, []);
  assert.equal(def.routines, undefined);
});

test("the one secret is the JSON map the Sign-ins panel writes, and the service mounts it read-only", () => {
  assert.equal(def.secrets.provided[0].name, "servers_keys");
  assert.equal(def.secrets.provided[0].setup.pattern, "^\\{[\\s\\S]*\\}$");
  assert.deepEqual(def.services.run.ssh.secrets, ["servers_keys"]);
  assert.deepEqual(def.services.run.ssh.env.SERVERS_KEYS_FILE, "/run/secrets/servers_keys");
  assert.equal(def.services.run.ssh.port, 8103);
});
