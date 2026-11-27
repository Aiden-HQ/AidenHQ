// The status row (spec §8) and the read pass that fills it: a sanitized row per machine, built from a recorded read, with no
// address, user name, key or package list; and the check tool itself, driven by the same stand-in ssh the transport test uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DDL, parseDf, publishRow, retireSql, rowOf, stateOfError } from "../service/src/status.ts";
import { StatusStore } from "../service/src/status-store.ts";
import { configTools } from "../service/src/tools.ts";
import { createMcp } from "../service/src/mcp.ts";
import { parseOsRelease, readoutFrom } from "../service/src/apt.ts";
import type { Machine } from "../service/src/config.ts";
import { HostKeyChanged, type Keys } from "../service/src/ssh.ts";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
// As in ssh.test.ts: the banner is assembled at run time so no literal here is a key-shaped string.
const PEM_HEAD = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "OPENSSH", "PRIVATE KEY-----"].join(" ");
const KEY = `${PEM_HEAD}\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n${PEM_END}\n`;

/** A fixture's `### <command>` sections, as the host printed each one. */
function sections(name: string) {
  const parts = new Map<string, string>();
  let key = "";
  for (const line of readFileSync(join(dir, `${name}.txt`), "utf8").split("\n")) {
    const m = /^### (.*)$/.exec(line);
    if (m) { key = m[1]!; parts.set(key, ""); continue; }
    if (key) parts.set(key, `${parts.get(key)}${line}\n`);
  }
  return (k: string) => (parts.get(k) ?? "").trim();
}

const machine: Machine = { name: "vm-one", address: "vm-one", port: 22, user: "user", key: "vm-one-key", enabled: true, expected_fingerprint: "", security_minutes: 60, weekly_day: "mon", weekly_time: "03:00", reboot_policy: "auto", quiet_start: "03:00", quiet_end: "05:00" };

test("df -Pk is read per mount, in GB, and a mount the host did not answer stays null", () => {
  const text = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 41152736 1234 18432000 7% /\ntmpfs 65536 0 65536 0% /run\n/dev/vda2 523248 100 430080 1% /boot\n";
  assert.deepEqual(parseDf(text), { root_free_gb: 17.58, boot_free_gb: 0.41 });
  assert.deepEqual(parseDf(""), { root_free_gb: null, boot_free_gb: null });
});

test("a successful check's row carries counts, disk and the time, and no package list or key", () => {
  const g = sections("ubuntu-lts");
  const ok = { ok: true as const, readout: readoutFrom({ os: parseOsRelease(g("os-release")), policy: g("apt-cache policy"), simulated: g("apt-get -s upgrade"), holds: g("apt-mark showhold"), units: g("systemctl list-units --type=service --state=running --no-legend --plain"), rebootRequired: true, freeRootGb: 18.4, freeBootGb: 0.42, bootId: g("boot id"), unattendedUpgrades: true, securityStatus: g("ubuntu-security-status --format json") }) };
  const row = rowOf(machine, ok, "2026-11-27T10:00:00Z");
  assert.deepEqual(row, { name: "vm-one", distro: "Ubuntu 24.04.3", state: "ok", pending: 3, security: 3, security_known: true, reboot_needed: true, disk: { root_free_gb: 18.4, boot_free_gb: 0.42 }, updated_at: "2026-11-27T10:00:00Z" });
  const text = JSON.stringify(row);
  for (const secret of ["vm-one-key", "user", "PRIVATE KEY", "libc6", "openssl"]) assert.ok(!text.includes(secret), `the row never carries ${secret}`);
  // The warehouse row flattens the same readout and adds the family and the honest note.
  const pub = publishRow(machine, ok, "2026-11-27T10:00:00Z");
  assert.equal(pub.family, "ubuntu-lts");
  assert.equal(pub.pending, 3);
  assert.equal(pub.root_free_gb, 18.4);
  assert.match(String(pub.security_note), /backported/);
  for (const secret of ["vm-one-key", "PRIVATE KEY", "libc6"]) assert.ok(!JSON.stringify(pub).includes(secret), `the published row never carries ${secret}`);
});

