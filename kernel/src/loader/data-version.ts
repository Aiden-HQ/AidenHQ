// A module's data_version (spec §6.4.1): code never starts on data newer than it. Each module with a data dir declares an
// integer data_version (default 0) and migrates its own data forward only; the loader keeps the version the data was last
// started with in data/modules/<module>/.data_version, inside the dir, so a snapshot restore brings the marker back with it.
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MARKER = ".data_version";

/**
 * Refuses (throws) when the data's marker is newer than the declared version; otherwise, with `write`, records the declared
 * version (the real compile, before compose starts the module). The staged compile only checks. The marker is never followed
 * as a symlink: it is replaced by a rename, and anything but a regular file holding an integer refuses.
 */
export function checkDataVersion(module: string, declared: number, dataDir: string, write = true): void {
  const file = join(dataDir, MARKER);
  let marker: number | undefined;
  try {
    if (!lstatSync(file).isFile()) throw new Error(`${module}: ${file} is not a regular file`);
    const text = readFileSync(file, "utf8");
    if (!/^\d+\n?$/.test(text)) throw new Error(`${module}: ${file} does not hold a data_version`);
    marker = Number(text);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (marker !== undefined && marker > declared) throw new Error(`${module}: data_version ${declared} is older than its data (${marker})`);
  if (write && marker !== declared) {
    writeFileSync(`${file}.tmp`, `${declared}\n`);
    renameSync(`${file}.tmp`, file);
  }
}
