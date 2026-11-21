// A child process to its end, shared by the engines (engines.ts) and deepsec (deepsec.ts).
import { spawn } from "node:child_process";

/** A child process to its end (killed at `minutes`): exit code, stdout, the tail of stderr. */
export async function run(cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; minutes?: string | number }) {
  const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (d: Buffer) => (stdout += d));
  child.stderr.on("data", (d: Buffer) => { stderr += d; if (stderr.length > 1e6) stderr = stderr.slice(-5e5); });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Number(o.minutes ?? 20) * 60_000);
  const code = await new Promise<number | null>((ok) => { child.on("close", ok); child.on("error", () => ok(null)); });
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}
export const stopped = (r: { code: number | null; stderr: string; timedOut: boolean }, said = "") =>
  r.timedOut ? "timed out" : /\b402\b|cap_reached|budget/i.test(said + r.stderr) ? "the run's budget ran out" : `the engine stopped (exit ${r.code})`;
