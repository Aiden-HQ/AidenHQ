// The transport (spec §4), driven by a stand-in `ssh` binary that records its argv and answers like a host. Nothing here leaves the
// machine: the key in these tests is generated text, never a real one, and the assertion that matters is that it never shows up in
// a command line, an error or a returned value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, HostKeyChanged, TIMEOUTS, readKeys, scrub, withConnection, type Keys, type SshMachine } from "../service/src/ssh.ts";

// An SSH key's text as a test sees it: the PEM banner is split so the literal never looks like a key to a secret scanner
// (services/board/test/page-secrets.test.ts does the same), and the body is a base64 fragment, not a key.
const PEM_HEAD = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "OPENSSH", "PRIVATE KEY-----"].join(" ");
const KEY = `${PEM_HEAD}\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\n${PEM_END}\n`;
const PIN = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OLD_PIN = `SHA256:${"B".repeat(43)}`;

/** A stand-in ssh: records each call's argv, then behaves as `mode` says. */
function fakeSsh(dir: string, mode: "ok" | "changed" | "denied" | "timeout" = "ok") {
  const log = join(dir, "calls.jsonl");
  const bin = join(dir, "ssh");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const pinned = args.find((a) => a.startsWith("UserKnownHostsFile="))?.split("=")[1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args }) + "\\n");
