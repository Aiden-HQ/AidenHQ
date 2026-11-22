// The host's health probes (POST /v1/health/probe {probe}, the host's health_probe_key): the modules' own (a connection's
// `health_probes` in module.yaml), each one read tool of that connection with fixed arguments, called as the narrowest agent granted it through the module call a replayed record makes.
// The caller names a probe and nothing else; it gets back whether the call worked, never what the tool answered.
import http from "node:http";
import { fail } from "./proxy.ts";
import type { Connection, Grant } from "./identity.ts";
import type { Requester } from "./records.ts";
import type { Resolver } from "./net.ts";

type Log = (msg: string, fields?: Record<string, unknown>) => void;
export function createHealthProbe({ grants, connections, kindOf, callAs, log = () => {} }: {
  grants: () => Record<string, Grant>; connections: () => Record<string, Connection>;
  /** writes.kindOf: a tool with a write kind is never probed. */
  kindOf: (connection: string, tool: string) => string | undefined;
  callAs: (q: Requester, connection: string, tool: string, args: unknown) => Promise<{ ok: boolean; text: string }>;
  log?: Log;
}) {
  return async function probe(b: { probe?: unknown }): Promise<{ ok: boolean; ms: number; error?: string }> {
    const declared = Object.entries(connections()).flatMap(([connection, conn]) => Object.entries(conn.health_probes ?? {}).map(([name, h]) => ({ name, connection, conn, tool: h.tool, args: () => h.args ?? {} })));
    const p = declared.find((d) => d.name === String(b.probe));
    if (!p) throw fail(404, "not_found", `no probe ${String(b.probe).slice(0, 40)} (${declared.map((d) => d.name).join(", ")})`);
    const conn = p.conn;
    // Reads only: a tool the connection tags write or destructive, or that has a write kind, is never called.
    if (!conn.tools.read.includes(p.tool) || conn.tools.write.includes(p.tool) || conn.tools.destructive.includes(p.tool) || kindOf(p.connection, p.tool)) throw fail(409, "not_read", `${p.connection}.${p.tool} is not a plain read tool`);
    // The agent holding it with the fewest tools overall, then by id: the narrowest caller there is.
    const count = (g: Grant) => Object.values(g.tools ?? {}).reduce((n, t) => n + t.length, 0);
    const [id, g] = Object.entries(grants()).filter(([, g]) => g.tools?.[p.connection]?.includes(p.tool)).sort(([i, a], [j, c]) => count(a) - count(c) || i.localeCompare(j))[0] ?? [];
    if (!id || !g) throw fail(409, "no_caller", `no agent is granted ${p.connection}.${p.tool}`);
    const t0 = Date.now();
    const r = await callAs({ agent: id, key: String(g.key ?? ""), name: String(g.key ?? ""), roles: [...(g.roles ?? [])], kind: "run" }, p.connection, p.tool, p.args()).catch((e: Error) => ({ ok: false, text: e.message }));
    const ms = Date.now() - t0;
    log("proxy", { connection: p.connection, tool: p.tool, method: "tools/call", agent: g.key ?? id, ms, total: ms, outcome: r.ok ? "ok" : "error", via: "health-probe" });
    return r.ok ? { ok: true, ms } : { ok: false, ms, error: r.text.slice(0, 200) };
  };
}

/**
 * Every connection's /healthz, asked from the kernel (which reaches each service by its container address, so a module with no
 * board network is probed the same as any other). ok unless the HTTP status or `ok: false` says otherwise; the board's Connections page reads this.
 */
export function createConnectionHealth({ connections, resolver, timeoutMs = 4000 }: { connections: () => Record<string, Connection>; resolver: Resolver; timeoutMs?: number }) {
  const one = async (url: string) => {
    const checkedAt = new Date().toISOString();
    try {
      const to = await resolver.resolve(new URL("/healthz", url).href);
      const r = await fetch(`http://${to.host}:${to.port}${to.path}`, { signal: AbortSignal.timeout(timeoutMs) });
      let j: Record<string, unknown> = {};
      try { j = JSON.parse(await r.text()); } catch {}
      const detail = typeof j.detail === "string" ? j.detail.slice(0, 200) : undefined;
      const channels = j.channels && typeof j.channels === "object" ? Object.fromEntries(Object.entries(j.channels as Record<string, unknown>).map(([k, v]) => [k, v === true])) : undefined;
      return { ok: r.ok && j.ok !== false, status: r.status, ...(typeof j.state === "string" ? { state: j.state } : {}), ...(detail ? { detail } : {}), ...(channels ? { channels } : {}), checkedAt };
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      resolver.forget(url);
      return { ok: false, detail: `unreachable: ${err.cause?.code ?? err.message}`.slice(0, 200), checkedAt };
    }
  };
  return async () => Object.fromEntries(await Promise.all(Object.entries(connections()).filter(([, c]) => c.url).map(async ([n, c]) => [n, await one(c.url)] as const)));
}

/**
 * One service's own /healthz: its status and its JSON body, read bounded so a service that stops mid-answer, keeps dribbling or
 * floods cannot hold the caller up or grow it — the reviewer restart check (reviews.ts `check`) reads a module's /healthz here.
 * The deadline is wall-clock (`timeoutMs`, 4 s), not a socket-idle timeout: a peer that keeps sending data is cut off too. A body
 * past `maxBytes` (8 KB) is no answer at all, not a truncated one parsed into an instance. Never throws: an unreachable service
 * answers `{ status: 0, body: {} }`. Every answer of `status: 0` also forgets the resolved address, the deadline and the size
 * bound alike: a service replaced by an apply can leave the old address blackholing rather than refusing, and a cached one would
 * keep answering nothing for the cache's minute — the next probe must resolve the replacement.
 */
export async function readHealth({ resolver, url, timeoutMs = 4000, maxBytes = 8192 }: { resolver: Resolver; url: string; timeoutMs?: number; maxBytes?: number }): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    // Asking the root: the /healthz path, with the Host a dispatch to the module carries.
    const to = await resolver.resolve(new URL("/healthz", url).href);
    return await new Promise((ok) => {
      let done = false;
      let req: http.ClientRequest | undefined;
      const answer = (status: number, body: Record<string, unknown> = {}) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        // No answer at all (a deadline, a size bound, a broken socket): the address is unproven, so a cached one is dropped and
        // the next probe resolves the service again. Without this a container recreated at a new address keeps being asked at the
        // old one, which blackholes rather than refuses, for as long as the resolver's cache holds it.
        if (status === 0) resolver.forget(url);
        req?.destroy();
        ok({ status, body });
      };
      // Elapsed time, not socket idleness: `req.setTimeout` only fires when nothing moves, so a peer dribbling bytes would never
      // time it out and the sweep awaiting this probe would wait as long as it liked.
      const deadline = setTimeout(() => answer(0), timeoutMs);
      req = http.request({ host: to.host, port: to.port, path: "/healthz", method: "GET", headers: { host: new URL(url).host } }, (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (c: Buffer) => {
          n += c.length;
          // Past the bound the answer is unusable: a truncated prefix can still parse and name an instance that never said so.
          if (n > maxBytes) return answer(0);
          chunks.push(c);
        });
        res.on("end", () => {
          let j: Record<string, unknown> = {};
          try { const p = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); if (p && typeof p === "object" && !Array.isArray(p)) j = p; } catch {}
          answer(res.statusCode ?? 0, j);
        });
        res.on("error", () => answer(0));
      });
      req.on("error", () => answer(0));
      req.end();
    });
  } catch {
    return { status: 0, body: {} };
  }
}
