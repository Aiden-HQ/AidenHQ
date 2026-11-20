// A paperclip container killed before its embedded Postgres shut down leaves postmaster.pid behind, and the next start
// refuses: "Refusing to reuse PostgreSQL: its data directory belongs to another instance." (2026-11-14 outage).
import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

// Stale only when the logs show exactly that refusal and no postgres runs in the (restarting) container.
export const isStalePidRefusal = (logs: string, psOutput: string) =>
  /Refusing to reuse PostgreSQL: its data directory belongs to another instance/.test(logs) && !/\bpostgres\b/.test(psOutput);

// Returns true when it moved the pid file aside and restarted paperclip.
export function recoverStalePid({ repo, dataDir, env }: { repo: string; dataDir: string; env: NodeJS.ProcessEnv }) {
  const sh = (args: string[]) => execFileSync("docker", ["compose", ...args], { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const logs = sh(["logs", "--tail", "200", "paperclip"]);
  let ps = "";
  try { ps = sh(["exec", "-T", "paperclip", "ps", "-eo", "args"]); } catch { /* restarting: nothing runs */ }
  const pid = join(dataDir, "paperclip/instances/default/db/postmaster.pid");
  if (!isStalePidRefusal(logs, ps) || !existsSync(pid)) return false;
  sh(["stop", "paperclip"]);
  const backup = `${pid}.stale-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(pid, backup);
  sh(["start", "paperclip"]);
  console.log(`  paperclip: stale postmaster.pid moved to ${backup}; restarted`);
  return true;
}
