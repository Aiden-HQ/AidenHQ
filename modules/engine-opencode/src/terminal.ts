// The session's TUI: opencode attached to its own server in tmux, served by ttyd on the lease's terminal port. The board
// proxies it with basic auth `aidenhq:<the lease's secret>`; `credential` is that secret. The pane's own environment carries this lease's server password: a tmux server shared
// with other leases hands its panes its own first environment, not the client's.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** tmux session `lease` runs `opencode attach`; ttyd serves it. Returns the ttyd process. */
export function startTerminal(o: { lease: string; leaseDir: string; port: number; sessionPort: number; session: string; credential: string; cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  const r = spawnSync("tmux", ["new-session", "-d", "-s", o.lease, "-c", o.cwd, "-e", `OPENCODE_SERVER_PASSWORD=${o.env.OPENCODE_SERVER_PASSWORD}`, "opencode", "attach", `http://127.0.0.1:${o.sessionPort}`, "--session", o.session], { env: o.env, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`tmux new-session failed (${r.status ?? r.error?.message})`);
  const ttyd = spawn("ttyd", ["--port", String(o.port), "--credential", `aidenhq:${o.credential}`, "--writable", "tmux", "attach", "-t", o.lease], { env: o.env, stdio: ["ignore", "inherit", "inherit"] });
  if (ttyd.pid) writeFileSync(join(o.leaseDir, "ttyd.pid"), String(ttyd.pid), { mode: 0o600 });
  return ttyd;
}
