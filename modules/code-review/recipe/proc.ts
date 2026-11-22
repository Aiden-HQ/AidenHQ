// Shared by review.ts, the engines (engines.ts) and deepsec (deepsec.ts): a child process to its end, and a repo file read safely.
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A child process to its end (killed at `minutes`): exit code, stdout, the tail of stderr. */
export async function run(cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; minutes?: string | number; input?: string }) {
  const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {}); // a child that exits without reading its input
  child.stdin.end(o.input); // none: closed at once, as /dev/null would be
  let stdout = "", stderr = "", timedOut = false;
  // Decoded as streams, so a character split across chunks arrives whole.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => (stdout += d));
  child.stderr.on("data", (d: string) => { stderr += d; if (stderr.length > 1e6) stderr = stderr.slice(-5e5); });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Number(o.minutes ?? 20) * 60_000);
  const code = await new Promise<number | null>((ok) => { child.on("close", ok); child.on("error", () => ok(null)); });
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}
export const stopped = (r: { code: number | null; stderr: string; timedOut: boolean }, said = "") =>
  r.timedOut ? "timed out" : /\b402\b|cap_reached/i.test(said + r.stderr) ? "the install's spend limit was reached" : `the engine stopped (exit ${r.code})`;

/** A small regular file, never through a link; undefined otherwise. */
export function readSmall(file: string, max = 20_000) {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return undefined; }
  try { const st = fstatSync(fd); return st.isFile() ? readFileSync(fd, "utf8").slice(0, max) : undefined; } finally { closeSync(fd); }
}
/** Whether `rel` under `root` resolves without a link at any step (a tree may hold one pointing out of it). */
export const plain = (root: string, rel: string) => {
  let at = root;
  for (const part of rel.split("/")) { at = join(at, part); const st = lstatSync(at, { throwIfNoEntry: false }); if (!st || st.isSymbolicLink()) return false; }
  return true;
};