test("§10 a changed host key's row keeps the fingerprint the host presented, which is what the page offers to re-pin", () => {
  const seen = "SHA256:" + "B".repeat(43);
  const row = rowOf(machine, { ok: false, state: "host-key-changed", detail: `the host key of vm-one changed since it was pinned (pinned SHA256:${"A".repeat(43)}, host presented ${seen}): nothing ran` }, "2026-11-27T10:00:00Z");
  assert.equal(row.fingerprint, seen, "the row names the presented key, not the pin");
  // The published warehouse row still carries no fingerprint (it is not one of its columns): the page's store is the only holder.
  assert.ok(!JSON.stringify(publishRow(machine, { ok: false, state: "host-key-changed", detail: "host presented " + seen }, "2026-11-27T10:00:00Z")).includes(seen));
  // The real error carries the key as a field, so a long machine name in the message can never truncate it away.
  const err = new HostKeyChanged("a".repeat(250), "SHA256:" + "A".repeat(43), seen);
  assert.equal(rowOf(machine, { ...stateOfError(err) }, "2026-11-27T10:00:00Z").fingerprint, seen);
});

test("a failure's row keeps the state and says nothing else; its detail never reaches the shared row", () => {
  const row = rowOf(machine, { ok: false, state: "host-key-changed", detail: "the host key of vm-one changed" }, "2026-11-27T10:00:00Z");
  assert.deepEqual(row, { name: "vm-one", distro: null, state: "host-key-changed", pending: null, security: null, security_known: null, reboot_needed: null, disk: null, updated_at: "2026-11-27T10:00:00Z" });
  // §8: the shared row carries the controlled state only. A vault key's name or a connection detail stays in the direct answer.
  const detail = "vm-one: the key \"vm-one-key\" has no private key in the Sign-ins panel";
  const pub = publishRow(machine, { ok: false, state: "unsupported", detail }, "2026-11-27T10:00:00Z");
  assert.equal(pub.state, "unsupported");
  assert.equal(pub.security_note, null);
  assert.ok(!JSON.stringify(pub).includes("vm-one-key"), "the published row never carries the key's name");
  assert.ok(!JSON.stringify(pub).includes(detail), "the published row never carries the ssh detail");
});

test("the advertised src_servers views are created by the DDL itself, and the fleet view carries what source_new needs", () => {
  assert.match(DDL, /CREATE TABLE IF NOT EXISTS src_servers\.server/);
  assert.match(DDL, /CREATE OR REPLACE VIEW src_servers\.servers AS/);
  assert.match(DDL, /CREATE OR REPLACE VIEW src_servers\.fleet AS/);
  // source_new orders by seq and skips baseline rows on every view: the one-row aggregate must expose both.
  const fleet = DDL.slice(DDL.indexOf("VIEW src_servers.fleet"));
  assert.match(fleet, /max\(seq\) AS seq/);
  assert.match(fleet, /false AS baseline/);
  assert.match(fleet, /GRANT SELECT ON src_servers\.servers, src_servers\.fleet TO agents_open/);
});

test("a machine the owner removed is deleted from the published table, not left in the fleet", () => {
  assert.equal(retireSql("src_servers"), "DELETE FROM src_servers.server WHERE NOT (name = ANY($1::text[]))");
});

test("each transport failure maps to its own plain state", () => {
  assert.equal(stateOfError(Object.assign(new Error("x"), { name: "HostKeyChanged" })).state, "host-key-changed");
  assert.equal(stateOfError(new Error("vm-one: login refused (the key is not accepted for that user)")).state, "login-refused");
  assert.equal(stateOfError(new Error("vm-one: no-passwordless-sudo (apt needs a password sudo will not get)")).state, "no-passwordless-sudo");
  assert.equal(stateOfError(new Error("vm-one: unreachable")).state, "unreachable");
  assert.equal(stateOfError(new Error("vm-one: something else")).state, "failed");
});

/**
 * A stand-in ssh answering a recorded fixture's sections, so the check tool runs end to end without a host. The answers are a
 * table of `command -> { out } | { code }`, handed to the script as JSON: no interpolation inside a template.
 */
