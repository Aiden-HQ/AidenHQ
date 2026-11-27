// One sanitized status row per server (spec §8), written at most once per run, after the run, and never waited on: the warehouse
// is not in the execution path. A publish that fails is logged and skipped — patching must keep working while the warehouse is
// down — and the row carries no key, no address, no user name and no package list.
//
// The read half also lives here: the fixed argument lists this module runs on a host to answer §5's four questions, and the pure
// function that turns one read pass into a row. Every command is a constant of this file; nothing a caller sends becomes argv.
import { classify, detect, parseHolds, parseOsRelease, parsePolicy, parseSimulatedUpgrade, readoutFrom, type Readout } from "./apt.ts";
import type { Machine } from "./config.ts";
import type { StatusRow } from "./status-store.ts";
import { TIMEOUTS, type Connection } from "./ssh.ts";
import type { Table } from "./source-store.ts";

/**
 * The read pass (§5). `apt-get -s upgrade` decides what apt would upgrade and a held package is not in it; `apt-cache policy`
 * prints the sources only when it is asked about names, so it is asked about exactly those (`policyArgs`).
 */
export const READ = {
  osRelease: ["cat", "/etc/os-release"],
  simulatedUpgrade: ["apt-get", "-s", "upgrade"],
  holds: ["apt-mark", "showhold"],
  units: ["systemctl", "list-units", "--type=service", "--state=running", "--no-legend", "--plain"],
  disk: ["df", "-Pk", "/", "/boot"],
  bootId: ["cat", "/proc/sys/kernel/random/boot_id"],
} as const;

/** `df -Pk / /boot` as free space per mount (POSIX output: `Filesystem 1024-blocks Used Available Capacity Mounted on`). */
export function parseDf(text: string): { root_free_gb: number | null; boot_free_gb: number | null } {
  const out: { root_free_gb: number | null; boot_free_gb: number | null } = { root_free_gb: null, boot_free_gb: null };
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || f[0] === "Filesystem") continue;
    const avail = Number(f[3]);
    if (!Number.isFinite(avail)) continue;
    const gb = Math.round((avail / 1024 / 1024) * 100) / 100;
    if (f[5] === "/") out.root_free_gb = gb;
    else if (f[5] === "/boot") out.boot_free_gb = gb;
  }
  return out;
}

/** What one machine's read pass answered, or why it answered nothing. */
export type Checked =
  | { ok: true; readout: Readout; fingerprint?: string; first_pinned?: boolean }
  | { ok: false; state: string; detail: string };

const FAILED = "failed";

/** A failure's row state, from the transport's own words (the reason strings ssh.ts produces, never a shell's output). */
export function stateOfError(e: unknown): { state: string; detail: string } {
  const name = (e as { name?: string })?.name;
  if (name === "HostKeyChanged") return { state: "host-key-changed", detail: String((e as Error).message ?? e).slice(0, 300) };
  const msg = String((e as Error)?.message ?? e);
  if (/login refused/i.test(msg)) return { state: "login-refused", detail: msg.slice(0, 300) };
  if (/no-passwordless-sudo/i.test(msg)) return { state: "no-passwordless-sudo", detail: msg.slice(0, 300) };
  if (/unreachable|timed out|Connection/i.test(msg)) return { state: "unreachable", detail: msg.slice(0, 300) };
  return { state: FAILED, detail: msg.slice(0, 300) };
}

/**
 * The fixed read pass for one machine (§5): os-release, the policy table, holds, running units, free space, the boot ID and
 * whether unattended-upgrades is on. Read-only, one connection, every value from this file's constant argument lists.
 */
