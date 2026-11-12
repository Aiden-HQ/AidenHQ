/**
 * A job's own network namespace (engines.mjs jailed): `node netjail.mjs <pasta> <ports|none> <link> bwrap <args...>`.
 * bwrap creates the namespace (--unshare-net) and reports its pid (--info-fd 3); pasta joins it with Internet egress
 * through the host's sockets, on the link <link>.0/24, and forwards only <ports> from the job's 127.0.0.1 to the host's;
 * then the sandbox starts (--block-fd 4) with public resolvers (--ro-bind-data 5): the host's own (systemd-resolved,
 * the LAN's server) are out of the job's reach, and pasta 2024-02's --dns-forward doesn't answer. The job's own first
 * step (engines.mjs jailed) makes private ranges and the host's addresses unreachable and drops its capabilities.
 */
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";

const [pasta, ports, link, bwrap, ...args] = process.argv.slice(2);
// A stop signals the whole process group: the engine handles it; this stays until bwrap exits (its --die-with-parent).
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => {});
const child = spawn(bwrap, args, { stdio: ["inherit", "inherit", "inherit", "pipe", "pipe", "pipe"] });
for (const fd of [3, 4, 5]) child.stdio[fd].on("error", () => {}); // bwrap closes them as it goes
child.stdio[5].end("nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
let info = "";
let started = false;
child.stdio[3].on("data", (d) => {
  info += d;
  const pid = /"child-pid":\s*(\d+)/.exec(info)?.[1];
  if (!pid || started) return;
  started = true;
  const r = spawnSync(pasta, [
    "--config-net", "-4", "--no-map-gw", "-a", `${link}.15`, "-n", "24", "-g", `${link}.2`,
    "-D", "none", "-t", "none", "-u", "none", "-U", "none", "-T", ports, "-q", pid,
  ], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    console.error(`aidenhq: the job's network (pasta) failed to start (${r.error?.code ?? `exit ${r.status}`}); not running it outside its jail`);
    child.kill("SIGKILL");
    process.exit(1);
  }
  child.stdio[4].end("go");
});
child.on("error", (e) => {
  console.error(`aidenhq: couldn't start bwrap: ${e.code ?? e.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 0)));