function fakeHost(fixture: string) {
  const root = mkdtempSync(join(tmpdir(), "sm-check-"));
  mkdirSync(join(root, "tmp"));
  const g = sections(fixture);
  const ssh = join(root, "ssh"), keygen = join(root, "ssh-keygen");
  const exact: Record<string, { out?: string; code?: number }> = {
    true: { code: 0 },
    "cat /etc/os-release": { out: g("os-release") },
    "apt-get -s upgrade": fixture === "unsupported" ? { code: 100 } : { out: g("apt-get -s upgrade") },
    "apt-mark showhold": { out: g("apt-mark showhold") },
    "cat /proc/sys/kernel/random/boot_id": { out: g("boot id") },
    "test -f /var/run/reboot-required": { code: g("reboot") === "yes" ? 0 : 1 },
    "cat /var/run/reboot-required.pkgs": { code: 1 },
    "apt-config dump": { out: g("apt-config dump") },
    "systemctl is-enabled unattended-upgrades": { out: g("unattended-upgrades") },
    "test -f /etc/apt/apt.conf.d/20auto-upgrades": { code: 1 },
  };
  // A prefix answer for the commands that carry an argument this test does not fix (the package names in `apt-cache policy`).
  const prefixes: [string, { out: string }][] = [
    ["apt-cache policy", { out: g("apt-cache policy") }],
    ["systemctl list-units", { out: g("systemctl list-units --type=service --state=running --no-legend --plain") }],
    ["df ", { out: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 41152736 1 18432000 7% /\n/dev/vda2 523248 1 430080 1% /boot" }],
  ];
  const sec = g("ubuntu-security-status --format json");
  if (sec) exact["ubuntu-security-status --format json"] = { out: sec };
  // The stand-in is written from plain lines (no nested template): one table of answers it reads as JSON.
  const script = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    'const pinned = args.find((a) => a.startsWith("UserKnownHostsFile="))?.split("=")[1];',
    'if (pinned && !fs.existsSync(pinned)) fs.writeFileSync(pinned, "host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" + String.fromCharCode(10));',
    'const cmd = args.slice(args.findIndex((a) => a.includes("@")) + 1).join(" ");',
    `const exact = ${JSON.stringify(exact)};`,
    `const prefixes = ${JSON.stringify(prefixes)};`,
    "const answer = exact[cmd] ?? (prefixes.find((p) => cmd.startsWith(p[0])) ?? [])[1];",
    "if (!answer) process.exit(127);",
    "if (answer.code !== undefined) process.exit(answer.code);",
    'const text = answer.out.endsWith(String.fromCharCode(10)) ? answer.out : answer.out + String.fromCharCode(10);',
    "process.stdout.write(text);",
    "",
  ].join("\n");
  writeFileSync(ssh, script);
  chmodSync(ssh, 0o755);
  writeFileSync(keygen, `#!${process.execPath}
const fs = require("node:fs");
const f = process.argv[process.argv.length - 1];
try { const t = fs.readFileSync(f, "utf8"); if (!t.trim()) process.exit(1); } catch { process.exit(1); }
process.stdout.write("256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA host (ED25519)\\n");
`);
  chmodSync(keygen, 0o755);
  return { root, transport: { config: { stateDir: join(root, "state"), tmpDir: join(root, "tmp"), sshBin: ssh, keygenBin: keygen, env: {} } } };
}

const owner = async () => ({ agent: "", key: "", name: "", roles: [], tool: "", call: "", kind: "owner", assertion: "" });

test("server_manager_check reads a host, records its row, and files nothing", async () => {
  const { root, transport } = fakeHost("ubuntu-lts");
  const status = new StatusStore(join(root, "data"));
  const tools = configTools({ machines: () => JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" }]), status, transport, keys: () => ({ "vm-one-key": { private_key: KEY } }) as Keys, log: () => undefined });
  const handle = createMcp("server-manager", tools);
  const r = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "server_manager_check", arguments: { name: "vm-one" } } } as never, owner as never)) as any;
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.checked[0].name, "vm-one");
  assert.equal(out.checked[0].state, "ok");
  assert.deepEqual([out.checked[0].pending, out.checked[0].security, out.checked[0].reboot_needed], [3, 3, true]);
  assert.deepEqual(out.checked[0].disk, { root_free_gb: 17.58, boot_free_gb: 0.41 });
  assert.deepEqual(out.checked[0].services, ["cron.service", "nginx.service", "ssh.service", "systemd-journald.service"]);
  // §4: the run reports the fingerprint it pinned (and that it was the first pin), so the owner can compare it.
  assert.equal(out.checked[0].fingerprint, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(out.checked[0].first_pinned, true);
  assert.match(out.checked[0].security_note, /backported/);
  // The row is in the store the page reads, and the answer carries no key.
  const stored = status.get("vm-one")!;
  assert.deepEqual([stored.state, stored.pending, stored.distro], ["ok", 3, "Ubuntu 24.04.3"]);
  assert.ok(!JSON.stringify(r.result).includes("PRIVATE KEY"));
  // A read files no record: the answer carries no settings change, no write kind and no card.
  assert.ok(!/_aidenhq|settings_change/.test(JSON.stringify(r.result)));
});

