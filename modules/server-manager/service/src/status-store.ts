// The service's own state dir (SERVERS_STATE_DIR, a named volume at /data): the last readout per machine, the durable due-slot
// records and known_hosts/. Nothing secret lives here: a status row carries a machine's name, distro, counts, disk and times, never
// a key, an address, a user name or a package list (spec §8). The durable due-slot records (§12) and known_hosts/ land in later
// slices; this slice keeps the status store one file, rewritten atomically, and does not fetch over the network.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One machine's latest readout, as the status row and the page show it. */
export interface StatusRow {
  name: string;
  distro: string | null;
  /** `ok`, `unsupported`, `host-key-changed`, `unreachable`, `failed`, … (later slices set these; slice 1 has none yet). */
  state: string;
  pending: number | null;
  security: number | null;
  security_known: boolean | null;
  reboot_needed: boolean | null;
  disk: { root_free_gb: number | null; boot_free_gb: number | null } | null;
  updated_at: string | null;
}

export class StatusStore {
  private readonly file: string;
  private rows: Record<string, StatusRow> = {};
  constructor(dir: string) {
    this.file = dir.endsWith(".json") ? dir : `${dir.replace(/\/+$/, "")}/status.json`;
    mkdirSync(dirname(this.file), { recursive: true });
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) this.rows = v as Record<string, StatusRow>;
    } catch {
      this.rows = {};
    }
  }
  /** The rows, newest first by name (a stable order for tests). */
  all(): StatusRow[] {
    return Object.values(this.rows).sort((a, b) => a.name.localeCompare(b.name));
  }
  get(name: string): StatusRow | undefined {
    return this.rows[name];
  }
  /** Upsert one machine's readout and write the file atomically (a torn file would lose every other machine's row). */
  put(row: StatusRow): void {
    this.rows[row.name] = row;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.rows, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  remove(name: string): void {
    if (!(name in this.rows)) return;
    delete this.rows[name];
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.rows, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
