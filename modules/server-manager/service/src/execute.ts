// A patch inside its record (spec §6, §11): revalidate into an exact `name=version` list, prove it with a simulation, then install
// it non-interactively with the services and the boot ID read around it. Every rule §11 lists is here, in its order, and every
// argument list is a constant of this module (apt.ts): nothing a request wrote reaches a host.
//
// The rules the caller must be able to see are pure functions (the ones the fixtures test); `runPatch` is the one that opens a
// connection and does the work. Nothing here ever returns, logs or records key material.
import {
  classify, detect, parseAptConfig, parseHolds, parseOsRelease, parsePolicy, parseSecurityStatus, parseSimulatedUpgrade, parseUnits, unattendedUpgradesOn,
  type Family, type Readout,
} from "./apt.ts";
import {
  downloadEstimate, exactList, diskVerdict, estimateCommand, installCommand, listHash, parseSimulation, releaseJumps, SIMULATE_UPGRADE,
  simulationProblems, UPDATE_ARGV, word, type Planned,
} from "./apt.ts";
import { parseDf, READ, stateOfError } from "./status.ts";
import { TIMEOUTS, type Connection } from "./ssh.ts";
import type { Machine } from "./config.ts";

/** What a patch record says, and what `execute` re-derives (§6): the machine, the mode, the policy and the pinned set. */
export interface PatchArgs {
  machine: string;
  mode: "security" | "full";
  reboot_policy: "auto" | "ask";
  fingerprint: string;
  packages: string[];
  hash: string;
}

/**
 * What a run when the host's state no longer matches the record: the record's hash is compared with the host's as it is now, and a
 * mismatch never runs the old list (§11.1). The kernel re-files a new record from the fresh list.
 */
export class StalePatch extends Error {
  readonly code = "stale_patch";
  readonly machine: string;
  readonly expected: string;
  readonly actual: string;
  readonly packages: string[];
  constructor(machine: string, expected: string, actual: string, packages: string[]) {
    super(`${machine}: the package set changed since the record was filed (filed ${expected.slice(0, 12)}…, now ${actual.slice(0, 12)}…): nothing was installed`);
    this.name = "StalePatch";
    this.machine = machine;
    this.expected = expected;
    this.actual = actual;
    this.packages = packages;
  }
}

/** A refusal a run decides before touching a host, or the reason it stops: worded for the record's outcome and the page. */
export class PatchRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PatchRefused";
    this.code = code;
  }
}

/** The services a run saw before and after, and which of them are not back: §11.7 (never restarted) and §11.8 (start moved). */
export interface ServiceChange {
  stopped: string[];
  restarted: string[];
}

/** `systemctl show -p ActiveEnterTimestamp --value <unit>`: when the unit last started, as the host spelled it (or empty). */
export const START_TIME = (unit: string) => ["systemctl", "show", "-p", "ActiveEnterTimestamp", "--value", unit];

