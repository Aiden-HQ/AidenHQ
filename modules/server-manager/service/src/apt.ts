// The one distro adapter (spec §5): Ubuntu LTS and Debian stable, and nothing else. One read pass answers four questions: what is
// upgradable, which of those are security updates, is a reboot needed, and which services are running. Every function here is
// read-only until `install` (slice 3), and every answer is parsed from text this file recorded, so the logic is tested on
// fixtures rather than a live host.
//
// A package is a security update when the *candidate's* suite ends `-security` (jammy-security, bookworm-security): apt's
// Origin is `Ubuntu` or `Debian` and never ends that way, so Origin is not the test. Cross-checked with
// `ubuntu-security-status --format json` where the host has it, which also reports ESM-apps packages the suite test can't see.
// Honest limit, said in every report: a fix backported into a normal archive is not flagged as security.

/** The families this build speaks. Anything else is `unsupported`, with no probing and no best-effort. */
export type Family = "ubuntu-lts" | "debian-stable";

export interface OsRelease {
  ID: string;
  VERSION_ID?: string;
  VERSION_CODENAME?: string;
  PRETTY_NAME?: string;
}

/** `os-release`'s KEY=value lines (`/etc/os-release`), unquoted. */
export function parseOsRelease(text: string): OsRelease {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1").trim();
  }
  return { ID: out.ID ?? "", VERSION_ID: out.VERSION_ID, VERSION_CODENAME: out.VERSION_CODENAME, PRETTY_NAME: out.PRETTY_NAME };
}

/** Debian's released stable codenames (a new stable adds its name here and its fixture; nothing else in the adapter changes). */
const DEBIAN_STABLE = new Set(["bookworm", "trixie", "forky"]);

/**
 * Which family a host is, and why not when it is none: Ubuntu must be an even-year `.04` LTS (24.04, not 24.10), Debian must be a
 * released stable by codename (`VERSION_ID` alone also says `12`, which is what a stable names today, so the codename decides).
 */
export function detect(os: OsRelease): { family: Family } | { unsupported: string } {
  if (os.ID === "ubuntu") {
    const v = os.VERSION_ID ?? "";
    return /^\d+\.04$/.test(v) && Number(v.split(".")[0]) % 2 === 0
      ? { family: "ubuntu-lts" }
      : { unsupported: `Ubuntu ${v || "of no known version"}: only LTS releases (an even-year .04) are supported` };
  }
  if (os.ID === "debian") {
    const c = (os.VERSION_CODENAME ?? "").toLowerCase();
    return DEBIAN_STABLE.has(c)
      ? { family: "debian-stable" }
      : { unsupported: `Debian ${c || os.VERSION_ID || "of no known version"}: only a released stable is supported` };
  }
  return { unsupported: `${os.PRETTY_NAME || os.ID || "this host"}: only Ubuntu LTS and Debian stable are supported` };
}

/** One upgradable package, with the version apt would install and (when known) the suite that version comes from. */
export interface Upgradable {
  name: string;
  version: string;
  suite: string;
}

/**
 * `apt-cache policy` as one record per package: its candidate version and the suites of its candidate entries.
 *
 * ```
 * libc6:
 *   Installed: 2.35-0ubuntu3.8
 *   Candidate: 2.35-0ubuntu3.9
 *   Version table:
 *  *** 2.35-0ubuntu3.8 500
 *         500 http://archive.ubuntu.com/ubuntu jammy/main amd64 Packages
 *             100 /var/lib/dpkg/status
 *      2.35-0ubuntu3.9 500
 *         500 http://security.ubuntu.com/ubuntu jammy-security/main amd64 Packages
 * ```
 */
