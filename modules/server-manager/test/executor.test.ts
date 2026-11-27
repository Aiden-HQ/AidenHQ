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
import { ConsentStore, pendingId, rebootDue } from "../service/src/reboot.ts";
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
function fakeHost(i: { simulate?: string; estimate?: string; audit?: string; bootId?: string; units?: string; ua?: string; disk?: string } = {}) {
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
    // The estimate is its own `--print-uris` read (§11.3): the fixture's is real apt 2.8.4 output. `null` proves the refusal path.
    ["sudo -n env DEBIAN_FRONTEND=noninteractive apt-get --print-uris install", { out: i.estimate ?? g("apt-get --print-uris install --only-upgrade libc6=2.39-0ubuntu8.5 openssl=3.0.13-0ubuntu3.4") }],
    ["sudo -n apt-get update", { out: "" }],
    ["sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install", { out: "Setting up libc6...\nSetting up openssl...\n" }],
    ["df ", { out: i.disk ?? "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 41152736 1 18432000 7% /\n/dev/vda2 1523248 1 1430080 1% /boot" }],
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
  // The plan's disk guard read a real estimate, not `0`: the exact list's `--print-uris` call carries `Need to get 4598 kB`,
  // which is what the fixture's `-s` output never printed.
  assert.ok(h.read().some((c) => c.cmd.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get --print-uris install --only-upgrade -y")), "the plan reads the estimate from --print-uris over the exact list");
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

// §11.1 — the check that the plan is the whole change runs on the *exact list's* simulation, never the wider inventory one. A host
// that also has an ordinary update must not have that update rejected as "outside the approved list" for a security-only record.
test("§11.1 a security record installs on a host that also has ordinary updates: the exact simulation decides, not the inventory", async () => {
  const h = fakeHost();
  const { d } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  // The exact simulation for a security record must name only the security packages; here it also lists `curl`, the host's ordinary
  // update, which is exactly what a wrong (inventory-based) comparison refuses.
  const mixedSim = [
    "The following packages will be upgraded:", "  curl libc6 openssl tzdata", "4 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    "Need to get 5,120 kB of archives.", "Inst curl [8.5.0-2ubuntu9] (8.5.0-2ubuntu9.1 Ubuntu:24.04/noble-updates [amd64])",
    "Inst libc6 [2.39-0ubuntu8.3] (2.39-0ubuntu8.5 Ubuntu:24.04/noble-security [amd64])",
  ].join("\n");
  const mixed = fakeHost({ simulate: mixedSim });
  const mixedDeps = deps(mixed);
  const out = await createExecutor(mixedDeps.d).execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: plan.args, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(out.ok, false);
  assert.match(out.text, /curl/, "the inventory's extra package is what the exact simulation would flag");
  // And the unmodified fixture — whose exact simulation lists only libc6/openssl/tzdata — installs cleanly.
  const clean = await ex.execute({ id: "k-fedcba9876543210", kind: "server-manager.patch", args: plan.args, digest: "d", idempotency_key: "i2", tier: 0 } as never);
  assert.equal(clean.ok, true, clean.text);
  assert.ok(h.read().some((c) => c.cmd.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade")), "the install ran on the exact list");
});

// §11.3 — the plan-time guard reads the exact list's real estimate. With the estimate read as `0` (the old `-s` path) the floor is
// the only thing judged, so a host with 2 GB free would pass a 1.5 GB download that needs twice that. The guard must refuse it.
test("§11.3 planPatch's disk guard judges the real --print-uris estimate, not the 1 GB floor a zero would fall back to", async () => {
  const twoGb = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 41152736 1 2097152 7% /";
  const big = [
    "The following packages will be upgraded:", "  libc6 openssl tzdata", "3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    "Need to get 1.5 GB of archives.", "After this operation, 3 GiB of additional disk space will be used.",
  ].join("\n");
  const h = fakeHost({ estimate: big, disk: twoGb });
  const ex = createExecutor(deps(h).d);
  await assert.rejects(
    ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never),
    (e: Error & { code?: string }) => e.code === "low_disk" && /1536 MB download/.test(e.message),
    "2 GB free is short of twice 1.5 GB, and the guard says so with the real number",
  );
  // The same host with the estimate it really printed for this list passes: the guard is reading bytes, not a constant.
  const small = [
    "The following packages will be upgraded:", "  libc6 openssl tzdata", "3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    "Need to get 4598 kB of archives.",
  ].join("\n");
  const ok = await createExecutor(deps(fakeHost({ estimate: small, disk: twoGb })).d).plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  assert.equal((ok.args as { packages: string[] }).packages.length, 3);
});

// §11.3 — the estimate is unavailable, not zero. The old code read it off `apt-get -s`, which never prints it, so every patch was
// refused as `disk_unknown`; that refusal is right and stays. When `--print-uris` also prints none, the run still refuses before
// anything is installed, and so does the plan.
test("§11.3 runPatch and planPatch refuse disk_unknown when --print-uris prints no estimate", async () => {
  // A host whose `-s` plan is fine but whose `--print-uris` call prints no `Need to get` line: the simulation says what to install
  // and nothing says how many bytes it costs.
  const noEstimate = "The following packages will be upgraded:\n  libc6 openssl tzdata\n3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n";
  const h = fakeHost({ estimate: noEstimate });
  const { d, wakes } = deps(h);
  const ex = createExecutor(d);
  // The plan needs an estimate for its own guard, so it refuses first and files nothing.
  await assert.rejects(
    ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never),
    (e: Error & { code?: string }) => e.code === "disk_unknown" && /no download estimate/.test(e.message),
    "the plan refuses a host whose estimate it cannot read, rather than judging it against the 1 GB floor",
  );
  assert.ok(!h.read().some((c) => c.cmd.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade")), "nothing was installed");
  // The run's own refusal: a record planned on a host that answered, executed on one that does not, names disk_unknown and refuses.
  const good = fakeHost();
  const planned = await createExecutor(deps(good).d).plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const run = await createExecutor(deps(fakeHost({ estimate: noEstimate })).d).execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: planned.args, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(run.ok, false, run.text);
  assert.match(run.text, /no download estimate for this exact list/, "the run names the missing estimate, not a zero-byte guess");
  const runHost = fakeHost({ estimate: noEstimate });
  const runDeps = deps(runHost);
  const run2 = await createExecutor(runDeps.d).execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: planned.args, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(run2.ok, false, run2.text);
  assert.match(run.text, /space the run needs is unknown/, "the refusal is the disk guard's, not a plan mismatch");
  assert.ok(!runHost.read().some((c) => c.cmd.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade")), "the install never ran");
  assert.equal(runDeps.wakes.length, 1, "a refused run wakes the agent with what it refused");
  void wakes;
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
  const at = "2026-11-28T02:00:00Z";
  (globalThis as { Date: unknown }).Date = class extends realDate { constructor(...a: unknown[]) { super(...(a.length ? (a as [string]) : [at])); } static now() { return Date.parse(at); } };
  try {
    const out = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.reboot", args: outside, digest: "d", idempotency_key: "i", tier: 0 } as never);
    assert.equal(out.ok, false);
    assert.match(out.text, /outside its quiet window/);
    assert.ok(!h.read().some((c) => c.cmd.includes("systemctl reboot")));
  } finally { (globalThis as { Date: unknown }).Date = realDate; }
  assert.equal(wakes.length >= 1, true, "§13: a refused or failed reboot wakes the agent");
});

// §6, §11.12 — a reboot the scheduler filed for one window, and the owner approved after that window closed, is deferred *and*
// re-armed: the "already filed for this pending id" mark is cleared, so the next window files it again instead of the approval
// silently expiring unused. Without the re-arm `rebootDue` answers nothing for every later window.
test("§6 a reboot deferred outside its window re-arms, so the next window files it again", async () => {
  const h = fakeHost();
  const { d } = deps(h);
  const id = pendingId({ boot_id: sections("ubuntu-lts")("boot id"), kernel: "6.8.0-48-generic", reboot_pkgs: ["libc6"] });
  // The scheduler filed a record for this pending id in the window that has since closed.
  const consent = new ConsentStore(join(h.root, "data"));
  consent.decide("vm-one", id, PIN, new Date("2026-11-28T00:30:00Z"));
  consent.markFiled("vm-one", id);
  const window = { quiet_start: "03:00", quiet_end: "05:00" };
  const recordWindow = { start: "03:00", end: "05:00" };
  assert.equal(rebootDue(window, consent.get("vm-one"), new Date("2026-11-28T02:00:00Z"), "UTC"), undefined, "filed once; outside the window it is not due again either");
  const realDate = Date;
  const at = "2026-11-27T12:00:00Z";
  (globalThis as { Date: unknown }).Date = class extends realDate { constructor(...a: unknown[]) { super(...(a.length ? (a as [string]) : [at])); } static now() { return Date.parse(at); } };
  try {
    const out = await createExecutor(d).execute({ id: "k-0123456789abcdef", kind: "server-manager.reboot", args: { machine: "vm-one", fingerprint: PIN, pending_id: id, quiet_window: recordWindow, reboot_policy: "auto" }, digest: "d", idempotency_key: "i", tier: 0 } as never);
    assert.equal(out.ok, false);
    assert.match(out.text, /outside its quiet window/);
  } finally { (globalThis as { Date: unknown }).Date = realDate; }
  const after = new ConsentStore(join(h.root, "data")).get("vm-one");
  assert.equal(after?.decided_at !== undefined, true, "the owner's decision is not spent by a deferral");
  assert.equal(after?.filed, undefined, "the once-per-window mark is cleared, so the window that opens can file it");
  assert.equal(rebootDue(window, after, new Date("2026-11-28T03:30:00Z"), "UTC"), id, "the next window files the same approved reboot");
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

// §12 — one write per machine at a time, across both kinds: a reboot must never land while the same host's dpkg is unpacking.
test("§12 a patch and a reboot for one machine do not overlap: the reboot waits for the patch's connection to close", async () => {
  const h = fakeHost();
  const { d } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const rebootArgs = {
    machine: "vm-one", fingerprint: PIN, quiet_window: { start: "00:00", end: "00:01" }, reboot_policy: "auto",
    pending_id: pendingId({ boot_id: sections("ubuntu-lts")("boot id"), kernel: "6.8.0-48-generic", reboot_pkgs: ["libc6"] }),
  };
  // Both start at once. The reboot's window is tiny and (at the real clock) shut, so it returns before issuing anything — what this
  // asserts is that it could not even reach its connection until the patch had finished and closed its own.
  const patch = ex.execute({ id: "k-0000000000000001", kind: "server-manager.patch", args: plan.args, digest: "d", idempotency_key: "a", tier: 0 } as never);
  const reboot = ex.execute({ id: "k-0000000000000002", kind: "server-manager.reboot", args: rebootArgs, digest: "d", idempotency_key: "b", tier: 0 } as never);
  const [p1, r1] = await Promise.all([patch, reboot]);
  assert.equal(p1.ok, true, p1.text);
  assert.equal(r1.ok, false, "the closed window stops the reboot");
  // The calls interleave only as "patch's whole run, then the reboot's reads": no reboot command, and the patch's install is before
  // the reboot's first host read.
  const calls = h.read().map((c) => c.cmd);
  const install = calls.findIndex((c) => c.startsWith("sudo -n flock -w 600 -x /var/lib/dpkg/lock-frontend env DEBIAN_FRONTEND=noninteractive apt-get install "));
  assert.ok(install >= 0, "the patch installed");
  assert.ok(!calls.some((c) => c === "sudo -n systemctl reboot"), "nothing rebooted");
  assert.ok(calls.lastIndexOf("uname -r") > install, "the reboot's reads happened after the patch's install, so the two never overlapped");
});

// §11.12 — the clock that decides consent, the window and the reboot is sampled after the host is read, never before it: the reads
// can take seconds, and a window ending while they run must close the run. The order is asserted on the source, so a later edit that
// moves the clock back above the read fails here without a test that could ever reboot anything.
test("§11.12 the window clock is taken after the reboot state is read", async () => {
  const src = readFileSync(new URL("../service/src/executor.ts", import.meta.url), "utf8");
  const read = src.indexOf("const st = await readRebootState(c);");
  const now = src.indexOf("const now = new Date();");
  assert.ok(read > 0 && now > 0);
  assert.ok(now > read, "`now` is sampled after `readRebootState`, so consent, window and reboot share a time taken once the reads are done");
  assert.ok(!/const now = new Date\(\);\s*\n\s*const st = await readRebootState/.test(src), "never sampled before the read");
});

// §6 — an "ask me first" machine reboots only on the owner's decision: a Tier 0 record with no decision on record refuses.
test("§6 an ask-first reboot refuses a Tier 0 record with no owner decision, and runs on the Tier 2 one", async () => {
  const h = fakeHost();
  const { d } = deps(h);
  const machines = JSON.stringify([{ name: "vm-one", address: "vm-one", user: "user", key: "vm-one-key", reboot_policy: "ask" }]);
  const ex = createExecutor({ ...d, machines: () => machines });
  const plan = await ex.plan({ kind: "server-manager.reboot", args: { machine: "vm-one" }, requester: module(), task: "" } as never);
  const args = { ...(plan.args as Record<string, unknown>), quiet_window: { start: "00:00", end: "23:59" } };
  const low = await ex.execute({ id: "k-0000000000000001", kind: "server-manager.reboot", args, digest: "d", idempotency_key: "a", tier: 0 } as never);
  assert.equal(low.ok, false);
  assert.match(low.text, /asks before it reboots|no owner decision/);
  assert.ok(!h.read().some((c) => c.cmd === "sudo -n systemctl reboot"), "a Tier 0 record reboots nothing on an ask-first machine");
  // The owner's Tier 2 decision gets past that gate: it is not refused for want of a decision (its own run then meets the window).
  const high = await ex.execute({ id: "k-0000000000000002", kind: "server-manager.reboot", args: { ...args, quiet_window: { start: "00:00", end: "00:01" } }, digest: "d", idempotency_key: "b", tier: 2 } as never);
  assert.doesNotMatch(high.text, /asks before it reboots|no owner decision/, "a Tier 2 record is not refused for want of a decision");
});

// §11.1 — the executor refiles a patch whose refresh moved the set, because the kernel's pre-run re-plan saw the old index.
test("§11.1 a stale patch is refiled by the executor for the set the refresh showed", async () => {
  const h = fakeHost();
  const { d, filed } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const stale = { ...(plan.args as Record<string, unknown>), packages: ["libc6=2.39-0ubuntu8.5"], hash: listHash(["libc6=2.39-0ubuntu8.5"]) };
  const r = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: stale, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(r.ok, false);
  // The refile is fired detached; give its promise a turn to settle.
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(filed.some((f) => f.kind === "server-manager.patch"), "a replacement patch record is filed from the executor");
  assert.match(r.text, /Filed again as k-0123456789abcdef/, "the outcome names the record it filed, the way the kernel words its own refile");
});

// §11.1, §13 — when the replacement cannot be filed, that is the thing the agent must be woken for: a scheduled run that goes stale
// and files nothing installs nothing and tells nobody otherwise.
test("§11.1 a stale patch whose refile fails wakes the agent instead of failing silently", async () => {
  const h = fakeHost();
  const base = deps(h);
  const d: ExecutorDeps = { ...base.d, file: async () => { throw new Error("kernel unavailable"); } };
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const stale = { ...(plan.args as Record<string, unknown>), packages: ["libc6=2.39-0ubuntu8.5"], hash: listHash(["libc6=2.39-0ubuntu8.5"]) };
  const r = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: stale, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.equal(r.ok, false);
  assert.match(r.text, /could not be filed/);
  assert.equal(base.wakes.length, 1);
  assert.match(base.wakes[0]!.title, /could not be refiled/);
});

// §11.1, §13 — a refile that fails *after* the outcome's 5 s bound still wakes the agent: the outcome said it was on its way, and the
// failure must reach someone who can file it.
test("§11.1 a refile that fails after the outcome was written still wakes the agent", async () => {
  const h = fakeHost();
  const base = deps(h);
  const d: ExecutorDeps = {
    ...base.d,
    file: (() => new Promise((_, no) => setTimeout(() => no(new Error("kernel went away")), 5_600))) as ExecutorDeps["file"],
  };
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const stale = { ...(plan.args as Record<string, unknown>), packages: ["libc6=2.39-0ubuntu8.5"], hash: listHash(["libc6=2.39-0ubuntu8.5"]) };
  const r = await ex.execute({ id: "k-0123456789abcdef", kind: "server-manager.patch", args: stale, digest: "d", idempotency_key: "i", tier: 0 } as never);
  assert.match(r.text, /being filed/, "the outcome cannot claim an id it has not got");
  await new Promise((ok) => setTimeout(ok, 1_200));
  assert.equal(base.wakes.length, 1, "the late failure still reaches the agent");
  assert.match(base.wakes[0]!.title, /could not be refiled/);
});

// §11.1 — a second stale run inside the window reuses the replacement already filed, rather than filing a chain of records.
test("§11.1 a second stale run the same window does not file another replacement", async () => {
  const h = fakeHost();
  const { d, filed } = deps(h);
  const ex = createExecutor(d);
  const plan = await ex.plan({ kind: "server-manager.patch", args: { machine: "vm-one", mode: "security" }, requester: module(), task: "" } as never);
  const stale = { ...(plan.args as Record<string, unknown>), packages: ["libc6=2.39-0ubuntu8.5"], hash: listHash(["libc6=2.39-0ubuntu8.5"]) };
  await ex.execute({ id: "k-0000000000000001", kind: "server-manager.patch", args: stale, digest: "d", idempotency_key: "a", tier: 0 } as never);
  await ex.execute({ id: "k-0000000000000002", kind: "server-manager.patch", args: stale, digest: "d", idempotency_key: "b", tier: 0 } as never);
  assert.equal(filed.filter((f) => f.kind === "server-manager.patch").length, 1, "one replacement for one moving index");
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
