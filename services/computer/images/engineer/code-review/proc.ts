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
  // A killed run (aborted, or out of time) ends now: its group killed and its pipes closed, so nothing that outlived it (a helper
  // in another group, or the engine already gone) can hold them open.
  const kill = () => {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    child.stdout.destroy();
    child.stderr.destroy();
  };
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
  const code = await new Promise<number | null>((ok) => { child.on("close", ok); child.on("error", () => ok(null)); });
  clearTimeout(timer);
  if (o.watch && !aborted && line) aborted = o.watch(line); // a last line with no newline
  // An aborted run never counts as finished, whatever its exit.
  return { code: aborted ? null : code, stdout, stderr, timedOut, aborted };
}
/**
 * The gateway's own 402 refusal as an engine prints it: the status then the type (`402 cap_reached`, `402 {"error":"cap_reached"}`),
 * its JSON type, or its message with the amounts. A bare `cap_reached` is not one: an engine's stderr echoes what the reviewer
 * read, and the code it reads (the gateway's own source, a test) names it.
 */
const SPEND_REFUSAL = /\b402:?\s+(?:\{[^}\n]*)?\bcap_reached\b|"type"\s*:\s*"cap_reached"|spend cap reached: the install's (?:daily|monthly) limit, \$\d|task spend cap reached: this task's \$\d/i;
/** The provider's own rate limit, as the gateway relays it. */
const RATE_LIMITED = /\brate_limit_(?:exceeded|error)\b|error event: 429\b|\b(?:status|http)[ :]*429\b|\b429 Too Many Requests\b/i;
export const stopped = (r: { code: number | null; stderr: string; timedOut: boolean; aborted?: string }, said = "") =>
  // `said` is the engine's own error events: the reported error. `stderr` also echoes what the reviewer read, so a spend refusal
  // in it counts only when the events report no rate limit.
  r.aborted ?? (r.timedOut ? "timed out" : SPEND_REFUSAL.test(said) || (!RATE_LIMITED.test(said) && SPEND_REFUSAL.test(r.stderr)) ? "the install's spend limit was reached" : RATE_LIMITED.test(`${said}\n${r.stderr}`) ? "the model provider rate limited the call" : /spend_held/i.test(said + r.stderr) ? "the gateway held the call for room (503)" : /\b402\b/.test(said + r.stderr) ? "the model provider refused the call (402)" : `the engine stopped (exit ${r.code})`);

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
