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

test("each machine's state line carries disk on / and /boot beside pending, security, reboot and last check", () => {
  // §9 lists the disk readout as part of the row's state: a full /boot turns a kernel update into a machine that does not come back.
  assert.match(html, /free on \//, "the row shows free space on /");
  assert.match(html, /free on \/boot/, "the row shows free space on /boot");
  for (const tag of ["reboot needed", "pending", "security", "checked "]) assert.ok(html.includes(tag), `the row shows ${tag}`);
  // Low space is flagged, not just printed.
  assert.match(html, /st\.disk\.root_free_gb < 1 \? "needs"/);
  assert.match(html, /st\.disk\.boot_free_gb < 1 \? "needs"/);
});

test("check now is a read: it calls server_manager_check and files nothing", () => {
  assert.ok(html.includes('tool("server_manager_check"'), "the page calls the check");
  assert.match(html, /"Check now"/);
  assert.match(html, /checking\.has\(name\)/, "a check in flight is not started twice");
  // The check is the read tool: it carries no record, so its call is the read name and nothing else.
  assert.ok(!/server_manager_check", \{[^}]*record/.test(html), "the check call carries no record");
});

test("the page's write actions file the typed kinds, never a command: patch, reboot, and a re-pin only on a changed key", () => {
  // §9: install security now and full update now file the same server-manager.patch a schedule would, with mode security or full;
  // the reboot files server-manager.reboot; and the re-pin is offered only while the machine is host-key-changed, with the
  // fingerprint the page was shown (§10), so a stale click cannot pin a third key.
  assert.ok(html.includes('tool("server_manager_patch"'), "the page files a patch");
  assert.ok(html.includes('tool("server_manager_reboot"'), "the page files a reboot");
  assert.ok(html.includes('tool("server_manager_host_key_reset"'), "the page offers a re-pin");
  for (const label of ["Install security now", "Full update now", "Re-pin the key shown", "Reboot"]) assert.ok(html.includes(`"${label}"`), `the page has a ${label} button`);
  assert.match(html, /patchNow\(name, "security"\)/);
  assert.match(html, /patchNow\(name, "full"\)/);
  assert.match(html, /st\.state === "host-key-changed" && st\.fingerprint/, "the re-pin is offered only with a fingerprint the page was shown");
  assert.match(html, /repinNow\(name, st\.fingerprint\)/);
  // §10: the fingerprint is on the card, in the state line, before the button — on a reload the earlier check's message is gone, so a
  // click that accepted an unseen key would be the whole defect.
  assert.match(html, /presented \$\{st\.fingerprint\}/, "the state line names the fingerprint the host presented");
  assert.ok(html.indexOf("presented ${st.fingerprint}") < html.indexOf('act("Re-pin the key shown"'), "it is drawn before the re-pin action is offered");
  // Nothing the page sends is a shell word: the only arguments are a machine name, a mode and a fingerprint.
  assert.ok(!/command|argv|shell/i.test(html), "the page sends no command, argv or shell word");
  // The buttons read the machine's last readout, so it is declared before the closure that draws them: a `const` used above its
  // own declaration throws on the first render, and the page would be blank for every machine.
  assert.ok(html.indexOf("const st = stateOf[name];") < html.indexOf("const writeActs = ()"), "the readout is declared before the actions that read it");
});