export async function readHost(c: Connection, pin?: { fingerprint: string; firstPinned: boolean }): Promise<Checked> {
  try {
    // os-release first, and the family decided before any family-specific command runs: a Fedora host has no apt-cache, and
    // asking it would report `failed` where the honest answer is `unsupported` (§5: no probing, no best-effort).
    const os = await c.exec([...READ.osRelease], TIMEOUTS.read);
    const family = detect(parseOsRelease(os.stdout));
    if ("unsupported" in family) return { ok: false, state: "unsupported", detail: family.unsupported };
    const simulated = await c.exec([...READ.simulatedUpgrade], TIMEOUTS.read);
    // `apt-cache policy <name>…`: package names are the only words added, each checked like every other word by `exec`.
    const names = [...new Set(parseSimulatedUpgrade(simulated.stdout).map((p) => p.name))].sort();
    const policy = names.length ? await c.exec(["apt-cache", "policy", ...names], TIMEOUTS.read) : { code: 0, stdout: "", stderr: "" };
    const holds = await c.probe([...READ.holds]);
    const units = await c.exec([...READ.units], TIMEOUTS.read);
    const df = await c.exec([...READ.disk], TIMEOUTS.read);
    const bootId = (await c.exec([...READ.bootId], TIMEOUTS.read)).stdout.trim();
    const reboot = await c.probe(["test", "-f", "/var/run/reboot-required"]);
    const rebootPkgs = await c.probe(["cat", "/var/run/reboot-required.pkgs"]);
    // `systemctl is-enabled` answers "enabled" with exit 0, "disabled"/"masked" with a non-zero code: both are answers.
    const ua = await c.probe(["systemctl", "is-enabled", "unattended-upgrades"]);
    const uaConf = await c.probe(["test", "-f", "/etc/apt/apt.conf.d/20auto-upgrades"]);
    const uaOn = ua.code === 0 ? !/^disabled|^masked|^not-found/i.test(ua.stdout.trim()) : uaConf.code === 0;
    const securityStatus = await c.probe(["ubuntu-security-status", "--format", "json"]);
    const disk = parseDf(df.stdout);
    const r = readoutFromChecked({
      os: os.stdout,
      policy: policy.stdout,
      simulated: simulated.stdout,
      holds: holds.code === 0 ? holds.stdout : "",
      units: units.stdout,
      freeRootGb: disk.root_free_gb,
      freeBootGb: disk.boot_free_gb,
      bootId,
      rebootRequired: reboot.code === 0,
      rebootPkgs: rebootPkgs.code === 0 ? rebootPkgs.stdout : "",
      unattendedUpgrades: uaOn,
      securityStatus: securityStatus.code === 0 ? securityStatus.stdout : undefined,
    });
    // §4: every run reports the fingerprint it used, so a pin that is not the one the owner expected is visible in the report.
    return r.ok ? { ...r, ...(pin ? { fingerprint: pin.fingerprint, first_pinned: pin.firstPinned } : {}) } : r;
  } catch (e) {
    const { state, detail } = stateOfError(e);
    return { ok: false, state, detail };
  }
}

/** The adapter's readout from the raw text of a read pass (the same inputs the fixtures record). */
function readoutFromChecked(i: {
  os: string; policy: string; simulated: string; holds: string; units: string; freeRootGb: number | null; freeBootGb: number | null;
  bootId: string; rebootRequired: boolean; rebootPkgs: string; unattendedUpgrades: boolean; securityStatus?: string;
}): Checked {
  const r = readoutFrom({
    os: parseOsRelease(i.os),
    policy: i.policy,
    simulated: i.simulated,
    holds: i.holds,
    units: i.units,
    rebootRequired: i.rebootRequired || !!i.rebootPkgs.trim(),
    freeRootGb: i.freeRootGb,
    freeBootGb: i.freeBootGb,
    bootId: i.bootId,
    unattendedUpgrades: i.unattendedUpgrades,
    securityStatus: i.securityStatus,
  });
  if ("unsupported" in r) return { ok: false, state: "unsupported", detail: r.unsupported };
  return { ok: true, readout: r };
}

/** One machine's row, ready for the page's store and the warehouse: counts, disk and times, never a package list. */
export function rowOf(machine: Machine, checked: Checked, at: string): StatusRow {
  if (!checked.ok) {
    return { name: machine.name, distro: null, state: checked.state, pending: null, security: null, security_known: null, reboot_needed: null, disk: null, updated_at: at };
  }
  const r = checked.readout;
  return {
    name: machine.name,
    distro: r.distro,
    state: "ok",
    pending: r.upgradable.length,
    security: r.security.length,
    security_known: r.security_known,
    reboot_needed: r.reboot_needed,
    disk: r.disk,
    updated_at: at,
  };
}