const mode = ${JSON.stringify(mode)};
// The host key is exchanged and recorded before authentication, so the scan (and any failing login) leaves it pinned.
if (pinned && !fs.existsSync(pinned)) fs.writeFileSync(pinned, "host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n");
if (mode === "changed") { process.stderr.write("@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@\\n"); process.exit(255); }
if (mode === "denied") { process.stderr.write("user@host: Permission denied (publickey).\\n"); process.exit(255); }
if (mode === "timeout") { setTimeout(() => {}, 60000); }
else {
  const cmd = args[args.length - 1];
  if (cmd === "true") process.exit(0);
  if (cmd.includes("os-release")) process.stdout.write('PRETTY_NAME="Ubuntu 24.04.3 LTS"\\nID=ubuntu\\nVERSION_ID="24.04"\\nVERSION_CODENAME=noble\\n');
  else if (cmd.includes("apt-cache policy")) process.stdout.write("libc6:\\n  Installed: 1\\n  Candidate: 2\\n  Version table:\\n     2 500\\n        500 http://x/ubuntu noble-security/main amd64 Packages\\n");
  else process.stdout.write("");
  process.exit(0);
}
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const keygen = join(dir, "ssh-keygen");
  writeFileSync(keygen, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const f = args[args.length - 1];
let t = "";
try { t = fs.readFileSync(f, "utf8"); if (!t.trim()) process.exit(1); } catch { process.exit(1); }
// A pin file holding OLDKEY stands for a key pinned on an earlier day: its fingerprint differs from what the host presents now.
process.stdout.write(t.includes("OLDKEY") ? "256 ${OLD_PIN} host (ED25519)\\n" : "256 ${PIN} host (ED25519)\\n");
`);
  chmodSync(keygen, 0o755);
  return { bin, keygen, log, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).args as string[]) : []) };
}

const machine: SshMachine = { name: "vm-one", address: "vm-one", port: 22, user: "user", key: "vm-one-key", expected_fingerprint: "" };
const keys = (): Keys => ({ "vm-one-key": { private_key: KEY } });

function transport(dir: string, mode: "ok" | "changed" | "denied" | "timeout" = "ok") {
  const f = fakeSsh(dir, mode);
  return { transport: { config: { stateDir: join(dir, "state"), tmpDir: join(dir, "tmp"), sshBin: f.bin, keygenBin: f.keygen, env: {} } }, f };
}

test("batch, a pinned host file, fixed timeouts, and the key by path only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  mkdirSync(join(dir, "tmp"));
  const { transport: t, f } = transport(dir);
  const r = await withConnection(t, machine, keys(), async (c, pin) => {
    assert.equal(pin.firstPinned, true);
    assert.equal(pin.fingerprint, PIN);
    const out = await c.exec(["cat", "/etc/os-release"]);
    return out.stdout;
  });
  assert.match(r, /Ubuntu 24.04.3 LTS/);
  // The host key is read without authenticating first, then the connection itself, then the command on it.
  const [scan, open, run] = f.calls();
  assert.equal(f.calls().length, 3);
  const args = [...scan!, ...open!, ...run!];
  for (const o of ["BatchMode=yes", "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "RequestTTY=no", `ConnectTimeout=${TIMEOUTS.connect}`, "IdentitiesOnly=yes"])
    assert.ok(args.includes(o), `ssh runs with -o ${o}`);
  assert.ok(args.some((a) => /UserKnownHostsFile=.*known_hosts\/vm-one$/.test(a)), "the pin is per machine");
  assert.ok(scan!.includes("PreferredAuthentications=none"), "the host key is read without offering the private key");
  assert.ok(scan!.includes("StrictHostKeyChecking=accept-new"), "the scan records what the host presents, in a throwaway file");
  assert.ok(!scan!.some((a) => /UserKnownHostsFile=.*known_hosts\/vm-one$/.test(a)), "the scan never writes the machine's pin before it is checked");
  assert.ok(open!.includes("StrictHostKeyChecking=yes"), "the connection must present exactly the key just checked");
  assert.ok(run!.includes("StrictHostKeyChecking=yes"), "every later connection refuses a changed key");
  assert.equal(args.filter((a) => a === "user@vm-one").length, 3, "user@address with -p and -l, once per connection");
  assert.ok(run!.slice(-3).join(" ").includes("user@vm-one"), "the command and target are the last words");
  assert.ok(!JSON.stringify(f.calls()).includes("BEGIN OPENSSH PRIVATE KEY"), "the key's text is never on a command line");
  assert.ok(!JSON.stringify(f.calls()).includes("b3BlbnNzaC1rZXk"), "not even the key's body is on a command line");
});

test("the key's file is 0600 inside the tmpfs and gone after the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  mkdirSync(join(dir, "tmp"));
  const { transport: t, f } = transport(dir);
  let keyPath = "";
  await withConnection(t, machine, keys(), async (c) => {
    // The key is named only on the connection after the scan: the scan is given no `-i` at all.
    assert.ok(!f.calls()[0]!.some((a, i, all) => all[i - 1] === "-i"), "the host-key scan never names the key");
    keyPath = f.calls()[1]!.find((a, i, all) => all[i - 1] === "-i")!;
    const mode = (await import("node:fs")).statSync(keyPath).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.ok(keyPath.startsWith(join(dir, "tmp")), "the key is written in the tmpfs");
  });
  assert.equal(existsSync(keyPath), false, "the key file is unlinked in a finally");
});

test("a changed host key refuses the run and names both fingerprints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  mkdirSync(join(dir, "tmp"));
  const { transport: t } = transport(dir, "changed");
  // Pin it first so the run is not the first connection.
  mkdirSync(join(dir, "state", "known_hosts"), { recursive: true });
  writeFileSync(join(dir, "state", "known_hosts", "vm-one"), "host ssh-ed25519 OLDKEY\n");
  await assert.rejects(() => withConnection(t, machine, keys(), async () => "ran"), (e: Error) => {
    assert.ok(e instanceof HostKeyChanged);
    assert.match(e.message, /changed since it was pinned/);
    // §10: the refusal names the key the host presents now, which is not the stored one.
    assert.ok(e.message.includes(OLD_PIN), "the pinned fingerprint is named");
    assert.ok(e.message.includes(PIN), "the presented fingerprint is named");
    assert.equal((e as HostKeyChanged).seen, PIN);
    return true;
  });
});

test("a first connection whose key is not the expected fingerprint refuses, before anything runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  mkdirSync(join(dir, "tmp"));
  const { transport: t, f } = transport(dir);
  await assert.rejects(() => withConnection(t, { ...machine, expected_fingerprint: `SHA256:${"b".repeat(43)}` }, keys(), async () => "ran"), HostKeyChanged);
  assert.equal(f.calls().length, 1, "the connection is tried once, and nothing runs on it");
});

test("§10 a re-pinned key connects even where a stale expected_fingerprint is still set: the pin is the authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  mkdirSync(join(dir, "tmp"));
  const { transport: t } = transport(dir);
  // The owner re-pinned the host's current key (a pin file exists); the setting still names the old one, which only the owner can edit.
  mkdirSync(join(dir, "state", "known_hosts"), { recursive: true });
  writeFileSync(join(dir, "state", "known_hosts", "vm-one"), `host ssh-ed25519 ${PIN}\n`);
  const ran = await withConnection(t, { ...machine, expected_fingerprint: OLD_PIN }, keys(), async () => "ran");
  assert.equal(ran, "ran", "the first connection's expectation is not enforced forever");
});

test("a refused login says so in plain words and never echoes the key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  mkdirSync(join(dir, "tmp"));
  const { transport: t } = transport(dir, "denied");
  await assert.rejects(() => withConnection(t, machine, keys(), async () => "ran"), (e: Error) => {
    assert.match(e.message, /login refused/);
    assert.ok(!e.message.includes("PRIVATE KEY"));
    return true;
  });
});

test("a connection that never answers is cut at the connect timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  mkdirSync(join(dir, "tmp"));
  const { transport: t } = transport(dir, "timeout");
  await assert.rejects(() => withConnection(t, machine, keys(), async () => "ran"), /timed out/);
});

test("a machine whose key is not in the map says so and opens nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  const { transport: t, f } = transport(dir);
  await assert.rejects(() => withConnection(t, machine, {}, async () => "ran"), /has no private key/);
  assert.equal(f.calls().length, 0);
});

test("a command word outside the allowed characters is refused before ssh runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  mkdirSync(join(dir, "tmp"));
  const { transport: t, f } = transport(dir);
  await assert.rejects(() => withConnection(t, machine, keys(), async (c) => c.exec(["apt-get", "install", "a;reboot"])), /outside the allowed characters/);
  assert.equal(f.calls().length, 2, "the scan and the opening connection ran, and the refused command did not");
});

test("every error string is scrubbed of the key, whole and line by line", () => {
  assert.equal(scrub(`oops ${KEY} end`, KEY).includes("PRIVATE KEY"), false);
  assert.equal(scrub("line: b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB", KEY).includes("b3BlbnNzaC1rZXktdjE"), false);
  assert.equal(scrub("nothing secret here", KEY), "nothing secret here");
});

test("the key map is read as JSON, and a broken file is no keys rather than a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-keys-"));
  const f = join(dir, "keys");
  writeFileSync(f, JSON.stringify({ a: { private_key: KEY } }));
  assert.equal(readKeys(f).a?.private_key, KEY);
  writeFileSync(f, "{not json");
  assert.deepEqual(readKeys(f), {});
  assert.deepEqual(readKeys(undefined), {});
});

test("the connection is closed even when the work throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  mkdirSync(join(dir, "tmp"));
  const { transport: t, f } = transport(dir);
  let keyPath = "";
  await assert.rejects(() => withConnection(t, machine, keys(), async (c) => {
    keyPath = f.calls()[1]!.find((a, i, all) => all[i - 1] === "-i")!;
    throw new Error("boom");
  }), /boom/);
  assert.equal(existsSync(keyPath), false);
});

test("a connection built without opening writes no key at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  const { transport: t } = transport(dir);
  const c = new Connection(machine, t, keys());
  c.close();
  assert.equal(existsSync(join(dir, "tmp")), false);
});

test("an IPv6 address is passed bare, with the port on its own flag: never user@[addr] which ssh cannot resolve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ssh-"));
  mkdirSync(join(dir, "tmp"));
  const { transport: t, f } = transport(dir);
  await withConnection(t, { ...machine, address: "[2001:db8::1]", port: 2222 }, keys(), async (c) => c.exec(["true"]));
  const target = f.calls().at(-1)!.find((a) => a === "user@2001:db8::1");
  assert.equal(target, "user@2001:db8::1", "the literal is passed without brackets");
  const args = f.calls().at(-1)!;
  assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2), ["-p", "2222"]);
  assert.ok(!f.calls().flat().some((a) => a.includes("[2001")), "the bracketed form is never passed");
});
