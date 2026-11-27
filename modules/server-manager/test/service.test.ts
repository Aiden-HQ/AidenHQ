// The service's MCP connection (spec §3, §9): it answers the page's read tools and serves the view, and the caller check refuses a
// call with no assertion. The service is started only for a live instance; here the handle is built in-process, as code-review's
// and ship's tests build theirs. The keys in the test are generated, never stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcp, pageHtml } from "../service/src/mcp.ts";
import { configTools } from "../service/src/tools.ts";
import { StatusStore } from "../service/src/status-store.ts";

const dir = mkdtempSync(join(tmpdir(), "sm-test-"));
const status = new StatusStore(dir);
status.put({ name: "vm-one", distro: "ubuntu-lts", state: "ok", pending: 4, security: 2, security_known: true, reboot_needed: false, disk: { root_free_gb: 12, boot_free_gb: 1.5 }, updated_at: "2026-11-27T00:00:00Z" });

const machines = JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" }]);
const tools = configTools({ machines: () => machines, status });
// A caller that is the owner: no roles needed, no agent; the handle's own check is exercised in caller.test through the SDK.
const owner = async () => ({ agent: "", key: "", name: "", roles: [], tool: "", call: "", kind: "owner", assertion: "" });
const agent = async () => ({ agent: "a-1", key: "server-manager", name: "Rolf", roles: [], tool: "", call: "", kind: "agent", assertion: "" });

const handle = createMcp("server-manager", tools, [{ uri: "ui://server-manager/page", html: pageHtml(new URL("../service/src/", import.meta.url)) }]);
const call = (m: unknown, who = owner) => handle(m as never, who as never) as Promise<any>;

test("tools/list names the module's own tools: the three reads and the three writes the page lists", async () => {
  const r = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = r.result.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, ["server_manager_check", "server_manager_config", "server_manager_host_key_reset", "server_manager_patch", "server_manager_reboot", "server_manager_status"]);
});

test("server_manager_config reads the machines with their defaults, summaries and no key value", async () => {
  const r = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "server_manager_config", arguments: {} } });
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.machines[0].name, "vm-one");
  assert.equal(out.machines[0].effective.port, 22);
  assert.match(out.machines[0].summary, /checks every 1h/);
  assert.ok(!JSON.stringify(r.result).includes("PRIVATE KEY"), "no key material in the answer");
});

test("server_manager_config with a draft returns it as the owner's one settings change; an agent's draft is refused", async () => {
  const draft = [{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" }];
  const r = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "server_manager_config", arguments: { edits: { machines: draft } } } });
  const sc = r.result.structuredContent;
  assert.deepEqual(sc._aidenhq.settings_change, [{ kind: "setting", key: "servers_machines", value: draft }]);
  const refused = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "server_manager_config", arguments: { edits: { machines: draft } } } }, agent);
  assert.equal(refused.result.isError, true);
});

test("a draft the schema refuses comes back with its problems and no change", async () => {
  const r = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "server_manager_config", arguments: { edits: { machines: [{ name: "vm-one", address: "vm-one", user: "user" }] } } } });
  const sc = r.result.structuredContent;
  assert.equal(sc._aidenhq, undefined);
  assert.ok(sc.problems.some((p: { field: string }) => p.field === "servers_machines[0].key"));
});

test("a draft that would drop a saved entry the list can't read is refused, naming the entry", async () => {
  // The saved list holds one entry with a bad port: the page never renders it, so an unrelated edit's whole-list draft must not
  // delete it. The module refuses and names it; fixing the entry (the draft carries it, valid) lets the same save through.
  const broken = JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" }, { name: "vm-two", address: "vm-two", user: "user", key: "vm-two-key", port: 70000 }]);
  const tools = configTools({ machines: () => broken, status });
  const handle = createMcp("server-manager", tools, []);
  const owner2 = async () => ({ agent: "", key: "", name: "", roles: [], tool: "", call: "", kind: "owner", assertion: "" });
  const draft = [{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key", port: 2222 }];
  const r = await (handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "server_manager_config", arguments: { edits: { machines: draft } } } }, owner2 as never) as Promise<any>);
  assert.equal(r.result.structuredContent._aidenhq, undefined);
  assert.ok(r.result.structuredContent.problems.some((p: { message: string }) => /vm-two/.test(p.message)));
  // A deliberate removal, or the entry carried and fixed, is allowed.
  for (const machines of [[...draft, { name: "vm-two", address: "vm-two", user: "user", key: "vm-two-key" }]]) {
    const ok = await (handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "server_manager_config", arguments: { edits: { machines } } } }, owner2 as never) as Promise<any>);
    assert.ok(ok.result.structuredContent._aidenhq?.settings_change, "a draft that carries the entry is a change");
  }
});

