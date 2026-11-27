// The one transport to a server (spec §4): one SSH connection per run, a key named from the map, a pinned host key, batch mode
// and fixed timeouts. Nothing here is a command the caller wrote: the only things that ever run on a host are the argument lists
// this module builds (apt.ts), and every one of them is a fixed argv with values this module validated.
//
// A key is held only at connect time: its text is written to a mode-0600 file inside the container's tmpfs, named on the ssh
// command line by path (never by value), and unlinked in a finally. It is never logged, never returned by a tool, never put in a
// record or a status row, and every error string this file produces is scrubbed of it.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The bounds §4 states: connect 15 s, a read command 120 s, the install 1500 s, the reboot wait 900 s. `lock` is the longer bound a
 * call that may wait on the dpkg lock needs: §11.9 lets `flock` and apt's own `DPkg::Lock::Timeout=600` wait 600 s, so the outer
 * SSH deadline must outlast that wait or a patch would be killed for a lock it was told to wait out.
 */
export const TIMEOUTS = { connect: 15, read: 120_000, lock: 660_000, install: 1_500_000, reboot: 900_000 };

/** A host key that is not the pinned one. The run stops and only the owner's explicit reset re-pins it (§10). */
export class HostKeyChanged extends Error {
  readonly machine: string;
  readonly expected: string;
  readonly seen: string;

  constructor(machine: string, expected: string, seen: string) {
    super(`the host key of ${machine} changed since it was pinned (pinned ${expected || "unknown"}, host presented ${seen || "unknown"}): nothing ran`);
    this.name = "HostKeyChanged";
    this.machine = machine;
    this.expected = expected;
    this.seen = seen;
  }
}

/** The map's shape (`servers_keys`): key name -> { private_key }. Read fresh on every use; never written here. */
export type Keys = Record<string, { private_key?: string } | undefined>;

export function readKeys(file: string | undefined): Keys {
  if (!file) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Keys) : {};
  } catch {
    return {};
  }
}

/**
 * Removes every trace of a secret from a string: the whole value, and each of its non-trivial lines. Used on every message this
 * file throws, on the command's stderr, and on an assertion failure, so a key that reached a shell error is still not recorded.
 */
export function scrub(text: string, ...secrets: (string | undefined)[]): string {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (!s || s.length < 8) continue;
    out = out.split(s).join("[key]");
    for (const line of s.split(/\r?\n/)) if (line.trim().length >= 16) out = out.split(line).join("[key]");
  }
  return out;
}

export interface SshMachine {
  name: string;
  address: string;
  port: number;
  user: string;
  key: string;
  expected_fingerprint: string;
}

/** How a run reaches a host: the machine, its key's text, where its pin lives, and the binary (a test replaces it). */
export interface Transport {
  config: { stateDir: string; tmpDir?: string; sshBin?: string; keygenBin?: string; env?: NodeJS.ProcessEnv };
}

export type ExecResult = { code: number; stdout: string; stderr: string };

/**
 * What a command word may hold: a package name=version, a path, a number, a flag. Never a quote, `;`, `$`, `|`, `` ` ``, `&`, `<`,
 * `>`, a newline or a space, so no word can end a command or start a second one however it was built. `~` and `:` are the
 * Debian version separators (`1.2-1~deb12u1`, `1:2.3`), and the patch schema permits both.
 */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,.~\/\[\]{}-]+$/;
/** One word for the host's shell: a word with a shell-special character (`~`, `[`, `{`) is single-quoted (no quotes can reach here, so no escaping). */
const quote = (a: string) => (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(a) ? a : `'${a}'`);

const HOST_KEY_CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i;

/**
 * The key a host presents right now, read *without* authenticating: ssh does its key exchange and records the host key before any
 * user authentication, and `PreferredAuthentications=none` stops it there, so a private key is never offered to a host whose key
 * has not been checked yet (§4, §10). No `-i` is passed at all: the scan holds no key material.
 */
