// The Servers page as the board reads it (the pattern: services/board/test/module-views.test.ts): the page proposes only its own
// module's setting, the Sign-ins panel's keys come from each machine's `key`, and the page's HTML calls the page's own tools and
// shows a quiet, empty start. The manifest is parsed here, so a drift in module.yaml fails this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appliedValues, mapKeys, mayPropose, type PagePoint } from "../../../services/board/src/module-views.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
// yaml is the scripts package's dependency (the compiler's own parser), resolved from there; the module service has none of its own.
const YAML = createRequire(join(root, "../../scripts/package.json"))("yaml") as { parse: (s: string) => any };
const def = YAML.parse(readFileSync(join(root, "module.yaml"), "utf8"));
const page = { ...def.contributes["board.pages"][0], module: "server-manager" } as PagePoint;
const html = readFileSync(join(root, "service/src/page.html"), "utf8");

test("the page proposes servers_machines and nothing else", () => {
  assert.equal(mayPropose(page, "servers_machines", ["server-manager"]), true);
  assert.equal(mayPropose(page, "maintainer_repos", ["github"]), false);
  assert.deepEqual(page.settings, ["servers_machines"]);
});

test("the Sign-ins panel's keys come from each machine's key, once each, valid names only", () => {
  const settings = appliedValues({ servers_machines: { set: true, value: [{ name: "vm-one", key: "vm-one-key" }, { name: "vm-two", key: "vm-one-key" }, { name: "vm-three", key: "Not A Key" }, { name: "vm-four" }] } });
  const map = page.secret_maps![0]!;
  assert.equal(map.secret, "servers_keys");
  assert.deepEqual(map.fields, [{ name: "private_key", label: "Private key", kind: "key", maxLength: 4096 }]);
  assert.deepEqual(mapKeys(map.keys_from, settings), ["vm-one-key"]);
});

test("the page is the module's own view; every tool it lists is one of the connection's, and the page calls the ones it uses", () => {
  assert.equal(page.id, "server-manager");
  assert.equal(page.view, "ui://server-manager/page");
  assert.equal(page.icon, "shield");
  assert.equal(page.order, 40);
  assert.deepEqual(page.tools, ["server_manager_config", "server_manager_status", "server_manager_check", "server_manager_patch", "server_manager_reboot", "server_manager_host_key_reset"]);
  // Each tool the page lists is a read or write tool of its own connection (what compile enforces), never a destructive one.
  const conn = def.connections["server-manager"].tools;
  for (const t of page.tools) assert.ok(conn.read.includes(t) || conn.write.includes(t), `${t} is a read or write tool of the connection`);
  assert.deepEqual(conn.named, ["server_manager_check"]);
  // This slice's page reads the config and the status; its action buttons (check now, install now, reboot, re-pin) arrive with the
  // SSH transport, and the page lists those tools already so the board serves them as soon as they answer.
  for (const t of ["server_manager_config", "server_manager_status"]) assert.ok(html.includes(`tool("${t}"`), `page.html calls ${t}`);
  // The page's one Save lives outside the frame (the board's bar); the page itself never files a change.
  assert.ok(!/fetch\(|XMLHttpRequest|\.save\(/.test(html));
});

test("a new install is quiet: no servers yet, no routine, and the empty state says how to add one", () => {
  assert.equal(def.routines, undefined, "the module schedules nothing at install");
  assert.deepEqual(def.settings.servers_machines.default, []);
  assert.match(html, /No servers yet/);
  assert.match(html, /\+ Add server/);
  // Keys are typed in the Sign-ins panel, outside this frame: the page never holds a key's value.
  assert.match(html, /Sign-ins panel/);
});

test("the page has one editor per machine, and the schedule, reboot policy and quiet window are all present", () => {
  for (const label of ["Address", "User", "Port", "Key name", "Check for updates", "Weekly full pass", "Reboot policy", "Quiet window"]) assert.ok(html.includes(`"${label}"`), `page has a ${label} field`);
});

test("pending removals are kept by name, so removing two servers removes both", () => {
  // One `removing` value would let a second Remove replace the first, and the first server would come back on Save.
  assert.match(html, /removing = new Set\(\)/, "removals are a set of names");
  assert.ok(!/removing = name\b/.test(html), "a removal never replaces another by assignment");
  for (const op of ["removing.add(name)", "removing.delete(name)", "!removing.has(m.name)", "removing.has(name)"]) assert.ok(html.includes(op), `the page uses ${op}`);
});

test("the page keeps the last draft the module accepted, and never proposes a value the module would refuse", () => {
  // A refused draft (local rule or the module's own problems) drops back to the last accepted one, so the bar's Save is what the
  // screen shows; the page checks the entry rules itself before it proposes anything.
  assert.match(html, /const local = problemsOf\(list\)/);
  assert.match(html, /drafts = structuredClone\(lastGood.drafts\)/);
  assert.match(html, /The last good draft is what Save carries/);
  // A saved entry the module could not read is reported, not silently dropped by an unrelated edit.
  assert.match(html, /isn't listed/);
});