test("a saved entry with no name is never deleted by a draft either", async () => {
  // The page cannot render a nameless entry, so it cannot carry or remove one: any whole-list draft that omits it is refused, and
  // the message says where to fix it.
  const broken = JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" }, { address: "vm-two", user: "user", key: "vm-two-key" }]);
  const handle = createMcp("server-manager", configTools({ machines: () => broken, status }), []);
  const owner2 = async () => ({ agent: "", key: "", name: "", roles: [], tool: "", call: "", kind: "owner", assertion: "" });
  const r = await (handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "server_manager_config", arguments: { edits: { machines: [{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key", port: 2222 }] } } } }, owner2 as never) as Promise<any>);
  assert.equal(r.result.structuredContent._aidenhq, undefined);
  assert.ok(r.result.structuredContent.problems.some((p: { message: string }) => /no name/.test(p.message)));
});

test("server_manager_status shows each machine's last readout, and the view is served", async () => {
  const r = await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "server_manager_status", arguments: {} } });
  const out = JSON.parse(r.result.content[0].text);
  assert.deepEqual([out.servers[0].distro, out.servers[0].pending, out.servers[0].security, out.servers[0].reboot_needed], ["ubuntu-lts", 4, 2, false]);
  const v = await call({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "ui://server-manager/page" } });
  assert.equal(v.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(v.result.contents[0].text, /Servers/);
});

test("a malformed value never reaches a tool: the machine list stays empty when it isn't JSON", async () => {
  const bad = configTools({ machines: () => "{nope", status });
  const h = createMcp("server-manager", bad);
  const r = (await h({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "server_manager_status", arguments: {} } } as never, owner as never)) as any;
  const out = JSON.parse(r.result.content[0].text);
  assert.deepEqual(out.servers, []);
});

test("the three write tools are the owner's own actions: an agent's call is refused before anything runs", async () => {
  // §9: a patch, a reboot and a host-key reset verify the caller came from the owner's signed-in session, not an agent's
  // assertion. The view route sends kind: "owner" with no agent; an agent's call carries its key. An agent is refused before the
  // service even looks at the machine or files anything.
  const filed: { kind: string; args: Record<string, unknown>; machine: string }[] = [];
  const tools = configTools({
    machines: () => machines, status,
    filing: { file: async (kind, args, machine) => { filed.push({ kind, args, machine }); return { id: "k-0123456789abcdef", tier: 0, state: "claimed" }; } },
  });
  const handle = createMcp("server-manager", tools, []);
  const call = (m: unknown, who = owner) => handle(m as never, who as never) as Promise<any>;
  const argsOf: Record<string, Record<string, unknown>> = { server_manager_patch: { machine: "vm-one", mode: "security" }, server_manager_reboot: { machine: "vm-one" }, server_manager_host_key_reset: { machine: "vm-one", fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } };
  for (const name of ["server_manager_patch", "server_manager_reboot", "server_manager_host_key_reset"]) {
    const refused = await call({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name, arguments: argsOf[name] } }, agent);
    assert.equal(refused.result.isError, true, `${name} refuses an agent`);
    assert.match(refused.result.content[0].text, /the owner's/);
  }
  assert.deepEqual(filed, [], "an agent's call files nothing");
  // The owner's own click files the record: the same kind a schedule files, naming the machine (never a command).
  const patch = await call({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "server_manager_patch", arguments: { machine: "vm-one", mode: "security" } } });
  assert.equal(JSON.parse(patch.result.content[0].text).filed.tier, 0);
  const reboot = await call({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "server_manager_reboot", arguments: { machine: "vm-one" } } });
  assert.equal(JSON.parse(reboot.result.content[0].text).filed.id, "k-0123456789abcdef");
  assert.deepEqual(filed.map((f) => [f.kind, f.machine]), [["server-manager.patch", "vm-one"], ["server-manager.reboot", "vm-one"]]);
  // Nothing a click sends becomes a command: the tool reads only the machine and the mode, and what it files carries those two
  // (a schema the kernel checks refuses any other field; here the extra word never leaves this function).
  const before = filed.length;
  await call({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "server_manager_patch", arguments: { machine: "vm-one", mode: "security", command: "id" } } });
  assert.equal(filed.length, before + 1);
  assert.deepEqual(filed.at(-1)!.args, { machine: "vm-one", mode: "security" }, "only the machine and the mode are filed; no command ever is");
});
