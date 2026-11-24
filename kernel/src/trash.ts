// Removing a folder off the event loop: it is renamed out of the way in one synchronous step (so its path is free at once and
// nothing can be admitted into it), then removed asynchronously. A trash folder sits beside what it takes, on the same
// filesystem; one a crash left behind is emptied by the disk sweep (workspaces.ts), which removes every root's .trash.
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Removes a tree off the event loop: chmod first (read-only Go module caches, an overlay's mode-000 work dir), then rm. */
export async function removeTree(dir: string) {
  await execFileP("chmod", ["-R", "u+rwx", dir]).catch(() => {});
  await rm(dir, { recursive: true, force: true, maxRetries: 2 });
}

/** What a trash folder holds now (an earlier removal a restart or an error cut short) is removed in the background. */
export function emptyTrash(trash: string, log: (msg: string, f?: Record<string, unknown>) => void = () => {}) {
  let names: string[] = [];
  try { names = readdirSync(trash); } catch { return; }
  for (const n of names) void removeTree(join(trash, n)).catch((e: Error) => log("trash not removed", { trash, err: e.message }));
}

/**
 * `path` renamed into `trash` now and removed in the background (a removal error goes to `log`). A path that isn't there is
 * nothing to do; any other rename error throws, so the caller never reuses a path that is still full.
 */
export function trashAway(path: string, trash: string, log: (msg: string, f?: Record<string, unknown>) => void = () => {}) {
  const to = join(trash, `${basename(path)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    mkdirSync(trash, { recursive: true });
    renameSync(path, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  void removeTree(to).catch((e: Error) => log("trash not removed", { trash: to, err: e.message }));
}
