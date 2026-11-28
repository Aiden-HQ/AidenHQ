// One sanitized status row per server (spec §8), written at most once per run, after the run, and never waited on: the warehouse
// is not in the execution path. A publish that fails is logged and skipped — patching must keep working while the warehouse is
// down — and the row carries no key, no address, no user name and no package list.
//
// The read half also lives here: the fixed argument lists this module runs on a host to answer §5's four questions, and the pure
// function that turns one read pass into a row. Every command is a constant of this file; nothing a caller sends becomes argv.
import { classify, detect, parseAptConfig, parseHolds, parseOsRelease, parsePolicy, parseSimulatedUpgrade, readoutFrom, unattendedUpgrades, type Readout } from "./apt.ts";
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
  // `/` and `/boot` are separate probes: a host without its own `/boot` still answers for `/`, and `df`'s non-zero exit for the
  // missing path is an answer, not a failed check.
  diskRoot: ["df", "-Pk", "/"],
  diskBoot: ["df", "-Pk", "/boot"],
  bootId: ["cat", "/proc/sys/kernel/random/boot_id"],
  aptConfig: ["apt-config", "dump"],
  // The ESM-apps packages the suite test cannot see (§5); not on every host, so a missing tool is simply no answer.
  securityStatus: ["ubuntu-security-status", "--format", "json"],
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
  if (name === "HostKeyChanged") {
    // The presented key is carried as a field, not left to a regex over a truncated message: it is what §10's re-pin names.
    const seen = (e as { seen?: string }).seen;
    const detail = seen ? `the host presented ${seen}: nothing ran` : String((e as Error).message ?? e).slice(0, 300);
    return { state: "host-key-changed", detail };
  }
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
    // Free space is a nice-to-have, not a reason to fail a machine: most cloud images have no separate `/boot`, and `df` exits
    // non-zero for a path that does not exist. Each mount is probed on its own, and a mount the host did not answer stays null.
    const dfRoot = await c.probe([...READ.diskRoot]);
    const dfBoot = await c.probe([...READ.diskBoot]);
    const bootId = (await c.exec([...READ.bootId], TIMEOUTS.read)).stdout.trim();
    const reboot = await c.probe(["test", "-f", "/var/run/reboot-required"]);
    const rebootPkgs = await c.probe(["cat", "/var/run/reboot-required.pkgs"]);
    // The effective setting decides, not the unit's state: `apt-config dump` shows what APT will do after every drop-in and
    // override. `systemctl is-enabled` is only the fallback when the key is absent, and its exit status is read with its words:
    // enabled is exit 0, disabled/masked/not-found are non-zero answers, and an absent unit (empty stdout plus a "not found"
    // diagnostic) is off. A probe that failed for another reason stays unknown, never a false "on".
    const aptConfig = await c.exec([...READ.aptConfig], TIMEOUTS.read);
    const ua = await c.probe(["systemctl", "is-enabled", "unattended-upgrades"]);
    const uaState = unattendedUpgrades(parseAptConfig(aptConfig.stdout), ua);
    const securityStatus = await c.probe([...READ.securityStatus]);
    const disk = { root_free_gb: parseDf(dfRoot.stdout).root_free_gb, boot_free_gb: parseDf(dfBoot.stdout).boot_free_gb };
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
      unattendedUpgrades: uaState === "unknown" ? null : uaState === "on",
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
  bootId: string; rebootRequired: boolean; rebootPkgs: string; unattendedUpgrades: boolean | null; securityStatus?: string;
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

/** The fingerprint a failed read saw, when the failure was the host presenting a different key (§10): the page offers a re-pin
 *  only with a key the owner was actually shown, and never from an ssh message's text. */
export function fingerprintOf(checked: { state: string; detail: string }): string | null {
  if (checked.state !== "host-key-changed") return null;
  const m = /presented (SHA256:[A-Za-z0-9+/]{43})/.exec(checked.detail);
  return m ? m[1]! : null;
}