export function parsePolicy(text: string): Map<string, { installed?: string; candidate?: string; suites: string[] }> {
  const out = new Map<string, { installed?: string; candidate?: string; versions: Map<string, string[]> }>();
  let pkg: { installed?: string; candidate?: string; versions: Map<string, string[]> } | undefined;
  let version: string | undefined;
  for (const raw of text.split("\n")) {
    // A package header: `libc6:` and, for a foreign architecture, `libc6:i386:`. It is matched before the version line below,
    // because `libc6:i386:` would otherwise read as a version. The qualifier is kept, so the name is the package apt knows.
    const head = /^([A-Za-z0-9][A-Za-z0-9+._-]*(?::[a-z0-9][a-z0-9-]*)?):\s*$/.exec(raw);
    if (head) { pkg = { versions: new Map() }; version = undefined; out.set(head[1]!, pkg); continue; }
    if (!pkg) continue;
    const inst = /^\s+Installed:\s*(\S+)/.exec(raw);
    if (inst) { pkg.installed = inst[1]; continue; }
    const cand = /^\s+Candidate:\s*(\S+)/.exec(raw);
    if (cand) { pkg.candidate = cand[1]; continue; }
    // A version line: ` *** 2.39-0ubuntu8.3 500` or `     2.39-0ubuntu8.5 500`. The `***` marks the installed one.
    const v = /^\s+(?:\*\*\*\s+)?(\S+)\s+\d+\s*$/.exec(raw);
    if (v) { version = v[1]; if (!pkg.versions.has(version)) pkg.versions.set(version, []); continue; }
    // A release line under a version: `     500 http://…/ubuntu noble-security/main amd64 Packages`.
    const r = /^\s+\d+\s+\S+\s+([a-z][a-z0-9-]*)\/[a-z0-9-]+\s+\S+\s+Packages/.exec(raw);
    if (r && version) pkg.versions.get(version)!.push(r[1]!);
  }
  // The candidate's own suites are the ones that count: an older version's security suite must not mark a normal-archive candidate.
  return new Map([...out].map(([name, p]) => [name, { installed: p.installed, candidate: p.candidate, suites: [...(p.versions.get(p.candidate ?? "") ?? [])] }]));
}

/** `apt-get -s upgrade` / `apt list --upgradable` as `name version` pairs. */
export function parseSimulatedUpgrade(text: string): Upgradable[] {
  const out: Upgradable[] = [];
  for (const line of text.split("\n")) {
    const m = /^Inst (\S+) (?:\[[^\]]*\] )?\((\S+)/.exec(line.trim());
    if (m) out.push({ name: m[1]!, version: m[2]!.replace(/,$/, ""), suite: "" });
  }
  return out;
}

/** `ubuntu-security-status --format json`: ESM-apps packages the suite test cannot see. */
export function parseSecurityStatus(text: string): { esm_apps: string[]; total: number } | undefined {
  /** One package entry, in any of the shapes the Ubuntu tools print. */
  type Pkg = { name?: string; package?: string; is_esm_app?: boolean; service_name?: string };
  try {
    // Three shapes, all read: the Ubuntu Pro client's `packages` list (`package`, `service_name: "esm-apps"`), the older
    // `packages_detail` list (`name`, `is_esm_app`), and a list written as `packages` in that second shape. Anything else is
    // "no answer", never a crash inside a read.
    const v = JSON.parse(text) as { packages?: unknown; packages_detail?: unknown; summary?: { packages?: { security?: number } } };
    const list: Pkg[] = [v.packages, v.packages_detail].flatMap((x) => (Array.isArray(x) ? (x as Pkg[]) : []));
    const name = (p: Pkg) => p?.package ?? p?.name;
    const esm = list.flatMap((p) => {
      const n = name(p);
      const isEsm = p?.is_esm_app === true || p?.service_name === "esm-apps" || p?.service_name === "esm-infra";
      return isEsm && n ? [n] : [];
    });
    return { esm_apps: esm, total: Number(v.summary?.packages?.security ?? esm.length) };
  } catch {
    return undefined;
  }
}

/** `/var/run/reboot-required`, and the packages that asked for it (its `.pkgs` companion), if the host wrote one. */
export function parseRebootRequired(exists: boolean, pkgsText?: string): boolean {
  return exists || !!pkgsText?.trim();
}

/** `systemctl list-units --type=service --state=running --no-legend --plain`: the running units, sorted, unit name only. */
export function parseUnits(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\S+\.service)\s+\S+\s+\S+\s+\S+/.exec(line);
    if (m) out.add(m[1]!);
  }
  return [...out].sort();
}

/** `apt-mark showhold`: packages the owner pinned; never upgraded, and named in the report. */
export function parseHolds(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).sort();
}

