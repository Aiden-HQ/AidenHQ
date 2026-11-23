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
  routines?: string[];
  connections?: string[];
  apps?: string[];
  revision?: string;
  marketplace?: string;
  tier?: string;
  source?: { url?: string };
  setup_flow?: { title?: string };
  /** Write kinds it declares (kind → floor, scripts/modules.ts) and the secret names it mounts. */
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
  // An imported module's routines are created paused (scripts/modules.ts): the owner turns each on.
  if (m.routines?.length) out.push(`${plural(m.routines.length, "routine")}${m.tier === "declared" ? " (start paused)" : ""}: ${m.routines.join(", ")}`);
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

export class CommitUnreadable extends Error {}

export type Resolve = (repo: string) => Promise<{ sha: string; date: string }>;
const MIN_AGE_MS = 7 * 24 * 3600_000;
const TTL_MS = 10 * 60_000;

/**
 * The commit the board pins a marketplace at: the newest on the repo's default branch that is at least 7 days old (the
 * supply-chain rule), from GitHub's commit metadata only (unauthenticated). Cached about ten minutes.
 */
export function createResolver(fetchFn: typeof fetch, now: () => number = Date.now): Resolve {
  const cache = new Map<string, { at: number; value: Promise<{ sha: string; date: string }> }>();
  const lookup = async (repo: string) => {
    const until = new Date(now() - MIN_AGE_MS).toISOString().replace(/\.\d+Z$/, "Z");
    const res = await fetchFn(`https://api.github.com/repos/${repo}/commits?until=${encodeURIComponent(until)}&per_page=1`, { headers: { accept: "application/vnd.github+json", "user-agent": "aidenhq-board" } }).catch(() => null);
    if (!res?.ok) throw new CommitUnreadable("can't read that repository's commits; it must be public or reachable");
    const [c] = (await res.json()) as { sha?: string; commit?: { committer?: { date?: string }; author?: { date?: string } } }[];
    if (!c?.sha) throw new CommitUnreadable("that repository has no commit older than 7 days to pin");
    return { sha: c.sha, date: c.commit?.committer?.date ?? c.commit?.author?.date ?? "" };
  };
  return (repo) => {
    const hit = cache.get(repo);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    const value = lookup(repo);
    cache.set(repo, { at: now(), value });
    value.catch(() => cache.delete(repo));
    return value;
  };
}

const repoOf = (url?: string) => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url ?? "")?.[1];

/** The marketplaces compile has read, from the catalog. `latest` is the newest commit old enough to pin; `newer` is whether it differs from the pin. */
export async function marketplacesOf(catalog: Entry[], resolve: Resolve) {
  const by = new Map<string, { name: string; source: string; sha: string; modules: number; newer: boolean; latest?: { sha: string; date: string } }>();
  for (const m of catalog.filter((x) => x.name !== "kernel")) {
    const name = m.marketplace ?? "aidenhq";
    const row = by.get(name) ?? { name, source: "", sha: "", modules: 0, newer: false };
    row.modules++;
    row.source ||= m.source?.url ?? "";
    row.sha ||= m.revision ?? "";
    by.set(name, row);
  }
  const rows = [...by.values()];
  await Promise.all(rows.map(async (row) => {
    const repo = repoOf(row.source);
    const latest = repo && row.sha ? await resolve(repo).catch(() => undefined) : undefined;
    if (latest) Object.assign(row, { latest, newer: latest.sha !== row.sha });
  }));
  return { marketplaces: rows };
}

/** The tools its module grants an agent on one connection (module.yaml as written), or null for an agent its module doesn't list. */
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
