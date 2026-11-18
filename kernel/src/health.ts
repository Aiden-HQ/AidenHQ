// The host's health probe (POST /v1/health/probe, the operator's key): one read tool called on a connection, as the agent that
// holds it, through the same module call a replayed record makes. scripts/healthcheck.sh asks; nothing else does.
import { fail } from "./proxy.ts";
import type { Connection, Grant } from "./identity.ts";
import { rolesOf } from "./identity.ts";
import type { Requester } from "./records.ts";

export function createHealthProbe({ grants, connections, callAs }: {
  grants: () => Record<string, Grant>; connections: () => Record<string, Connection>;
  callAs: (q: Requester, connection: string, tool: string, args: unknown) => Promise<{ ok: boolean; text: string }>;
}) {
  return async function probe(b: { connection?: unknown; tool?: unknown; args?: unknown }): Promise<{ ok: boolean; text: string }> {
    const connection = String(b.connection ?? ""), tool = String(b.tool ?? "");
    const conn = Object.hasOwn(connections(), connection) ? connections()[connection] : undefined;
    if (!conn) throw fail(404, "not_found", `no connection ${connection}`);
    // Reads only: a probe never writes, whatever the caller names.
    if (!conn.tools.read.includes(tool) || conn.tools.write.includes(tool) || conn.tools.destructive.includes(tool)) throw fail(400, "bad_request", `${connection}.${tool} is not a read tool`);
    // The agent holding it with the fewest tools overall, then by id: the narrowest caller there is.
    const count = (g: Grant) => Object.values(g.tools ?? {}).reduce((n, t) => n + t.length, 0);
    const [id, g] = Object.entries(grants()).filter(([, g]) => g.tools?.[connection]?.includes(tool)).sort(([i, a], [j, b2]) => count(a) - count(b2) || i.localeCompare(j))[0] ?? [];
    if (!id || !g) throw fail(409, "no_caller", `no agent is granted ${connection}.${tool}`);
    return callAs({ agent: id, key: String(g.key ?? ""), name: String(g.key ?? ""), roles: rolesOf(g), kind: "run" }, connection, tool, b.args ?? {});
  };
}
