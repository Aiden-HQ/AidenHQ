// A reboot, and the consent that binds it (spec §6, §10, §11.11-12): need detection from the host's own flag, the quiet window in
// the instance's timezone (a window that ends before it starts wraps midnight), a pending id over the boot ID it expects to leave,
// the kernel that needs it and the package set that put it there, consent that expires 12 hours after it was granted, and a
// come-back proof that is the boot ID changing, never SSH answering.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TIMEOUTS, type Connection } from "./ssh.ts";

/** A wall-clock `HH:MM` as minutes of the day. */
export const minutesOf = (hhmm: string) => {
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(hhmm);
  if (!m) throw new Error(`not a time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * Whether a moment is inside a window: `[start, end)` in the instance's zone, wrapping midnight when end <= start (23:00–01:00 is
 * a real window). A zero-length window is a whole day's window (`start === end`), which the page never produces and a hand edit
 * could: it is read as the full day rather than as never.
 */
export function inWindow(start: string, end: string, at: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const now = hour * 60 + minute, from = minutesOf(start), to = minutesOf(end);
  return from === to ? true : from < to ? now >= from && now < to : now >= from || now < to;
}

/** A package in `/var/run/reboot-required.pkgs`, with the installed version that asked for the reboot. */
export interface RebootPackage { name: string; version: string }

/**
 * The pending reboot id (§6): a hash of the boot ID the host is on, the running kernel, the installed kernel awaiting the next
 * boot, and each reboot-triggering package with its installed version. Names alone are not enough: a second update to the same
 * package leaves the boot ID, `uname -r` and the names unchanged while a different update is pending, so the installed versions
 * (and the kernel package the next boot would load) are what make it a different reboot. It changes with any of them, so an
 * approval can never ride a second update or a different machine.
 */
export function pendingId(i: { boot_id: string; kernel: string; kernel_awaiting: string; reboot_pkgs: RebootPackage[] }): string {
  const pkgs = [...i.reboot_pkgs]
    .map((p) => `${p.name.trim()}=${p.version.trim()}`)
    .filter((p) => !p.startsWith("="))
    .sort()
    .join(",");
  return createHash("sha256").update([i.boot_id.trim(), i.kernel.trim(), i.kernel_awaiting.trim(), pkgs].join("\n")).digest("hex");
}

/** Consent lasts 12 hours from when it was granted (§6); after that the pending reboot is dropped and reported, never held. */
export const CONSENT_MS = 12 * 60 * 60 * 1000;

export interface Consent {
  pending: string;
  granted_at: string;
  /** The pending id a record was last filed for, so a deferred reboot is filed once per window, not every minute. */
  filed?: string;
  /** The host key the decision was taken over: a re-pin after it is a different identity, so the consent no longer applies. */
  fingerprint?: string;
  /** When the kernel actually decided the record (the owner's approval on an ask-first machine), never when it was planned. */
  decided_at?: string;
}

/**
 * Consent, per machine, in the data dir: the pending id a plan was raised for and when. It is written from the plan (so a card the
 * owner leaves open expires whether or not it is ever approved) and removed by the run that uses it, so a second approval of the
 * same pending id is a fresh decision, not a replayed one.
 */
export class ConsentStore {
  private readonly file: string;
  private map: Record<string, Consent>;
  constructor(dir: string) {
    this.file = join(dir, "reboot-consent.json");
    mkdirSync(dirname(this.file), { recursive: true });
    this.map = this.load();
  }
  /**
   * The file as it is *now*. The executor, the scheduler and a plan each hold their own store, and the scheduler drops an expired
   * consent while the executor keeps its own copy: reading the file on every call is what keeps one's drop visible to the other,
   * and what makes a re-filed approval start its own 12 hours.
   */
  private load(): Record<string, Consent> {
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  }
  get(machine: string): Consent | undefined { return this.load()[machine]; }
  /**
   * Record a pending id for a machine. A consent for the *same* pending id keeps its original time (a record left open ages out);
   * a different pending id, or an entry already past its 12 hours, starts fresh, so a new approval made after the old one lapsed
   * is not refused for the old one's age.
   */
  note(machine: string, pending: string, at = new Date()): Consent {
    this.map = this.load();
    const had = this.map[machine];
    if (had && had.pending === pending && at.getTime() - Date.parse(had.granted_at) <= CONSENT_MS) return had;
    this.map[machine] = { pending, granted_at: at.toISOString() };
    this.save();
    return this.map[machine]!;
  }
  /**
   * Record the kernel's decision for a pending id — the moment `execute` is called, which is only after the kernel has decided the
   * record. Consent is written here, never at plan time: a card the owner never answers, or rejects, authorises nothing, and a plan
   * the kernel never runs must not be able to leave a reboot the scheduler could pick up. A decision for the same pending id and pin
   * keeps its original clock (a run that defers to a later window is the same decision, not a new one); a new one starts fresh.
   */
  decide(machine: string, pending: string, fingerprint: string, at = new Date(), prior?: Consent): Consent {
    this.map = this.load();
    const had = prior ?? this.map[machine];
    if (had && had.pending === pending && had.decided_at && at.getTime() - Date.parse(had.decided_at) <= CONSENT_MS) {
      this.map[machine] = { pending, granted_at: had.granted_at, decided_at: had.decided_at, fingerprint: had.fingerprint ?? fingerprint, ...(had.filed ? { filed: had.filed } : {}) };
      this.save();
      return this.map[machine]!;
    }
    this.map[machine] = { pending, granted_at: at.toISOString(), decided_at: at.toISOString(), fingerprint };
    this.save();
    return this.map[machine]!;
  }

  /**
   * Re-arm a live decision's window refile. A run that found its window already closed reports it and leaves the owner's decision
   * standing; the scheduler files it once more when the window opens, because the "already filed for this pending id" mark is
   * cleared here. The 12 hours are unchanged: this is the same decision, resumed.
   */
  rearm(machine: string, pending: string): void {
    this.map = this.load();
    const c = this.map[machine];
    if (!c || c.pending !== pending || c.filed === undefined) return;
    const { filed: _filed, ...rest } = c;
    this.map[machine] = rest;
    this.save();
  }

  /**
   * The owner's decision that a live consent still rests on: the same pending id, the same pinned host key, decided inside its 12
   * hours, and not yet spent by a run. A deferred reboot the owner already approved can be filed again for the window that opens
   * without asking a second time — one decision, one reboot of that exact pending id (§6).
   */
  decided(machine: string, pending: string, fingerprint: string, at = new Date()): Consent | undefined {
    this.map = this.load();
    const c = this.map[machine];
    if (!c || c.pending !== pending || !c.decided_at) return undefined;
    if (c.fingerprint && fingerprint && c.fingerprint !== fingerprint) return undefined;
    if (at.getTime() - Date.parse(c.decided_at) > CONSENT_MS) return undefined;
    return c;
  }
  /** Records that a reboot record was filed for this pending id (the scheduler's deferral guard); the approval is still live. */
  markFiled(machine: string, pending: string): void {
    this.map = this.load();
    const c = this.map[machine];
    if (!c || c.pending !== pending || c.filed === pending) return;
    this.map[machine] = { ...c, filed: pending };
    this.save();
  }
  drop(machine: string): void {
    this.map = this.load();
    if (!(machine in this.map)) return;
    delete this.map[machine];
    this.save();
  }
  /** A consent still inside its 12 hours, or the reason it is not (expired, or not the pending id this run re-derived). */
  check(machine: string, pending: string, at = new Date(), fingerprint?: string): { ok: true; consent: Consent } | { ok: false; reason: string } {
    this.map = this.load();
    const c = this.map[machine];
    if (!c) return { ok: false, reason: "no consent is recorded for this reboot: it was dropped, or the record predates this run" };
    if (fingerprint && c.fingerprint && c.fingerprint !== fingerprint) return { ok: false, reason: "the host key was re-pinned after this consent was given: it authorises the machine it was decided for, not this one" };
    if (at.getTime() - Date.parse(c.decided_at ?? c.granted_at) > CONSENT_MS) return { ok: false, reason: `the consent expired (decided ${c.decided_at ?? c.granted_at}, more than 12 hours ago): the pending reboot is dropped and must be asked for again` };
    if (c.pending !== pending) return { ok: false, reason: "what the machine needs has changed since it was approved (a different boot ID, kernel or package set): this approval is for another reboot" };
    return { ok: true, consent: c };
  }
  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.map, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** What a run read about the reboot: the boot ID it expects to leave, the running kernel, the installed kernel awaiting boot,
 * and the packages (with their installed versions) that asked for it. */
export interface RebootState { boot_id: string; kernel: string; kernel_awaiting: string; reboot_pkgs: RebootPackage[]; needed: boolean }

export const REBOOT_READ = {
  bootId: ["cat", "/proc/sys/kernel/random/boot_id"],
  kernel: ["uname", "-r"],
  rebootPkgs: ["cat", "/var/run/reboot-required.pkgs"],
  rebootFlag: ["test", "-f", "/var/run/reboot-required"],
  /** `dpkg-query -W`'s default format is `package<TAB>version`; no package names or globs are added to the argv. */
  installedVersions: ["dpkg-query", "-W"],
} as const;

/**
 * The dpkg frontend lock, taken non-blocking and verbosely: a package writer already holds it, so the state is not read or a
 * reboot issued while a transaction may be changing the versions the approval names. `--verbose` is what puts "failed to get lock"
 * on stderr, so a lock conflict can be told from a command that failed for its own reason (a plain `flock -n` says nothing).
 */
export const DPKG_LOCK_NOWAIT = ["sudo", "-n", "flock", "--verbose", "-n", "-x", "/var/lib/dpkg/lock-frontend"] as const;

/**
 * Every lock held on the host, by path. apt and dpkg lock `/var/lib/dpkg/lock*` with fcntl (POSIX) locks, which `flock(1)` neither
 * takes nor sees on Linux, so a manual or unattended-upgrades transaction is found here instead. util-linux ships `lslocks` on both
 * Ubuntu and Debian; sudo lets it resolve paths held by root's processes.
 */
export const HELD_LOCKS = ["sudo", "-n", "lslocks", "-n", "-r", "-o", "PATH"] as const;

/** Whether `lslocks`' output shows a dpkg or apt lock held by any process. */
export const aptBusy = (lslocks: string) => /^\/var\/lib\/(dpkg\/lock|apt\/lists\/lock)/m.test(lslocks);

/** A package writer held the dpkg lock when the final reboot state was read. */
export class RebootLocked extends Error {}

/** `dpkg-query -W`'s `package<TAB>version` lines as a map. A malformed line is skipped, never guessed at. */
export function parseInstalledVersions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [name, version] = line.trim().split(/\s+/);
    if (!name || !version) continue;
    out.set(name, version);
    // `dpkg-query -W` prints a multi-arch package as `libc6:amd64`; `/var/run/reboot-required.pkgs` names it `libc6`. Keep both
    // spellings so the reboot-triggering package's installed version is found.
    const base = name.replace(/:[a-z0-9-]+$/i, "");
    if (base !== name && !out.has(base)) out.set(base, version);
  }
  return out;
}

/**
 * The installed kernel image(s) the next boot would load: every concrete `linux-image-…` package except the running kernel's own.
 * The meta packages (`linux-image-generic`, `linux-image-amd64`) are not a kernel release and are left out. Sorted, so the same
 * installed set always spells the same value.
 */
export function awaitingKernel(running: string, installed: Map<string, string>): string {
  const bare = (name: string) => name.replace(/:[a-z0-9-]+$/i, "");
  const runningPkgs = new Set([`linux-image-${running}`, `linux-image-unsigned-${running}`]);
  return [...installed.entries()]
    .filter(([name]) => /^linux-image-(?:unsigned-)?\d/.test(bare(name)) && !runningPkgs.has(bare(name)))
    .map(([name, version]) => `${bare(name)}=${version}`)
    .sort()
    .join(",");
}

/**
 * Reads a host's reboot state: the boot ID, the running kernel, the kernel awaiting boot, and the reboot-triggering packages with
 * their installed versions (from `dpkg-query -W`). `lock` is the final read before a reboot: the installed versions are read under
 * the dpkg lock, non-blocking, so a package writer that is changing them makes this refuse instead of returning a stale approval.
 */
export async function readRebootState(c: Connection, opts: { lock?: boolean } = {}): Promise<RebootState> {
  const flag = await c.probe([...REBOOT_READ.rebootFlag]);
  const pkgs = flag.code === 0 ? await c.probe([...REBOOT_READ.rebootPkgs]) : undefined;
  const boot = (await c.exec([...REBOOT_READ.bootId], TIMEOUTS.read)).stdout.trim();
  const kernel = (await c.exec([...REBOOT_READ.kernel], TIMEOUTS.read)).stdout.trim();
  if (opts.lock) {
    const held = await c.probe([...HELD_LOCKS], TIMEOUTS.read);
    if (held.code !== 0) throw new Error(`lslocks did not complete (exit ${held.code}${held.stderr.trim() ? `: ${held.stderr.trim().split("\n")[0]}` : ""}), so whether a package manager is running is unknown`);
    if (aptBusy(held.stdout)) throw new RebootLocked("a package manager was writing to the host, so the reboot state could not be read");
  }
  const installed = opts.lock
    ? await c.probe([...DPKG_LOCK_NOWAIT, ...REBOOT_READ.installedVersions], TIMEOUTS.read)
    : await c.exec([...REBOOT_READ.installedVersions], TIMEOUTS.read);
  if (opts.lock && installed.code !== 0) {
    if (/flock: failed to get lock/i.test(installed.stderr)) throw new RebootLocked("a package manager was writing to the host, so the reboot state could not be read");
    throw new Error(`dpkg-query -W did not complete (exit ${installed.code}${installed.stderr.trim() ? `: ${installed.stderr.trim().split("\n")[0]}` : ""})`);
  }
  const versions = parseInstalledVersions(installed.stdout);
  const reboot_pkgs = (pkgs?.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean).map((name) => ({ name, version: versions.get(name) ?? "" }));
  return { boot_id: boot, kernel, kernel_awaiting: awaitingKernel(kernel, versions), reboot_pkgs, needed: flag.code === 0 };
}

/**
 * Whether a deferred reboot should be filed now (§6: "a reboot deferred to the quiet window's start" gets its own record). A machine
 * with a live consent — a reboot a patch needed and did not do inside the window — is filed once the window is open, unless that same
 * pending id has already been filed (a second file would be a second reboot for one approval). The consent is what bounds it: it expires after 12 h and is dropped on success, so this can
 * never refile forever for a reboot nobody wants.
 */
export function rebootDue(i: { quiet_start: string; quiet_end: string }, consent: Consent | undefined, at: Date, timeZone: string): string | undefined {
  if (!consent) return undefined;
  if (consent.filed === consent.pending) return undefined;
  // A consent past its 12 hours is dropped and reported by the sweep, never filed: the scheduler must not resurrect one it finds
  // expired after being offline, because planning a record would otherwise start a fresh clock for it.
  if (at.getTime() - Date.parse(consent.granted_at) > CONSENT_MS) return undefined;
  if (!inWindow(i.quiet_start, i.quiet_end, at, timeZone)) return undefined;
  return consent.pending;
}

/**
 * The one command a reboot runs: a fixed argv, never a caller's words. It takes the dpkg lock non-blocking around `systemctl`, so a
 * package writer that is still running when the reboot is issued makes the command refuse instead of rebooting a different state.
 */
export const REBOOT_ARGV = [...DPKG_LOCK_NOWAIT, "systemctl", "reboot"];

/**
 * Rebooting (§11.11-12): the window is rechecked at the moment of the reboot, not when the run started; the command is issued and
 * the boot ID is polled every 5 s for up to 900 s. Done only when the boot ID changed; SSH answering again is not proof, because a
 * host that never went down still answers.
 */
export async function rebootAndProve(c: Connection, i: { before: string; window: { start: string; end: string }; timeZone: string; at?: Date }): Promise<{ ok: true; boot_id_after: string } | { ok: false; reason: string; boot_id_after?: string }> {
  const at = i.at ?? new Date();
  if (!inWindow(i.window.start, i.window.end, at, i.timeZone)) return { ok: false, reason: `outside the quiet window ${i.window.start}–${i.window.end} (${i.timeZone}): the reboot waits for it` };
  // The host usually closes sshd before `systemctl reboot` returns, so the command itself may end with a dropped connection: that is
  // the reboot starting, not the reboot failing. Only a refused command (a host that will not accept `sudo`) is a real failure, and
  // the proof below is what decides either way. A `Connection` cannot tell its own refusal from a cut, so a failure here is kept and
  // reported only if the boot ID never changes.
  let issued: Error | undefined;
  const busy = { ok: false as const, reason: "a package manager held the dpkg lock when the reboot was due, so the host was not rebooted: run again once it is clear" };
  try {
    // A writer that started after the final read (apt's own fcntl lock, which flock cannot see): refuse now.
    const held = await c.probe([...HELD_LOCKS], TIMEOUTS.read);
    if (held.code === 0 && aptBusy(held.stdout)) return busy;
    const r = await c.probe([...REBOOT_ARGV], TIMEOUTS.read);
    // A writer that took the lock after the final read: refuse now, rather than poll for a reboot that never happened.
    if (r.code !== 0 && /flock: failed to get lock/i.test(r.stderr)) return busy;
    // A dropped connection (ssh's 255, the reboot starting) throws from `probe` and lands in the catch below. A returned non-zero
    // exit is the host refusing the command (sudo denied, systemctl failed): polling then could credit an unrelated reboot to this
    // run, so it fails now.
    if (r.code !== 0) return { ok: false, reason: `the reboot command was refused: exit ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]}` : ""}; nothing was rebooted` };
  } catch (e) {
    // A connection that drops as the host goes down is the reboot starting, not a failed reboot; the boot ID is the proof.
    issued = e as Error;
  }
  const deadline = Date.now() + TIMEOUTS.reboot;
  let after = "";
  // The connection may drop while the host goes down: a failed read is expected, and the loop retries until the bound.
  while (Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, 5_000));
    try { after = (await c.exec([...REBOOT_READ.bootId], TIMEOUTS.read)).stdout.trim(); } catch { continue; }
    if (after && after !== i.before) return { ok: true, boot_id_after: after };
  }
  return { ok: false, reason: `the boot ID did not change within ${Math.round(TIMEOUTS.reboot / 1000)} s (still ${after || i.before || "unknown"}): the reboot is not proven, so it is not done${issued ? ` (the reboot command answered: ${issued.message.slice(0, 200)})` : ""}`, ...(after ? { boot_id_after: after } : {}) };
}