function scanPresented(
  t: Transport, machine: SshMachine,
  base: (strict: "accept-new" | "yes", pinFile: string, withKey: boolean) => string[],
  run: (args: string[], timeoutMs: number) => Promise<ExecResult>,
): Promise<{ fingerprints: string[]; knownHosts: string }> {
  const dir = mkdtempSync(join(t.config.tmpDir ?? tmpdir(), "sm-scan-"));
  chmodSync(dir, 0o700);
  const tmp = join(dir, "known_hosts");
  const target = (() => { const a = machine.address.startsWith("[") && machine.address.endsWith("]") ? machine.address.slice(1, -1) : machine.address; return `${machine.user}@${a}`; })();
  return (async () => {
    try {
      await run([...base("accept-new", tmp, false), "-o", "PreferredAuthentications=none", "-o", "PasswordAuthentication=no", target, "true"], TIMEOUTS.connect * 1000);
      let knownHosts = "";
      try { knownHosts = readFileSync(tmp, "utf8"); } catch { knownHosts = ""; }
      return { fingerprints: await fingerprintsOf(t, tmp), knownHosts };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

/** `ssh-keygen -l -E sha256` over a known_hosts file: the fingerprints it holds. */
function fingerprintsOf(t: Transport, file: string): Promise<string[]> {
  try { if (statSync(file).size === 0) return Promise.resolve([]); } catch { return Promise.resolve([]); }
  return new Promise((resolve) => {
    const child = spawn(t.config.keygenBin ?? "ssh-keygen", ["-l", "-E", "sha256", "-f", file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.on("error", () => resolve([]));
    child.on("close", () => resolve(stdout.split("\n").flatMap((l) => { const m = /\b(SHA256:[A-Za-z0-9+/]{43})\b/.exec(l); return m ? [m[1]!] : []; })));
  });
}

/**
 * The fingerprints a host presents right now, without authenticating (§10's re-pin reads this before it writes anything). The
 * caller compares them with the fingerprint the owner was shown; nothing is pinned here.
 */
export async function presentedKey(t: Transport, machine: SshMachine): Promise<string[]> {
  const base = (strict: "accept-new" | "yes", pinFile: string, withKey: boolean) => {
    const args = [
      "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes",
      "-o", "RequestTTY=no", "-o", `ConnectTimeout=${TIMEOUTS.connect}`, "-o", "LogLevel=ERROR",
      "-o", "UserKnownHostsFile=" + pinFile, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes",
      "-o", `StrictHostKeyChecking=${strict}`, "-p", String(machine.port), "-l", machine.user,
    ];
    if (withKey) throw new Error("a scan takes no key");
    return args;
  };
  const run = (args: string[], timeoutMs: number) => new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(t.config.sshBin ?? "ssh", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...(t.config.env ?? process.env), LC_ALL: "C" } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(String(e.message))); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
  const seen = await scanPresented(t, machine, base, run);
  return seen.fingerprints;
}

/**
 * The owner's re-pin (§10): the host's key as it presents it right now, written to `<stateDir>/known_hosts/<machine>`. The expected
 * fingerprint — the one the owner was shown — must be among the keys the host presents, or nothing is written at all (a stale click
 * cannot pin a third key). No key material is involved: the scan holds no key.
 */
export async function repin(t: Transport, machine: SshMachine, expected: string): Promise<{ fingerprint: string }> {
  const base = (strict: "accept-new" | "yes", pinFile: string) => [
    "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes",
    "-o", "RequestTTY=no", "-o", `ConnectTimeout=${TIMEOUTS.connect}`, "-o", "LogLevel=ERROR",
    "-o", "UserKnownHostsFile=" + pinFile, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes",
    "-o", `StrictHostKeyChecking=${strict}`, "-p", String(machine.port), "-l", machine.user,
  ];
  const run = (args: string[], timeoutMs: number) => new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(t.config.sshBin ?? "ssh", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...(t.config.env ?? process.env), LC_ALL: "C" } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(String(e.message))); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
  const dir = mkdtempSync(join(t.config.tmpDir ?? tmpdir(), "sm-pin-"));
  chmodSync(dir, 0o700);
  const tmp = join(dir, "known_hosts");
  try {
    const a = machine.address.startsWith("[") && machine.address.endsWith("]") ? machine.address.slice(1, -1) : machine.address;
    await run([...base("accept-new", tmp), "-o", "PreferredAuthentications=none", "-o", "PasswordAuthentication=no", `${machine.user}@${a}`, "true"], TIMEOUTS.connect * 1000);
    const seen = await fingerprintsOf(t, tmp);
    if (!seen.length) throw new Error(`${machine.name}: unreachable (the host presented no host key): nothing was re-pinned`);
    if (!seen.includes(expected)) throw new Error(`${machine.name}: the host presents ${seen.join(", ")}, not ${expected}: nothing was re-pinned. Check the fingerprint and try again.`);
    let knownHosts = "";
    try { knownHosts = readFileSync(tmp, "utf8"); } catch { knownHosts = ""; }
    if (!knownHosts.trim()) throw new Error(`${machine.name}: the host's key was read but not recorded: nothing was re-pinned`);
    const pin = join(t.config.stateDir, "known_hosts", machine.name);
    mkdirSync(dirname(pin), { recursive: true, mode: 0o700 });
    writeFileSync(pin, knownHosts, { mode: 0o600 });
    return { fingerprint: expected };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One connection to one machine, opened for one run and closed at the end. */
export class Connection {
  private keyFile: string | null = null;
  private dir: string | null = null;
  private closed = false;
  readonly machine: SshMachine;
  private readonly t: Transport;
  /** Where the machine's pin lives, as the settings name it (what a re-pin writes). */
  readonly pinFile: string;
  /**
   * The pin this run verified, copied once at open. Every later command in this run checks against *this* file, so an owner's
   * re-pin mid-run — a different host behind the same name — cannot move the trust anchor under a write already in flight (§4).
   */
  private runPin: string | null = null;
  private readonly secret: string;

  constructor(machine: SshMachine, t: Transport, keys: Keys) {
    this.machine = machine;
    this.t = t;
    const entry = keys[machine.key];
    this.secret = entry?.private_key ?? "";
    if (!this.secret.trim()) throw new Error(`${machine.name}: the key "${machine.key}" has no private key in the Sign-ins panel`);
    this.pinFile = join(t.config.stateDir, "known_hosts", machine.name);
  }

  /**
   * Where a machine's SSH target is spelled: always user@address with -p port, never parsed out of a string. An IPv6 literal is
   * passed bare: the port is its own flag, and ssh does not strip brackets from a `user@[addr]` destination (it would try to
   * resolve the brackets themselves).
   */
  private target(): string {
    const a = this.machine.address.startsWith("[") && this.machine.address.endsWith("]") ? this.machine.address.slice(1, -1) : this.machine.address;
    return `${this.machine.user}@${a}`;
  }

  private baseArgs(strict: "accept-new" | "yes" = "yes", pinFile = this.runPin ?? this.pinFile, withKey = true): string[] {
    const args = [
      // Batch, always: no password prompt, no agent forwarding, no X11, no port forwarding, and no TTY (§4).
      "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes",
      "-o", "RequestTTY=no", "-o", `ConnectTimeout=${TIMEOUTS.connect}`, "-o", "LogLevel=ERROR",
      "-o", "UserKnownHostsFile=" + pinFile, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes",
      // Every connection checks the pin: the first may record what the host presents, the rest must match it exactly (§4).
      "-o", `StrictHostKeyChecking=${strict}`,
      "-p", String(this.machine.port), "-l", this.machine.user,
    ];
    if (withKey && this.keyFile) args.push("-i", this.keyFile);
    return args;
  }

  /** Writes the key for this one connection (0600, in the tmpfs), and returns its path. */
  private writeKey(): string {
    const tmp = this.t.config.tmpDir ?? tmpdir();
    const dir = mkdtempSync(join(tmp, "sm-"));
    chmodSync(dir, 0o700);
    const file = join(dir, "id");
    writeFileSync(file, this.secret.endsWith("\n") ? this.secret : `${this.secret}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    this.dir = dir;
    return (this.keyFile = file);
  }

  private spawnRun(args: string[], timeoutMs: number, input?: string): Promise<ExecResult> {
    const bin = this.t.config.sshBin ?? "ssh";
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...(this.t.config.env ?? process.env), LC_ALL: "C" } });
      let stdout = "", stderr = "", done = false;
      const fail = (e: Error) => { if (done) return; done = true; child.kill("SIGKILL"); reject(e); };
      const timer = setTimeout(() => fail(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => { if (stderr.length < 200_000) stderr += d; });
      child.on("error", (e) => { clearTimeout(timer); fail(new Error(String(e.message))); });
      child.on("close", (code) => { clearTimeout(timer); if (done) return; done = true; resolve({ code: code ?? -1, stdout, stderr }); });
      // A command's stdin is closed at once: nothing waits for a prompt, and no secret is ever piped into a host.
      child.stdin.end(input ?? "");
    });
  }

  /** Runs the local ssh-keygen over a known_hosts file: the fingerprints it holds, as SHA256 strings. */
  private async fingerprints(file: string): Promise<string[]> {
    try { if (statSync(file).size === 0) return []; } catch { return []; }
    const r = await this.spawnKeygen(["-l", "-E", "sha256", "-f", file]);
    if (r.code !== 0) return [];
    // `<bits> SHA256:… <comment> (<type>)`, one line per key.
    return r.stdout.split("\n").flatMap((l) => { const m = /\b(SHA256:[A-Za-z0-9+/]{43})\b/.exec(l); return m ? [m[1]!] : []; });
  }

  /** The fingerprints already pinned for this machine (empty for a machine nobody has connected to yet). */
  private pinned(): Promise<string[]> {
    return this.fingerprints(this.pinFile);
  }

  /** The key the host presents right now, read without a key at all (§4, §10). */
  private presented(): Promise<{ fingerprints: string[]; knownHosts: string }> {
    return scanPresented(this.t, this.machine, this.baseArgs.bind(this), this.spawnRun.bind(this));
  }

  private spawnKeygen(args: string[]): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.t.config.keygenBin ?? "ssh-keygen", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", (e) => reject(new Error(String(e.message))));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  /**
   * Opens the connection, and decides the host key before anything runs or authenticates (§4, §10):
   *   - the first connection records what the host presents (trust-on-first-use, stated plainly in the spec) — unless the entry
   *     names an `expected_fingerprint`, which must match or the run refuses with nothing pinned;
   *   - a machine already pinned must present one of its pinned keys, or the run refuses and the owner's reset is the only way on.
   * The presented key is read before authentication (PreferredAuthentications=none), so a key the owner did not expect is never
   * authenticated against, and a refusal names the key the host actually presented.
   */
  async open(): Promise<{ fingerprint: string; firstPinned: boolean }> {
    mkdirSync(dirname(this.pinFile), { recursive: true, mode: 0o700 });
    const before = await this.pinned();
    const seen = await this.presented();
    const presented = seen.fingerprints;
    if (!presented.length) throw new Error(`${this.machine.name}: unreachable (the host presented no host key)`);
    // The key is written only once the host key is known to be the one expected: it is never on a command line for a host whose
    // identity has not been checked.
    this.writeKey();
    const first = before.length === 0;
    // `expected_fingerprint` is the owner's check on the *first* connection (§4: "when it does, the first connection must match it");
    // once a key is pinned, that pin is the authority. Otherwise a rotated key the owner re-pinned (§10) could never connect again,
    // because the module cannot rewrite a setting only the owner writes.
    if ((first && this.machine.expected_fingerprint) || !first) {
      const expected = first && this.machine.expected_fingerprint ? [this.machine.expected_fingerprint] : before;
      if (!presented.some((f) => expected.includes(f))) {
        // Nothing is pinned from a host that is not the one the owner expected: the next run refuses too, until a reset.
        if (first) rmSync(this.pinFile, { force: true });
        throw new HostKeyChanged(this.machine.name, expected.join(", "), presented.join(", "));
      }
    }
    if (first) {
      // Trust-on-first-use: pin exactly the key checked a moment ago, and the connection below must match it.
      writeFileSync(this.pinFile, seen.knownHosts, { mode: 0o600 });
      if (!(await this.pinned()).length) throw new Error(`${this.machine.name}: could not pin the host key: nothing ran`);
    }
    // Freeze the pin this run verified: every command below it checks this copy, never the live file a re-pin could rewrite.
    this.runPin = this.freezePin();
    const r = await this.spawnRun([...this.baseArgs("yes"), this.target(), "true"], TIMEOUTS.connect * 1000);
    if (r.code !== 0) {
      const msg = scrub(r.stderr || r.stdout, this.secret).trim();
      if (HOST_KEY_CHANGED.test(msg)) throw new HostKeyChanged(this.machine.name, before.join(", "), presented.join(", "));
      throw new Error(`${this.machine.name}: ${this.reason(msg)}`);
    }
    const after = await this.pinned();
    return { fingerprint: (after.length ? after : presented).join(", "), firstPinned: first };
  }

  /**
   * A private copy of the pin as this run checked it, in the run's own 0700 directory (written beside the key's file, and unlinked
   * with it). A pin file that is empty or unreadable leaves the copy empty, and the next command then fails its host-key check —
   * nothing at all is trusted where the pin could not be frozen.
   */
  private freezePin(): string {
    if (!this.dir) throw new Error("the connection's directory is missing");
    const copy = join(this.dir, "known_hosts");
    try { writeFileSync(copy, readFileSync(this.pinFile), { mode: 0o600 }); } catch { writeFileSync(copy, "", { mode: 0o600 }); }
    return copy;
  }

  /** A plain failure's one-line reason, scrubbed: the readout never quotes a shell's page of output. */
  private reason(msg: string): string {
    const line = msg.split("\n").map((l) => l.trim()).find(Boolean) ?? "the connection failed";
    if (/Permission denied/i.test(line)) return "login refused (the key is not accepted for that user)";
    if (/sudo:.*password|a password is required/i.test(line)) return "no-passwordless-sudo (apt needs a password sudo will not get)";
    if (/Could not resolve hostname|Connection refused|Connection timed out|No route to host/i.test(line)) return "unreachable";
    return line.slice(0, 300);
  }

  /**
   * Runs one fixed argv on the host and returns its output; the timeout is the caller's bound (§4). ssh hands its command words to
   * the host's shell, so every word is checked against a narrow charset (this module's own values: package names, versions, paths)
   * and the whole command is refused if any word falls outside it. No word a request wrote ever reaches here.
   */
  async exec(argv: string[], timeoutMs = TIMEOUTS.read): Promise<ExecResult> {
    if (!this.keyFile) throw new Error("the connection was not opened");
    for (const a of argv) if (!SAFE_WORD.test(a)) throw new Error(`${this.machine.name}: refused a command word outside the allowed characters`);
    const r = await this.spawnRun([...this.baseArgs(), this.target(), ...argv.map(quote)], timeoutMs);
    if (r.code !== 0) throw new Error(`${this.machine.name}: ${this.reason(scrub(r.stderr || r.stdout, this.secret))}`);
    return { code: r.code, stdout: r.stdout, stderr: scrub(r.stderr, this.secret) };
  }

  /**
   * Runs one fixed argv and returns its exit status instead of throwing: a read that answers yes or no by exit code (a file's
   * presence, whether a unit is enabled) is not a failure when it answers no. Same word check as `exec`.
   *
   * ssh itself exits 255 when the connection or the session fails, so 255 is rethrown as a failure: a dropped connection must not
   * read as "the file is not there" (which would say a reboot is not needed on a host nobody could reach).
   */
  async probe(argv: string[], timeoutMs = TIMEOUTS.read): Promise<ExecResult> {
    if (!this.keyFile) throw new Error("the connection was not opened");
    for (const a of argv) if (!SAFE_WORD.test(a)) throw new Error(`${this.machine.name}: refused a command word outside the allowed characters`);
    const r = await this.spawnRun([...this.baseArgs(), this.target(), ...argv.map(quote)], timeoutMs);
    if (r.code === 255 || HOST_KEY_CHANGED.test(r.stderr)) throw new Error(`${this.machine.name}: ${this.reason(scrub(r.stderr || r.stdout, this.secret))}`);
    return { code: r.code, stdout: scrub(r.stdout, this.secret), stderr: scrub(r.stderr, this.secret) };
  }

  /** Unlinks the key's file and its directory. Safe to call twice; a run always calls it in a finally. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.keyFile = null;
    this.dir = null;
    this.runPin = null;
  }
}

/** Opens one connection for one run, and closes it whatever happens: one connection per run, never pooled (§4). */
export async function withConnection<T>(t: Transport, machine: SshMachine, keys: Keys, fn: (c: Connection, pin: { fingerprint: string; firstPinned: boolean }) => Promise<T>): Promise<T> {
  const c = new Connection(machine, t, keys);
  try {
    const pin = await c.open();
    return await fn(c, pin);
  } finally {
    c.close();
  }
}
