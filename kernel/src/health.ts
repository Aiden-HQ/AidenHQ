// The host's health probes (POST /v1/health/probe {probe}, the host's health_probe_key): a fixed set, each one read tool of a
// connection with fixed arguments, called as the narrowest agent granted it through the module call a replayed record makes.
// The caller names a probe and nothing else; it gets back whether the call worked, never what the tool answered.
import { fail } from "./proxy.ts";
import type { Connection, Grant } from "./identity.ts";
import { rolesOf } from "./identity.ts";
import type { Requester } from "./records.ts";

type Log = (msg: string, fields?: Record<string, unknown>) => void;
const day = () => new Date().toISOString().slice(0, 10);
export const PROBES: Record<string, { connection: string; tool: string; args: () => Record<string, unknown> }> = {
  gmail: { connection: "google_workspace", tool: "gmail_search", args: () => ({ query: "in:inbox", max_results: 1 }) },
  calendar: { connection: "google_workspace", tool: "calendar_list_events", args: () => ({ start: `${day()}T00:00:00Z`, end: `${day()}T23:59:59Z`, max_results: 5 }) },
  github: { connection: "github", tool: "github_whoami", args: () => ({}) },
};

export function createHealthProbe({ grants, connections, kindOf, callAs, log = () => {} }: {
  grants: () => Record<string, Grant>; connections: () => Record<string, Connection>;
  /** writes.kindOf: a tool with a write kind is never probed. */
  kindOf: (connection: string, tool: string) => string | undefined;
  callAs: (q: Requester, connection: string, tool: string, args: unknown) => Promise<{ ok: boolean; text: string }>;
  log?: Log;
}) {
  return async function probe(b: { probe?: unknown }): Promise<{ ok: boolean; ms: number; error?: string }> {
    const p = Object.hasOwn(PROBES, String(b.probe)) ? PROBES[String(b.probe)] : undefined;
    if (!p) throw fail(404, "not_found", `no probe ${String(b.probe).slice(0, 40)} (${Object.keys(PROBES).join(", ")})`);
    const conn = Object.hasOwn(connections(), p.connection) ? connections()[p.connection] : undefined;
    if (!conn) throw fail(404, "not_found", `no connection ${p.connection}`);
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