/** One machine's row, ready for the page's store and the warehouse: counts, disk and times, never a package list. */
export function rowOf(machine: Machine, checked: Checked, at: string): StatusRow {
  if (!checked.ok) {
    // A changed key's row keeps the fingerprint the host presented, which is what the page offers to re-pin (§10): without it the
    // recovery the owner is shown has nothing safe to name.
    const seen = fingerprintOf(checked);
    return { name: machine.name, distro: null, state: checked.state, pending: null, security: null, security_known: null, reboot_needed: null, disk: null, ...(seen ? { fingerprint: seen } : {}), updated_at: at };
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

/** The statement that retires machines the owner removed: every published row whose name is not in the saved list. */
export const retireSql = (schema: string) => `DELETE FROM ${schema}.server WHERE NOT (name = ANY($1::text[]))`;

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
    max(checked_at) AS updated_at,
    max(seq) AS seq,
    false AS baseline
  FROM src_servers.server;
COMMENT ON VIEW src_servers.fleet IS 'The whole fleet in one row: how many machines are listed, checked and failing, how many need a reboot, and the totals of security and other upgradable packages. updated_at = when the newest check ran; seq = the newest row it counted, so source_new can follow it like any other view.';
GRANT SELECT ON src_servers.servers, src_servers.fleet TO agents_open;`;

/** One row as the source table holds it; the readout's own parts are flattened so a change log line names one field. */
export function publishRow(machine: Machine, checked: Checked, at: string): Record<string, unknown> {
  // A failure publishes its controlled state and nothing else: the detail (an ssh message, a key's name, a connection detail) is
  // for the owner's own check response, never for a row every agent with the warehouse may read (§8).
  if (!checked.ok) return { name: machine.name, distro: null, family: null, state: checked.state, pending: null, security: null, security_known: null, reboot_needed: null, root_free_gb: null, boot_free_gb: null, boot_id: null, unattended_upgrades: null, security_note: null, checked_at: at };
  const r = checked.readout;
  return {
    name: machine.name, distro: r.distro, family: r.family, state: "ok", pending: r.upgradable.length, security: r.security.length,
    security_known: r.security_known, reboot_needed: r.reboot_needed, root_free_gb: r.disk.root_free_gb, boot_free_gb: r.disk.boot_free_gb,
    boot_id: r.boot_id, unattended_upgrades: r.unattended_upgrades, security_note: r.security_note, checked_at: at,
  };
}

/**
 * Creates the table and the two advertised views. Run at service start, not on a check: a fresh install with no machines still
 * has `src_servers.servers` and `src_servers.fleet`, empty, for a reader to query. A missing password (the warehouse module off) or
 * any error is logged once and skipped: the service works without the warehouse.
 */
export async function ensureSchema(log: (msg: string, f?: Record<string, unknown>) => void): Promise<void> {
  try {
    // Loaded lazily: pg is the container's dependency, and a test that imports this file's pure functions never needs it.
    const { SourceStore } = await import("./source-store.ts");
    const store = SourceStore.fromEnv("servers");
    if (!store) return log("no warehouse password yet (warehouse module or warehouse_src_servers_password missing); src_servers not created");
    await store.migrate(DDL);
  } catch (e) {
    log("src_servers schema setup failed; the service is unaffected", { err: String((e as Error).message ?? e).slice(0, 200) });
  }
}

/**
 * Publishes one run's rows (at most once per run, after it). `inventory` is every machine the settings list now: a row for a
 * machine the owner removed is deleted, so the aggregate never counts a retired machine. A missing password (the warehouse module
 * off) or any error is logged once and skipped: nothing in a run waits on this.
 */
export async function publish(rows: Record<string, unknown>[], inventory: string[], log: (msg: string, f?: Record<string, unknown>) => void): Promise<void> {
  if (!rows.length && !inventory.length) return;
  try {
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
      // Every row is keyed by machine name: one that is not in the saved list any more is gone from the fleet.
      await store.pool.query(retireSql(store.schema), [inventory]);
      return n;
    });
  } catch (e) {
    log("status publish failed; the run is unaffected", { err: String((e as Error).message ?? e).slice(0, 200) });
  }
}