/** `apt-config dump` as key -> value (`APT::Periodic::Unattended-Upgrade "1";` is `1`). First listing of a key wins. */
export function parseAptConfig(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9_:/-]+)\s+"([^"]*)";\s*$/.exec(line.trim());
    if (m && !out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * Whether unattended upgrades are actually on. The effective APT setting decides: an owner who sets
 * `APT::Periodic::Unattended-Upgrade "0"` has turned it off even while the unit is enabled and `20auto-upgrades` is still there.
 * The unit's state is only the fallback for a host whose `apt-config dump` does not carry the key.
 */
export function unattendedUpgradesOn(config: Map<string, string>, unitState = ""): boolean {
  const v = config.get("APT::Periodic::Unattended-Upgrade");
  if (v !== undefined) return Number(v) > 0;
  return !/^disabled|^masked|^not-found/i.test(unitState.trim());
}

/** What one read pass saw, as the report and the status row use it. */
export interface Readout {
  family: Family;
  distro: string;
  upgradable: Upgradable[];
  security: string[];
  security_known: boolean;
  reboot_needed: boolean;
  services: string[];
  holds: string[];
  disk: { root_free_gb: number | null; boot_free_gb: number | null };
  boot_id: string;
  unattended_upgrades: boolean;
  /** The one honest limit, said once: backported fixes in a normal archive are not flagged as security. */
  security_note: string;
}

/** Is this package's candidate from a security suite: any suite ending `-security`, or `stable-security`. */
export const isSecuritySuite = (suite: string) => /(^|-)(security)$/.test(suite.trim().toLowerCase());

/**
 * From the policy table: the upgradable set (installed != candidate), and which of them are security. `planned` is the set
 * `apt-get -s upgrade` said it would upgrade (`name -> version`): apt decides *what* is upgradable and held back, and the policy
 * table decides only *where the candidate comes from*. Without `planned` the whole table is read, for a fixture of one package.
 */
export function classify(policy: Map<string, { installed?: string; candidate?: string; suites: string[] }>, holds: string[], esm: string[] = [], planned?: Map<string, string>): { upgradable: Upgradable[]; security: string[] } {
  const upgradable: Upgradable[] = [];
  const security: string[] = [];
  for (const [name, p] of policy) {
    if (!p.candidate || p.candidate === "(none)" || p.installed === p.candidate) continue;
    if (holds.includes(name)) continue;
    // With a planned set, a package apt would not upgrade (held, or pinned back) is not in this run's set at all.
    if (planned && planned.get(name) !== p.candidate) continue;
    const suite = p.suites.find(isSecuritySuite) ?? "";
    upgradable.push({ name, version: p.candidate, suite });
    if (suite || esm.includes(name)) security.push(name);
  }
  upgradable.sort((a, b) => a.name.localeCompare(b.name));
  security.sort();
  return { upgradable, security };
}

/** The readout built from one recorded read pass (the fixtures are exactly these inputs). */
export function readoutFrom(i: { os: OsRelease; policy: string; simulated?: string; rebootRequired: boolean; units: string; holds?: string; securityStatus?: string; freeRootGb: number | null; freeBootGb: number | null; bootId: string; unattendedUpgrades: boolean }): Readout | { unsupported: string } {
  const d = detect(i.os);
  if ("unsupported" in d) return d;
  const holds = parseHolds(i.holds ?? "");
  const status = i.securityStatus ? parseSecurityStatus(i.securityStatus) : undefined;
  // `apt-get -s upgrade` says what apt would upgrade; the policy table (queried for those names) says where each candidate comes
  // from. Bare `apt-cache policy` prints pin priorities and no packages, so the policy read alone can never say what is pending.
  const planned = i.simulated === undefined ? undefined : new Map(parseSimulatedUpgrade(i.simulated).map((p) => [p.name, p.version]));
  const { upgradable, security } = classify(parsePolicy(i.policy), holds, status?.esm_apps ?? [], planned);
  return {
    family: d.family,
    distro: i.os.PRETTY_NAME?.split(" ").slice(0, 2).join(" ") || d.family,
    upgradable,
    security,
    security_known: true,
    reboot_needed: parseRebootRequired(i.rebootRequired),
    services: parseUnits(i.units),
    holds,
    disk: { root_free_gb: i.freeRootGb, boot_free_gb: i.freeBootGb },
    boot_id: i.bootId,
    unattended_upgrades: i.unattendedUpgrades,
    security_note: "a fix backported into a normal archive is not counted as a security update",
  };
}