test("checking an unsupported host records it as unsupported and never runs an action on it", async () => {
  const { root, transport } = fakeHost("unsupported");
  const status = new StatusStore(join(root, "data"));
  const tools = configTools({ machines: () => JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" }]), status, transport, keys: () => ({ "vm-one-key": { private_key: KEY } }) as Keys });
  const r = (await createMcp("server-manager", tools)({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "server_manager_check", arguments: {} } } as never, owner as never)) as any;
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.checked[0].state, "unsupported");
  assert.match(out.checked[0].detail, /only Ubuntu LTS and Debian stable/);
  assert.equal(status.get("vm-one")!.state, "unsupported");
  assert.equal(status.get("vm-one")!.pending, null);
});

test("a machine whose key is missing is recorded as failed, not crashed on, and an unknown name says so", async () => {
  const { root, transport } = fakeHost("ubuntu-lts");
  const status = new StatusStore(join(root, "data"));
  const tools = configTools({ machines: () => JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "missing-key" }]), status, transport, keys: () => ({}) });
  const r = (await createMcp("server-manager", tools)({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "server_manager_check", arguments: {} } } as never, owner as never)) as any;
  const out = JSON.parse(r.result.content[0].text);
  // A failure is a result: the row says what went wrong and the check's answer carries it, rather than the whole call failing.
  assert.equal(out.checked[0].state, "failed");
  assert.match(out.checked[0].detail, /no private key/);
  assert.equal(status.get("vm-one")!.state, "failed");
  assert.equal(status.get("vm-one")!.pending, null);
  const tools2 = configTools({ machines: () => "[]", status, transport, keys: () => ({}) });
  const r2 = (await createMcp("server-manager", tools2)({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "server_manager_check", arguments: { name: "nope" } } } as never, owner as never)) as any;
  assert.match(JSON.parse(r2.result.content[0].text).problem, /no enabled machine called nope/);
});

test("one machine's failure does not stop the fleet: every enabled machine is checked and reported", async () => {
  const { root, transport } = fakeHost("ubuntu-lts");
  const status = new StatusStore(join(root, "data"));
  const tools = configTools({
    machines: () => JSON.stringify([
      { name: "vm-one", address: "vm-one", user: "user", key: "missing-key" },
      { name: "vm-two", address: "vm-two", user: "user", key: "vm-one-key" },
    ]),
    status, transport, keys: () => ({ "vm-one-key": { private_key: KEY } }),
  });
  const r = (await createMcp("server-manager", tools)({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "server_manager_check", arguments: {} } } as never, owner as never)) as any;
  const out = JSON.parse(r.result.content[0].text);
  assert.deepEqual(out.checked.map((c: { name: string; state: string }) => [c.name, c.state]), [["vm-one", "failed"], ["vm-two", "ok"]]);
  assert.equal(status.get("vm-one")!.state, "failed");
  assert.equal(status.get("vm-two")!.state, "ok");
});

test("the check answers while the warehouse publish is still open, and hands it every listed machine", async () => {
  const { root, transport } = fakeHost("ubuntu-lts");
  const status = new StatusStore(join(root, "data"));
  let resolve!: () => void;
  let inventory: string[] = [];
  const never = new Promise<void>((r) => (resolve = r));
  const tools = configTools({
    machines: () => JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" }]),
    status, transport, keys: () => ({ "vm-one-key": { private_key: KEY } }),
    // A publish that never settles, as a down or locked warehouse would be: the answer must not wait on it.
    publishRows: (_rows, inv) => { inventory = inv; return never; },
  });
  const r = (await Promise.race([
    createMcp("server-manager", tools)({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "server_manager_check", arguments: {} } } as never, owner as never),
    new Promise((_, reject) => setTimeout(() => reject(new Error("the check waited on the warehouse")), 5000)),
  ])) as any;
  assert.equal(JSON.parse(r.result.content[0].text).checked[0].state, "ok");
  assert.deepEqual(inventory, ["vm-one"], "the whole saved list is the publish's inventory");
  resolve();
});

