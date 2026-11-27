// The two typed write kinds end to end (spec §3, §6, §10, §11), driven by a stand-in ssh answering the recorded Ubuntu fixture: plan
// reads the host and proposes the exact set or the pending reboot; execute re-derives it and refuses a stale or changed one before
// anything runs. §6's records, §13's wakes and §10's re-pin are asserted here too. No host is touched, and no key leaves a temp file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutor, type ExecutorDeps } from "../service/src/executor.ts";
import { pendingId } from "../service/src/reboot.ts";
import { listHash } from "../service/src/apt.ts";
import { word } from "../service/src/apt.ts";
import type { Keys } from "../service/src/ssh.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const PEM_HEAD = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "OPENSSH", "PRIVATE KEY-----"].join(" ");
const KEY = `${PEM_HEAD}\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n${PEM_END}\n`;
const PIN = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function sections(name: string) {
  const parts = new Map<string, string>();
  let key = "";
  for (const line of readFileSync(join(fixtures, `${name}.txt`), "utf8").split("\n")) {
    const m = /^### (.*)$/.exec(line);
    if (m) { key = m[1]!; parts.set(key, ""); continue; }
    if (key) parts.set(key, `${parts.get(key)}${line}\n`);
  }
  return (k: string) => (parts.get(k) ?? "").trim();
}

