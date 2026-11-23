// Whether the proxy admits a tool on the endpoint a call came to, asked of the proxy itself so the same rule applies:
// `/mcp/read` lists only reads (manifest tag and upstream read-only hint), and `/mcp` lists the upstream catalog. A name
// is admission only when the entry comes from the live upstream list: the proxy's stand-ins (what it lists while the
// upstream is unreachable) carry no annotations, while every live entry gets the read/write hints, so a cached stand-in
// is never taken for live membership.
export type Ask = (path: string, key: string, body: unknown) => Promise<Record<string, any> | undefined>;
/** The tools/list body a probe asks for. */
export const TOOL_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };
type Tool = { name?: unknown; annotations?: unknown };
const live = (t: Tool) => Boolean(t.annotations && typeof t.annotations === "object");
const toolsOf = (list: Record<string, any> | undefined): Tool[] | undefined => (Array.isArray(list?.result?.tools) ? (list.result.tools as Tool[]) : undefined);

/**
 * Whether `name` is served on the requested endpoint, and whether that was confirmed. `confirmed: false` means the probe
 * couldn't tell (the catalog was unreadable, or only stand-ins came back): a caller retries rather than claiming the tool
 * is refused. `confirmed: true` is a real answer, including "the read endpoint's rule excludes every tool".
 */
export async function servedTool(readOnly: boolean, name: string, ask: Ask, keyOf: (readOnly: boolean) => string | undefined): Promise<{ served: boolean; confirmed: boolean }> {
  const key = keyOf(readOnly);
  if (!key) return { served: false, confirmed: false };
  const tools = toolsOf(await ask(readOnly ? "/mcp/read" : "/mcp", key, TOOL_LIST));
  // No list at all (a 5xx, a timeout, an unreadable answer): admission is unconfirmed, not refused.
  if (!tools) return { served: false, confirmed: false };
  // Cached stand-ins (never annotated) mean the proxy can't reach the upstream: an outage, not a catalog that excludes
  // the tool. An *empty* read list is ambiguous — the upstream may be unreachable, or Slack may simply offer no tool
  // whose annotations mark it a read — so the full catalog decides: reachable there means this empty list is a real
  // answer, and the tool is genuinely not served on the read endpoint.
  if (!tools.length && readOnly) {
    const serviceKey = keyOf(false);
    const all = toolsOf(serviceKey ? await ask("/mcp", serviceKey, TOOL_LIST) : undefined) ?? [];
    if (!all.some(live)) return { served: false, confirmed: false };
    // The full catalog is live, so the upstream is reachable: ask the read endpoint once more. A first empty list can
    // have been its own transient failure, and only a second one is a real answer that the read rule excludes the tool.
    const reads = toolsOf(await ask("/mcp/read", key, TOOL_LIST));
    if (reads && !reads.length) return { served: false, confirmed: true };
    // A read list that exists but carries only unannotated stand-ins is the proxy's outage fallback: unconfirmed.
    if (!reads?.some(live)) return { served: false, confirmed: false };
    return { served: reads.some((t) => String(t?.name ?? "") === name && live(t)), confirmed: true };
  }
  if (!tools.length || !tools.some(live)) return { served: false, confirmed: false };
  // A live catalog answered: either it carries the tool or it genuinely doesn't, and both are confirmed.
  return { served: tools.some((t) => String(t?.name ?? "") === name && live(t)), confirmed: true };
}