test("a failed probe (ssh exit 255) is a failure, never 'no': a dropped connection does not say a reboot isn't needed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-probe-"));
  mkdirSync(join(dir, "tmp"));
  // The scan and the opening connect succeed; every later command on the session dies at 255.
  const ssh = join(dir, "ssh");
  const script = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    'const pinned = args.find((a) => a.startsWith("UserKnownHostsFile="))?.split("=")[1];',
    'if (pinned && !fs.existsSync(pinned)) fs.writeFileSync(pinned, "host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" + String.fromCharCode(10));',
    "const cmd = args[args.length - 1];",
    'if (cmd === "true") process.exit(0);',
    'if (cmd.includes("os-release")) { process.stdout.write(\'PRETTY_NAME="Ubuntu 24.04.3 LTS"\' + String.fromCharCode(10) + \'ID=ubuntu\' + String.fromCharCode(10) + \'VERSION_ID="24.04"\' + String.fromCharCode(10) + \'VERSION_CODENAME=noble\' + String.fromCharCode(10)); process.exit(0); }',
    'process.stderr.write("Connection reset by peer" + String.fromCharCode(10));',
    "process.exit(255);",
    "",
  ].join("\n");
  writeFileSync(ssh, script);
  chmodSync(ssh, 0o755);
  const keygen = join(dir, "ssh-keygen");
  writeFileSync(keygen, `#!${process.execPath}
const fs = require("node:fs");
try { if (!fs.readFileSync(process.argv[process.argv.length - 1], "utf8").trim()) process.exit(1); } catch { process.exit(1); }
process.stdout.write("256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA host (ED25519)\\n");
`);
  chmodSync(keygen, 0o755);
  const status = new StatusStore(join(dir, "data"));
  const tools = configTools({
    machines: () => JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" }]),
    status, transport: { config: { stateDir: join(dir, "state"), tmpDir: join(dir, "tmp"), sshBin: ssh, keygenBin: keygen, env: {} } },
    keys: () => ({ "vm-one-key": { private_key: KEY } }),
  });
  const r = (await createMcp("server-manager", tools)({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "server_manager_check", arguments: {} } } as never, owner as never)) as any;
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.checked[0].state, "unreachable");
  assert.equal(out.checked[0].reboot_needed, null);
  assert.equal(status.get("vm-one")!.state, "unreachable");
});

test("a host with no separate /boot is checked, not failed: df's non-zero for that path leaves boot_free_gb null", async () => {
  const { root, transport } = fakeHost("ubuntu-lts");
  // `df -Pk /boot` is the ordinary cloud-image case: the path is part of `/`, and df exits 1 saying so.
  const real = transport.config.sshBin!;
  const text = readFileSync(real, "utf8");
  writeFileSync(real, text.replace(
    'const answer = exact[cmd] ?? (prefixes.find((p) => cmd.startsWith(p[0])) ?? [])[1];',
    'if (cmd === "df -Pk /boot") { process.stderr.write("df: /boot: No such file or directory" + String.fromCharCode(10)); process.exit(1); }\nconst answer = exact[cmd] ?? (prefixes.find((p) => cmd.startsWith(p[0])) ?? [])[1];',
  ));
  const status = new StatusStore(join(root, "data"));
  const tools = configTools({ machines: () => JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key" }]), status, transport, keys: () => ({ "vm-one-key": { private_key: KEY } }) });
  const r = (await createMcp("server-manager", tools)({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "server_manager_check", arguments: {} } } as never, owner as never)) as any;
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.checked[0].state, "ok");
  assert.deepEqual(out.checked[0].disk, { root_free_gb: 17.58, boot_free_gb: null });
  assert.equal(out.checked[0].pending, 3, "the rest of the read still happened");
});