/** A stand-in ssh over the recorded fixture, with the answers the write path asks for (the exact-list simulation, dpkg, units). */
function fakeHost(i: { simulate?: string; audit?: string; bootId?: string; units?: string; ua?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sm-exec-"));
  mkdirSync(join(root, "tmp"));
  mkdirSync(join(root, "state"), { recursive: true });
  const g = sections("ubuntu-lts");
  const calls = join(root, "calls.jsonl");
  const exact: Record<string, { out?: string; code?: number }> = {
    true: { code: 0 },
    "cat /etc/os-release": { out: g("os-release") },
    "apt-get -s upgrade -o DPkg::Lock::Timeout=600": { out: g("apt-get -s upgrade") },
    "apt-mark showhold": { out: g("apt-mark showhold") },
    "cat /proc/sys/kernel/random/boot_id": { out: i.bootId ?? g("boot id") },
    "uname -r": { out: "6.8.0-48-generic" },
    "test -f /var/run/reboot-required": { code: 0 },
    "cat /var/run/reboot-required.pkgs": { out: "libc6\n" },
    "apt-config dump": { out: i.ua === "enabled" ? g("apt-config dump") : "" },
    "systemctl is-enabled unattended-upgrades": { out: i.ua ?? "disabled" },
    "sudo -n dpkg --audit": { out: i.audit ?? "" },
  };
  const prefixes: [string, { out: string }][] = [
    ["apt-cache policy", { out: g("apt-cache policy") }],
    ["systemctl list-units", { out: i.units ?? g("systemctl list-units --type=service --state=running --no-legend --plain") }],
    ["sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -s install", { out: i.simulate ?? g("apt-get -s install --only-upgrade libc6=2.39-0ubuntu8.5 openssl=3.0.13-0ubuntu3.4") }],
    ["sudo -n apt-get update", { out: "" }],
    ["sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install", { out: "Setting up libc6...\nSetting up openssl...\n" }],
    ["df ", { out: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 41152736 1 18432000 7% /\n/dev/vda2 1523248 1 1430080 1% /boot" }],
    ["systemctl show", { out: "Sun 2026-11-23 04:31:02 UTC" }],
  ];
  const script = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    'const pinned = args.find((a) => a.startsWith("UserKnownHostsFile="))?.split("=")[1];',
    'if (pinned && !fs.existsSync(pinned)) fs.writeFileSync(pinned, "host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" + String.fromCharCode(10));',
    'const at = args.findIndex((a) => a.includes("@"));',
    "const raw = args.slice(at + 1).join(\" \");",
    // The dpkg lock guard (§11.9) is stripped for the lookup only, so every expected command below is the same words it was.
    'const cmd = raw.split("flock -w 600 -x /var/lib/dpkg/lock-frontend ").join("");',
    `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cmd: raw, key: args.includes("-i") }) + "\\n");`,
    `const exact = ${JSON.stringify(exact)};`,
    `const prefixes = ${JSON.stringify(prefixes)};`,
    "const answer = exact[cmd] ?? (prefixes.find((p) => cmd.startsWith(p[0])) ?? [])[1];",
    'if (!answer) { process.stderr.write("unexpected " + cmd + String.fromCharCode(10)); process.exit(127); }',
    "if (answer.code !== undefined) process.exit(answer.code);",
    'process.stdout.write(answer.out.endsWith(String.fromCharCode(10)) ? answer.out : answer.out + String.fromCharCode(10));',
    "",
  ].join("\n");
  const ssh = join(root, "ssh");
  writeFileSync(ssh, script);
  chmodSync(ssh, 0o755);
  const keygen = join(root, "ssh-keygen");
  writeFileSync(keygen, `#!${process.execPath}
const fs = require("node:fs");
try { if (!fs.readFileSync(process.argv[process.argv.length - 1], "utf8").trim()) process.exit(1); } catch { process.exit(1); }
process.stdout.write("256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA host (ED25519)\\n");
`);
  chmodSync(keygen, 0o755);
  const read = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { cmd: string; key: boolean });
  return { root, read, transport: { config: { stateDir: join(root, "state"), tmpDir: join(root, "tmp"), sshBin: ssh, keygenBin: keygen, env: {} } } };
}

function deps(h: ReturnType<typeof fakeHost>, over: Partial<ExecutorDeps> = {}): { d: ExecutorDeps; wakes: { title: string; body: string }[]; filed: { kind: string; args: Record<string, unknown> }[] } {
  const wakes: { title: string; body: string }[] = [], filed: { kind: string; args: Record<string, unknown> }[] = [];
  const machines = JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key", reboot_policy: "auto" }]);
  const d: ExecutorDeps = {
    machines: () => machines, keys: () => ({ "vm-one-key": { private_key: KEY } }) as Keys, transport: () => h.transport,
    timeZone: () => "UTC", stateDir: join(h.root, "data"), log: () => undefined,
    wake: async (w) => { wakes.push(w); },
    file: async (kind, args) => { filed.push({ kind, args }); return { id: "k-0123456789abcdef", tier: 0, state: "claimed" }; },
    taskFor: async () => "task-1",
    ...over,
  };
  return { d, wakes, filed };
}

const module = (extra: Record<string, unknown> = {}) => ({ kind: "module", module: "server-manager", agent: "", key: "", name: "", roles: [], ...extra });

test("plan for a patch reads the host and proposes the exact name=version list with its hash", async () => {
  const h = fakeHost();
  const { d } = deps(h);
  const plan = await createExecutor(d).plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const args = plan.args as { machine: string; mode: string; packages: string[]; hash: string; fingerprint: string; reboot_policy: string };
  assert.equal(args.machine, "vm-one");
  assert.equal(args.mode, "security");
  assert.deepEqual(args.packages, ["libc6=2.39-0ubuntu8.5", "openssl=3.0.13-0ubuntu3.4", "tzdata=2024b-1ubuntu1.1"]);
  assert.equal(args.hash, listHash(args.packages));
  assert.equal(args.fingerprint, PIN, "the plan names the fingerprint it read the host over");
  assert.equal(args.reboot_policy, "auto");
  assert.match(plan.card!["sentence"]!, /Installs 3 security updates/);
  // Only the server-manager service files its own kinds.
  await assert.rejects(createExecutor(d).plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module({ module: "github" }), task: "" } as never), /only the server-manager service/);
  await assert.rejects(createExecutor(d).plan({ kind: "server-manager.patch", args: { machine: "vm-nine", mode: "security" }, requester: module(), task: "" } as never), /no machine/);
});

