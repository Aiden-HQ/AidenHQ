// Shared by review.ts, the engines (engines.ts) and deepsec (deepsec.ts): a child process to its end, and a repo file read safely.
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A child process to its end (killed at `minutes`): exit code, stdout, the tail of stderr. `watch` sees each stdout line as it
 * comes; a reason it returns kills the child at once (`aborted`).
 */
export async function run(cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; minutes?: string | number; input?: string; watch?: (line: string) => string | undefined }) {
  // Its own process group, so a kill takes the commands it started too (one still holding stdout would keep the run open).
  const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
  child.stdin.on("error", () => {}); // a child that exits without reading its input
  child.stdin.end(o.input); // none: closed at once, as /dev/null would be
  let stdout = "", stderr = "", timedOut = false, aborted: string | undefined, line = "";
  // Decoded as streams, so a character split across chunks arrives whole.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    stdout += d;
    if (!o.watch || aborted) return;
    const parts = d.split("\n"); // only the chunk is split: a long line is joined once, when it ends
    const lines = parts.length > 1 ? [line + parts[0]!, ...parts.slice(1, -1)] : [];
    line = parts.length > 1 ? parts.at(-1)! : line + d;
    for (const l of lines) if ((aborted = o.watch(l))) { kill(); break; }
  });
  child.stderr.on("data", (d: string) => { stderr += d; if (stderr.length > 1e6) stderr = stderr.slice(-5e5); });
  const timer = setTimeout(() => { timedOut = true; kill(); }, Number(o.minutes ?? 20) * 60_000);
  // A killed run ends when the child does: a command that outlived it can't hold its pipes open.
  child.on("exit", () => { if (aborted || timedOut) { child.stdout.destroy(); child.stderr.destroy(); } });
  const code = await new Promise<number | null>((ok) => { child.on("close", ok); child.on("error", () => ok(null)); });
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut, aborted };
}
export const stopped = (r: { code: number | null; stderr: string; timedOut: boolean; aborted?: string }, said = "") =>
  r.aborted ?? (r.timedOut ? "timed out" : /\b402\b|cap_reached/i.test(said + r.stderr) ? "the install's spend limit was reached" : `the engine stopped (exit ${r.code})`);

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
