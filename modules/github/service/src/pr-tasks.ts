// Opener provenance: which task (and branch) opened each PR the code host opened, in the cache dir's pr-tasks.json. The code host
// writes it as it executes a `pr` write; Flow, the merge queue, siblings and ship (through /internal/ship/openers) read it.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = (dir: string) => join(dir, "pr-tasks.json");
/** Every PR url (lower case) the code host opened, with the task and branch that opened it. */
export const readPrTasks = (cacheDir: string): Record<string, { task: string; branch: string; held?: boolean }> => (existsSync(file(cacheDir)) ? JSON.parse(readFileSync(file(cacheDir), "utf8")) : {});
/**
 * Remember the task (and branch) that opened a PR, and whether its `ship:stop` label is the publisher's hold (`held`: a publish
 * without `--hold` lifts only a hold, never a person's label; a record written without it keeps what it had). Written whole or not
 * at all: a kill mid-write leaves the old file.
 */
export function notePrTask(cacheDir: string, url: string, v: { task: string; branch: string; held?: boolean }) {
  const all = readPrTasks(cacheDir);
  writeFileSync(`${file(cacheDir)}.tmp`, JSON.stringify({ ...all, [url.toLowerCase()]: { ...all[url.toLowerCase()], ...v } }));
  renameSync(`${file(cacheDir)}.tmp`, file(cacheDir));
}