/** A unit's start time as a comparable number (seconds), or null when systemd has none (`n/a`, empty). */
export function startSeconds(text: string): number | null {
  const t = Date.parse(text.trim());
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * §11.7-8, from the running units and their start times before and after: a unit that ran and does not now is `stopped` (flagged,
 * never restarted); one that still runs but whose start moved was restarted by a maintainer script, and is named.
 */
export function serviceChange(before: { units: string[]; starts: Map<string, number | null> }, after: { units: string[]; starts: Map<string, number | null> }): ServiceChange {
  const now = new Set(after.units);
  const stopped = before.units.filter((u) => !now.has(u)).sort();
  const restarted = before.units
    .filter((u) => now.has(u))
    .filter((u) => { const a = before.starts.get(u) ?? null, b = after.starts.get(u) ?? null; return a != null && b != null && b > a; })
    .sort();
  return { stopped, restarted };
}

/** What one patch run did, as the record's outcome carries it (§6): the changed packages and services before/after. */
export interface PatchOutcome {
  ok: boolean;
  machine: string;
  mode: "security" | "full";
  fingerprint: string;
  hash: string;
  installed: Planned[];
  held: string[];
  before: string[];
  after: string[];
  stopped: string[];
  restarted: string[];
  boot_id_before: string;
  boot_id_after: string;
  reboot_needed: boolean;
  unattended_upgrades: boolean;
  disk: { root_free_gb: number | null; boot_free_gb: number | null };
  needed_gb: number;
  detail?: string;
  /** What the run refused to do and why (a release jump, a broken dpkg state, a plan the simulation did not match). */
  refused?: string;
}

/** The exact list from a readout (§5's answer names the upgradable set and which are security), as `name=version`. */
export function planFrom(readout: Readout, mode: "security" | "full"): Planned[] {
  return exactList(readout.upgradable, readout.security, mode);
}

/** A record's hash over the words the record names: what `execute` recomputes and compares. */
export const hashOf = (list: Planned[]) => listHash(list.map(word));

/**
 * §11.4: a broken dpkg state is not patched over. `dpkg --audit` names packages left half-configured; an empty answer is a clean
 * state. A non-empty one stops the run and reports it for the owner to decide: this run never repairs the state on its own, and
 * builds no argument list that would.
 */
export const DPKG_AUDIT = ["dpkg", "--audit"];

/** The policy table's installed versions, for §11.6's release guard. */
export function installedFrom(policy: Map<string, { installed?: string; candidate?: string; suites: string[] }>): Map<string, string | undefined> {
  return new Map([...policy].map(([name, p]) => [name, p.installed]));
}

/**
 * The revalidation (§11.1) as one read: `apt-get update`, then the upgradable set again, with versions, and the security subset.
 * Pure over its inputs so the fixture tests assert the recomputed list and its hash.
 */
export function revalidate(i: { os: string; policy: string; simulated: string; holds?: string; units?: string; bootId?: string; rebootRequired?: boolean; freeRootGb?: number | null; freeBootGb?: number | null; unattendedUpgrades?: boolean; securityStatus?: string }, mode: "security" | "full"): { family: Family } | { unsupported: string } | { readout: Readout; list: Planned[]; hash: string } {
  const d = detect(parseOsRelease(i.os));
  if ("unsupported" in d) return d;
  const holds = parseHolds(i.holds ?? "");
  const sim = i.simulated ?? "";
  // The plan's set is what the simulation says apt would upgrade, read again against the policy table so the version is the
  // candidate apt would install. The space is a separate read: the simulation prints no `Need to get` line on a real host.
  const planned = new Map(parseSimulatedUpgrade(sim).map((p) => [p.name, p.version]));
  // `ubuntu-security-status` names ESM-apps packages whose candidate is not on a `-security` suite; the read path counts them, so the
  // revalidation must too, or a security plan would omit a package the page showed as a security update (§5, §11.1).
  const esm = i.securityStatus ? (parseSecurityStatus(i.securityStatus)?.esm_apps ?? []) : [];
  const { upgradable, security } = classify(parsePolicy(i.policy), holds, esm, planned);
  const list = exactList(upgradable, security, mode);
  return {
    readout: { family: d.family, distro: "", upgradable, security, security_known: true, reboot_needed: !!i.rebootRequired, services: parseUnits(i.units ?? ""), holds, disk: { root_free_gb: i.freeRootGb ?? null, boot_free_gb: i.freeBootGb ?? null }, boot_id: i.bootId ?? "", unattended_upgrades: i.unattendedUpgrades ?? false, security_note: "" },
    list,
    hash: hashOf(list),
  };
}

/**
 * Every §11 gate a patch passes, in order, as one verdict the executor and its tests both read: the record's hash, the simulated
 * plan, the release guard, the disk, the broken state. `list` is the freshly recomputed set, so a caller records or reports it.
 */
export function verifyPatch(rec: PatchArgs, fresh: { list: Planned[]; hash: string; downloaded_bytes: number | null; disk: { root_free_gb: number | null; boot_free_gb: number | null }; simulation: string; installed: Map<string, string | undefined>; audit: string; holds: string[]; unattended_upgrades: boolean; reboot_needed: boolean }): { ok: true } | { ok: false; code: string; reason: string } | { stale: true } {
  // §11.1: what gets installed is what this last read showed. A different set is not the approved one.
  if (fresh.hash !== rec.hash) return { stale: true };
  if (fresh.list.length !== rec.packages.length || fresh.list.some((p, i) => word(p) !== rec.packages[i])) return { stale: true };
  // The simulation must show no package outside the list installed, removed or downgraded (§11.1).
  const outside = simulationProblems(parseSimulation(fresh.simulation), rec.packages);
  if (outside.length) return { ok: false, code: "plan_mismatch", reason: `the plan is not what the record said: ${outside.slice(0, 5).join("; ")}${outside.length > 5 ? ` (and ${outside.length - 5} more)` : ""}. Nothing was installed.` };
  // §11.3: disk first, both places — measured on the estimate for *this exact list*, never the wider inventory. A host whose
  // simulation printed no estimate is refused rather than judged against the 1 GB floor, because the space this run needs is then
  // unknown, and guessing low is what a full `/boot` turns into a machine that does not come back.
  if (fresh.downloaded_bytes == null) return { ok: false, code: "disk_unknown", reason: "apt printed no download estimate for this exact list, so the space the run needs is unknown: nothing was installed rather than guess it" };
  const disk = diskVerdict(fresh.disk, fresh.downloaded_bytes);
  if (!disk.ok) return { ok: false, code: "low_disk", reason: disk.reason };
  // §11.4: a broken state is not patched over. `dpkg --audit` prints nothing on a clean host.
  if (fresh.audit.trim()) return { ok: false, code: "dpkg_broken", reason: `dpkg reports an interrupted run (${fresh.audit.trim().split("\n").slice(0, 8).join("; ")}), which this run would patch over. Nothing was installed, and the run does not repair it: finish or roll back that state on the host, then run again.` };
  // §11.6: never a release upgrade.
  const jump = releaseJumps(fresh.list, fresh.installed);
  if (jump.length) return { ok: false, code: "release_jump", reason: `this would move the release, not patch it: ${jump.join(", ")}. Nothing was installed; a release upgrade is not this module's to do.` };
  return { ok: true };
}

/** A readout's text, for a report: the numbers a person checks, never a shell's page of output. */
export function describe(o: { installed: Planned[]; held: string[]; stopped: string[]; restarted: string[]; unattended_upgrades: boolean; disk: { root_free_gb: number | null; boot_free_gb: number | null } }): string {
  const parts = [`${o.installed.length} package${o.installed.length === 1 ? "" : "s"} installed`];
  if (o.stopped.length) parts.push(`STOPPED and not restarted: ${o.stopped.join(", ")}`);
  if (o.restarted.length) parts.push(`restarted by its maintainer script: ${o.restarted.join(", ")}`);
  if (o.held.length) parts.push(`held, not upgraded: ${o.held.join(", ")}`);
  if (o.unattended_upgrades) parts.push("unattended-upgrades is on, and was left to do its own work");
  return parts.join("; ");
}

/** Runs one approved patch on one machine, and closes the connection whatever happens (§4: one connection per run). */
export async function runPatch(c: Connection, machine: Machine, rec: PatchArgs): Promise<PatchOutcome> {
  const base: PatchOutcome = {
    ok: false, machine: machine.name, mode: rec.mode, fingerprint: rec.fingerprint, hash: rec.hash, installed: [], held: [], before: [], after: [], stopped: [], restarted: [],
    boot_id_before: "", boot_id_after: "", reboot_needed: false, unattended_upgrades: false, disk: { root_free_gb: null, boot_free_gb: null }, needed_gb: 1,
  };
  try {
    // §11.9: the lock's own wait (600 s), then the refresh — the SSH deadline outlasts both.
    await c.exec([...UPDATE_ARGV], TIMEOUTS.lock);
    const os = await c.exec([...READ.osRelease]);
    const simulated = await c.exec([...SIMULATE_UPGRADE]);
    const names = [...new Set(parseSimulatedUpgrade(simulated.stdout).map((p) => p.name))].sort();
    const policy = names.length ? await c.exec(["apt-cache", "policy", ...names]) : { code: 0, stdout: "", stderr: "" };
    const holds = await c.probe([...READ.holds]);
    const unitsBefore = await c.exec([...READ.units]);
    const dfRoot = await c.probe([...READ.diskRoot]);
    const dfBoot = await c.probe([...READ.diskBoot]);
    const bootBefore = (await c.exec([...READ.bootId])).stdout.trim();
    const aptConfig = await c.exec([...READ.aptConfig]);
    const ua = await c.probe(["systemctl", "is-enabled", "unattended-upgrades"]);
    const rebootBefore = await c.probe(["test", "-f", "/var/run/reboot-required"]);
    const audit = await c.probe(["sudo", "-n", ...DPKG_AUDIT]);
    const secStatus = await c.probe([...READ.securityStatus]);
    const fresh = revalidate({
      os: os.stdout, policy: policy.stdout, simulated: simulated.stdout, holds: holds.code === 0 ? holds.stdout : "",
      units: unitsBefore.stdout, bootId: bootBefore, rebootRequired: rebootBefore.code === 0,
      freeRootGb: parseDf(dfRoot.stdout).root_free_gb, freeBootGb: parseDf(dfBoot.stdout).boot_free_gb,
      unattendedUpgrades: unattendedUpgradesOn(parseAptConfig(aptConfig.stdout), ua.stdout),
      securityStatus: secStatus.code === 0 ? secStatus.stdout : undefined,
    }, rec.mode);
    if ("unsupported" in fresh) return { ...base, detail: fresh.unsupported, refused: "unsupported" };
    // §11.1: what gets installed is what this last read showed. The hash is compared before anything runs, so a set that moved since
    // the record was filed stops here — and a new record is filed for what this read showed, never the approved one.
    if (fresh.hash !== rec.hash || fresh.list.length !== rec.packages.length || fresh.list.some((p, i) => word(p) !== rec.packages[i])) {
      throw new StalePatch(machine.name, rec.hash, fresh.hash, fresh.list.map(word));
    }
    // Nothing to do: the set is empty (a revalidation that found every package already current). A record is still reported.
    if (!fresh.list.length) return { ...base, ok: true, detail: "nothing to install: the last read found no upgrade left for this mode", held: fresh.readout.holds };
    // The same call, simulated, with the identical list (§11.1). It runs the whole list the record names, so its own summary is what
    // proves the plan is exactly the change — the inventory simulation above is every upgradable package, which is a wider set than a
    // security-only record, and reading it here would refuse every security patch for the packages it correctly left out.
    const exact = await c.exec(installCommand(rec.packages, true), TIMEOUTS.lock);
    // The space this run needs, from the same words with `--print-uris` instead of `-s` (§11.3): a simulation prints no `Need to get`
    // line, so reading the estimate off it refused every patch as `disk_unknown`. It takes no lock and is not waited out: it only
    // reads (the one call with the plain SSH read bound, 120 s), so it can never queue behind the very install this run is proving.
    const estimate = await c.exec(estimateCommand(rec.packages));
    const downloaded = downloadEstimate(estimate.stdout);
    const verdict = verifyPatch(rec, {
      // One estimate for the verdict and the reported need: the exact list's own `Need to get`, from `--print-uris`.
      list: fresh.list, hash: fresh.hash, downloaded_bytes: downloaded, disk: fresh.readout.disk, simulation: exact.stdout,
      installed: installedFrom(parsePolicy(policy.stdout)), audit: audit.code === 0 ? audit.stdout : "", holds: fresh.readout.holds,
      unattended_upgrades: fresh.readout.unattended_upgrades, reboot_needed: fresh.readout.reboot_needed,
    });
    Object.assign(base, { held: fresh.readout.holds, before: fresh.readout.services, boot_id_before: bootBefore, unattended_upgrades: fresh.readout.unattended_upgrades, disk: fresh.readout.disk, needed_gb: diskNeeded(downloaded ?? 0) });
    if ("stale" in verdict) throw new StalePatch(machine.name, rec.hash, fresh.hash, fresh.list.map(word));
    if (!verdict.ok) return { ...base, detail: verdict.reason, refused: verdict.code };
    // §11.10: when unattended-upgrades is the one that patches this host, the module stays out of its way. Refreshing and reading
    // does no harm, but installing would race it, so the run stops here and the report says why: the records already showed the
    // module does not disable it, and this is the other half of "coexist".
    // It is a clean outcome, not a failure: this is what §11.10 asks for, and waking the agent every hour to say the host looks
    // after itself would be noise.
    if (fresh.readout.unattended_upgrades) return { ...base, ok: true, unattended_upgrades: true, held: fresh.readout.holds, detail: `unattended-upgrades is on for this host, and it was left to do the work: this run installed nothing, so the two never race. Turn it off on the host if this module should patch it instead.` };
    // §11.7-8: the units that must not quietly stop are read with their start times *before* the install, so a maintainer script's
    // restart shows as a moved start afterwards. Reading both sides after the install would report "no change" for every restart.
    const beforeUnits = fresh.readout.services;
    const beforeStarts = await startTimes(c, beforeUnits);
    // §11.2 and §11.9: non-interactive, bounded, the lock waited out. The install's own timeout is the transport's 1500 s bound.
    await c.exec(installCommand(rec.packages), TIMEOUTS.install);
    // §11.7-8, and §11.11's boot ID.
    const unitsAfter = await c.exec([...READ.units]);
    const bootAfter = (await c.exec([...READ.bootId])).stdout.trim();
    const rebootAfter = await c.probe(["test", "-f", "/var/run/reboot-required"]);
    const before = serviceChange({ units: beforeUnits, starts: beforeStarts }, { units: parseUnits(unitsAfter.stdout), starts: await startTimes(c, parseUnits(unitsAfter.stdout)) });
    const installed = fresh.list.filter((p) => p.name);
    return {
      ...base, ok: true, installed, held: fresh.readout.holds, after: parseUnits(unitsAfter.stdout),
      stopped: before.stopped, restarted: before.restarted, boot_id_after: bootAfter, reboot_needed: rebootAfter.code === 0,
      detail: describe({ installed, held: fresh.readout.holds, stopped: before.stopped, restarted: before.restarted, unattended_upgrades: fresh.readout.unattended_upgrades, disk: fresh.readout.disk }),
    };
  } catch (e) {
    // §11.1: a set that moved is not a failed patch — the caller files a replacement record for what this last read showed, and only
    // it can (the kernel's re-plan ran before this run's refresh). It is rethrown as itself, never flattened into a refusal.
    if (e instanceof StalePatch) throw e;
    const { state, detail } = stateOfError(e);
    return { ...base, detail: (e as Error).message ? String((e as Error).message).slice(0, 500) : detail, refused: (e as { code?: string }).code ?? state };
  }
}

/** Each unit's start time, read one at a time (a unit that vanished answers nothing, and is not a failure). */
async function startTimes(c: Connection, units: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const u of units) {
    const r = await c.probe(START_TIME(u)).catch(() => undefined);
    out.set(u, r ? startSeconds(r.stdout) : null);
  }
  return out;
}

const diskNeeded = (bytes: number) => Math.max(1, (bytes / 1024 ** 3) * 2);

