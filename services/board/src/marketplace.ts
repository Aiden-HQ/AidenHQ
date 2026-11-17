// Modules > Browse and Marketplaces, and an agent's grants (docs/design/agent-and-module-pages.md). Read from the compiled
// module catalog (config/modules.json) and compiled config (paperclip.yaml): compile already reads every configured
// marketplace at its pinned sha, so the board fetches no code. A third-party marketplace's modules appear once compile
// has read them (installed ones); that is the limit of this data until compile writes the whole listing.
import type { Compiled } from "./settings.js";

interface Entry {
  name: string;
  description?: string;
  enabled?: boolean;
  requires?: string[];
  agents?: string[];
  connections?: string[];
  apps?: string[];
  revision?: string;
  marketplace?: string;
  tier?: string;
  source?: { url?: string };
  setup_flow?: { title?: string };
  /** Write kinds it declares (kind → floor, scripts/modules.mjs) and the secret names it mounts. */
  writes?: Record<string, { floor: number; panel?: boolean }>;
  secrets?: string[];
  setup?: string;
  /** Its own agents' module.yaml values before the instance's overrides: a grant is "read", "write" or a list of tools. */
  defaults?: { agents?: Record<string, { connections?: Record<string, "read" | "write" | string[]> }> };
}

const KINDS = ["agents", "connections", "channels", "apps"] as const;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function kindsOf(m: Entry): string[] {
  return [...(m.agents?.length ? ["agents"] : []), ...(m.connections?.length ? ["connections"] : []), ...(m.name.startsWith("channel-") ? ["channels"] : []), ...(m.apps?.length ? ["apps"] : [])];
}

/** What turning it on would add, in plain words. */
function addsOf(m: Entry): string[] {
  const out: string[] = [];
  if (m.agents?.length) out.push(`${plural(m.agents.length, "agent")}: ${m.agents.join(", ")}`);
  if (m.connections?.length) out.push(`${plural(m.connections.length, "connection")}: ${m.connections.join(", ")}`);
  if (m.apps?.length) out.push(`${plural(m.apps.length, "app")}: ${m.apps.join(", ")}`);
  const writes = Object.keys(m.writes ?? {});
  if (writes.length) out.push(`may ask to: ${writes.join(", ")}`);
  if (m.secrets?.length) out.push(`needs: ${m.secrets.join(", ")}`);
  else if (m.setup) out.push("needs a sign-in or key from you");
  if (m.requires?.length) out.push(`also turns on: ${m.requires.join(", ")}`);
  return out;
}

export function browseModules(catalog: Entry[], q: string, kind: string) {
  const needle = q.trim().toLowerCase();
  return {
    modules: catalog
      .filter((m) => m.name !== "kernel")
      .filter((m) => !KINDS.includes(kind as never) || kindsOf(m).includes(kind))
      .filter((m) => !needle || `${m.name} ${m.description ?? ""} ${m.marketplace ?? ""}`.toLowerCase().includes(needle))
      .map((m) => ({
        name: m.name,
        description: m.description ?? "",
        marketplace: m.marketplace ?? "aidenhq",
        tier: m.tier ?? "official",
        adds: addsOf(m),
        installed: Boolean(m.enabled),
        ...(m.setup_flow?.title ? { setupFlow: { title: m.setup_flow.title } } : {}),
      })),
  };
}

/** The marketplaces compile has read, from the catalog. `newer` is false: nothing here knows a marketplace's newest commit. */
export function marketplacesOf(catalog: Entry[]) {
  const by = new Map<string, { name: string; source: string; sha: string; modules: number; newer: boolean }>();
  for (const m of catalog.filter((x) => x.name !== "kernel")) {
    const name = m.marketplace ?? "aidenhq";
    const row = by.get(name) ?? { name, source: "", sha: "", modules: 0, newer: false };
    row.modules++;
    row.source ||= m.source?.url ?? "";
    row.sha ||= m.revision ?? "";
    by.set(name, row);
  }
  return { marketplaces: [...by.values()] };
}

/** The tools its module grants an agent on one connection (module.yaml as written), or null for an agent without one (an instance agent's). */
function moduleGrant(catalog: Entry[], key: string, connection: string, tools: { read: string[]; write: string[] }): string[] | null {
  const g = catalog.find((m) => m.defaults?.agents?.[key])?.defaults!.agents![key]!.connections?.[connection];
  return g === "read" ? tools.read : g === "write" ? [...tools.read, ...tools.write] : Array.isArray(g) ? g : null;
}

/** One agent's tools per connection, with their class and whether the agent holds them now (compile's effective grants) and by default (its module's). */
export function agentGrants(compiled: Compiled | null, catalog: Entry[], key: string) {
  const agent = compiled?.agents?.[key];
  if (!agent) return null;
  const moduleOf = new Map(catalog.flatMap((m) => (m.connections ?? []).map((c) => [c, m.name] as const)));
  return {
    connections: Object.entries(agent.enabled_tools ?? {}).map(([id, held]) => {
      const t = compiled?.mcp_servers?.[id]?.tools ?? {};
      const classed = [...(t.read ?? []).map((n) => [n, "read"] as const), ...(t.write ?? []).map((n) => [n, "write"] as const), ...(t.destructive ?? []).map((n) => [n, "destructive"] as const)];
      const byDefault = moduleGrant(catalog, key, id, { read: t.read ?? [], write: t.write ?? [] });
      return {
        id,
        module: moduleOf.get(id) ?? "",
        tools: classed.map(([name, cls]) => ({ name, class: cls, granted: held.includes(name), default: (byDefault ?? held).includes(name) })),
      };
    }),
  };
}
