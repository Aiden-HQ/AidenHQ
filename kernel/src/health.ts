// The host's health probes (POST /v1/health/probe {probe}, the host's health_probe_key): the modules' own (a connection's
// `health_probes` in module.yaml), each one read tool of that connection with fixed arguments, called as the narrowest agent granted it through the module call a replayed record makes.
// The caller names a probe and nothing else; it gets back whether the call worked, never what the tool answered.
import { fail } from "./proxy.ts";
import type { Connection, Grant } from "./identity.ts";
import { rolesOf } from "./identity.ts";
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
    const r = await callAs({ agent: id, key: String(g.key ?? ""), name: String(g.key ?? ""), roles: rolesOf(g), kind: "run" }, p.connection, p.tool, p.args()).catch((e: Error) => ({ ok: false, text: e.message }));
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