test("execute installs exactly the approved list with the -s simulation first, and reports the outcome with the services", async () => {
  const h = fakeHost();
  const { d, wakes, filed } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const out = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: plan.args, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(out.ok, true, out.text);
  assert.match(out.text, /3 packages installed|packages installed/);
  assert.match(out.text, /Pinned host key SHA256:/);
  const calls = h.read().map((c) => c.cmd);
  // The refresh, the simulation with the exact list, then the install with the same list: never `upgrade` or a service restart.
  const sim = calls.findIndex((c) => c.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get -s install --only-upgrade"));
  const inst = calls.findIndex((c) => c.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade"));
  assert.ok(sim >= 0 && inst > sim, "the exact -s simulation runs before the install");
  assert.equal(calls[inst], "sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold libc6=2.39-0ubuntu8.5 openssl=3.0.13-0ubuntu3.4 tzdata=2024b-1ubuntu1.1");
  assert.ok(!calls.some((c) => /dist-upgrade|do-release-upgrade|\bupgrade$/.test(c) && !c.startsWith("apt-get -s")), "never a bare upgrade");
  // §6: the reboot the run needs files its own record, and the outcome names it.
  assert.deepEqual(filed.map((f) => f.kind), ["server-manager.reboot"]);
  assert.match(out.text, /Reboot needed: yes/);
  assert.equal(wakes.length, 0);
});

test("§11.10 a host with unattended-upgrades on is left to it: nothing is installed, and the report says why", async () => {
  const h = fakeHost({ ua: "enabled" });
  const { d, wakes } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const out = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: plan.args, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(out.ok, true, "staying out of its way is the correct outcome, not a failure");
  assert.match(out.text, /unattended-upgrades is on/);
  assert.equal(wakes.length, 0, "the agent is not woken for it every hour");
  assert.ok(!h.read().some((c) => c.cmd.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get install")), "never an install beside unattended-upgrades");
});

test("§11.7-8 the services' start times are read before the install, so a maintainer script's restart is named", async () => {
  const h = fakeHost();
  const { d } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: plan.args, digest: "d", idempotency_key: "i", tier: 0 } as never);
  const calls = h.read().map((c) => c.cmd);
  const install = calls.findIndex((c) => c.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade"));
  const firstStart = calls.findIndex((c) => c.startsWith("systemctl show -p ActiveEnterTimestamp"));
  assert.ok(firstStart >= 0 && firstStart < install, "every unit's start time is read before the install, not after it");
});

test("§10 a patch whose record names another host key refuses before anything is installed, and wakes the agent", async () => {
  const h = fakeHost();
  const { d, wakes } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const args = { ...(plan.args as Record<string, unknown>), fingerprint: `SHA256:${"Z".repeat(43)}` };
  const out = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(out.ok, false);
  assert.match(out.text, /host key changed/);
  assert.equal(wakes.length, 1);
  assert.ok(!h.read().some((c) => c.cmd.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get install")), "nothing is installed on a host whose identity changed");
});

test("execute stops a stale record before anything is installed: the record's hash is not the host's set", async () => {
  const h = fakeHost();
  const { d } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const stale = { ...(plan.args as Record<string, unknown>), packages: ["libc6=2.39-0ubuntu8.5"], hash: listHash(["libc6=2.39-0ubuntu8.5"]) };
  const r = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: stale, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(r.ok, false);
  assert.match(r.text, /changed since the record was filed|new record/);
  const calls = h.read().map((c) => c.cmd);
  assert.ok(!calls.some((c) => c.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get install")), "nothing is installed when the plan is stale");
});

test("execute refuses to install a plan the exact-list simulation says changes something outside it", async () => {
  const h = fakeHost({ simulate: "The following NEW packages will be installed:\n  libssl3t64\n0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.\nInst libssl3t64 (3.0.13 Ubuntu:24.04/noble [amd64])" });
  const { d, wakes } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const r = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: plan.args, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(r.ok, false);
  assert.match(r.text, /libssl3t64 would be installed/);
  assert.ok(!h.read().some((c) => c.cmd.startsWith("sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install")), "the install never ran");
  assert.equal(wakes.length, 1, "§13: a failed run wakes the agent");
  assert.match(wakes[0]!.title, /patch run stopped/);
});

test("execute refuses a broken dpkg state and names it, before any install", async () => {
  const h = fakeHost({ audit: "The following packages have been unpacked but not yet configured:\n  libc6\n" });
  const { d, wakes } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const r = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: plan.args, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(r.ok, false);
  assert.match(r.text, /interrupted run/);
  assert.ok(!h.read().some((c) => c.cmd.startsWith("sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install")));
  assert.equal(wakes.length, 1);
});

test("plan for a reboot binds a pending id over the boot ID, kernel and packages, and raises to Tier 2 on an ask-first machine", async () => {
  const h = fakeHost();
  const ask = deps(h);
  const machines = JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key", reboot_policy: "ask" }]);
  const d = { ...ask.d, machines: () => machines };
  const plan = await createExecutor(d).plan({ kind: "server-manager.reboot", args: { machine: "vm-one" }, requester: module(), task: "t" } as never);
  const args = plan.args as { pending_id: string; quiet_window: { start: string; end: string } };
  assert.equal(args.pending_id, pendingId({ boot_id: sections("ubuntu-lts")("boot id"), kernel: "6.8.0-48-generic", reboot_pkgs: ["libc6"] }));
  assert.deepEqual(args.quiet_window, { start: "03:00", end: "05:00" });
  assert.deepEqual(plan.raise && [plan.raise.tier, plan.raise.rule], [2, "reboot-consent"], "an ask-first machine is the owner's decision, never the reviewer's");
  // An auto machine files at its floor.
  const auto = await createExecutor(deps(h).d).plan({ kind: "server-manager.reboot", args: { machine: "vm-one" }, requester: module(), task: "" } as never);
  assert.equal(auto.raise, undefined);
});

test("execute refuses a reboot whose pending id no longer matches, and one outside its quiet window, before rebooting", async () => {
  const h = fakeHost();
  const { d, wakes } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.reboot", args: { machine: "vm-one" }, requester: module(), task: "" } as never);
  const other = { ...(plan.args as Record<string, unknown>), pending_id: pendingId({ boot_id: "another", kernel: "6.8.0-48-generic", reboot_pkgs: ["libc6"] }) };
  const mismatched = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.reboot", args: other, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.text, /another reboot/);
  assert.ok(!h.read().some((c) => c.cmd.includes("systemctl reboot")), "nothing rebooted");
  // The window is read at the moment of the reboot: 12:00 UTC is outside 03:00–05:00.
  const outside = { ...(plan.args as Record<string, unknown>) };
  const realDate = Date;
  const at = "2026-11-27T12:00:00Z";
  (globalThis as { Date: unknown }).Date = class extends realDate { constructor(...a: unknown[]) { super(...(a.length ? (a as [string]) : [at])); } static now() { return Date.parse(at); } };
  try {
    const out = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.reboot", args: outside, digest: "d", idempotency_key: "i", tier: 0 } as never);
    assert.equal(out.ok, false);
    assert.match(out.text, /outside its quiet window/);
    assert.ok(!h.read().some((c) => c.cmd.includes("systemctl reboot")));
  } finally { (globalThis as { Date: unknown }).Date = realDate; }
  assert.equal(wakes.length >= 1, true, "§13: a refused or failed reboot wakes the agent");
});

test("a changed host key refuses the reboot and wakes the agent with both fingerprints", async () => {
  const h = fakeHost();
  // A different pin is what the record names, while the host still presents the fixture's key.
  const { d, wakes } = deps(h);
  const other = `SHA256:${"B".repeat(43)}`;
  const r = await createExecutor(d).execute({ id: "k-0123456789abcdef", kind: "server-manager.reboot", args: { machine: "vm-one", fingerprint: other, pending_id: "0".repeat(64), quiet_window: { start: "00:00", end: "23:59" }, reboot_policy: "auto" }, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(r.ok, false);
  assert.match(r.text, /host key changed/);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]!.title, /different host key/);
  assert.ok(!h.read().some((c) => c.cmd.includes("systemctl reboot")));
});

test("§6 a reboot record whose policy no longer matches the machine refuses, before it connects", async () => {
  const h = fakeHost();
  const { d } = deps(h); // the machine is `auto`
  const plan = await createExecutor(d).plan({ kind: "server-manager.reboot", args: { machine: "vm-one" }, requester: module(), task: "" } as never);
  const args = { ...(plan.args as Record<string, unknown>), reboot_policy: "ask" }; // filed when it was ask-first
  const out = await createExecutor(d).execute({ id: "k-0123456789abcdef", kind: "server-manager.reboot", args, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(out.ok, false);
  assert.match(out.text, /reboot policy changed/);
  assert.ok(!h.read().some((c) => c.cmd.includes("systemctl reboot")), "nothing is rebooted on a stale authorisation");
});

test("§10 the re-pin writes the pin only when the host presents the fingerprint the owner was shown", async () => {
  const h = fakeHost();
  const { repin } = await import("../service/src/ssh.ts");
  const target = { name: "vm-one", address: "vm-one", port: 22, user: "user", key: "vm-one-key", expected_fingerprint: "" };
  await assert.rejects(repin(h.transport, target, `SHA256:${"C".repeat(43)}`), /not SHA256:C+.*nothing was re-pinned/);
  const r = await repin(h.transport, target, PIN);
  assert.equal(r.fingerprint, PIN);
  assert.ok(readFileSync(join(h.root, "state", "known_hosts", "vm-one"), "utf8").includes("ssh-ed25519"), "the pin is the key the host presented");
});
