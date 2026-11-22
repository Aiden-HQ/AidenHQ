// A job's branch as its box handed it over: a git bundle the in-box `aidenhq publish|review|apply` wrote at
// <workspace>/.aidenhq/bundles/<sha>.bundle. Both code hosts read it the one way: that one file, opened without following a
// symlink, resolved after opening to a regular file inside that task's folder, copied whole into the reader's own scratch.
// Host git and host fs writes never run in a workspace a box can write; git then reads only the copy.
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, readlinkSync, realpathSync, writeSync } from "node:fs";
import { join, sep } from "node:path";

/** Where the in-box `aidenhq` leaves a branch's bundle, relative to the task's workspace. */
export const bundlePath = (sha: string) => `.aidenhq/bundles/${sha}.bundle`;
/** The one ref a bundle carries, named by the sha alone so no branch decides it; hosts fetch it into the branch they push. The in-box `aidenhq` (plain node) writes the same literal. */
export const publishRef = (sha: string) => `refs/aidenhq/publish/${sha}`;
const MAX_BUNDLE = 1 << 30;
const IDENT = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const SHA = /^[0-9a-f]{40}$/;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/**
 * Copies task `ident`'s bundle of `sha` to `<scratch>/branch.bundle` (made exclusively) and returns that path. `what` names it in
 * refusals (e.g. "acme/x `fix`"). 404: no bundle; 400: a symlink, not a regular file, or outside the task; 413: too large.
 */
export function copyBoxBundle(tasksDir: string, scratch: string, ident: string, sha: string, what: string): string {
  if (!IDENT.test(String(ident))) throw fail(400, `${ident} is not a task's workspace`);
  if (!SHA.test(String(sha))) throw fail(400, "sha is a full commit sha");
  const task = join(realpathSync(tasksDir), ident);
  const inside = (p: string) => p.startsWith(task + sep);
  const at = join(task, bundlePath(sha));
  let fd: number;
  try { fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if ((e as { code?: string }).code === "ELOOP") throw fail(400, `the bundle of ${what} is a symlink; refusing it`);
    throw fail(404, `task ${ident} has no bundle of ${what} at ${sha.slice(0, 12)} (publish it with aidenhq)`);
  }
  const copy = join(scratch, "branch.bundle");
  try {
    // What was opened, not what the path says now: /proc's link where there is one.
    const opened = existsSync(`/proc/self/fd/${fd}`) ? readlinkSync(`/proc/self/fd/${fd}`) : realpathSync(at);
    const st = fstatSync(fd);
    if (!inside(opened) || !inside(realpathSync(at)) || !st.isFile() || st.size > MAX_BUNDLE) throw fail(400, `the bundle of ${what} isn't a regular file inside task ${ident}`);
    const out = openSync(copy, "wx", 0o600), buf = Buffer.alloc(1 << 20);
    try { for (let n, total = 0; (n = readSync(fd, buf)) > 0; ) { if ((total += n) > MAX_BUNDLE) throw fail(413, "the bundle is too large"); writeSync(out, buf, 0, n); } } finally { closeSync(out); }
  } finally {
    closeSync(fd);
  }
  return copy;
}
