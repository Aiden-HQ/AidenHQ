// Where a module's service is: its compose container's address on the backplane network (the kernel runs on the host,
// where compose service names don't resolve). Cached a minute; forget() after a failed connect. An IP or localhost URL is
// used as it is (tests, and services published on loopback).
import { execFile } from "node:child_process";

export type Target = { host: string; port: number; path: string };

export function createResolver({ project = "aidenhq", inspect = dockerInspect }: { project?: string; inspect?: (container: string, network: string) => Promise<string> } = {}) {
  const ips = new Map<string, { ip: string; at: number }>();
  async function resolve(urlStr: string): Promise<Target> {
    const u = new URL(urlStr);
    const port = Number(u.port || 80), path = `${u.pathname}${u.search}`;
    if (/^[\d.]+$/.test(u.hostname) || u.hostname === "localhost") return { host: u.hostname, port, path };
    const hit = ips.get(u.hostname);
    if (hit && Date.now() - hit.at < 60_000) return { host: hit.ip, port, path };
    const ip = (await inspect(`${project}-${u.hostname}-1`, `${project}_backplane`)).trim();
    if (!/^[\d.]+$/.test(ip)) throw new Error(`the service ${u.hostname} isn't running`);
    ips.set(u.hostname, { ip, at: Date.now() });
    return { host: ip, port, path };
  }
  return { resolve, forget: (urlStr: string) => void ips.delete(new URL(urlStr).hostname) };
}

function dockerInspect(container: string, network: string): Promise<string> {
  return new Promise((resolve) => execFile("docker", ["inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container], { timeout: 10_000 }, (err, out) => resolve(err ? "" : String(out))));
}
export type Resolver = ReturnType<typeof createResolver>;
