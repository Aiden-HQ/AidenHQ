// Where a module's service is: its compose container's address (the kernel runs on the host, where compose service names
// don't resolve). The name a URL uses is the service's compose name (`<project>-<name>-1`) or, for a module's generated
// service, the name it declared (its `aidenhq.service` label; the compose key is `<module>-<name>`). Any of its networks'
// addresses works from the host; its module's own network is preferred. Cached ten minutes, one lookup at a time per host; forget() after a failed connect.
// An IP or localhost URL is used as it is (tests).
import { execFile } from "node:child_process";

export type Target = { host: string; port: number; path: string };
const TTL_MS = 10 * 60_000;
type Inspect = (name: string) => Promise<string>;

export function createResolver({ project = "aidenhq", inspect = dockerAddress(project) }: { project?: string; inspect?: Inspect } = {}) {
  const ips = new Map<string, { ip: string; at: number }>();
  const pending = new Map<string, Promise<string>>();
  async function resolve(urlStr: string): Promise<Target> {
    const u = new URL(urlStr);
    const port = Number(u.port || 80), path = `${u.pathname}${u.search}`;
    if (/^[\d.]+$/.test(u.hostname) || u.hostname === "localhost") return { host: u.hostname, port, path };
    const hit = ips.get(u.hostname);
    if (hit && Date.now() - hit.at < TTL_MS) return { host: hit.ip, port, path };
    let lookup = pending.get(u.hostname);
    if (!lookup) {
      lookup = (async () => {
        const ip = (await inspect(u.hostname)).trim();
        if (!/^[\d.]+$/.test(ip)) throw new Error(`the service ${u.hostname} isn't running`);
        ips.set(u.hostname, { ip, at: Date.now() });
        return ip;
      })().finally(() => pending.delete(u.hostname));
      pending.set(u.hostname, lookup);
    }
    return { host: await lookup, port, path };
  }
  return { resolve, forget: (urlStr: string) => void ips.delete(new URL(urlStr).hostname) };
}

const run = (args: string[]): Promise<string> => new Promise((ok) => execFile("docker", args, { timeout: 10_000 }, (err, out) => ok(err ? "" : String(out))));

/** The container's address: on its module's network (aidenhq-mod-*) if it has one, else the backplane, else any. */
export function pickAddress(networks: Record<string, { IPAddress?: string }>, project: string): string {
  const names = Object.keys(networks).sort();
  const pick = names.find((n) => n.startsWith("aidenhq-mod-") && !n.endsWith("-egress")) ?? names.find((n) => n === `${project}_backplane`) ?? names[0];
  return (pick && networks[pick]?.IPAddress) || "";
}

export function dockerAddress(project: string): Inspect {
  return async (name) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return "";
    // Two containers declaring one name is a config compile refuses: answer nothing rather than pick one.
    const byLabel = (await run(["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=aidenhq.service=${name}`])).split("\n").map((l) => l.trim()).filter(Boolean);
    if (byLabel.length > 1) return "";
    const json = await run(["inspect", "-f", "{{json .NetworkSettings.Networks}}", byLabel[0] || `${project}-${name}-1`]);
    try { return pickAddress(JSON.parse(json || "{}"), project); } catch { return ""; }
  };
}
export type Resolver = ReturnType<typeof createResolver>;