/** The published table: one row per machine, keyed by name (the one column a page or an agent may read). */
export const SERVERS: Table = {
  name: "server",
  key: ["name"],
  cols: {
    name: "text", distro: "text", family: "text", state: "text", pending: "integer", security: "integer", security_known: "boolean",
    reboot_needed: "boolean", root_free_gb: "real", boot_free_gb: "real", boot_id: "text", unattended_upgrades: "boolean",
    security_note: "text", checked_at: "timestamptz",
  },
  tracked: ["state", "pending", "security", "reboot_needed"],
};

export const DDL = `CREATE TABLE IF NOT EXISTS src_servers.server (
  name text PRIMARY KEY,
  distro text,
  family text,
  state text NOT NULL,
  pending integer,
  security integer,
  security_known boolean,
  reboot_needed boolean,
  root_free_gb real,
  boot_free_gb real,
  boot_id text,
  unattended_upgrades boolean,
  security_note text,
  checked_at timestamptz NOT NULL,
  baseline boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  seq bigint NOT NULL DEFAULT nextval('src_meta.seq')
);
CREATE INDEX IF NOT EXISTS server_seq ON src_servers.server (seq);
CREATE OR REPLACE VIEW src_servers.servers AS
  SELECT name, distro, family, state, pending, security, security_known, reboot_needed, root_free_gb, boot_free_gb,
    unattended_upgrades, security_note, checked_at, checked_at AS updated_at, baseline, first_seen_at, ingested_at, seq
  FROM src_servers.server;
COMMENT ON VIEW src_servers.servers IS 'One sanitized status row per machine this instance maintains: distro family, state, how many packages are upgradable and how many of those are security updates, whether a reboot is needed, free GB on / and /boot, and when it last checked. No address, user name, key or package list.';
CREATE OR REPLACE VIEW src_servers.fleet AS
  SELECT count(*)::integer AS servers,
    count(*) FILTER (WHERE state = 'ok')::integer AS checked,
    count(*) FILTER (WHERE state <> 'ok')::integer AS failing,
    count(*) FILTER (WHERE reboot_needed)::integer AS reboot_needed,
    coalesce(sum(security), 0)::integer AS security,
    coalesce(sum(pending), 0)::integer AS pending,
    max(checked_at) AS updated_at
  FROM src_servers.server;
COMMENT ON VIEW src_servers.fleet IS 'The whole fleet in one row: how many machines are listed, checked and failing, how many need a reboot, and the totals of security and other upgradable packages. updated_at = when the newest check ran.';
GRANT SELECT ON src_servers.servers, src_servers.fleet TO agents_open;`;

/** One row as the source table holds it; the readout's own parts are flattened so a change log line names one field. */
export function publishRow(machine: Machine, checked: Checked, at: string): Record<string, unknown> {
  if (!checked.ok) return { name: machine.name, distro: null, family: null, state: checked.state, pending: null, security: null, security_known: null, reboot_needed: null, root_free_gb: null, boot_free_gb: null, boot_id: null, unattended_upgrades: null, security_note: checked.detail, checked_at: at };
  const r = checked.readout;
  return {
    name: machine.name, distro: r.distro, family: r.family, state: "ok", pending: r.upgradable.length, security: r.security.length,
    security_known: r.security_known, reboot_needed: r.reboot_needed, root_free_gb: r.disk.root_free_gb, boot_free_gb: r.disk.boot_free_gb,
    boot_id: r.boot_id, unattended_upgrades: r.unattended_upgrades, security_note: r.security_note, checked_at: at,
  };
}

/**
 * Publishes one run's rows (at most once per run, after it). A missing password (the warehouse module off) or any error is
 * logged once and skipped: nothing in a run waits on this.
 */
export async function publish(rows: Record<string, unknown>[], log: (msg: string, f?: Record<string, unknown>) => void): Promise<void> {
  if (!rows.length) return;
  try {
    // Loaded lazily: pg is the container's dependency, and a test that imports this file's pure functions never needs it.
    const { SourceStore } = await import("./source-store.ts");
    const store = SourceStore.fromEnv("servers");
    if (!store) return log("no warehouse password yet (warehouse module or warehouse_src_servers_password missing); status not published");
    await store.migrate(DDL);
    await store.run("servers", "fleet", async () => {
      let n = 0;
      for (const row of rows) {
        await store.upsert(SERVERS, row, { baseline: false });
        n++;
      }
      return n;
    });
  } catch (e) {
    log("status publish failed; the run is unaffected", { err: String((e as Error).message ?? e).slice(0, 200) });
  }
}
